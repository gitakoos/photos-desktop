/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * Source:  https://github.com/gitakoos/photos-desktop
 * Website: https://www.photosforproton.eu
 *
 * This file is part of Photos for Proton.
 *
 * Photos for Proton is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// Changing the capture date or the place of photos already on Drive, the way the Android app
// does it.
//
// Drive keeps a photo's date and place in the revision it was uploaded with and allows no
// second revision, so they are changed by a corrected copy: the original is downloaded, the
// new date is written into the file's own metadata (`embedDate.ts`) and a new place into a
// JPEG's EXIF (`embedGps.ts`), never touching the picture, the copy is uploaded with that
// date and place, its tags and the original's other metadata, and it
// joins every album the original was in. What this computer keeps by the photo (hidden,
// labels, faces, the search index, kept offline, an album cover) moves to the copy. The
// original goes to the Drive trash last, and only once all of that is confirmed: a step
// that fails leaves both, never a photo dropped from an album.
//
// The queue is kept on disk with each photo's stage and its copy, so a restart carries on
// where it stopped without a second upload. What a copy goes up as (its name and content hash)
// is saved before it is sent, so a job cut off before the copy could be recorded (a lock, a
// crash) finds that copy on Drive and finishes with it instead of sending another. One photo
// at a time: an original is held whole in memory while its copy is made.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { webcrypto } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

import { ThumbnailType } from "@protontech/drive-sdk";

import { downloadToBuffer } from "./editor.ts";
import { embedCaptureDate } from "./embedDate.ts";
import { embedGps, validPlace, type GpsPlace } from "./embedGps.ts";
import { applyMeta, canEditMeta, parseMetaChange, readTextMeta, type MetaChange, type TextMeta } from "./metaEdit.ts";
import { downloadWhole } from "./viewerMeta.ts";
import { dateFromName } from "./nameDate.ts";
import { activeRevisionOf, nodeLocation, nodeName, toMillis } from "./nodes.ts";
import { isStall, SDK_STALL_MS, StallError, withStallGuard } from "./stallGuard.ts";
import { readSealedOrSetAside, StoreLockedError, storeDir, writeSealedAtomic } from "./store.ts";

/**
 * One photo and what it should have: a capture time (0 keeps its own), a place (left out keeps
 * its own, null takes it away), and a metadata change (description and copyright, or private
 * metadata taken out), all written into the one copy.
 */
export type DateEditItem = { uid: string; captureMs: number; place?: GpsPlace | null; meta?: MetaChange };

/** How far a photo got: its copy uploaded, in its albums, and what this computer keeps moved. */
export type Stage = "queued" | "uploaded" | "joined" | "carried";

/**
 * A copy as it is being sent, saved before the upload starts: the name and content hash Drive
 * finds it by, and what the job records once it is up.
 */
export type SentCopy = {
  name: string;
  sha1: string;
  albums: string[];
  tags: number[];
  expectMs: number;
  /** Bytes the copy saves (Compress on Drive). */
  saved?: number;
};

/** A photo on its way to being replaced by a copy, as far as it got. */
export type Replacement = {
  uid: string;
  stage: Stage;
  newUid?: string;
  albums?: string[];
  tags?: number[];
  /** The capture time the copy went up with, which it must show. */
  expectMs?: number;
  /** How many times the rest of the replacement failed after its copy went up. */
  attempts?: number;
  /** A copy sent, or being sent, that the job has not recorded as up yet. */
  sent?: SentCopy;
};

/**
 * A photo in the queue. Its metadata changes are kept merged, at most one strip and one text
 * change, applied in that order, so a second request for a photo still waiting adds to the
 * first rather than replacing it.
 */
type QueueEntry = Omit<DateEditItem, "meta"> & Replacement & { meta?: MetaChange[] };

/** Why a photo was not taken in, for the window to word: `busy` is one already being replaced. */
export type DateEditErrorCode = "busy";

export type DateEditStatus = {
  running: boolean;
  total: number;
  done: number;
  changed: number;
  unchanged: number;
  failed: number;
  /** The photos that could not be changed and why, newest last. */
  errors: { uid: string; error: string; code?: DateEditErrorCode }[];
  cancelled: boolean;
};

/** What the date editor shows of a photo before anything is changed. */
export type DateEditInfo = {
  uid: string;
  name: string;
  captureMs: number;
  /** The date its file name records, or null. */
  nameMs: number | null;
  /** Where it was taken, latitude then longitude, or null. */
  place: [number, number] | null;
  /** Why it cannot be changed, or null when it can. */
  blocked: "live" | "type" | "read" | null;
};

/** What the session does for the queue: the Drive actions that touch this computer's own data too. */
export type DateEditDeps = {
  photos: any;
  addToAlbum: (albumUid: string, uids: string[]) => Promise<{ uid: string; ok: boolean }[]>;
  trash: (uids: string[]) => Promise<{ uid: string; ok: boolean; error?: string }[]>;
  /** Moves what this computer keeps by `oldUid` (hidden, labels, faces, search, offline, covers) to `newUid`. */
  carry: (oldUid: string, newUid: string) => Promise<void>;
};

const QUEUE_FILE = "date-edit.enc";

const META_REFUSED = {
  text: "Only JPEG and PNG photos can carry a description and copyright",
  strip: "Private metadata can only be removed from JPEG and PNG photos",
} as const;
const META_UNREADABLE = "The photo's metadata could not be read, so nothing was changed";
const BUSY = "This photo is still being changed. Try again when it is done.";

/** The largest photo whose file is read for the text panels and the viewer's details. */
export const META_READ_MAX_BYTES = 200 * 1024 * 1024;

/** The photos being replaced right now, by this editor or Compress on Drive: one replacement of a photo at a time. */
export const replacing = new Set<string>();

/** Each original a finished replacement moved to the trash, by the copy that took its place. */
export const replacedBy = new Map<string, string>();
const REPLACED_MAX = 5000;

const TRASHED = "This photo is in the Drive trash, so it was not changed";

/** How many times the rest of a replacement is tried once its copy is up, before the copy is taken back. */
export const FINISH_ATTEMPTS = 3;

/** Thrown when the copy a job follows to is being replaced right now: the job waits its turn. */
export class FollowBusy extends Error {}

function noteReplaced(oldUid: string, newUid: string): void {
  replacedBy.delete(oldUid);
  replacedBy.set(oldUid, newUid);
  if (replacedBy.size > REPLACED_MAX) replacedBy.delete(replacedBy.keys().next().value as string);
}

/**
 * The photo a job works on, read from Drive. When it is in the trash because a finished
 * replacement took its place, the job moves on to that copy (and to its copy, if that was
 * replaced in turn), and `e.uid` names the copy from then on. A photo in the trash that no
 * replacement here took the place of is refused.
 */
export async function liveOriginal(photos: any, e: { uid: string }): Promise<any> {
  let uid = e.uid;
  for (let hop = 0; hop < 16; hop++) {
    const next = replacedBy.get(uid);
    let node: any = null;
    try {
      node = await freshNode(photos, uid);
    } catch (err) {
      if (!next) throw err;
    }
    if (node && !node.trashTime) {
      if (uid !== e.uid) {
        if (replacing.has(uid)) throw new FollowBusy(BUSY);
        replacing.add(uid);
        e.uid = uid;
      }
      return node;
    }
    if (!next) {
      if (node) throw new Error(TRASHED);
      return node;
    }
    uid = next;
  }
  throw new Error(TRASHED);
}

/**
 * After the last failed try at finishing a replacement whose copy is up, the copy goes to the
 * trash so no second photo stays, what this computer keeps moved back to the original first
 * when it had been moved. A copy sent but never recorded as up is looked for on Drive and goes
 * the same way when it is there. A copy whose original is no longer there is kept. Answers the
 * error to report.
 */
export async function abandonCopy(deps: DateEditDeps, e: Replacement, why: string): Promise<string> {
  let copy = e.stage === "queued" ? undefined : e.newUid;
  if (e.stage === "queued" && e.sent) {
    try {
      copy = (await findSentCopy(deps.photos, e.uid, e.sent)) ?? undefined;
    } catch {
      return `${why}. A copy may have reached Drive and could not be looked for, so both may be kept`;
    }
  }
  if (!copy) return why;
  let original: any = null;
  try {
    original = await freshNode(deps.photos, e.uid);
  } catch {
    /* unreadable: treated as gone */
  }
  if (!original || original.trashTime) return `${why}. The copy is kept, as the original is no longer there`;
  try {
    if (e.stage === "carried") await deps.carry(copy, e.uid);
    const [trashed] = await deps.trash([copy]);
    if (trashed?.ok) return `${why}. The copy was moved to the trash and the original kept`;
  } catch {
    /* reported below */
  }
  return `${why}. The copy could not be moved to the trash, so both are kept`;
}

/**
 * The copy a job sent before it was cut off, when Drive holds it: a photo of the name and content
 * it went up with, not the original, out of the trash and showing the date it went up with. Null
 * when there is none, so the job sends one; throws when Drive cannot be asked, so it does not.
 */
export async function findSentCopy(photos: any, original: string, sent: SentCopy): Promise<string | null> {
  const found: string[] = await photos.findPhotoDuplicates(sent.name, async () => sent.sha1);
  for (const uid of found) {
    if (uid === original) continue;
    const node = await freshNode(photos, uid).catch(() => null);
    if (!node || node.trashTime) continue;
    if (sent.expectMs > 0 && !sameCapture(toMillis(node?.photo?.captureTime), sent.expectMs)) continue;
    return uid;
  }
  return null;
}

/** Records a copy as up: the job goes on to finishing the replacement with it. */
export function recordSent(e: Replacement & { saved?: number }, newUid: string, sent: SentCopy): void {
  e.newUid = newUid;
  e.albums = sent.albums;
  e.tags = sent.tags;
  e.expectMs = sent.expectMs;
  if (sent.saved !== undefined) e.saved = sent.saved;
  e.stage = "uploaded";
  delete e.sent;
}

/**
 * A job cut off after its copy was sent: when Drive holds that copy, it is recorded and saved,
 * and answers true. Answers false when there is nothing to pick up.
 */
export async function pickUpSentCopy(photos: any, e: Replacement & { saved?: number }, save: () => void): Promise<boolean> {
  if (e.stage !== "queued" || !e.sent) return false;
  const found = await findSentCopy(photos, e.uid, e.sent);
  if (!found) return false;
  recordSent(e, found, e.sent);
  save();
  process.stderr.write("[replace] picked up a copy sent before the job was cut off\n");
  return true;
}

/**
 * The session's actions as a job may use them: refused once the session is no longer the one the
 * job started under (locked, signed out, signed in again), and a step that ran across that is
 * refused too, so the job stops where it stands and nothing more is done under a session that
 * went away. `live` says whether it still is.
 */
export function guardedDeps<T extends DateEditDeps>(deps: T, live: () => boolean): T {
  const check = () => {
    if (!live()) throw new StoreLockedError();
  };
  const wrap =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      check();
      const out = await run(...args);
      check();
      return out;
    };
  return { ...deps, addToAlbum: wrap(deps.addToAlbum), trash: wrap(deps.trash), carry: wrap(deps.carry) };
}

/**
 * Keeps the progress the process holds over what was saved: a job whose copy went up while the store
 * was locked could not save that, and is picked up where it is held. The saved queue says which
 * jobs there are.
 */
export function withHeldProgress<T extends Replacement>(saved: T[], held: T[]): T[] {
  return saved.map((s) => held.find((h) => h.uid === s.uid) ?? s);
}

/** Saves the queue, or leaves it for the next save while the store is locked. */
export function persistUnlessLocked<T>(persist: (items: T[]) => void, items: T[]): void {
  try {
    persist(items);
  } catch (e) {
    if (!(e instanceof StoreLockedError)) throw e;
  }
}

/** Two times count as the same capture when they are within this of each other. */
const SAME_MS = 1000;

/** Two places count as the same within this many degrees (about ten centimetres). */
const SAME_DEGREES = 1e-6;

/** The file types whose own metadata can carry a new date (see `embedDate.ts`). */
const EMBEDDABLE = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
  "video/3gpp",
]);

export function sameCapture(a: number, b: number): boolean {
  return a > 0 && b > 0 && Math.abs(a - b) < SAME_MS;
}

/** Whether a photo at `held` (or nowhere) is already at `wanted` (or nowhere). */
export function samePlace(held: [number, number] | null, wanted: GpsPlace | null): boolean {
  if (!held || !wanted) return !held && !wanted;
  return Math.abs(held[0] - wanted.lat) < SAME_DEGREES && Math.abs(held[1] - wanted.lon) < SAME_DEGREES;
}

/** Whether an entry asks for anything: a new date, a place set or taken away, or a metadata change. */
export function asksForChange(item: { uid?: unknown; captureMs?: number; place?: GpsPlace | null; meta?: unknown } | null | undefined): boolean {
  if (!item || typeof item.uid !== "string") return false;
  const date = Number.isFinite(item.captureMs) && (item.captureMs as number) > 0;
  const place = item.place === null || validPlace(item.place);
  return date || place || metaChanges(item.meta).length > 0;
}

/** The metadata changes an entry holds, as one request or the merged list the queue keeps. */
export function metaChanges(raw: unknown): MetaChange[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.reduce<MetaChange[]>((merged, one) => {
    const change = parseMetaChange(one);
    return change ? mergeMeta(merged, change) : merged;
  }, []);
}

/**
 * `held` with `next` added: strip options are joined, a text field the later change names wins,
 * and a strip that takes the text out drops the text change made before it.
 */
export function mergeMeta(held: MetaChange[], next: MetaChange): MetaChange[] {
  let strip = held.find((m) => m.kind === "strip") as Extract<MetaChange, { kind: "strip" }> | undefined;
  let text = held.find((m) => m.kind === "text") as Extract<MetaChange, { kind: "text" }> | undefined;
  if (next.kind === "strip") {
    strip = strip
      ? { kind: "strip", location: strip.location || next.location, camera: strip.camera || next.camera, text: strip.text || next.text }
      : { ...next };
    if (next.text) text = undefined;
  } else {
    const fields: Partial<Record<"description" | "copyright" | "author", string>> = {};
    for (const key of ["description", "copyright", "author"] as const) {
      const value = next[key] ?? text?.[key];
      if (value !== undefined) fields[key] = value;
    }
    text = { kind: "text", ...fields };
  }
  return [...(strip ? [strip] : []), ...(text ? [text] : [])];
}

export function isLivePhoto(node: any): boolean {
  return !!node?.photo?.mainPhotoNodeUid || (node?.photo?.relatedPhotoNodeUids ?? []).length > 0;
}

export function canCarryDate(mediaType: string | null | undefined): boolean {
  return EMBEDDABLE.has(String(mediaType ?? "").toLowerCase().split(";")[0].trim());
}

/** The albums a node lists itself in. */
export function albumUidsOf(node: any): string[] {
  return [...new Set(((node?.photo?.albums ?? []) as any[]).map((a) => String(a?.nodeUid ?? "")).filter(Boolean))];
}

/** The tags `want` lists that `node` does not carry. */
export function missingTags(node: any, want: number[]): number[] {
  const has = new Set((node?.photo?.tags ?? []) as number[]);
  return want.filter((tag) => !has.has(tag));
}

/**
 * `ms` as the ISO string a camera would claim: its wall clock in this machine's zone, with that
 * zone's offset, the form Proton's clients read a claimed capture time in.
 */
export function claimedCaptureString(ms: number): string {
  const at = new Date(ms);
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/**
 * The original's claimed metadata with its camera capture time set to the new one: Proton's web
 * shows a photo's date from this claim before the plain capture time.
 */
export function withClaimedCaptureTime(claimed: any, captureMs: number): Record<string, unknown> {
  const base = claimed && typeof claimed === "object" ? claimed : {};
  const camera = base.Camera && typeof base.Camera === "object" ? base.Camera : {};
  return { ...base, Camera: { ...camera, CaptureTime: claimedCaptureString(captureMs) } };
}

/** The original's claimed metadata with the place and the device taken out, as `strip` asks. */
export function withClaimedStrip(claimed: any, strip: { location: boolean; camera: boolean }): Record<string, unknown> {
  const base: Record<string, unknown> = claimed && typeof claimed === "object" ? { ...claimed } : {};
  if (strip.location) {
    delete base.Location;
    delete base.location;
  }
  if ((strip.location || strip.camera) && base.Camera && typeof base.Camera === "object") {
    const camera = { ...(base.Camera as Record<string, unknown>) };
    if (strip.camera) delete camera.Device;
    if (strip.location) delete camera.SubjectCoordinates;
    base.Camera = camera;
  }
  return base;
}

/** The original's claimed metadata with the place set, or taken away for null. */
export function withClaimedPlace(claimed: any, place: GpsPlace | null): Record<string, unknown> {
  const base: Record<string, unknown> = claimed && typeof claimed === "object" ? { ...claimed } : {};
  delete base.Location;
  delete base.location;
  return place ? { ...base, Location: { Latitude: place.lat, Longitude: place.lon } } : base;
}

/** Reads a node from Drive again rather than from the SDK's cache, which a write made here leaves stale. */
export async function freshNode(photos: any, uid: string): Promise<any> {
  const access = photos?.nodes?.access;
  if (typeof access?.notifyNodeChanged === "function") {
    try {
      await access.notifyNodeChanged(uid);
    } catch {
      /* the read below still answers, perhaps from the cache */
    }
  }
  return photos.getNode(uid);
}

/** The thumbnails the original carries, so the copy shows the same pictures. Best-effort. */
export async function storedThumbnails(photos: any, uid: string): Promise<any[]> {
  const out: any[] = [];
  try {
    for (const type of [ThumbnailType.Type1, ThumbnailType.Type2]) {
      for await (const r of withStallGuard(photos.iterateThumbnails([uid], type), SDK_STALL_MS, "iterateThumbnails")) {
        const result = r as any;
        if (result.ok) out.push({ type, thumbnail: result.thumbnail });
      }
    }
  } catch {
    /* uploaded without the one that failed; Drive makes its own */
  }
  return out;
}

/** Nodes read per `iterateNodes` call by the date editor's listing. */
const INFO_BATCH = 200;

/** One photo's row in the editor, from its node. */
function infoOf(uid: string, node: any): DateEditInfo {
  const name = nodeName(node);
  return {
    uid,
    name,
    captureMs: toMillis(node?.photo?.captureTime),
    nameMs: name ? dateFromName(name) : null,
    place: nodeLocation(node),
    blocked: isLivePhoto(node) ? "live" : canCarryDate(node?.mediaType) ? null : "type",
  };
}

const unread = (uid: string): DateEditInfo => ({ uid, name: "", captureMs: 0, nameMs: null, place: null, blocked: "read" });

/** `photos.getNode`, given up on after `stallMs`. */
async function oneNode(photos: any, uid: string, stallMs: number): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StallError("getNode(dateEdit)", stallMs)), stallMs);
  });
  const read = Promise.resolve().then(() => photos.getNode(uid));
  read.catch(() => {}); // abandoned when the stall wins
  try {
    return await Promise.race([read, stall]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the editor shows of each photo: its name, date, the date its name records, and whether it can change.
 *
 * Read a few hundred nodes at a time through `iterateNodes`, as the map and the downloads do. One
 * `getNode` after another took minutes over a Fix dates selection of a couple of thousand photos, and one
 * that never answered held the panel on "Reading the photos" for good. A batch that fails leaves only
 * its unread photos to `getNode`, each under the same stall guard. Once anything stalls the SDK is not
 * answering, and every photo not read yet is shown as one that could not be read: waiting out each
 * batch in turn would outlast the host's wait for the answer.
 */
export async function dateEditInfo(photos: any, uids: string[], stallMs = SDK_STALL_MS): Promise<DateEditInfo[]> {
  const found = new Map<string, DateEditInfo>();
  let wedged = false;
  for (let at = 0; at < uids.length && !wedged; at += INFO_BATCH) {
    const batch = uids.slice(at, at + INFO_BATCH);
    try {
      for await (const node of withStallGuard(photos.iterateNodes(batch), stallMs, "iterateNodes(dateEdit)")) {
        const n = node as any;
        if (n?.missingUid) found.set(n.missingUid, unread(n.missingUid));
        else if (n?.uid) found.set(n.uid, infoOf(n.uid, n));
      }
    } catch (e) {
      if (isStall(e)) wedged = true;
      process.stderr.write(`[dateedit] a batch of ${batch.length} could not be read together: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    for (const uid of batch) {
      if (found.has(uid) || wedged) continue;
      try {
        const node = await oneNode(photos, uid, stallMs);
        found.set(uid, node ? infoOf(uid, node) : unread(uid));
      } catch (e) {
        if (isStall(e)) wedged = true;
        found.set(uid, unread(uid));
      }
    }
  }
  if (wedged) process.stderr.write(`[dateedit] Drive stopped answering; ${uids.length - found.size} photos shown as unread\n`);
  return uids.map((uid) => found.get(uid) ?? unread(uid));
}

/** What the description and strip panels, and the viewer's details, show of a photo. */
export type MetaInfo = {
  uid: string;
  name: string;
  /** What is held in the file, or null when it was not read or has none of it. */
  text: TextMeta | null;
  /** Why it cannot be changed, or null when it can. */
  blocked: "live" | "type" | "read" | null;
};

/** The text read from files already looked at: a photo's revision never changes, a replacement is a new uid. */
const textCache = new Map<string, TextMeta | null>();
const TEXT_CACHE_MAX = 32;

/**
 * Each photo's name and whether a description, copyright or strip can be written into it. With
 * `read`, the text its file holds as well (one photo only: the file is downloaded to read it).
 */
export async function metaInfo(photos: any, uids: string[], read: boolean): Promise<MetaInfo[]> {
  const out: MetaInfo[] = [];
  for (const uid of uids) {
    try {
      const node = await photos.getNode(uid);
      const blocked = isLivePhoto(node) ? "live" : canEditMeta(node?.mediaType) ? null : "type";
      let text: TextMeta | null = null;
      if (read && !blocked) {
        if (textCache.has(uid)) text = textCache.get(uid) ?? null;
        else {
          // A file too large to read whole, or one that cannot be read, shows no text.
          const bytes = await downloadWhole(photos, uid, META_READ_MAX_BYTES);
          text = bytes ? readTextMeta(bytes) : null;
          if (textCache.size >= TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value as string);
          textCache.set(uid, text);
        }
      }
      out.push({ uid, name: nodeName(node), text, blocked });
    } catch {
      out.push({ uid, name: "", text: null, blocked: "read" });
    }
  }
  return out;
}

/**
 * One photo, from the stage it reached. Answers "unchanged" when Drive already shows its date.
 * Throws with the reason a step failed; the original is then still in place.
 */
export async function replaceOne(deps: DateEditDeps, e: QueueEntry, save: () => void): Promise<"changed" | "unchanged"> {
  const { photos } = deps;
  await pickUpSentCopy(photos, e, save);
  if (e.stage === "queued") {
    // Read from Drive, not the SDK's cache: a favourite or an album another device gave the photo since this
    // app last read it must ride along to the copy, or trashing the original loses it.
    const node = await liveOriginal(photos, e);
    if (isLivePhoto(node)) throw new Error("A Live Photo's picture and video are dated together, so neither is changed alone");
    const heldMs = toMillis(node?.photo?.captureTime);
    const newDate = e.captureMs > 0 && !sameCapture(heldMs, e.captureMs);
    const newPlace = e.place !== undefined && !samePlace(nodeLocation(node), e.place);
    const metas = metaChanges(e.meta);
    const strip = metas.find((m) => m.kind === "strip") as Extract<MetaChange, { kind: "strip" }> | undefined;
    if (!newDate && !newPlace && metas.length === 0) return "unchanged";
    const captureMs = newDate ? e.captureMs : heldMs;
    const name = nodeName(node);
    const mediaType = node?.mediaType;
    if (!name || !mediaType) throw new Error("The photo could not be read");
    if ((newDate || newPlace) && !canCarryDate(mediaType)) throw new Error("This file type cannot carry a new date");
    if (metas.length > 0 && !canEditMeta(mediaType)) throw new Error(META_REFUSED[metas[0]!.kind]);

    const revision = activeRevisionOf(node);
    const original = await downloadToBuffer(photos, e.uid);
    let embedded: { bytes: Buffer; how: string } | null =
      newDate || newPlace ? correctedBytes(original, newDate, captureMs, newPlace ? (e.place ?? null) : undefined) : { bytes: original, how: "meta" };
    if (!embedded) throw new Error("This file type cannot carry a new date");
    if (metas.length > 0) {
      let edited = embedded.bytes;
      for (const meta of metas) {
        const next = applyMeta(edited, meta);
        if (!next) throw new Error(META_UNREADABLE);
        edited = next;
      }
      // A strip of what Drive holds beside the file (its place, its device) is a change even when the file had none of it.
      const claimStripped = !!strip && claimChangedByStrip(revision?.claimedAdditionalMetadata, strip);
      if (!newDate && !newPlace && edited === embedded.bytes && !claimStripped) return "unchanged";
      // The file itself unchanged: its own date written in keeps its bytes from being taken for the original's.
      if (!newDate && !newPlace && edited === original) edited = embedCaptureDate(edited, captureMs)?.bytes ?? edited;
      embedded = { bytes: edited, how: `${embedded.how}+${metas.map((m) => m.kind).join("+")}` };
    }
    const bytes = embedded.bytes;
    const digestInput = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    const sha1 = Buffer.from(await webcrypto.subtle.digest("SHA-1", digestInput)).toString("hex");
    const modified = toMillis(revision?.claimedModificationTime);
    const tags = ((node?.photo?.tags ?? []) as number[]).slice();
    const sent: SentCopy = { name, sha1, albums: albumUidsOf(node), tags, expectMs: captureMs };
    e.sent = sent;
    save();
    const uploader = await photos.getFileUploader(
      name,
      {
        mediaType,
        expectedSize: bytes.byteLength,
        expectedSha1: sha1,
        ...(modified > 0 ? { modificationTime: new Date(modified) } : {}),
        ...(captureMs > 0 ? { captureTime: new Date(captureMs) } : {}),
        tags,
        additionalMetadata: claimFor(revision?.claimedAdditionalMetadata, newDate, captureMs, newPlace ? (e.place ?? null) : undefined, strip ?? null),
      },
      new AbortController().signal,
    );
    const stream = Readable.toWeb(Readable.from(bytes)) as any;
    const controller = await uploader.uploadFromStream(stream, await storedThumbnails(photos, e.uid));
    const { nodeUid } = await controller.completion();
    if (!nodeUid || nodeUid === e.uid) throw new Error("Drive did not keep a new copy");
    recordSent(e, nodeUid, sent);
    save();
    process.stderr.write(`[dateedit] uploaded a corrected copy (${embedded.how})\n`);
  }

  await finishReplacement(deps, e, save);
  return "changed";
}

/**
 * The rest of a replacement once its copy is up: the copy checked and given the original's tags,
 * added to every album the original was in, what this computer keeps moved to it, and the
 * original moved to the Drive trash last. Throws with the reason a step failed, the original kept.
 */
export async function finishReplacement(deps: DateEditDeps, e: Replacement & { captureMs?: number }, save: () => void): Promise<void> {
  const { photos } = deps;
  const newUid = e.newUid!;
  if (e.stage === "uploaded") {
    const copy = await freshNode(photos, newUid);
    const expectMs = e.expectMs ?? e.captureMs ?? 0;
    if (expectMs > 0 && !sameCapture(toMillis(copy?.photo?.captureTime), expectMs)) {
      throw new Error("The new copy did not get the new date; the original is kept");
    }
    const lacking = missingTags(copy, e.tags ?? []);
    if (lacking.length > 0) {
      for await (const r of withStallGuard(photos.updatePhotos([{ nodeUid: newUid, tagsToAdd: lacking, tagsToRemove: [] }]), SDK_STALL_MS, "updatePhotos")) {
        if (!(r as any).ok) throw new Error("The new copy could not be marked as the original was; the original is kept");
      }
    }
    const albums = e.albums ?? [];
    const joined = new Set(albumUidsOf(copy));
    for (const album of albums) {
      if (joined.has(album)) continue;
      const results = await deps.addToAlbum(album, [newUid]);
      if (!results.some((r) => r.ok)) {
        const why = (results.find((r) => !r.ok) as { error?: string } | undefined)?.error ?? "no answer";
        process.stderr.write(`[dateedit] album add refused: ${why}\n`);
        throw new Error("The new copy could not be added to one of its albums; the original is kept");
      }
    }
    if (albums.length > 0) {
      const check = albumUidsOf(await freshNode(photos, newUid));
      if (!albums.every((a) => check.includes(a))) throw new Error("The new copy is not in every album yet; the original is kept");
    }
    e.stage = "joined";
    save();
  }

  if (e.stage === "joined") {
    await deps.carry(e.uid, newUid);
    e.stage = "carried";
    save();
  }

  const [trashed] = await deps.trash([e.uid]);
  if (!trashed?.ok) {
    // Trashed already, by another device or an earlier try whose answer was lost: the replacement is through.
    const original = await freshNode(photos, e.uid).catch(() => null);
    if (!original?.trashTime) throw new Error("The original could not be moved to the trash; both are kept");
  }
  noteReplaced(e.uid, newUid);
}

/** An item as the window sent it, with only the fields that ask for something. */
function cleanItem(i: DateEditItem): QueueEntry {
  const out: QueueEntry = { uid: i.uid, captureMs: Number.isFinite(i.captureMs) && i.captureMs > 0 ? i.captureMs : 0, stage: "queued" };
  if (i.place === null) out.place = null;
  else if (validPlace(i.place)) out.place = { lat: i.place.lat, lon: i.place.lon };
  const meta = metaChanges(i.meta);
  if (meta.length > 0) out.meta = meta;
  return out;
}

/** Whether taking out what `strip` names changes the metadata Drive holds beside the file. */
export function claimChangedByStrip(claimed: any, strip: { location: boolean; camera: boolean }): boolean {
  const base = claimed && typeof claimed === "object" ? claimed : {};
  return JSON.stringify(withClaimedStrip(base, strip)) !== JSON.stringify(base);
}

/**
 * The bytes of the corrected copy: a new place written into a JPEG's EXIF (`place` undefined keeps
 * the file's own), and the date written in as well when it changes or when the file could not take
 * the place, which keeps its bytes from being taken for the original's. Null when the file cannot
 * carry what is asked.
 */
export function correctedBytes(
  original: Buffer,
  newDate: boolean,
  captureMs: number,
  place: GpsPlace | null | undefined,
): { bytes: Buffer; how: string } | null {
  const placed = place !== undefined ? embedGps(original, place) : null;
  if (!newDate && placed) return { bytes: placed, how: "gps" };
  if (!(captureMs > 0)) return null;
  return embedCaptureDate(placed ?? original, captureMs);
}

/** The claimed metadata the corrected copy goes up with: the new date's claim and the new place. */
export function correctedClaim(
  claimed: any,
  newDate: boolean,
  captureMs: number,
  place: GpsPlace | null | undefined,
): Record<string, unknown> {
  const dated = newDate ? withClaimedCaptureTime(claimed, captureMs) : claimed && typeof claimed === "object" ? claimed : {};
  return place !== undefined ? withClaimedPlace(dated, place) : dated;
}

/** The claimed metadata for a copy: the date and place claims, then what a strip takes out. */
function claimFor(
  claimed: any,
  newDate: boolean,
  captureMs: number,
  place: GpsPlace | null | undefined,
  strip: { location: boolean; camera: boolean } | null,
): Record<string, unknown> {
  const base = correctedClaim(claimed, newDate, captureMs, place);
  return strip ? withClaimedStrip(base, strip) : base;
}

/** The queue as saved: what is left to do, each photo with the stage it reached. */
function readQueue(): QueueEntry[] {
  const raw = readSealedOrSetAside(join(storeDir(), QUEUE_FILE));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as { v: 1; items: QueueEntry[] };
    return Array.isArray(parsed?.items)
      ? parsed.items.filter((i) => asksForChange(i)).map((i) => ({ ...i, captureMs: i.captureMs > 0 ? i.captureMs : 0, meta: metaChanges(i.meta) }))
      : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueueEntry[]): void {
  const path = join(storeDir(), QUEUE_FILE);
  if (items.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(storeDir(), { recursive: true });
  writeSealedAtomic(path, Buffer.from(JSON.stringify({ v: 1, items }), "utf8"));
}

const idle = (): DateEditStatus => ({ running: false, total: 0, done: 0, changed: 0, unchanged: 0, failed: 0, errors: [], cancelled: false });

/** Runs the date changes one photo after another, kept on disk until each is through. */
export class DateEditor {
  private status: DateEditStatus = idle();
  private queue: QueueEntry[] = [];
  private running: Promise<void> | null = null;
  /** The photo being replaced right now, whatever stage its entry still shows. */
  private current: string | null = null;
  private deps: DateEditDeps | null = null;
  /** Counts each attach and detach, so a job knows the session it started under is gone. */
  private attachment = 0;

  constructor(
    private readonly persist: (items: QueueEntry[]) => void = writeQueue,
    /** The wait before the rest of a replacement whose copy is up is tried again. */
    private readonly retryMs = 30_000,
  ) {}

  /**
   * Signed in: picks up a queue a restart or a lock cut short. A job this process took further than
   * the store could record while locked goes on from where it is held.
   */
  attach(deps: DateEditDeps, saved: QueueEntry[] = readQueue()): void {
    this.deps = deps;
    this.attachment++;
    if (saved.length > 0) {
      this.queue = withHeldProgress(saved, this.queue);
      this.status = { ...idle(), total: saved.length };
    }
    if (this.queue.length > 0) this.kick();
  }

  /** Signed out or locked: stops the current photo at its next step, keeping the queue on disk. */
  detach(): void {
    this.deps = null;
    this.attachment++;
  }

  getStatus(): DateEditStatus {
    return { ...this.status, errors: [...this.status.errors] };
  }

  /**
   * Adds photos to change. One still waiting takes the newer date and place, and its metadata
   * changes are merged with the new ones. One already being replaced is not changed again: it
   * is reported, and can be asked for once its copy is through.
   */
  start(items: DateEditItem[]): DateEditStatus {
    const fresh = items.filter((i) => asksForChange(i)).map(cleanItem);
    if (fresh.length === 0) return this.getStatus();
    if (!this.running && this.queue.length === 0) this.status = idle();
    for (const item of fresh) {
      const waiting = this.queue.find((q) => q.uid === item.uid);
      if (waiting && waiting.stage === "queued" && !waiting.sent && waiting.uid !== this.current) {
        if (item.captureMs > 0) waiting.captureMs = item.captureMs;
        if (item.place !== undefined) waiting.place = item.place;
        if (item.meta) waiting.meta = item.meta.reduce(mergeMeta, waiting.meta ?? []);
      } else if (waiting || item.uid === this.current || replacing.has(item.uid)) {
        this.status.total++;
        this.status.done++;
        this.status.failed++;
        this.status.errors.push({ uid: item.uid, error: BUSY, code: "busy" });
      } else {
        this.queue.push(item);
        this.status.total++;
      }
    }
    this.persist(this.queue);
    this.kick();
    return this.getStatus();
  }

  /** Drops the photos not started; the one in hand, and any already uploaded, are finished first. */
  stop(): DateEditStatus {
    if (!this.running) return this.getStatus();
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.stage !== "queued" || q.sent || q.uid === this.current);
    if (this.queue.length < before) {
      this.status.cancelled = true;
      this.persist(this.queue);
    }
    return this.getStatus();
  }

  private kick(): void {
    if (this.running || !this.deps) return;
    this.status.running = true;
    this.running = this.drain().finally(() => {
      this.running = null;
      this.status.running = false;
      // Attached again while the last run was still winding down: the queue goes on under the new session.
      if (this.deps && this.queue.length > 0) this.kick();
    });
  }

  private async drain(): Promise<void> {
    const attachment = this.attachment;
    while (this.queue.length > 0) {
      if (!this.deps || this.attachment !== attachment) return;
      const deps = guardedDeps(this.deps, () => this.attachment === attachment);
      const entry = this.queue[0]!;
      // A photo Compress on Drive is replacing goes on once that is through, onto its copy.
      if (replacing.has(entry.uid)) {
        this.queue.push(this.queue.shift()!);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const claimed = entry.uid;
      replacing.add(claimed);
      this.current = claimed;
      try {
        const outcome = await replaceOne(deps, entry, () => this.persist(this.queue));
        if (outcome === "changed") this.status.changed++;
        else this.status.unchanged++;
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        if (e instanceof FollowBusy) {
          this.queue.push(this.queue.shift()!);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        // Locked or signed out: the photo stays in the queue for the next sign-in, as far as it got.
        if (this.attachment !== attachment) {
          persistUnlessLocked(this.persist, this.queue);
          return;
        }
        // A job whose copy is up, or may be, is tried again rather than given up, so no second copy is sent.
        if (entry.stage !== "queued" || entry.sent) {
          entry.attempts = (entry.attempts ?? 0) + 1;
          if (entry.attempts < FINISH_ATTEMPTS) {
            process.stderr.write(`[dateedit] finishing a replacement failed, tried again later: ${message}\n`);
            this.queue.push(this.queue.shift()!);
            this.persist(this.queue);
            await new Promise((r) => setTimeout(r, this.retryMs));
            continue;
          }
        }
        const error = await abandonCopy(deps, entry, message);
        this.status.failed++;
        this.status.errors.push({ uid: claimed, error });
        process.stderr.write(`[dateedit] a photo was not changed: ${error}\n`);
      } finally {
        replacing.delete(claimed);
        replacing.delete(entry.uid);
        this.current = null;
      }
      this.status.done++;
      this.queue = this.queue.filter((q) => q !== entry);
      persistUnlessLocked(this.persist, this.queue);
    }
  }
}

export const dateEditor = new DateEditor();
