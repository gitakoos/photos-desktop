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

// Whether a file from an export is already in the library. Proton's own check finds a photo
// only by its exact name and bytes, and an export (Ente's, a Takeout) renames clashes, and may
// hold another encoding of a photo the phone uploaded: all of those went up a second time.
//
// Two checks, in order:
//  - the same file under any name: the file's SHA-1, keyed the way Proton keys a photo's
//    content hash, against the hashes the timeline listing hands out for every photo;
//  - the same photo in other bytes: a library photo taken in the same second (or a whole number
//    of quarter hours away, for a time zone read differently) that looks the same, by the
//    fingerprint the duplicate finder uses. For a video, as the duplicate finder groups them: one
//    of the very same size and length whatever its date (a header rewritten), or one starting
//    the same second or whole hours off (UTC against local time) of the same length; a length
//    that differs is another clip. Such a match is only "probably there": the review shows it,
//    and leaves it out unless asked.

import { createHmac } from "node:crypto";

import { isUsable, matches, type Fingerprint } from "./pdq.ts";

/** A library photo; `size` and `durationMs` where they are known, for videos. */
export type LibraryPhoto = { uid: string; captureTime: number; video: boolean; size?: number | null; durationMs?: number | null };

export type MatchWhy =
  | "same_file"
  | "same_time_look"
  | "same_time_video"
  | "same_size_video"
  | "smaller_in_library"
  | "same_time"
  | "live_video"
  | "same_in_export"
  | "unchecked";

export type Match =
  | { verdict: "new" }
  | { verdict: "already"; uid: string; why: "same_file" | "same_in_export"; hidden: boolean }
  | { verdict: "probable"; uid: string | null; why: MatchWhy; hidden: boolean };

/** Seconds of slack either side of a capture time. */
const SLACK_S = 1;
/** A time zone read differently moves a capture time by whole quarter hours, up to 14 hours. */
const ZONE_STEP_S = 900;
const ZONE_STEPS = 56;
/** Of a video, only whole hours: a camera writes UTC where another app wrote local time. */
const VIDEO_HOUR_STEPS = 14;
/** Videos of one size and length beyond this many are a camera's padded segments, not copies. */
const SIZE_TWINS_MAX = 4;
/** How far the lengths of two files of one video may differ: a re-encode trims a frame or two. */
const lengthSlack = (a: number, b: number) => Math.min(1_500, Math.max(200, 0.02 * Math.max(a, b)));
/**
 * Of the same second, lengths further apart than this are another clip. Looser than the slack:
 * the export's length and the library's were read by different programs, which may round.
 */
const OTHER_CLIP_MS = 1_500;
/** Whole hours off, the lengths must agree this closely, as the duplicate finder asks. */
const SHIFTED_SLACK_MS = 200;
/** An export file this much larger than its library copy is the better one: the library's is lighter. */
const LARGER_BY = 1.1;

/**
 * The photo root's hash key, which Proton keys names and content hashes with. The SDK keeps it
 * to itself (its own duplicate check uses it the same way), so it is read from there; null if
 * that ever changes, and the import then falls back to Proton's name-and-bytes check.
 */
export async function photoRootHashKey(client: any): Promise<Uint8Array | null> {
  try {
    const timeline = client?.photos?.timeline;
    const { volumeId, rootNodeId } = await timeline.photoShares.getRootIDs();
    const keys = await timeline.nodesService.getNodeKeys(`${volumeId}~${rootNodeId}`);
    return keys?.hashKey instanceof Uint8Array ? keys.hashKey : null;
  } catch {
    return null;
  }
}

/** Proton's content hash for a file: its SHA-1 (hex), keyed with the photo root's hash key. */
export function contentHashOf(sha1: string, hashKey: Uint8Array): string {
  return createHmac("sha256", hashKey).update(sha1, "utf8").digest("hex");
}

export class LibraryIndex {
  private readonly bySecond = new Map<number, LibraryPhoto[]>();
  private readonly byContent = new Map<string, string>();
  private readonly bySizeLength = new Map<string, LibraryPhoto[]>();
  /** Series looked up so far, by uid. Series is by length alone: it errs towards uploading. */
  private readonly seriesOf = new Map<string, boolean>();

  constructor(
    photos: LibraryPhoto[],
    contentHashes: Iterable<[string, string]>,
    private readonly hashKey: Uint8Array | null,
    private readonly printOf: (uid: string) => Promise<Fingerprint | null>,
    private readonly isHidden: (uid: string) => boolean = () => false,
  ) {
    for (const p of photos) {
      const s = Math.round(p.captureTime / 1000);
      const list = this.bySecond.get(s);
      if (list) list.push(p);
      else this.bySecond.set(s, [p]);
      if (p.video && p.size && p.durationMs) {
        const key = `${p.size}:${p.durationMs}`;
        const twins = this.bySizeLength.get(key);
        if (twins) twins.push(p);
        else this.bySizeLength.set(key, [p]);
      }
    }
    const listed = new Set(photos.map((p) => p.uid));
    for (const [uid, hash] of contentHashes) {
      // Only photos still in the library: a hash of one since trashed means nothing now. Of a
      // hidden and a shown copy, the shown one, which the import may put in an album.
      if (!listed.has(uid)) continue;
      const held = this.byContent.get(hash);
      if (!held || (this.isHidden(held) && !this.isHidden(uid))) this.byContent.set(hash, uid);
    }
  }

  /** Whether a file can be looked up by its content: the key and the library's hashes are here. */
  canMatchContent(): boolean {
    return this.hashKey !== null && this.byContent.size > 0;
  }

  /** The library photo with exactly these bytes, under any name. */
  sameFile(sha1: string): string | null {
    if (!this.hashKey) return null;
    return this.byContent.get(contentHashOf(sha1, this.hashKey)) ?? null;
  }

  /**
   * Library photos of the same kind taken at `ms`: within a second of it, and for a picture also
   * a whole number of quarter hours away, nearest first.
   */
  takenAt(ms: number, video: boolean): { photo: LibraryPhoto; shifted: boolean }[] {
    const at = Math.round(ms / 1000);
    const out: { photo: LibraryPhoto; shifted: boolean }[] = [];
    const steps = video ? VIDEO_HOUR_STEPS : ZONE_STEPS;
    const step = video ? 4 * ZONE_STEP_S : ZONE_STEP_S;
    for (let k = 0; k <= steps; k++) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        const centre = at + sign * k * step;
        for (let d = -SLACK_S; d <= SLACK_S; d++) {
          for (const photo of this.bySecond.get(centre + d) ?? []) {
            if (photo.video === video) out.push({ photo, shifted: k !== 0 });
          }
        }
      }
    }
    return out;
  }

  /** Library videos of exactly this size and length, unless so many share it they are a camera's segments. */
  sameSizeLength(size: number, durationMs: number): LibraryPhoto[] {
    const twins = this.bySizeLength.get(`${size}:${durationMs}`) ?? [];
    return twins.length > SIZE_TWINS_MAX ? [] : twins;
  }

  /**
   * Whether a library video is one of a series: another video of about its length within half
   * an hour (a dashcam's segments, a timelapse's clips). A match whole hours off is no proof then.
   */
  inVideoSeries(photo: LibraryPhoto): boolean {
    const length = photo.durationMs;
    if (!length) return false;
    const known = this.seriesOf.get(photo.uid);
    if (known !== undefined) return known;
    const at = Math.round(photo.captureTime / 1000);
    const found = (() => {
    for (let d = -1800; d <= 1800; d++) {
      // A copy dated the same moment (a lighter one beside its original) is no series.
      if (Math.abs(d) <= 2) continue;
      for (const other of this.bySecond.get(at + d) ?? []) {
        if (other.uid === photo.uid || !other.video || !other.durationMs) continue;
        if (Math.abs(other.durationMs - length) <= lengthSlack(other.durationMs, length)) return true;
      }
    }
    return false;
    })();
    this.seriesOf.set(photo.uid, found);
    return found;
  }

  hidden(uid: string): boolean {
    return this.isHidden(uid);
  }

  print(uid: string): Promise<Fingerprint | null> {
    return this.printOf(uid).catch(() => null);
  }
}

/** What is known of one file of an export, for matching. */
export type ExportFile = {
  sha1: string;
  /** When it was taken, from the export's own record or the file's EXIF; null when unknown. */
  takenMs: number | null;
  video: boolean;
  /** Its size in bytes and, for a video, its length, where known. */
  size?: number | null;
  durationMs?: number | null;
  /**
   * Of a video: whether the export holds other videos of about its length within half an hour
   * (a series, so a match hours off is no proof), and whether more than a few share its very
   * size and length (a camera's padded segments, so a twin is no proof either).
   */
  inSeries?: boolean;
  crowded?: boolean;
  /** Its fingerprint, made only when asked for. */
  print: () => Promise<Fingerprint | null>;
};

/**
 * Whether `file` is in the library: the same file, probably the same photo, or new. A library
 * photo in `claimed` is already some other file's exact copy, and is no candidate: in a library
 * that holds most of an export byte for byte, that keeps a burst's next frame, or another video
 * of the same second, from being taken for the one the library has.
 */
export async function matchFile(index: LibraryIndex, file: ExportFile, claimed: ReadonlySet<string> = new Set()): Promise<Match> {
  const same = index.sameFile(file.sha1);
  if (same) return { verdict: "already", uid: same, why: "same_file", hidden: index.hidden(same) };
  if (file.video) return matchVideo(index, file, claimed);
  if (file.takenMs === null || !Number.isFinite(file.takenMs)) return { verdict: "new" };
  const near = index.takenAt(file.takenMs, file.video).filter((n) => !claimed.has(n.photo.uid));
  if (near.length === 0) return { verdict: "new" };
  const own = await file.print().catch(() => null);
  if (own && isUsable(own)) {
    let unseen: string | null = null;
    for (const { photo, shifted } of near) {
      const theirs = await index.print(photo.uid);
      if (theirs && isUsable(theirs)) {
        if (matches(own, theirs)) {
          return { verdict: "probable", uid: photo.uid, why: "same_time_look", hidden: index.hidden(photo.uid) };
        }
      } else if (!shifted && unseen === null) unseen = photo.uid;
    }
    // A photo of the same second whose look could not be had is no proof of a new one.
    if (unseen) return { verdict: "probable", uid: unseen, why: "same_time", hidden: index.hidden(unseen) };
    return { verdict: "new" };
  }
  // Nothing to compare by (a picture this computer cannot read, or a flat frame): a photo of
  // the same second is enough to hold it back for a look, never one a time zone away.
  const exact = near.find((n) => !n.shifted);
  if (!exact) return { verdict: "new" };
  return { verdict: "probable", uid: exact.photo.uid, why: "same_time", hidden: index.hidden(exact.photo.uid) };
}

/**
 * A video, by the rules the duplicate finder groups videos by. The very same size and length
 * first, whatever the dates. Then one starting the same second, or whole hours off when both
 * lengths say it is one video; of the same second with a length unknown on either side, the
 * time alone holds it back. A library copy much smaller than the file is told apart, so the
 * review can say the export holds the better one.
 */
function matchVideo(index: LibraryIndex, file: ExportFile, claimed: ReadonlySet<string>): Match {
  const length = file.durationMs ?? null;
  const probable = (photo: LibraryPhoto, why: MatchWhy): Match => {
    const smaller = !!file.size && !!photo.size && file.size > photo.size * LARGER_BY;
    return { verdict: "probable", uid: photo.uid, why: smaller ? "smaller_in_library" : why, hidden: index.hidden(photo.uid) };
  };
  if (file.size && length && !file.crowded) {
    const twin = index.sameSizeLength(file.size, length).find((p) => !claimed.has(p.uid) && !index.inVideoSeries(p));
    if (twin) return probable(twin, "same_size_video");
  }
  if (file.takenMs === null || file.takenMs === undefined || !Number.isFinite(file.takenMs)) return { verdict: "new" };
  // Those whose length agrees first, then one of the same second whose length is not known.
  let unknownLength: LibraryPhoto | null = null;
  for (const { photo, shifted } of index.takenAt(file.takenMs, true)) {
    if (claimed.has(photo.uid)) continue;
    const theirs = photo.durationMs ?? null;
    if (length && theirs) {
      const apart = Math.abs(length - theirs);
      if (!shifted && apart <= OTHER_CLIP_MS) return probable(photo, "same_time_video");
      if (shifted && apart <= SHIFTED_SLACK_MS && !file.inSeries && !index.inVideoSeries(photo)) {
        return probable(photo, "same_time_video");
      }
    } else if (!shifted && unknownLength === null) {
      unknownLength = photo;
    }
  }
  return unknownLength ? probable(unknownLength, "same_time_video") : { verdict: "new" };
}
