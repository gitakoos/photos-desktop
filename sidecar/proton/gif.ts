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

// The GIF maker's writing side. The window samples the chosen part of a video frame by frame,
// framed as its preview shows it, and hands each frame over as a still; here they are kept in a
// temporary folder, joined into one looping GIF and uploaded as a new photo with the video's date.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import sharp from "sharp";

import { nodeName, toMillis } from "./nodes.ts";
import { mediaAttributes, thumbnailPair } from "./upload.ts";

/** The frames a second the window samples at, and the most frames one GIF takes (ten seconds). */
export const GIF_FPS = 12;
export const GIF_MAX_FRAMES = GIF_FPS * 10;
/** A frame's longest edge is one of the sizes the maker offers, never more. */
const MAX_EDGE = 1080;

type Job = { dir: string; count: number; width: number; height: number };

const jobs = new Map<string, Job>();

function jobsDir(): string {
  return join(tmpdir(), "pfp-gif");
}

/** The name the GIF goes up under: the video's, marked and stamped so it never meets another. */
export function gifName(sourceName: string, when: Date): string {
  const dot = sourceName.lastIndexOf(".");
  const stem = (dot > 0 ? sourceName.slice(0, dot) : sourceName).trim() || "video";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `_${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `${stem}_gif_${stamp}.gif`;
}

/** Starts a GIF: a folder for its frames. */
export function gifBegin(width: number, height: number): { job: string } {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!(w > 0 && h > 0 && Math.max(w, h) <= MAX_EDGE)) throw new Error("Unsupported GIF size");
  const job = randomUUID();
  const dir = join(jobsDir(), job);
  mkdirSync(dir, { recursive: true });
  jobs.set(job, { dir, count: 0, width: w, height: h });
  return { job };
}

/** Keeps one frame, a JPEG or PNG still, at its place in the order. */
export function gifFrame(job: string, index: number, base64: string): { count: number } {
  const j = jobs.get(job);
  if (!j) throw new Error("This GIF is no longer being made");
  if (!Number.isInteger(index) || index < 0 || index >= GIF_MAX_FRAMES) throw new Error("Too many frames");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0) throw new Error("Empty frame");
  writeFileSync(join(j.dir, `${String(index).padStart(4, "0")}.img`), bytes);
  j.count = Math.max(j.count, index + 1);
  return { count: j.count };
}

/** Drops a GIF being made and its frames. */
export function gifCancel(job: string): void {
  const j = jobs.get(job);
  jobs.delete(job);
  if (j) rmSync(j.dir, { recursive: true, force: true });
}

/** The frames joined into one looping GIF, every frame its own still of the same size. */
export async function joinFrames(files: string[], width: number, height: number, fps = GIF_FPS): Promise<Buffer> {
  const frames = await Promise.all(
    files.map((f) => sharp(f, { failOn: "none" }).resize(width, height, { fit: "fill" }).removeAlpha().png().toBuffer()),
  );
  const delay = Math.round(1000 / fps);
  return sharp(frames, { join: { animated: true } })
    .gif({ delay: frames.map(() => delay), loop: 0, effort: 7 })
    .toBuffer();
}

/**
 * Joins the frames kept for `job` and uploads the GIF as a new photo beside `sourceUid`: the
 * video's capture time, so it sorts next to it, and the video's name marked as a GIF.
 */
export async function gifFinish(photos: any, job: string, sourceUid: string): Promise<{ uid: string; size: number }> {
  const j = jobs.get(job);
  if (!j) throw new Error("This GIF is no longer being made");
  try {
    const files = readdirSync(j.dir)
      .filter((f) => f.endsWith(".img"))
      .sort()
      .map((f) => join(j.dir, f));
    if (files.length < 2) throw new Error("A GIF needs at least two frames");
    const gif = await joinFrames(files, j.width, j.height);

    const source = await photos.getNode(sourceUid);
    const captureMs = toMillis(source?.photo?.captureTime);
    const sha1 = createHash("sha1").update(gif).digest("hex");
    let thumbnails: any[] = [];
    try {
      thumbnails = await thumbnailPair(sharp(files[0], { failOn: "none" }));
    } catch {
      /* Drive makes its own */
    }
    const uploader = await photos.getFileUploader(
      gifName(nodeName(source) || "video", new Date()),
      {
        mediaType: "image/gif",
        expectedSize: gif.byteLength,
        expectedSha1: sha1,
        modificationTime: new Date(),
        captureTime: new Date(captureMs > 0 ? captureMs : Date.now()),
        tags: [],
        additionalMetadata: mediaAttributes({ width: j.width, height: j.height }),
      },
      new AbortController().signal,
    );
    const controller = await uploader.uploadFromStream(Readable.toWeb(Readable.from(gif)) as any, thumbnails);
    const { nodeUid } = await controller.completion();
    process.stderr.write(`[gif] saved a GIF of ${files.length} frames: ${gif.byteLength} bytes\n`);
    return { uid: nodeUid, size: gif.byteLength };
  } finally {
    gifCancel(job);
  }
}
