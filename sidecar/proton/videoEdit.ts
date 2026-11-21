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

// The video editor's Drive side. A Drive video is downloaded to the editor's staging folder (the
// one the host reads sources from and writes edits to), and what the host's ffmpeg made there is
// uploaded as a NEW node carrying the source's capture time, place and camera; the original is
// never touched.
//
// The staging folder is the host's: it names it in `PFP_VEDIT_DIR` when it starts the sidecar
// (on Linux a folder on disk, as the sandbox's /tmp is a small RAM disk), so both sides read and
// write the same place.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";

import sharp from "sharp";

import { cameraOf, locationOf } from "./editor.ts";
import { activeRevisionOf, nodeName, toMillis } from "./nodes.ts";
import { mediaAttributes, photoTagsFor, thumbnailPair } from "./upload.ts";

/** The name of the folder the host stages edits in. */
export const STAGING_DIR = "pfp-vedit";

/** The host's staging folder, or the one under the temp folder when it named none. */
export function stagingRoot(): string {
  const named = process.env.PFP_VEDIT_DIR;
  return named && isAbsolute(named) && basename(named) === STAGING_DIR ? named : join(tmpdir(), STAGING_DIR);
}

/** Where the editor's Drive downloads go: inside the staging folder, so staging one is a rename. */
export function editDownloadDir(): string {
  return join(stagingRoot(), "pfp-hyd");
}

/** `path` resolved, when it lies inside `root` resolved; null when either cannot be found. */
function realInside(path: string, root: string): { real: string; parts: string[] } | null {
  try {
    const real = realpathSync.native(path);
    const rel = relative(realpathSync.native(root), real);
    if (!rel || isAbsolute(rel) || rel.split(sep)[0] === "..") return null;
    return { real, parts: rel.split(sep) };
  } catch {
    return null;
  }
}

export type EditKind = "video" | "gif" | "frame";

const EDIT_TYPES: Record<string, { kind: EditKind; mediaType: string; tag: string }> = {
  mp4: { kind: "video", mediaType: "video/mp4", tag: "edit" },
  gif: { kind: "gif", mediaType: "image/gif", tag: "gif" },
  jpg: { kind: "frame", mediaType: "image/jpeg", tag: "frame" },
};

/** The container extensions the editor's ffmpeg reads, by the media type Drive reports. */
const SOURCE_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
  "video/x-matroska": "mkv",
  "video/webm": "mkv",
  "video/3gpp": "3gp",
  "video/x-msvideo": "avi",
  "video/mp2t": "ts",
};

export function sourceExtension(mediaType: string, name: string): string {
  const byType = SOURCE_EXTENSIONS[mediaType.toLowerCase().split(";")[0].trim()];
  if (byType) return byType;
  const own = extname(name).slice(1).toLowerCase();
  return Object.values(SOURCE_EXTENSIONS).includes(own) ? own : "mp4";
}

export type VideoEditSource = {
  /** Where the download is going; `hydrateProgress` says when it is whole. */
  path: string;
  name: string;
  ext: string;
  captureTime: number | null;
  camera: string | null;
  latitude: number | null;
  longitude: number | null;
};

/** What the editor needs of a Drive video besides its bytes. The download itself is `startHydrate`'s. */
export async function videoEditSourceInfo(photos: any, uid: string): Promise<Omit<VideoEditSource, "path">> {
  const node = await photos.getNode(uid);
  const mediaType = String(node?.mediaType ?? "");
  if (!mediaType.toLowerCase().startsWith("video/")) throw new Error("NOT_A_VIDEO");
  const name = nodeName(node) || "video";
  const extra = activeRevisionOf(node)?.claimedAdditionalMetadata ?? null;
  const { latitude, longitude } = locationOf(extra);
  return {
    name,
    ext: sourceExtension(mediaType, name),
    captureTime: node?.photo?.captureTime ? toMillis(node.photo.captureTime) : null,
    camera: cameraOf(extra),
    latitude,
    longitude,
  };
}

const DOWNLOAD_NAME = /^pfp-hyd-[0-9a-f-]{36}\.bin$/;

/** Whether a path is a finished download of the editor's: `<staging>/pfp-hyd/pfp-hyd-<uuid>.bin`. */
export function isHydratedDownload(path: string): boolean {
  if (!isAbsolute(path) || !DOWNLOAD_NAME.test(basename(path))) return false;
  const found = realInside(path, editDownloadDir());
  return !!found && found.parts.length === 1;
}

/**
 * The downloads the editor started through `videoEditSource`, the only ones the window may ask
 * after, stop or stage. The general download calls stay the host's own.
 */
export class EditorDownloads {
  private paths = new Set<string>();

  constructor(
    private readonly io: {
      progress: (path: string) => { done: boolean; error: string | null };
      cancel: (path: string) => void;
    },
  ) {}

  add(path: string): void {
    this.paths.add(path);
  }

  private known(path: string): string {
    if (!this.paths.has(path)) throw new Error("not a download of the editor");
    return path;
  }

  progress(path: string): { done: boolean; error: string | null } {
    const state = this.io.progress(this.known(path));
    if (state.error) this.paths.delete(path);
    return state;
  }

  /** Stops the download and deletes what of it arrived. */
  cancel(path: string): { cancelled: true } {
    this.io.cancel(this.known(path));
    this.paths.delete(path);
    rmSync(path, { force: true });
    return { cancelled: true };
  }

  /** Moves a finished download into the staging folder; see `stageSource`. */
  stage(path: string, ext: string): { path: string } {
    this.known(path);
    if (!this.io.progress(path).done) throw new Error("the download is not finished");
    const staged = stageSource(path, ext);
    this.paths.delete(path);
    return staged;
  }
}

/**
 * Moves a finished download into the staging folder under a name ffmpeg reads by its extension,
 * and returns where it is. The host reads sources from there and nowhere else outside the user's
 * own media files.
 */
export function stageSource(downloaded: string, ext: string): { path: string } {
  if (!isHydratedDownload(downloaded)) throw new Error("not a download of this app");
  const safe = /^[a-z0-9]{2,4}$/.test(ext) ? ext : "mp4";
  const dir = join(stagingRoot(), `src-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `source.${safe}`);
  renameSync(downloaded, path);
  return { path };
}

const OUTPUT_NAME = /^out\.(mp4|gif|jpg)$/;
const JOB_NAME = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The real path of a file the host's editor wrote, `<staging>/<job>/out.<mp4|gif|jpg>`, or null
 * for any other. Only such a file, and the thumbnail beside it, is ever uploaded from here, so a
 * renderer that has been taken over cannot have any other file of the user's sent to Drive by
 * naming it, through a link or `..` either: the path is resolved before it is judged.
 */
export function editOutputPath(path: string): string | null {
  if (!isAbsolute(path) || !OUTPUT_NAME.test(basename(path))) return null;
  const found = realInside(path, stagingRoot());
  if (!found || found.parts.length !== 2) return null;
  const [job, file] = found.parts as [string, string];
  return JOB_NAME.test(job) && OUTPUT_NAME.test(file) ? found.real : null;
}

export function isEditOutput(path: string): boolean {
  return editOutputPath(path) !== null;
}

const THUMB_NAME = /^(thumb\.jpg|out\.jpg|out\.gif)$/;

/**
 * The real path of the thumbnail source beside an output (`output` already resolved), or null:
 * the host's `thumb.jpg`, or the output itself for a frame (`out.jpg`) or a GIF (`out.gif`), whose
 * first frame becomes the thumbnail here because the host's ffmpeg cannot decode a GIF.
 */
export function editThumbPath(path: string, output: string): string | null {
  if (!isAbsolute(path) || !THUMB_NAME.test(basename(path))) return null;
  try {
    const real = realpathSync.native(path);
    return dirname(real) === dirname(output) && THUMB_NAME.test(basename(real)) ? real : null;
  } catch {
    return null;
  }
}

export function isEditThumb(path: string, output: string): boolean {
  return editThumbPath(path, output) !== null;
}

/** `stem_edit_yyyyMMdd_HHmmss.mp4`, `stem_gif_...gif` or `stem_frame_...jpg`. */
export function editedMediaName(sourceName: string, ext: string, when: Date): string {
  const kind = EDIT_TYPES[ext];
  if (!kind) throw new Error("unsupported edit");
  const dot = sourceName.lastIndexOf(".");
  const stem = (dot > 0 ? sourceName.slice(0, dot) : sourceName).trim() || "video";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `_${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `${stem}_${kind.tag}_${stamp}.${ext}`;
}

export type SaveEditInput = {
  path: string;
  thumb: string | null;
  name: string;
  captureTime: number | null;
  camera: string | null;
  latitude: number | null;
  longitude: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
};

function sha1Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Uploads the editor's output as a new photo or video with the original's capture time. */
export async function saveEditedMedia(photos: any, input: SaveEditInput): Promise<{ uid: string; size: number }> {
  const path = editOutputPath(input.path);
  if (!path) throw new Error("not a file of the editor");
  const ext = extname(path).slice(1);
  const type = EDIT_TYPES[ext];
  const size = statSync(path).size;
  if (size === 0) throw new Error("empty file");
  const name = editedMediaName(input.name || "video", ext, new Date());

  let thumbnails: any[] = [];
  const thumb = input.thumb ? editThumbPath(input.thumb, path) : null;
  if (thumb) {
    try {
      // Read from memory so no handle of sharp's keeps the file open while the host removes the
      // folder; only the first page of a GIF is decoded.
      thumbnails = await thumbnailPair(sharp(await readFile(thumb), { failOn: "none", pages: 1 }));
    } catch {
      /* uploaded without one */
    }
  }
  const sha1 = await sha1Of(path);
  const uploader = await photos.getFileUploader(
    name,
    {
      mediaType: type.mediaType,
      expectedSize: size,
      expectedSha1: sha1,
      modificationTime: new Date(),
      captureTime: new Date(input.captureTime && input.captureTime > 0 ? input.captureTime : Date.now()),
      tags: photoTagsFor(type.mediaType, name),
      additionalMetadata: mediaAttributes({
        width: input.width,
        height: input.height,
        durationSec: input.durationMs ? input.durationMs / 1000 : null,
        latitude: input.latitude,
        longitude: input.longitude,
        device: input.camera,
      }),
    },
    new AbortController().signal,
  );
  const stream = Readable.toWeb(createReadStream(path)) as any;
  const controller = await uploader.uploadFromStream(stream, thumbnails);
  const { nodeUid } = await controller.completion();
  process.stderr.write(`[videoEdit] saved ${type.kind}: ${size} bytes\n`);
  return { uid: nodeUid, size };
}
