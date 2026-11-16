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

// The duplicate finder, as the phone has it. Identical copies are photos whose content hash
// is the same: the server keeps one per photo, a keyed hash of its bytes, and hands it out with
// the timeline listing, so they cost nothing to find. Similar photos are found by the
// fingerprint in pdq.ts, made from each photo's small thumbnail and kept sealed on disk, so
// only new photos are read again. A photo that is an identical copy is shown under Identical
// only.
//
// The rule that stands between the user and a photo they would lose lives here, not in the
// window: only the copies of a group the finder itself holds right now can be moved to the
// trash, and of a group with copies kept, a kept one must still be there.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  ALGO_VERSION,
  COLOR_BYTES,
  HASH_WORDS,
  clusterSimilarAsync,
  colorDistance,
  distance,
  fingerprintFromPixels,
  isUsable,
  looksLikePage,
  matches,
  PAGE_MATCH_THRESHOLD,
  type Fingerprint,
} from "./pdq.ts";
import { DUPLICATES_FILE, readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

/**
 * identical: the same file. same: the same picture taken at the same moment, in another file (an
 * export, a copy with its metadata stripped). burst: shots seconds apart of one scene. similar:
 * the rest that look alike.
 */
export type DuplicateKind = "identical" | "same" | "burst" | "similar";
/**
 * A group's copies, oldest first, with each one's capture time in milliseconds. `keep` is the
 * copy to keep when there is one to prefer: of one photo or video in several files, the largest,
 * the one a lighter copy was made from.
 */
export type DuplicateGroup = { key: string; kind: DuplicateKind; uids: string[]; times: number[]; keep?: number };
/** What the finder asks about the copies it groups as one photo: file size and a video's length. */
export type CopyDetails = { uid: string; size: number | null; durationMs: number | null };
export type DuplicateGroups = {
  identical: DuplicateGroup[];
  same: DuplicateGroup[];
  burst: DuplicateGroup[];
  similar: DuplicateGroup[];
  ignored: DuplicateGroup[];
};
/** The groups to show, and whether they have been worked out yet. */
export type ShownGroups = DuplicateGroups & { ready: boolean };

export type DuplicateState = "idle" | "scanning" | "done" | "failed";
export type DuplicateStatus = {
  state: DuplicateState;
  /** Photos fingerprinted or found unreadable, of the library's. */
  done: number;
  total: number;
  /** Goes up whenever the groups may have changed, so the window knows to read them again. */
  version: number;
};

export type DuplicateSource = {
  /**
   * The whole library, with each photo's capture time and whether it is a video; reading it
   * refreshes the content hashes.
   */
  list(): Promise<{ uid: string; captureTime: number; video?: boolean }[]>;
  /** The small thumbnails of these photos; null for one that has none. A photo left out is asked for again. */
  thumbnails(uids: string[]): AsyncIterable<{ uid: string; bytes: Buffer | null }>;
  /** Sizes and video lengths of these photos; one it cannot answer for is left out. */
  details?(uids: string[]): Promise<CopyDetails[]>;
};

export type TrashOutcome = { uid: string; ok: boolean };

/** Photos read per round of the scan. */
const BATCH = 24;
/** The scan rests this long between rounds, so the grid's own thumbnails go first. */
const REST_MS = 150;
/** Fingerprints made between two saves. */
const SAVE_EVERY = 240;
const RECORD_BYTES = HASH_WORDS * 4 + 1 + COLOR_BYTES;

/** The key a group is remembered by: its copies, sorted, so the order shown does not matter. */
export const groupKey = (uids: string[]): string => [...uids].sort().join("|");

/**
 * The copies of one group that may go, given the ones the user keeps and those already gone,
 * or none at all when no kept copy is still there. Two cards can hold the same two photos
 * (an identical pair is also alike), so a keeper already taken by another card does not count.
 */
export function deletableExtras(group: string[], keep: Set<string>, gone: Set<string>): string[] {
  if (!group.some((u) => keep.has(u) && !gone.has(u))) return [];
  return group.filter((u) => !keep.has(u) && !gone.has(u));
}

/**
 * What goes when several groups go at once: whole groups (the user's explicit choice, every
 * copy) first, then each group with copies kept, each seeing what the ones before it took.
 * A group whose keeper is about to go with an earlier one then stands down instead of
 * taking its last copy.
 */
export function deletableAcross(
  partial: { uids: string[]; keep: Set<string> }[],
  whole: string[][],
  gone: Set<string>,
): string[] {
  const running = new Set(gone);
  const out: string[] = [];
  const take = (ids: string[]) => {
    for (const id of ids) {
      if (running.has(id)) continue;
      running.add(id);
      out.push(id);
    }
  };
  for (const uids of whole) take(uids);
  for (const { uids, keep } of partial) take(deletableExtras(uids, keep, running));
  return out;
}

/**
 * The groups the user leaves alone. A group stays ignored while all its copies belong to one
 * remembered group, so a copy moved to the trash leaves the rest ignored, while a new
 * look-alike brings the group back.
 */
export class IgnoredGroups {
  private readonly entries: Set<string>[];
  private readonly byMember = new Map<string, number[]>();

  constructor(readonly keys: string[]) {
    this.entries = keys.map((k) => new Set(k.split("|")));
    this.entries.forEach((ids, i) => {
      for (const id of ids) {
        const list = this.byMember.get(id);
        if (list) list.push(i);
        else this.byMember.set(id, [i]);
      }
    });
  }

  /** The remembered keys that cover this group. */
  covering(uids: string[]): string[] {
    const candidates = uids.length ? this.byMember.get(uids[0]) : undefined;
    if (!candidates) return [];
    return candidates.filter((i) => uids.every((u) => this.entries[i].has(u))).map((i) => this.keys[i]);
  }
}

type Saved = { v: 1; a: number; p: Record<string, string>; n: string[]; i: string[] };

function encode(fp: Fingerprint): string {
  const out = Buffer.alloc(RECORD_BYTES);
  for (let w = 0; w < HASH_WORDS; w++) out.writeUInt32LE(fp.bits[w] >>> 0, w * 4);
  out[HASH_WORDS * 4] = fp.quality;
  out.set(fp.color, HASH_WORDS * 4 + 1);
  return out.toString("base64");
}

function decodeRecord(text: string): Fingerprint | null {
  const raw = Buffer.from(text, "base64");
  if (raw.length !== RECORD_BYTES) return null;
  const bits = new Uint32Array(HASH_WORDS);
  for (let w = 0; w < HASH_WORDS; w++) bits[w] = raw.readUInt32LE(w * 4);
  return { bits, quality: raw[HASH_WORDS * 4], color: Uint8Array.from(raw.subarray(HASH_WORDS * 4 + 1)) };
}

/** The fingerprint of a thumbnail, turned upright and brought near the phone's 256 pixels. */
export async function fingerprintOf(bytes: Buffer | string): Promise<Fingerprint | null> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(bytes, { failOn: "none" })
    .rotate()
    .resize(256, 256, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return fingerprintFromPixels(data, info.width, info.height, info.channels);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = () => new Promise<void>((r) => setImmediate(r));

/** Two fingerprints this close are one picture: what a re-encode or a stripped header leaves. */
const SAME_DISTANCE = 12;
const SAME_COLOR = 12;
/**
 * How far apart two copies of one photo may be dated, beyond a whole-hour time-zone shift.
 * Capture times are whole seconds, so this is "the same second": two shots a second apart with
 * a blink between them are as close in look, and are a burst, not one photo twice.
 */
const SAME_WITHIN_MS = 999;
/** Time-zone shifts looked through for a copy dated in another zone. */
const SAME_HOUR_SHIFTS = 14;
/**
 * A photo with a look-alike this close in time is one of a series (a timelapse, a webcam, a
 * burst), and a frame of a series whole hours from it is another frame, not a copy in another zone.
 */
const SERIES_WITHIN_MS = 30 * 60_000;
/** Shots this close in time that look alike are a burst. */
const BURST_GAP_MS = 2_000;
/** The earlier shots a shot is compared with, at most, for a burst. */
const BURST_LOOK_BACK = 16;
/** Photos compared with one other at most, so thousands dated the same second stay cheap. */
const NEAR_MAX = 200;
/** Two videos starting this close, alike, of one length, are one video in two files. */
const VIDEO_SAME_MS = 2_000;
/** How far the lengths of two files of one video may differ: a re-encode can trim a frame or two. */
const VIDEO_LENGTH_SLACK_MS = 1_500;
/** Copies asked about per call. */
const DETAILS_BATCH = 200;
/** Files of one size and length beyond this many are a camera's padded segments, not copies. */
const SIZE_TWINS_MAX = 4;

/** While the scan runs, the groups are worked out again at most this often. */
const REGROUP_EVERY_MS = 15_000;
/** A change waits this long for the ones after it before the groups are worked out again. */
const REGROUP_AFTER_MS = 300;

export class DuplicateFinder {
  private source: DuplicateSource | null = null;
  /** Each photo's content hash, as the last timeline listing gave it. */
  private readonly contentHashes = new Map<string, string>();
  /** The content hash of each Live Photo's video, by its photo: the listing's related photos. */
  private readonly relatedHashes = new Map<string, string[]>();
  private prints = new Map<string, Fingerprint>();
  /** Photos with no thumbnail to read, or one that would not decode: not asked for again. */
  private unreadable = new Set<string>();
  private ignored: string[] = [];
  private loaded = false;
  /** The library as last listed: capture time by uid. */
  private library = new Map<string, number>();
  /** The library's videos, as last listed. */
  private videos = new Set<string>();
  /** Sizes and lengths asked about so far, by uid. */
  private readonly details = new Map<string, CopyDetails>();
  /** Moved to the trash this session, kept out of every group. */
  private readonly gone = new Set<string>();
  private status: DuplicateStatus = { state: "idle", done: 0, total: 0, version: 0 };
  private running: Promise<void> | null = null;
  private generation = 0;
  /**
   * The groups as last worked out, the ignored ones and the trashed copies still in. Working
   * them out compares fingerprints across the library, so it runs in the background, a slice
   * at a time, and asking for the groups always answers at once from here.
   */
  private computed: DuplicateGroup[] | null = null;
  private computedAt = 0;
  /** What the groups are made from changed since they were last worked out. */
  private stale = true;
  private computing: Promise<void> | null = null;
  private regroupTimer: ReturnType<typeof setTimeout> | null = null;
  private regroupDue = 0;
  private shown: { version: number; groups: ShownGroups } | null = null;

  constructor(
    private readonly fingerprint: (bytes: Buffer) => Promise<Fingerprint | null> = fingerprintOf,
    private readonly persist = true,
    private readonly restMs = REST_MS,
    private readonly regroupEveryMs = REGROUP_EVERY_MS,
  ) {}

  getStatus(): DuplicateStatus {
    return { ...this.status };
  }

  /** How many photos the last scan listed. */
  libraryCount(): number {
    return this.library.size;
  }

  /** Whether the groups are still to be worked out again for what is known now. */
  pending(): boolean {
    return this.stale || this.computing !== null || this.regroupTimer !== null;
  }

  /** The library to read, set on sign-in and cleared on sign-out or lock. */
  setSource(source: DuplicateSource | null): void {
    this.source = source;
    if (!source) {
      this.generation++;
      this.running = null;
      if (this.regroupTimer) clearTimeout(this.regroupTimer);
      this.regroupTimer = null;
      this.contentHashes.clear();
      this.relatedHashes.clear();
      this.library.clear();
      this.videos.clear();
      this.details.clear();
      this.gone.clear();
      this.prints.clear();
      this.unreadable.clear();
      this.ignored = [];
      this.loaded = false;
      this.computed = null;
      this.stale = true;
      this.status = { state: "idle", done: 0, total: 0, version: this.status.version + 1 };
    }
  }

  /**
   * Takes the content hashes out of one page of the timeline listing, as the server sent it.
   * `volumeId` is the one in the listing's address.
   */
  takeListing(volumeId: string, json: unknown): void {
    const photos = (json as { Photos?: unknown })?.Photos;
    if (!Array.isArray(photos)) return;
    for (const p of photos) {
      const link = (p as { LinkID?: unknown })?.LinkID;
      const hash = (p as { ContentHash?: unknown })?.ContentHash;
      if (typeof link !== "string") continue;
      const uid = `${volumeId}~${link}`;
      if (typeof hash === "string" && hash) this.contentHashes.set(uid, hash);
      else this.contentHashes.delete(uid);
      const related = (p as { RelatedPhotos?: unknown })?.RelatedPhotos;
      const hashes = Array.isArray(related)
        ? related.map((r) => (r as { ContentHash?: unknown })?.ContentHash).filter((h): h is string => typeof h === "string" && !!h)
        : [];
      if (hashes.length > 0) this.relatedHashes.set(uid, hashes);
      else this.relatedHashes.delete(uid);
    }
    this.inputsChanged();
  }

  /** Each library photo's content hash, as the last timeline listing gave it. */
  contentHashEntries(): [string, string][] {
    const related = [...this.relatedHashes].flatMap(([uid, hashes]) => hashes.map((h): [string, string] => [uid, h]));
    // A photo's own hash first, so a Live video's never stands in for a photo's own.
    return [...this.contentHashes, ...related];
  }

  /**
   * A library photo's fingerprint: the one the scan made, or one made now from its small
   * thumbnail, and kept, when the scan has not reached it. Null for one with no picture to read.
   */
  async printOf(uid: string): Promise<Fingerprint | null> {
    this.load();
    const known = this.prints.get(uid);
    if (known) return known;
    if (this.unreadable.has(uid) || !this.source) return null;
    for await (const { uid: got, bytes } of this.source.thumbnails([uid])) {
      if (got !== uid) continue;
      const fp = bytes ? await this.fingerprint(bytes).catch(() => null) : null;
      if (fp) this.prints.set(uid, fp);
      else this.unreadable.add(uid);
      return fp;
    }
    return null;
  }

  /** Photos moved to the trash anywhere in the app: no group holds them from now on. */
  removed(uids: string[]): void {
    for (const u of uids) this.gone.add(u);
    if (uids.length) this.bump();
  }

  /** Photos brought back from the trash. */
  restored(uids: string[]): void {
    let any = false;
    for (const u of uids) any = this.gone.delete(u) || any;
    if (any) this.bump();
  }

  /** Reads the library and fingerprints what is new; answers at once, the scan runs on. */
  start(): DuplicateStatus {
    if (!this.running && this.source) {
      const gen = ++this.generation;
      // Counted afresh: the last scan's "all done" would read as this one being through.
      this.status = { ...this.status, state: "scanning", done: 0, total: 0 };
      this.running = this.run(gen)
        .catch((e) => {
          if (gen !== this.generation) return;
          process.stderr.write(`[duplicates] scan failed: ${String((e as Error)?.message ?? e).slice(0, 120)}\n`);
          this.status = { ...this.status, state: "failed" };
          this.inputsChanged();
        })
        .finally(() => {
          if (gen === this.generation) this.running = null;
        });
    }
    return this.getStatus();
  }

  /** Waits for the scan running now and the groups it leaves, for tests. */
  async settled(): Promise<void> {
    await this.running;
    await this.current();
  }

  private bump(): void {
    this.status = { ...this.status, version: this.status.version + 1 };
  }

  private inputsChanged(): void {
    this.stale = true;
    this.scheduleRegroup();
  }

  private scheduleRegroup(): void {
    if (this.computing || !this.source) return;
    const wait =
      this.status.state === "scanning"
        ? Math.max(REGROUP_AFTER_MS, this.computedAt + this.regroupEveryMs - Date.now())
        : REGROUP_AFTER_MS;
    // A wait set while the scan ran gives way to the short one once it is through.
    if (this.regroupTimer) {
      if (Date.now() + wait >= this.regroupDue) return;
      clearTimeout(this.regroupTimer);
    }
    this.regroupDue = Date.now() + wait;
    this.regroupTimer = setTimeout(() => {
      this.regroupTimer = null;
      void this.regroup();
    }, wait);
  }

  private regroup(): Promise<void> {
    if (this.computing) return this.computing;
    const gen = this.generation;
    this.stale = false;
    this.computing = this.compute()
      .then((groups) => {
        if (gen !== this.generation) return;
        this.computed = groups;
        this.computedAt = Date.now();
        this.bump();
      })
      .catch((e) => {
        process.stderr.write(`[duplicates] grouping failed: ${String((e as Error)?.message ?? e).slice(0, 120)}\n`);
      })
      .finally(() => {
        this.computing = null;
        if (this.stale) this.scheduleRegroup();
      });
    return this.computing;
  }

  /** The groups worked out from everything known now, waiting for that if it is under way. */
  async current(): Promise<ShownGroups> {
    if (this.regroupTimer) {
      clearTimeout(this.regroupTimer);
      this.regroupTimer = null;
    }
    if (this.computing) await this.computing;
    if (this.stale) await this.regroup();
    return this.groups();
  }

  private async run(gen: number): Promise<void> {
    this.load();
    const source = this.source!;
    const listed = await source.list();
    if (gen !== this.generation) return;
    this.library = new Map(listed.map((p) => [p.uid, p.captureTime]));
    this.videos = new Set(listed.filter((p) => p.video).map((p) => p.uid));
    const todo = listed.map((p) => p.uid).filter((u) => !this.prints.has(u) && !this.unreadable.has(u));
    this.status = { ...this.status, total: listed.length, done: listed.length - todo.length };
    this.inputsChanged();
    let sinceSave = 0;
    for (let at = 0; at < todo.length; at += BATCH) {
      if (at > 0) await sleep(this.restMs);
      if (gen !== this.generation) return;
      for await (const { uid, bytes } of source.thumbnails(todo.slice(at, at + BATCH))) {
        if (gen !== this.generation) return;
        let fp: Fingerprint | null = null;
        if (bytes) fp = await this.fingerprint(bytes).catch(() => null);
        if (fp) this.prints.set(uid, fp);
        else this.unreadable.add(uid);
        this.status = { ...this.status, done: this.status.done + 1 };
        sinceSave++;
      }
      this.inputsChanged();
      if (sinceSave >= SAVE_EVERY) {
        this.save();
        sinceSave = 0;
      }
    }
    // Photos no longer in the library leave the file with this save.
    for (const uid of this.prints.keys()) if (!this.library.has(uid)) this.prints.delete(uid);
    for (const uid of this.unreadable) if (!this.library.has(uid)) this.unreadable.delete(uid);
    this.save();
    await this.learnVideoDetails(gen);
    if (gen !== this.generation) return;
    this.status = { ...this.status, state: "done" };
    this.inputsChanged();
  }

  /** Every group in the library as listed, ignored ones and this session's trash included. */
  private async compute(): Promise<DuplicateGroup[]> {
    const live = (u: string) => this.library.has(u);
    const timeOf = (u: string) => this.library.get(u) ?? 0;
    const byTime = (a: string, b: string) => timeOf(a) - timeOf(b) || (a < b ? -1 : 1);

    const byHash = new Map<string, string[]>();
    for (const [uid, hash] of this.contentHashes) {
      if (!live(uid)) continue;
      const list = byHash.get(hash);
      if (list) list.push(uid);
      else byHash.set(hash, [uid]);
    }
    const identical: DuplicateGroup[] = [];
    const inIdentical = new Set<string>();
    for (const uids of byHash.values()) {
      if (uids.length < 2) continue;
      uids.sort(byTime);
      uids.forEach((u) => inIdentical.add(u));
      identical.push({ key: groupKey(uids), kind: "identical", uids, times: uids.map(timeOf) });
    }

    // Every other photo with a picture to compare, in time order for the two passes that go by time.
    // A video is left to the look-alikes: a Live Photo's video beside its still, dated the same
    // second and opening on the same frame, is neither a copy nor a burst of it.
    const cand: { uid: string; fp: Fingerprint; t: number; video: boolean }[] = [];
    for (const [uid, fp] of this.prints) {
      if (!live(uid) || inIdentical.has(uid) || !isUsable(fp)) continue;
      cand.push({ uid, fp, t: timeOf(uid), video: this.videos.has(uid) });
    }
    cand.sort((a, b) => a.t - b.t || (a.uid < b.uid ? -1 : 1));
    const n = cand.length;
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const firstAt = (t: number) => {
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cand[mid].t < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const same = (i: number, j: number) =>
      distance(cand[i].fp.bits, cand[j].fp.bits) <= SAME_DISTANCE && colorDistance(cand[i].fp.color, cand[j].fp.color) <= SAME_COLOR;

    const placed = new Uint8Array(n);
    // Pages photographed one after another are not a burst: two pages join only when nearly
    // the same frame (a retake held steady).
    const pageLike = cand.map((c) => looksLikePage(c.fp));
    const burstLike = (i: number, j: number) =>
      matches(cand[i].fp, cand[j].fp) &&
      (!(pageLike[i] && pageLike[j]) || distance(cand[i].fp.bits, cand[j].fp.bits) <= PAGE_MATCH_THRESHOLD);
    const timed = (i: number) => cand[i].t > 0 && !cand[i].video;
    const burstOut: DuplicateGroup[] = [];
    /**
     * Shots of the photos not placed yet, each within seconds of an alike earlier one, joined;
     * those of at least `min` shots are bursts. Compared with several earlier shots, not only the
     * one before: another scene taken the same second sorts in between.
     */
    const bursts = async (min: number) => {
      for (let i = 0; i < n; i++) parent[i] = i;
      for (let i = 0; i < n; i++) {
        if (i % 2000 === 0) await pause();
        if (placed[i] || !timed(i)) continue;
        for (let j = i - 1, seen = 0; j >= 0 && cand[i].t - cand[j].t <= BURST_GAP_MS && seen < BURST_LOOK_BACK; j--) {
          if (placed[j] || !timed(j)) continue;
          seen++;
          if (burstLike(j, i)) parent[find(i)] = find(j);
        }
      }
      const runs = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        if (placed[i] || !timed(i)) continue;
        const r = find(i);
        const list = runs.get(r);
        if (list) list.push(i);
        else runs.set(r, [i]);
      }
      for (const run of runs.values()) {
        if (run.length < min) continue;
        run.forEach((i) => (placed[i] = 1));
        const uids = run.map((i) => cand[i].uid);
        burstOut.push({ key: groupKey(uids), kind: "burst", uids, times: uids.map(timeOf) });
      }
    };
    // Three shots or more first: frames of a still scene are as close as two copies of a photo,
    // and dated the same second, so they would otherwise pass for copies.
    await bursts(3);

    /**
     * Whether a photo has a look-alike within half an hour: one of a series, not a lone shot.
     * Looked for outward from it, nearest first, so a busy half hour cannot hide its neighbours.
     */
    const inSeries = (i: number) => {
      for (let j = i - 1, seen = 0; j >= 0 && cand[i].t - cand[j].t <= SERIES_WITHIN_MS && seen < NEAR_MAX; j--, seen++) {
        if (matches(cand[i].fp, cand[j].fp)) return true;
      }
      for (let j = i + 1, seen = 0; j < n && cand[j].t - cand[i].t <= SERIES_WITHIN_MS && seen < NEAR_MAX; j++, seen++) {
        if (matches(cand[i].fp, cand[j].fp)) return true;
      }
      return false;
    };

    // Same photo: one picture dated the same second, or whole hours apart (another time zone)
    // when neither is one of a series.
    for (let i = 0; i < n; i++) parent[i] = i;
    for (let i = 0; i < n; i++) {
      if (i % 2000 === 0) await pause();
      if (placed[i] || !timed(i)) continue;
      const t = cand[i].t;
      let lone: boolean | null = null;
      for (let k = 0; k <= SAME_HOUR_SHIFTS; k++) {
        const centre = t + k * 3_600_000;
        let j = k === 0 ? i + 1 : firstAt(centre - SAME_WITHIN_MS);
        for (let seen = 0; j < n && cand[j].t <= centre + SAME_WITHIN_MS && seen < NEAR_MAX; j++, seen++) {
          if (j === i || placed[j] || !timed(j) || !same(i, j)) continue;
          if (k > 0) {
            lone ??= !inSeries(i);
            if (!lone || inSeries(j)) continue;
          }
          parent[find(j)] = find(i);
        }
      }
    }
    const sameGroups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (placed[i] || !timed(i)) continue;
      const r = find(i);
      const list = sameGroups.get(r);
      if (list) list.push(i);
      else sameGroups.set(r, [i]);
    }
    const sameOut: DuplicateGroup[] = [];
    for (const members of sameGroups.values()) {
      if (members.length < 2) continue;
      members.forEach((i) => (placed[i] = 1));
      const uids = members.map((i) => cand[i].uid).sort(byTime);
      sameOut.push({ key: groupKey(uids), kind: "same", uids, times: uids.map(timeOf) });
    }

    // One video in several files. Sizes and lengths come from what the scan has learned; a video
    // not asked about yet is only matched by look and date, the strict way.
    const detail = (i: number) => this.details.get(cand[i].uid);
    const lengthOf = (i: number) => detail(i)?.durationMs ?? null;
    const joinVideos = (i: number, j: number) => {
      const ri = find(i);
      const rj = find(j);
      if (ri === rj) return;
      parent[rj] = ri;
    };
    for (let i = 0; i < n; i++) parent[i] = i;
    /**
     * Whether a video has a look-alike video within half an hour other than those in `twins`:
     * one of a series (a dashcam's segments, a timelapse), whose look-alikes are other clips.
     */
    const videoInSeries = (i: number, twins: (j: number) => boolean) => {
      const near = (j: number) => cand[j].video && !twins(j) && matches(cand[i].fp, cand[j].fp);
      for (let j = i - 1, seen = 0; j >= 0 && cand[i].t - cand[j].t <= SERIES_WITHIN_MS && seen < NEAR_MAX; j--, seen++) {
        if (near(j)) return true;
      }
      for (let j = i + 1, seen = 0; j < n && cand[j].t - cand[i].t <= SERIES_WITHIN_MS && seen < NEAR_MAX; j++, seen++) {
        if (near(j)) return true;
      }
      return false;
    };

    // First the strongest sign, whatever the dates say: the very same size in bytes and length,
    // and one first frame. That is one file with a few header bytes rewritten (a date, a tag).
    // A handful at most: a camera that pads every segment to one size makes many, and those are
    // other clips, as are members of a series.
    const bySize = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      if (placed[i] || !cand[i].video) continue;
      const d = detail(i);
      if (!d?.size || !d.durationMs) continue;
      const key = `${d.size}:${d.durationMs}`;
      const list = bySize.get(key);
      if (list) list.push(i);
      else bySize.set(key, [i]);
    }
    for (const list of bySize.values()) {
      if (list.length < 2 || list.length > SIZE_TWINS_MAX) continue;
      // Its own twins, and a lighter copy dated the same moment, are not a series.
      if (list.some((i) => videoInSeries(i, (j) => list.includes(j) || Math.abs(cand[j].t - cand[i].t) <= VIDEO_SAME_MS))) continue;
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) if (same(list[a], list[b])) joinVideos(list[a], list[b]);
      }
    }
    const settleVideos = () => {
      const groups = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        if (placed[i] || !cand[i].video) continue;
        const r = find(i);
        const list = groups.get(r);
        if (list) list.push(i);
        else groups.set(r, [i]);
      }
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        members.forEach((i) => (placed[i] = 1));
        const uids = members.map((i) => cand[i].uid).sort(byTime);
        const group: DuplicateGroup = { key: groupKey(uids), kind: "same", uids, times: uids.map(timeOf) };
        const keep = this.largestOf(uids);
        if (keep !== undefined) group.keep = keep;
        sameOut.push(group);
      }
      for (let i = 0; i < n; i++) parent[i] = i;
    };

    // Then by date, joined into the same groups as the twins above, so an original with a twin
    // and a lighter copy is one group of three: a lighter copy beside its original starts within seconds of it, or whole
    // hours off when one app wrote UTC and another local time. The two recordings overlap (one
    // camera does not film two clips at once) and their lengths differ by a trimmed frame or two.
    const slack = (a: number, b: number) => Math.min(VIDEO_LENGTH_SLACK_MS, Math.max(200, 0.02 * Math.max(a, b)));
    for (let i = 0; i < n; i++) {
      if (i % 2000 === 0) await pause();
      if (placed[i] || !cand[i].video || cand[i].t <= 0) continue;
      for (let k = 0; k <= SAME_HOUR_SHIFTS; k++) {
        const centre = cand[i].t + k * 3_600_000;
        let j = k === 0 ? i + 1 : firstAt(centre - VIDEO_SAME_MS);
        for (let seen = 0; j < n && cand[j].t <= centre + VIDEO_SAME_MS && seen < NEAR_MAX; j++, seen++) {
          if (j === i || placed[j] || !cand[j].video) continue;
          const a = lengthOf(i);
          const b = lengthOf(j);
          const off = Math.abs(cand[j].t - centre);
          // Recordings that overlap, the dates being whole seconds: a second off is rounding,
          // more than that must still leave the later one starting well inside the earlier.
          const overlap = (x: number, y: number) => off <= 1_000 || off < Math.min(x, y) - 1_000;
          let one: boolean;
          if (a === null || b === null) {
            // No length to go by: only the very same second, not hours off, and the strict look.
            one = k === 0 && off === 0 && same(i, j);
          } else if (k === 0) {
            one = overlap(a, b) && Math.abs(a - b) <= slack(a, b) && matches(cand[i].fp, cand[j].fp);
          } else {
            // Hours off: the strict look and length, and neither one of a series.
            const close = (x: number) => (y: number) => Math.abs(cand[y].t - cand[x].t) <= VIDEO_SAME_MS;
            one =
              overlap(a, b) &&
              Math.abs(a - b) <= 200 &&
              same(i, j) &&
              !videoInSeries(i, close(i)) &&
              !videoInSeries(j, close(j));
          }
          if (one) joinVideos(i, j);
        }
      }
    }
    settleVideos();

    // Two shots seconds apart that are not one photo twice.
    await bursts(2);

    // Similar: what is left, by look alone.
    const rest = cand.filter((_, i) => !placed[i]);
    const roots = await clusterSimilarAsync(
      rest.map((c) => c.fp),
      pause,
    );
    const byRoot = new Map<number, string[]>();
    roots.forEach((root, i) => {
      const list = byRoot.get(root);
      if (list) list.push(rest[i].uid);
      else byRoot.set(root, [rest[i].uid]);
    });
    const similar: DuplicateGroup[] = [];
    for (const uids of byRoot.values()) {
      if (uids.length < 2) continue;
      uids.sort(byTime);
      similar.push({ key: groupKey(uids), kind: "similar", uids, times: uids.map(timeOf) });
    }
    const order = (a: DuplicateGroup, b: DuplicateGroup) => b.uids.length - a.uids.length || b.times[0] - a.times[0];
    return [...identical.sort(order), ...sameOut.sort(order), ...burstOut.sort(order), ...similar.sort(order)];
  }

  /**
   * Learns the size and length of every video in the library not asked about yet, during the
   * scan, so working the groups out never waits on the network. One the source does not answer
   * for is noted as unknown. A batch that fails is left for the next scan and the rest go on;
   * three failing in a row is the connection gone, and the rest wait for the next scan too.
   */
  private async learnVideoDetails(gen: number): Promise<void> {
    const source = this.source;
    if (!source?.details) return;
    const ask = [...this.videos].filter((u) => !this.details.has(u));
    let failures = 0;
    for (let at = 0; at < ask.length; at += DETAILS_BATCH) {
      if (gen !== this.generation) return;
      const batch = ask.slice(at, at + DETAILS_BATCH);
      let got: CopyDetails[];
      try {
        got = await source.details(batch);
        failures = 0;
      } catch {
        if (++failures >= 3) return;
        continue;
      }
      for (const d of got) this.details.set(d.uid, d);
      for (const u of batch) if (!this.details.has(u)) this.details.set(u, { uid: u, size: null, durationMs: null });
    }
  }

  /** Of copies whose sizes are all known and not all equal, the index of the largest. */
  private largestOf(uids: string[]): number | undefined {
    const sizes = uids.map((u) => this.details.get(u)?.size ?? 0);
    if (sizes.some((s) => s <= 0)) return undefined;
    const largest = Math.max(...sizes);
    return sizes.some((s) => s !== largest) ? sizes.indexOf(largest) : undefined;
  }

  /** The groups as they stand, the trashed copies left out. */
  private live(): DuplicateGroup[] {
    if (!this.computed) return [];
    if (this.gone.size === 0) return this.computed;
    const out: DuplicateGroup[] = [];
    for (const g of this.computed) {
      if (!g.uids.some((u) => this.gone.has(u))) {
        out.push(g);
        continue;
      }
      const left = g.uids.map((u, i) => [u, g.times[i]] as const).filter(([u]) => !this.gone.has(u));
      if (left.length < 2) continue;
      const uids = left.map(([u]) => u);
      // The kept copy gone, the largest of those left is the one to keep.
      const kept = g.keep === undefined ? -1 : uids.indexOf(g.uids[g.keep]);
      const keep = g.keep === undefined ? undefined : kept >= 0 ? kept : this.largestOf(uids);
      out.push({ key: groupKey(uids), kind: g.kind, uids, times: left.map(([, t]) => t), ...(keep !== undefined ? { keep } : {}) });
    }
    return out;
  }

  /**
   * The groups to show, split by kind, the ignored ones apart; `ready` is false until they
   * have been worked out once. Answers at once.
   */
  groups(): ShownGroups {
    this.load();
    const version = this.status.version;
    if (this.shown?.version === version) return this.shown.groups;
    const ignored = new IgnoredGroups(this.ignored);
    const out: ShownGroups = { identical: [], same: [], burst: [], similar: [], ignored: [], ready: this.computed !== null };
    for (const g of this.live()) {
      if (ignored.covering(g.uids).length) out.ignored.push(g);
      else out[g.kind].push(g);
    }
    this.shown = { version, groups: out };
    return out;
  }

  ignore(uids: string[]): void {
    this.load();
    const key = groupKey(uids);
    if (!this.ignored.includes(key)) this.ignored.push(key);
    this.save();
    this.bump();
  }

  unignore(uids: string[]): void {
    this.load();
    const drop = new Set(new IgnoredGroups(this.ignored).covering(uids));
    this.ignored = this.ignored.filter((k) => !drop.has(k));
    this.save();
    this.bump();
  }

  /**
   * Moves the chosen copies to the trash: for each group, every copy but the kept ones, and for
   * each group asked for whole, every copy. A group counts only while the finder holds all of
   * the copies asked about as one of its own groups, and a group with copies kept only while
   * `stillThere` finds one of them on Drive, out of the trash, right now: another device may
   * have deleted it meanwhile. A group that fails either is left alone and counted as skipped.
   */
  async trash(
    picks: { uids: string[]; keep: string[] }[],
    whole: string[][],
    trashNodes: (uids: string[]) => Promise<TrashOutcome[]>,
    stillThere: (uids: string[]) => Promise<Set<string>>,
  ): Promise<{ trashed: string[]; failed: number; skipped: number }> {
    const current = this.live();
    // Groups are apart from one another, so a photo is in one at most.
    const groupOf = new Map<string, number>();
    current.forEach((g, i) => g.uids.forEach((u) => groupOf.set(u, i)));
    const held = (uids: string[]) => {
      if (uids.length < 2 || new Set(uids).size !== uids.length) return false;
      const g = groupOf.get(uids[0]);
      return g !== undefined && uids.every((u) => groupOf.get(u) === g);
    };
    let skipped = 0;
    const heldPicks: { uids: string[]; keep: string[] }[] = [];
    for (const p of picks) {
      if (held(p.uids)) heldPicks.push(p);
      else skipped++;
    }
    const wholeHeld: string[][] = [];
    for (const uids of whole) {
      if (held(uids)) wholeHeld.push(uids);
      else skipped++;
    }
    const keepers = [...new Set(heldPicks.flatMap((p) => p.keep.filter((u) => p.uids.includes(u))))];
    const there = keepers.length ? await stillThere(keepers) : new Set<string>();
    const missing = new Set([...this.gone, ...keepers.filter((u) => !there.has(u))]);
    const partial: { uids: string[]; keep: Set<string> }[] = [];
    for (const p of heldPicks) {
      const keep = new Set(p.keep);
      if (p.uids.some((u) => keep.has(u) && !missing.has(u))) partial.push({ uids: p.uids, keep });
      else skipped++;
    }
    const ids = deletableAcross(partial, wholeHeld, missing);
    if (ids.length === 0) return { trashed: [], failed: 0, skipped };
    const asked = new Set(ids);
    const results = await trashNodes(ids);
    const trashed = results.filter((r) => r.ok && asked.has(r.uid)).map((r) => r.uid);
    this.removed(trashed);
    return { trashed, failed: ids.length - trashed.length, skipped };
  }

  private path(): string {
    return join(storeDir(), DUPLICATES_FILE);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.persist) return;
    const raw = readSealedOrDiscard(this.path());
    if (!raw) return;
    try {
      const saved = JSON.parse(raw.toString("utf8")) as Saved;
      this.ignored = Array.isArray(saved.i) ? saved.i.filter((k) => typeof k === "string") : [];
      // Fingerprints of another recipe mean something else: they are made again.
      if (saved.a !== ALGO_VERSION) return;
      for (const [uid, text] of Object.entries(saved.p ?? {})) {
        const fp = decodeRecord(text);
        if (fp) this.prints.set(uid, fp);
      }
      this.unreadable = new Set(Array.isArray(saved.n) ? saved.n : []);
    } catch {
      /* a file that will not parse starts the fingerprints over */
    }
  }

  private save(): void {
    if (!this.persist) return;
    const p: Record<string, string> = {};
    for (const [uid, fp] of this.prints) p[uid] = encode(fp);
    const saved: Saved = { v: 1, a: ALGO_VERSION, p, n: [...this.unreadable], i: this.ignored };
    try {
      mkdirSync(storeDir(), { recursive: true });
      writeSealedAtomic(this.path(), Buffer.from(JSON.stringify(saved), "utf8"));
    } catch {
      /* the fingerprints are made again next time */
    }
  }
}

export const duplicateFinder = new DuplicateFinder();

/** A page of the photos timeline listing, and the volume in its address. */
const LISTING = /\/drive\/volumes\/([^/?]+)\/photos(?:\?|$)/;

/**
 * The Drive client's HTTP client, with the photos listing's answers also read for their content
 * hashes, which the Drive library leaves out of what it hands on. The library still reads the
 * answer itself; this reads a copy, and a copy that will not parse is let go.
 */
export function withListingTap<T extends { fetchJson(req: { url: string; method: string }): Promise<Response> }>(
  client: T,
  onPage: (volumeId: string, json: unknown) => void = (v, j) => duplicateFinder.takeListing(v, j),
): T {
  const fetchJson = client.fetchJson.bind(client);
  return {
    ...client,
    async fetchJson(req: Parameters<T["fetchJson"]>[0]): Promise<Response> {
      const res = await fetchJson(req);
      const m = req.method.toUpperCase() === "GET" && res.ok ? LISTING.exec(req.url) : null;
      if (m) {
        const volumeId = decodeURIComponent(m[1]);
        res
          .clone()
          .json()
          .then((json) => onPage(volumeId, json))
          .catch(() => {});
      }
      return res;
    },
  };
}
