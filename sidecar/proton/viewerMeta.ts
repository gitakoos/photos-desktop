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

// What the viewer reads out of a photo's own bytes: the camera facts for the details panel
// and the clip of a Live Photo or a motion photo.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { WritableStream } from "node:stream/web";

import { readCameraFacts, type CameraFacts } from "./cameraFacts.ts";
import { findMotionClip } from "./motionPhoto.ts";
import { openDownloader } from "./downloadSlots.ts";

/** A clip as the viewer plays it: base64 bytes and their media type. */
export type ClipBytes = { base64: string; mime: string };

/** The largest photo read whole for its EXIF or its clip. */
const READ_MAX_BYTES = 120 * 1024 * 1024;

/** The facts of a photo read in the background, polled until `done`. */
export type CameraFactsReply = { state: "working" } | { state: "done"; facts: CameraFacts | null };

/** How many photos' facts stay remembered, so stepping back to one answers at once. */
const FACTS_KEPT = 40;

/**
 * Camera facts read once per photo, off the channel: the first ask starts the read and
 * answers `working`, and the viewer asks again until it is `done`.
 */
export class CameraFactsJobs {
  private jobs = new Map<string, CameraFactsReply>();

  constructor(private readonly bytesOf: (uid: string) => Promise<Buffer | null>) {}

  ask(uid: string): CameraFactsReply {
    const known = this.jobs.get(uid);
    if (known) {
      this.jobs.delete(uid);
      this.jobs.set(uid, known);
      return known;
    }
    const job: CameraFactsReply = { state: "working" };
    this.jobs.set(uid, job);
    for (const old of this.jobs.keys()) {
      if (this.jobs.size <= FACTS_KEPT) break;
      this.jobs.delete(old);
    }
    void this.bytesOf(uid)
      .then((bytes) => (bytes ? readCameraFacts(bytes) : null))
      .catch(() => null)
      .then((facts) => {
        this.jobs.set(uid, { state: "done", facts });
      });
    return job;
  }

  clear(): void {
    this.jobs.clear();
  }
}

/** A whole file into memory, or null when it is larger than `cap` or cannot be read. */
export async function downloadWhole(photos: any, uid: string, cap = READ_MAX_BYTES): Promise<Buffer | null> {
  try {
    const { downloader, unused } = await openDownloader(photos, uid);
    const claimed = Number(downloader.getClaimedSizeInBytes?.() ?? 0);
    if (claimed > cap) {
      unused();
      return null;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const sink = new WritableStream<Uint8Array>({
      write(chunk) {
        total += chunk.byteLength;
        if (total > cap) throw new Error("too large to read");
        chunks.push(chunk);
      },
    });
    await downloader.downloadToStream(sink as any).completion();
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/** The clip cut out of a motion photo's bytes, or null when it holds none. */
export function embeddedClip(bytes: Buffer): ClipBytes | null {
  const found = findMotionClip(bytes);
  if (!found) return null;
  return { base64: bytes.subarray(found.start, found.end).toString("base64"), mime: "video/mp4" };
}

/** The video among a Live Photo's related nodes, or null when it has none. */
async function relatedVideoUid(photos: any, node: any): Promise<string | null> {
  for (const uid of node?.photo?.relatedPhotoNodeUids ?? []) {
    try {
      const related: any = await photos.getNode(uid);
      const type = String(related?.mediaType ?? "").toLowerCase();
      if (type.startsWith("video/")) return String(uid);
    } catch {
      /* a related node that cannot be read is not the clip */
    }
  }
  return null;
}

/**
 * The clip of a photo in the library: a Live Photo's paired video, which is a related node
 * on Drive, or the MP4 appended to a motion photo's JPEG. `original` is the photo's own
 * bytes, from the copy the viewer already holds where there is one.
 */
export async function motionClipOf(
  photos: any,
  uid: string,
  io: {
    original: (uid: string) => Promise<Buffer | null>;
    video: (photos: any, uid: string) => Promise<ClipBytes>;
  },
): Promise<ClipBytes | null> {
  const node: any = await photos.getNode(uid);
  const related = await relatedVideoUid(photos, node);
  if (related) return io.video(photos, related);
  const type = String(node?.mediaType ?? "").toLowerCase();
  if (type && type !== "image/jpeg") return null;
  const bytes = (await io.original(uid)) ?? (await downloadWhole(photos, uid));
  return bytes ? embeddedClip(bytes) : null;
}

const STILL_EXT = /^\.(jpe?g|heic|heif)$/i;
const PAIRED_VIDEO_EXT = /^\.(mov|mp4)$/i;

/**
 * The largest movie taken as a Live Photo's companion. A Live Photo's movie runs about three
 * seconds and stays well under this even in 4K; a larger file beside a still is a video of its
 * own, which is never read and handed to the window as a clip.
 */
export const LIVE_CLIP_MAX_BYTES = 15 * 1024 * 1024;

/**
 * The clip of a picture file on this computer: the MP4 inside a motion photo, or the movie
 * a Live Photo was exported beside, the same name with a .mov or .mp4 extension.
 *
 * `path` is the still as the host vetted it (`localMotionClip` in `lib.rs`: canonical, a photo,
 * outside the app's data). The companion is looked for only in that folder, and only a regular
 * file small enough to be a Live Photo's movie is read; a link is not followed.
 */
export async function localMotionClip(path: string): Promise<ClipBytes | null> {
  const ext = extname(path);
  if (!isAbsolute(path) || !STILL_EXT.test(ext)) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > READ_MAX_BYTES) return null;
    if (/^\.jpe?g$/i.test(ext)) {
      const clip = embeddedClip(await readFile(path));
      if (clip) return clip;
    }
    const stem = basename(path, ext).toLowerCase();
    const folder = dirname(path);
    for (const name of await readdir(folder)) {
      const other = extname(name);
      if (!PAIRED_VIDEO_EXT.test(other) || basename(name, other).toLowerCase() !== stem) continue;
      const movie = join(folder, name);
      const held = await lstat(movie);
      if (!held.isFile() || held.size === 0 || held.size > LIVE_CLIP_MAX_BYTES) continue;
      return {
        base64: (await readFile(movie)).toString("base64"),
        mime: /^\.mov$/i.test(other) ? "video/quicktime" : "video/mp4",
      };
    }
  } catch {
    /* a file that cannot be read has no clip to show */
  }
  return null;
}
