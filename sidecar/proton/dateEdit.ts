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

// Changing the capture date of photos already on Drive, the way the Android app does it.
//
// Drive keeps a photo's date in the revision it was uploaded with and allows no second
// revision, so a date is changed by a corrected copy: the original is downloaded, the new
// date is written into the file's own metadata (`embedDate.ts`, never touching the picture),
// the copy is uploaded with that date, its tags and the original's other metadata, and it
// joins every album the original was in. What this computer keeps by the photo (hidden,
// labels, faces, the search index, kept offline, an album cover) moves to the copy. The
// original goes to the Drive trash last, and only once all of that is confirmed: a step
// that fails leaves both, never a photo dropped from an album.
//
// The queue is kept on disk with each photo's stage and its copy, so a restart carries on
// where it stopped without a second upload. One photo at a time: an original is held whole
// in memory while its copy is made.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { webcrypto } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

import { ThumbnailType } from "@protontech/drive-sdk";

import { downloadToBuffer } from "./editor.ts";
import { embedCaptureDate } from "./embedDate.ts";
import { dateFromName } from "./nameDate.ts";
import { activeRevisionOf, nodeName, toMillis } from "./nodes.ts";
import { SDK_STALL_MS, withStallGuard } from "./stallGuard.ts";
import { readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

/** One photo and the capture time it should have. */
export type DateEditItem = { uid: string; captureMs: number };

/** How far a photo got: its copy uploaded, in its albums, and what this computer keeps moved. */
type Stage = "queued" | "uploaded" | "joined" | "carried";

type QueueEntry = DateEditItem & { stage: Stage; newUid?: string; albums?: string[]; tags?: number[] };

export type DateEditStatus = {
  running: boolean;
  total: number;
  done: number;
  changed: number;
  unchanged: number;
  failed: number;
  /** The photos that could not be changed and why, newest last. */
  errors: { uid: string; error: string }[];
  cancelled: boolean;
};

/** What the date editor shows of a photo before anything is changed. */
export type DateEditInfo = {
  uid: string;
  name: string;
  captureMs: number;
  /** The date its file name records, or null. */
  nameMs: number | null;
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

/** Two times count as the same capture when they are within this of each other. */
const SAME_MS = 1000;

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

/** Reads a node from Drive again rather than from the SDK's cache, which a write made here leaves stale. */
async function freshNode(photos: any, uid: string): Promise<any> {
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
async function storedThumbnails(photos: any, uid: string): Promise<any[]> {
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

/** What the editor shows of each photo: its name, date, the date its name records, and whether it can change. */
export async function dateEditInfo(photos: any, uids: string[]): Promise<DateEditInfo[]> {
  const out: DateEditInfo[] = [];
  for (const uid of uids) {
    try {
      const node = await photos.getNode(uid);
      const name = nodeName(node);
      out.push({
        uid,
        name,
        captureMs: toMillis(node?.photo?.captureTime),
        nameMs: name ? dateFromName(name) : null,
        blocked: isLivePhoto(node) ? "live" : canCarryDate(node?.mediaType) ? null : "type",
      });
    } catch {
      out.push({ uid, name: "", captureMs: 0, nameMs: null, blocked: "read" });
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
  if (e.stage === "queued") {
    // Read from Drive, not the SDK's cache: a favourite or an album another device gave the photo since this
    // app last read it must ride along to the copy, or trashing the original loses it.
    const node = await freshNode(photos, e.uid);
    if (isLivePhoto(node)) throw new Error("A Live Photo's picture and video are dated together, so neither is changed alone");
    if (sameCapture(toMillis(node?.photo?.captureTime), e.captureMs)) return "unchanged";
    const name = nodeName(node);
    const mediaType = node?.mediaType;
    if (!name || !mediaType) throw new Error("The photo could not be read");
    if (!canCarryDate(mediaType)) throw new Error("This file type cannot carry a new date");

    const revision = activeRevisionOf(node);
    const original = await downloadToBuffer(photos, e.uid);
    const embedded = embedCaptureDate(original, e.captureMs);
    if (!embedded) throw new Error("This file type cannot carry a new date");
    const bytes = embedded.bytes;
    const digestInput = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    const sha1 = Buffer.from(await webcrypto.subtle.digest("SHA-1", digestInput)).toString("hex");
    const modified = toMillis(revision?.claimedModificationTime);
    const tags = ((node?.photo?.tags ?? []) as number[]).slice();
    const uploader = await photos.getFileUploader(
      name,
      {
        mediaType,
        expectedSize: bytes.byteLength,
        expectedSha1: sha1,
        ...(modified > 0 ? { modificationTime: new Date(modified) } : {}),
        captureTime: new Date(e.captureMs),
        tags,
        additionalMetadata: withClaimedCaptureTime(revision?.claimedAdditionalMetadata, e.captureMs),
      },
      new AbortController().signal,
    );
    const stream = Readable.toWeb(Readable.from(bytes)) as any;
    const controller = await uploader.uploadFromStream(stream, await storedThumbnails(photos, e.uid));
    const { nodeUid } = await controller.completion();
    if (!nodeUid || nodeUid === e.uid) throw new Error("Drive did not keep a new copy");
    e.newUid = nodeUid;
    e.albums = albumUidsOf(node);
    e.tags = tags;
    e.stage = "uploaded";
    save();
    process.stderr.write(`[dateedit] uploaded a corrected copy (${embedded.how})\n`);
  }

  const newUid = e.newUid!;
  if (e.stage === "uploaded") {
    const copy = await freshNode(photos, newUid);
    if (!sameCapture(toMillis(copy?.photo?.captureTime), e.captureMs)) {
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
      if (!results.some((r) => r.ok)) throw new Error("The new copy could not be added to one of its albums; the original is kept");
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
  if (!trashed?.ok) throw new Error("The original could not be moved to the trash; both are kept");
  return "changed";
}

/** The queue as saved: what is left to do, each photo with the stage it reached. */
function readQueue(): QueueEntry[] {
  const raw = readSealedOrDiscard(join(storeDir(), QUEUE_FILE));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as { v: 1; items: QueueEntry[] };
    return Array.isArray(parsed?.items) ? parsed.items.filter((i) => typeof i?.uid === "string" && i.captureMs > 0) : [];
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
  private cancel = false;
  private deps: DateEditDeps | null = null;

  /** Signed in: picks up a queue a restart cut short. */
  attach(deps: DateEditDeps): void {
    this.deps = deps;
    const saved = readQueue();
    if (saved.length === 0) return;
    this.queue = saved;
    this.status = { ...idle(), total: saved.length };
    this.kick();
  }

  /** Signed out or locked: stops after the current photo, keeping the queue on disk. */
  detach(): void {
    this.cancel = true;
    this.deps = null;
  }

  getStatus(): DateEditStatus {
    return { ...this.status, errors: [...this.status.errors] };
  }

  /** Adds photos to change; one already waiting takes the newer date. */
  start(items: DateEditItem[]): DateEditStatus {
    const fresh = items.filter((i) => typeof i?.uid === "string" && Number.isFinite(i.captureMs) && i.captureMs > 0);
    if (fresh.length === 0) return this.getStatus();
    if (!this.running) this.status = idle();
    for (const item of fresh) {
      const waiting = this.queue.find((q) => q.uid === item.uid);
      if (waiting && waiting.stage === "queued") waiting.captureMs = item.captureMs;
      else if (!waiting) {
        this.queue.push({ uid: item.uid, captureMs: item.captureMs, stage: "queued" });
        this.status.total++;
      }
    }
    writeQueue(this.queue);
    this.kick();
    return this.getStatus();
  }

  /** Stops after the photo in hand; the ones not started are dropped. A photo already uploaded is finished first. */
  stop(): DateEditStatus {
    if (!this.running) return this.getStatus();
    this.cancel = true;
    return this.getStatus();
  }

  private kick(): void {
    if (this.running || !this.deps) return;
    this.cancel = false;
    this.status.running = true;
    this.running = this.drain().finally(() => {
      this.running = null;
      this.status.running = false;
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const deps = this.deps;
      if (!deps) return;
      const entry = this.queue[0];
      if (this.cancel && entry.stage === "queued") {
        this.status.cancelled = true;
        this.queue = this.queue.filter((q) => q.stage !== "queued");
        writeQueue(this.queue);
        continue;
      }
      try {
        const outcome = await replaceOne(deps, entry, () => writeQueue(this.queue));
        if (outcome === "changed") this.status.changed++;
        else this.status.unchanged++;
      } catch (e) {
        this.status.failed++;
        this.status.errors.push({ uid: entry.uid, error: (e as Error)?.message ?? String(e) });
        process.stderr.write(`[dateedit] a photo was not changed: ${(e as Error)?.message ?? e}\n`);
      }
      this.status.done++;
      this.queue.shift();
      writeQueue(this.queue);
    }
  }
}

export const dateEditor = new DateEditor();
