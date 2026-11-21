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

// Upload engine.
//
// Everything server-side goes through the SDK: `getFileUploader` for the bytes,
// `createAlbum` + `addPhotosToAlbum` for folders, `findPhotoDuplicates` to skip
// what is already there. Files stream straight off disk, so a large photo never
// sits in memory.
//
// Concurrency is the SDK's job, not ours: `getFileUploader` awaits its own
// queue (MAX_CONCURRENT_FILE_UPLOADS = 5), so we fire a group's files at once
// and let it throttle. Adding our own semaphore would only slow it down.
//
// RPC is request/response, so progress is state the UI polls. Drops accumulate:
// a second drop while one is running just appends to the queue.
//
// Thumbnails are sharp's work, which makes them a still-image affair: handed a video it
// can do nothing. So the frames arrive alongside the paths, already made: the host asks
// Windows for a picture of each video before the upload starts and stages it as a JPEG,
// which sharp reads as happily
// as it reads a photo. Nothing here decodes video, and nothing here knows about Windows.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { fileHasMotionClip } from "./motionPhoto.ts";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";

import exifr from "exifr";
import sharp from "sharp";

import { createAlbum, deleteAlbum, findAlbumByName, listAlbumPhotos, listAlbums } from "./albums.ts";
import { withStallGuard } from "./stallGuard.ts";
import { compression, compressForUpload, videoLaneBusy, wouldCompress, type PreparedCopy } from "./compression.ts";
import { compressedUploadOf, rememberCompressedUpload } from "./compressedUploads.ts";
import { hostCall } from "./hostCall.ts";
import {
  discardStagedImport,
  ensureFreeSpace,
  importStagingDir,
  isStagedImport,
  isZip,
  planExport,
  sweepStaleStaging,
  unpackZip,
  type ExportItem,
} from "./importer.ts";
import { folderAlbum, type SidecarMeta } from "./takeout.ts";
import { downloadMyFiles, planMyFiles, sourcesToTrash } from "./myFilesImport.ts";
import { dateFromName } from "./nameDate.ts";
import { diag } from "./diag.ts";
import { readMp4CreationTime } from "./mp4Date.ts";
import { readVideoTags } from "./videoTags.ts";
import { withRetry } from "./transient.ts";
import { contentHashOf, photoRootHashKey, type LibraryIndex } from "./importMatch.ts";
import { freshNode } from "./dateEdit.ts";
import { watchSlowUploads } from "./api.ts";
import { PhotoTag, ThumbnailType } from "@protontech/drive-sdk";

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".dng": "image/x-adobe-dng",
};

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".3gp": "video/3gpp",
};

/** sharp cannot decode these, so they upload without a thumbnail. */
const SHARP_CANNOT_DECODE = new Set([".heic", ".heif", ".dng"]);

/**
 * Drive photo tag ids. The server rejects anything outside 0..9, so these are the only
 * values that may ever be sent.
 */
const TAG_SCREENSHOT = 1;
const TAG_VIDEO = 2;
const TAG_BURST = 7;
const TAG_RAW = 9;

/**
 * Raw stills, by extension, matching the set the Android client tags. Only `.dng` can
 * reach this today because the rest are not in `IMAGE_TYPES` and so cannot be uploaded
 * at all; listing them costs nothing and keeps the two clients agreeing if that list
 * ever grows.
 */
const RAW_EXTENSIONS = new Set([
  ".dng",
  ".cr2",
  ".cr3",
  ".nef",
  ".arw",
  ".raf",
  ".orf",
  ".rw2",
  ".pef",
  ".srw",
]);

const THUMB_SMALL_PX = 512;
const THUMB_PREVIEW_PX = 1920;

// The most Drive takes for each thumbnail block, the budget Proton's own clients encode to.
// A block over it is refused with "The block content is too large", and the whole file
// with it, so a detailed photo (foliage, gravel, a crowd) that a fixed quality leaves
// heavy can never be uploaded at all.
const THUMB_SMALL_MAX_BYTES = 64 * 1024;
const THUMB_PREVIEW_MAX_BYTES = 1024 * 1024;
const THUMB_QUALITY_STEPS = [80, 70, 60, 50, 40, 30, 20, 10];

/**
 * What the host asked Windows about one file, for the types this side cannot open.
 *
 * A duration exists only once something has decoded the container, and nothing here
 * decodes video, so it arrives with the frames or not at all. Every field is optional:
 * a machine with no codec for a container answers nothing, and nothing is what gets
 * stored rather than a zero standing in for it.
 */
export type ShellMediaInfo = { width?: number; height?: number; durationSec?: number };

export type UploadItemStatus = "pending" | "uploading" | "done" | "skipped" | "failed";

export type UploadItem = {
  name: string;
  album: string | null;
  status: UploadItemStatus;
  error?: string;
  /** While it uploads: the file's size, and how much of it has gone up. */
  size?: number;
  sent?: number;
  /** While a lighter copy of it is being made: how far along, 0 to 1. */
  compressing?: number;
  /** Bytes the lighter copy that went up saved against the original. */
  saved?: number;
};

/**
 * An export being made ready, before any of it is queued: zips unpacking, then the
 * files waiting for the host's video frames, then being read into albums.
 */
export type ImportState = {
  phase: "downloading" | "unpacking" | "ready" | "planning" | "review";
  /** Bytes unpacked of the zip being unpacked, and its total. */
  done: number;
  total: number;
  /** Which zip of how many, while unpacking. */
  part: number;
  parts: number;
  /** The folders the import reads, once ready: the host makes frames from these. */
  roots?: string[];
  /** While reviewing: how many items, how many checked against the library, how many found. */
  items?: number;
  checked?: number;
  already?: number;
  /** Whether the check reads the library's content hashes; false is Proton's name-and-bytes check only. */
  byContent?: boolean;
};

/** What happened to an album at the end of an upload, beyond the files themselves. */
export type AlbumNote =
  /** The server said the album is full: the rest went into `part` ("Name (2)" and on). */
  | { kind: "split"; album: string; part: string; moved: number }
  /** Photos that could not be put in the album: they are in the library, not in it. */
  | { kind: "failed"; album: string; count: number };

export type UploadStatus = {
  running: boolean;
  /** While the photos of a group go into its album, after its files: how far that has got. */
  albumStep?: { album: string; added: number; total: number };
  /** The album splits and failures of the last upload, until the record is cleared. */
  albumNotes?: AlbumNote[];
  total: number;
  done: number;
  skipped: number;
  failed: number;
  items: UploadItem[];
  /** Present while an export is being made ready. */
  importing?: ImportState;
  /** Why the last import could not start, until the record is cleared. */
  importError?: string;
  /** How a move from My files ended: originals sent to the Drive trash, and those kept. */
  moveResult?: { moved: number; kept: number; failed: boolean };
  /** Bytes the lighter copies saved, over the files in the record. */
  saved?: number;
  /** How many drops held nothing to upload, so the window can say so rather than wait. */
  emptyDrops?: number;
};

type Group = {
  album: string | null;
  files: string[];
  startIndex: number;
  /** This group's staged frames, by `frameKey`. Empty unless the group holds video. */
  frames: Map<string, string>;
  /** What the shell knew about those same files, by `frameKey`. */
  media: Map<string, ShellMediaInfo>;
  /** An album that already exists, for a drop into it: nothing is created. */
  albumUid?: string;
  /**
   * A drop from the file-manager drive: the files are the host's staged copies, deleted
   * once each is in the library (a failed one is kept for the host to retry), and a
   * photo already in the library is added to the album rather than skipped, since
   * copying it into an album folder is how the file manager asks for exactly that.
   */
  fromDrive?: boolean;
  /** Dropped into the drive's Favorites folder: uploaded as a favorite. */
  favorite?: boolean;
  /** An export's sidecars, by file: the capture date, place and favourite to upload with. */
  sidecars?: Map<string, SidecarMeta>;
  /** The unpacked export these files are in, deleted once its last group is done. */
  staging?: Staging;
  /** Files the import's review already found in the library, with the photo they are. */
  known?: Map<string, string>;
  /** A Live Photo's videos, by its photo: uploaded right after it, the first as part of it. */
  related?: Map<string, string[]>;
  /** Each file's row in the status, where a group's rows are not one per file in order. */
  itemOf?: Map<string, number>;
  /**
   * The photo each file of an import became, filled as they upload. A group of
   * `albumOnly` files only puts those photos into its album: the files went up already,
   * with the group of the album they were first found in.
   */
  uidOf?: Map<string, string>;
  albumOnly?: boolean;
  /** Files the import's review already found new: no second duplicate check. */
  fresh?: Set<string>;
  /**
   * Lighter copies go up in place of the originals, as the compression settings ask. Not for a
   * move from My files, where the original itself goes to the trash.
   */
  compress?: boolean;
};

/** Unpacked exports shared by the groups read from them, and what runs once all are done. */
type Staging = { roots: string[]; groupsLeft: number; onDone?: () => Promise<void> };

/** Counts a group off its unpacked export, and deletes the export after the last one. */
async function releaseStaging(staging: Staging): Promise<void> {
  if (--staging.groupsLeft > 0) return;
  try {
    await staging.onDone?.();
  } catch (e) {
    process.stderr.write(`[import] after the import: ${(e as Error).name ?? "error"}\n`);
  }
  for (const root of staging.roots) await discardStagedImport(root);
}

/**
 * Whether a path is one of the host's staged frames: `<temp>/pfp-frame/frame-<32 hex>.jpg`,
 * the exact shape `upload_frame.rs` writes. A frame is read as a thumbnail and then
 * DELETED, and the map naming them arrives over the channel with the upload, so anything
 * else in it is dropped unread and untouched: a renderer that has been taken over cannot
 * get a user's file deleted, or uploaded as a thumbnail, by naming it as a frame. The
 * check is on the shape rather than the temp folder's spelling, which Windows and Node do
 * not always agree on.
 */
export function isStagedFrame(path: string): boolean {
  return (
    isAbsolute(path) &&
    basename(dirname(path)) === "pfp-frame" &&
    /^frame-[0-9a-f]{32}\.jpg$/.test(basename(path))
  );
}

/** The frames in a map that are the host's own; see `isStagedFrame`. */
export function ownFrames(frames: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, frame] of Object.entries(frames ?? {})) {
    if (typeof frame === "string" && isStagedFrame(frame)) out[path] = frame;
  }
  return out;
}

/** The folder the host stages the drive's drops in, one sub-folder per file. */
const DROP_DIR = "pfp-drop";

/**
 * Whether a file is one of the drive's staged copies, the only files an upload may delete.
 * The check is on the path's shape, `<...>/pfp-drop/<one folder>/<file>`, so a drive drop
 * naming anything else, a photo in the user's own folders included, is uploaded and left
 * exactly where it is.
 */
export function isStagedDrop(path: string): boolean {
  return isAbsolute(path) && basename(dirname(dirname(path))) === DROP_DIR;
}

/** The staged copies of drive drops that went up lighter, until the host takes them. */
const dropReplaced: string[] = [];

function noteDropReplaced(path: string): void {
  // Bounded: a host that never asks (an older one, or none) does not grow this for good.
  if (dropReplaced.length >= 5000) dropReplaced.shift();
  dropReplaced.push(path);
}

/**
 * The staged paths of the File Explorer drops that went up as lighter copies since the host
 * last asked, so it can put the file in the folder to the Recycle Bin and let the photo's own
 * copy take its place. Each is handed over once.
 */
export function takeDropReplaced(): string[] {
  return dropReplaced.splice(0, dropReplaced.length);
}

/** Delete one staged copy and the folder it was staged in. Never throws. */
async function discardStaged(path: string): Promise<void> {
  if (!isStagedDrop(path)) return;
  await rm(dirname(path), { recursive: true, force: true }).catch(() => {});
}

/**
 * One spelling of a path, so both sides of the frame lookup agree.
 *
 * The host names a frame by the path it was made from, and this side looks one up by the
 * path it is about to upload. The two are the same file but need not be the same string:
 * a folder's files are built by joining, a dropped file arrives as the shell spelled it,
 * and Windows does not care about case in either. Matching on the raw string would throw
 * a perfectly good thumbnail away over a capital letter.
 */
export function frameKey(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

/**
 * The entries belonging to one group's files, keyed for lookup.
 *
 * A drop is split into groups before this runs, so each group is handed only its own,
 * which is what lets a group discard its frames the moment it is finished with them.
 *
 * Generic over the value because the host returns two maps against the same keys, the
 * staged frames and what the shell knew about the same files, and both are split the
 * same way.
 */
export function framesForFiles<T>(files: string[], frames: Record<string, T>): Map<string, T> {
  const byKey = new Map(Object.entries(frames).map(([path, value]) => [frameKey(path), value]));
  const mine = new Map<string, T>();
  for (const file of files) {
    const key = frameKey(file);
    const value = byKey.get(key);
    if (value !== undefined) mine.set(key, value);
  }
  return mine;
}

/**
 * Delete whatever frames a group still holds.
 *
 * Called when a group is done with, however it ended: uploaded, skipped as a duplicate,
 * failed, or cancelled before it ever ran. `force` makes it idempotent, which matters
 * because the ordinary path has already deleted each frame as it was spent.
 */
async function discardFrames(group: Group): Promise<void> {
  for (const frame of group.frames.values()) {
    await rm(frame, { force: true }).catch(() => {});
  }
  group.frames.clear();
}

const status: UploadStatus = {
  running: false,
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  items: [],
};

let queue: Group[] = [];
let draining = false;
let abort = new AbortController();

export function getUploadStatus(): UploadStatus {
  return status;
}

/** How many rows of the record one status reading carries. */
const STATUS_ROWS = 200;

/**
 * The status as the window polls it: the counts, and at most `STATUS_ROWS` rows, chosen
 * from every failure, what is uploading, what is next, and the latest finished. The whole
 * record went across every 400 ms before, two thousand rows of it during a large import,
 * on the channel a click's answer also waits on: that, and drawing it all again each
 * time, is what made the window lag while an import ran.
 */
export function getUploadStatusView(): UploadStatus & { itemsTotal: number } {
  return { ...status, items: statusRows(status.items, STATUS_ROWS), itemsTotal: status.items.length };
}

/** The rows worth showing, in their order: failures, what is moving, what is next, the latest. */
/**
 * The pauses before trying a file again after a failure that may pass (the network
 * dropped, the server was busy). Two more tries, the second after a longer rest.
 */
const UPLOAD_RETRY_MS = [3_000, 10_000];

/** What the upload panel says about a failure: its message, or its kind when it has none. */
export function failureText(e: unknown): string {
  const err = e as { message?: unknown; name?: unknown; statusCode?: unknown; status?: unknown } | null;
  const message = typeof err?.message === "string" ? err.message.trim() : "";
  if (message) return message;
  const status = Number(err?.statusCode ?? err?.status ?? 0);
  const name = typeof err?.name === "string" && err.name !== "Error" ? err.name : "";
  if (status) return `Upload failed (${name || "server error"} ${status})`;
  return name ? `Upload failed (${name})` : "Upload failed";
}

export function statusRows(all: UploadItem[], limit: number): UploadItem[] {
  if (all.length <= limit) return all;
  const keep = new Set<number>();
  const add = (i: number) => {
    if (keep.size < limit) keep.add(i);
  };
  all.forEach((item, i) => item.status === "failed" && add(i));
  all.forEach((item, i) => item.status === "uploading" && add(i));
  let next = 0;
  for (let i = 0; i < all.length && next < 20; i++) {
    if (all[i].status === "pending") {
      add(i);
      next++;
    }
  }
  for (let i = all.length - 1; i >= 0 && keep.size < limit; i--) {
    if (all[i].status === "done" || all[i].status === "skipped") add(i);
  }
  return [...keep].sort((a, b) => a - b).map((i) => all[i]);
}

export function cancelUpload(): void {
  // The groups still waiting hold frames nothing will ever spend now. The one already
  // draining cleans up after itself when it unwinds.
  // A drive drop's staged copies are kept: the original may be gone, so they wait for the
  // host to upload them again rather than being thrown away with the queue.
  for (const group of queue) {
    void discardFrames(group);
    if (group.staging) void releaseStaging(group.staging);
  }
  queue = [];
  abort.abort();
  cancelImport();
}

/** Drops finished rows so a long-lived panel does not grow forever. */
export function clearFinishedUploads(): void {
  if (status.running || status.importing) return;
  status.importError = undefined;
  status.moveResult = undefined;
  status.albumNotes = undefined;
  status.items = [];
  status.total = 0;
  status.done = 0;
  status.skipped = 0;
  status.failed = 0;
  status.saved = undefined;
}

/** Whether a file of this name is a photo or video the upload takes. */
export function isMediaName(name: string): boolean {
  return !!mediaTypeOf(name);
}

function mediaTypeOf(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return IMAGE_TYPES[ext] ?? VIDEO_TYPES[ext] ?? null;
}

/**
 * The Drive photo tags that apply to one file, from its media type, its name and the name of
 * the folder it is in.
 *
 * Without these a video uploaded here reached Proton carrying no tag at all, and the
 * clients that read video-ness off the tag then showed it as a still photo.
 *
 * Only tags that follow from what is already known are set. Video and Raw are exact:
 * one is the media type, the other the container. Screenshot and Burst are name
 * conventions rather than facts about the bytes, and are the same rules the Android client
 * uses (its folder is the gallery bucket), so the same file classifies alike whichever
 * client sent it.
 *
 * Motion photo is set by the upload itself, which reads the file for its clip. Deliberately
 * absent: Panorama, which lives in the file's XMP; and Favorite, Selfie and Portrait, which
 * nothing on a desktop can determine. Guessing any of them from aspect ratio or size would
 * only be an invention.
 */
export function photoTagsFor(mediaType: string, name: string, folder = ""): number[] {
  const tags: number[] = [];
  const mime = mediaType.toLowerCase();
  const lower = name.toLowerCase();
  const bucket = folder.toLowerCase();
  const ext = extname(lower);

  if (
    mime.startsWith("image/") &&
    (bucket.includes("screenshot") || lower.startsWith("screenshot") || lower.startsWith("screen_shot"))
  ) {
    tags.push(TAG_SCREENSHOT);
  }
  if (mime.startsWith("video/")) tags.push(TAG_VIDEO);
  if (bucket.includes("burst") || lower.startsWith("burst")) tags.push(TAG_BURST);
  if (RAW_EXTENSIONS.has(ext)) tags.push(TAG_RAW);

  return tags;
}

/**
 * Every media file under `dir`, walked into sub-folders so a dropped folder-of-folders
 * (e.g. Pictures\2023\, 2024\) uploads its photos instead of silently uploading nothing.
 * A name starting with `.` (a hidden file or folder) is left out with everything under it.
 * Symbolic links are never followed, so there is no loop and nothing outside the dropped
 * tree is reached; depth is bounded as a second guard against a pathological tree.
 */
async function listMedia(dir: string): Promise<string[]> {
  const out: string[] = [];
  await walkMedia(dir, out, 0);
  return out.sort();
}

async function walkMedia(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 24) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // an unreadable sub-folder is skipped, not fatal
  }
  for (const e of entries) {
    if (e.isSymbolicLink() || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkMedia(full, out, depth + 1);
    } else if (e.isFile() && mediaTypeOf(e.name)) {
      out.push(full);
    }
  }
}

function sha1Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    // Large reads: an export is read whole once, and small ones cost more than the hashing.
    createReadStream(path, { highWaterMark: 1 << 20 })
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Whether sharp can open this file itself, which is also what decides where its
 *  dimensions come from: its own reading of the file, or what the shell said. */
function sharpCanDecode(path: string, mediaType: string): boolean {
  return mediaType.startsWith("image/") && !SHARP_CANNOT_DECODE.has(extname(path).toLowerCase());
}

/**
 * The dimensions a file is displayed at, which is what has to be stored.
 *
 * EXIF orientations 5 to 8 turn the image onto its other edge, so the stored width and
 * height are the ones a viewer draws rather than the ones in the header. Recording the
 * unturned pair would report a portrait phone photo as a landscape one.
 *
 * Null unless both edges are real positive numbers: a single edge is not a dimension,
 * and a zero is not a measurement.
 */
export function displayDimensions(
  width: number | undefined,
  height: number | undefined,
  orientation: number | undefined,
): { width: number; height: number } | null {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const turned = typeof orientation === "number" && orientation >= 5 && orientation <= 8;
  return turned
    ? { width: Math.round(h), height: Math.round(w) }
    : { width: Math.round(w), height: Math.round(h) };
}

/** What a photo says about where and on what it was taken. */
export type PhotoAttributes = {
  Media?: { Width?: number; Height?: number; Duration?: number };
  Location?: { Latitude: number; Longitude: number };
  Camera?: { Device?: string };
};

/**
 * The extended attributes of one file, or nothing at all to say.
 *
 * Drive shapes these as `{"Common":{...},"Media":{...},"Location":{...},"Camera":{...}}`,
 * and the SDK writes `Common` itself and merges this alongside it. **Duration is in
 * SECONDS**, which is the unit the readers on the other side scale by a thousand.
 *
 * `Location` is what puts a photo on a map. The coordinate is inside the file's own EXIF
 * either way, since the bytes upload untouched, but Proton's clients read the place from
 * this block rather than by opening the file, so a photo without it is a photo the map
 * cannot find.
 *
 * Nothing known means `undefined` rather than an empty block, so a file this can say
 * nothing about uploads with exactly the attributes it always had. A zero is never
 * written for a measurement: absent means unknown, whereas a zero would be read as an
 * answer. A coordinate is the exception, where 0 is a real place, so those are kept on
 * range and finiteness alone.
 */
export function mediaAttributes(info: {
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  device?: string | null;
}): PhotoAttributes | undefined {
  const out: PhotoAttributes = {};
  const media: { Width?: number; Height?: number; Duration?: number } = {};

  // No orientation to apply: both sources hand over dimensions already the way round they
  // are displayed, so this is reusing the same checks on a pair that needs no turning.
  const dims = displayDimensions(info.width ?? undefined, info.height ?? undefined, undefined);
  if (dims) {
    media.Width = dims.width;
    media.Height = dims.height;
  }
  const duration = Number(info.durationSec);
  if (Number.isFinite(duration) && duration > 0) media.Duration = duration;
  if (Object.keys(media).length > 0) out.Media = media;

  // Both halves or neither: half a coordinate is not a place, and writing one of them
  // would put the photo on the equator or the prime meridian rather than nowhere.
  // A missing half stays missing: Number(null) is 0, a real place.
  const lat = typeof info.latitude === "number" ? info.latitude : NaN;
  const lon = typeof info.longitude === "number" ? info.longitude : NaN;
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  ) {
    out.Location = { Latitude: lat, Longitude: lon };
  }

  const device = (info.device ?? "").trim();
  if (device) out.Camera = { Device: device.slice(0, 128) };

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A still's displayed dimensions, read from its header.
 *
 * Only ever called for a file sharp can open, which is the same file it is about to
 * thumbnail, so this costs a header read and never a decode. A video's dimensions can
 * not come from here: what sharp is handed for one of those is the staged frame, whose
 * size is the thumbnail's rather than the video's.
 */
async function stillDimensions(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const meta = await sharp(path).metadata();
    return displayDimensions(meta.width, meta.height, meta.orientation);
  } catch {
    return null; // unreadable header: the upload is still what was asked for
  }
}

/** EXIF capture time when the photo carries one, otherwise the file's mtime. */
/**
 * One readable name from EXIF's separate make and model fields.
 *
 * "Apple iPhone 15" reads better than the two apart, but the model often already opens
 * with the make, and Samsung and Google both write it that way. Joining blindly gives
 * "samsung SM-S901B" as "samsung samsung SM-S901B".
 */
export function deviceName(make?: unknown, model?: unknown): string {
  const mk = String(make ?? "").trim();
  const md = String(model ?? "").trim();
  if (md && mk && !md.toLowerCase().startsWith(mk.toLowerCase())) return `${mk} ${md}`;
  return md || mk;
}

/** What one EXIF read can tell about a photo. Every field is absent when unknown,
 *  including the capture time: the caller decides what to fall back to. */
type ExifFacts = {
  captureTime?: Date;
  latitude?: number;
  longitude?: number;
  device?: string;
};

/**
 * Read the file's EXIF once, for everything taken from it.
 *
 * One parse rather than one per fact: this runs for every file in an upload, and the
 * reader opens and scans the header each time it is called.
 *
 * `gps: true` is what turns the raw coordinate fields into signed `latitude` and
 * `longitude`. Read separately they arrive as degrees, minutes and seconds with the
 * hemisphere in a neighbouring field, and a photo south or west of zero would upload
 * on the wrong side of the planet.
 */
export async function exifFactsOf(path: string): Promise<ExifFacts> {
  const facts: ExifFacts = {};
  try {
    // The signed pair is worked out from the four GPS tags, so those are what has to be picked:
    // picking "latitude" and "longitude" by name leaves both out.
    const exif = await exifr.parse(path, {
      pick: [
        "DateTimeOriginal",
        "CreateDate",
        "Make",
        "Model",
        "GPSLatitude",
        "GPSLatitudeRef",
        "GPSLongitude",
        "GPSLongitudeRef",
      ],
      gps: true,
    });
    const taken = exif?.DateTimeOriginal ?? exif?.CreateDate;
    if (taken instanceof Date && !Number.isNaN(taken.getTime())) facts.captureTime = taken;
    if (typeof exif?.latitude === "number") facts.latitude = exif.latitude;
    if (typeof exif?.longitude === "number") facts.longitude = exif.longitude;
    const device = deviceName(exif?.Make, exif?.Model);
    if (device) facts.device = device;
  } catch {
    /* not an image, or no EXIF */
  }
  return facts;
}

/**
 * A video's place and camera from its own MP4/MOV tags, which exifr does not read. Read from the
 * original, so a lighter copy goes up with what the file it was made from says.
 */
async function videoFactsOf(path: string): Promise<ExifFacts> {
  const tags = await readVideoTags(path);
  const facts: ExifFacts = {};
  if (tags.latitude !== undefined && tags.longitude !== undefined) {
    facts.latitude = tags.latitude;
    facts.longitude = tags.longitude;
  }
  const device = deviceName(tags.make, tags.model);
  if (device) facts.device = device;
  return facts;
}

/**
 * A small grid thumbnail and an HD preview. Empty when the file cannot be decoded.
 *
 * `framePath` is a picture of this file the host already made, and it is the only way a
 * video reaches sharp at all. Without one the rule is exactly what it has always been:
 * stills sharp can decode get thumbnails, and anything else uploads without.
 */
async function makeThumbnails(
  path: string,
  mediaType: string,
  framePath?: string,
): Promise<any[]> {
  const input = framePath ?? path;
  if (!framePath && !sharpCanDecode(path, mediaType)) return [];
  try {
    // A staged frame carries no EXIF, so the turn below finds nothing to apply and the
    // shell's own right-way-up picture is left as it is. An ordinary photo is unaffected.
    const source = sharp(input, { failOn: "none" }).rotate(); // honour EXIF orientation
    return await thumbnailPair(source);
  } catch {
    return []; // a thumbnail is never worth failing the upload over
  } finally {
    // Spent either way: a frame sharp choked on is no more use than one it read.
    if (framePath) await rm(framePath, { force: true }).catch(() => {});
  }
}

/** The grid thumbnail and the HD preview Drive keeps beside a photo, each within its limit. */
export async function thumbnailPair(source: ReturnType<typeof sharp>): Promise<any[]> {
  // Both settled before either failure is passed on: the other may still be reading the file,
  // and on Windows a file still open cannot be deleted, so a staged frame would be left behind.
  const [small, preview] = await Promise.allSettled([
    jpegWithinBudget(source, THUMB_SMALL_PX, THUMB_SMALL_MAX_BYTES),
    jpegWithinBudget(source, THUMB_PREVIEW_PX, THUMB_PREVIEW_MAX_BYTES),
  ]);
  if (small.status === "rejected") throw small.reason;
  if (preview.status === "rejected") throw preview.reason;
  return [
    { type: ThumbnailType.Type1, thumbnail: new Uint8Array(small.value) },
    { type: ThumbnailType.Type2, thumbnail: new Uint8Array(preview.value) },
  ];
}

/**
 * The photo scaled to fit `maxPx` and encoded as a JPEG of at most `maxBytes`.
 *
 * Scaled once, then encoded at falling quality until it fits, so a large original is
 * decoded a single time however many steps it takes. If even the lowest quality is too
 * heavy the picture shrinks by a quarter and the steps start again.
 */
async function jpegWithinBudget(source: ReturnType<typeof sharp>, maxPx: number, maxBytes: number): Promise<Buffer> {
  // A JPEG has no transparency: a see-through picture (a screenshot, a signature) is laid on
  // white, as a viewer shows it, rather than on the black its empty pixels hold.
  let { data, info } = await source
    .clone()
    .resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (;;) {
    const raw = { width: info.width, height: info.height, channels: info.channels };
    for (const quality of THUMB_QUALITY_STEPS) {
      const jpeg = await sharp(data, { raw }).jpeg({ quality }).toBuffer();
      if (jpeg.length <= maxBytes) return jpeg;
    }
    const width = Math.max(1, Math.floor(info.width * 0.75));
    const height = Math.max(1, Math.floor(info.height * 0.75));
    if (width === info.width && height === info.height) {
      throw new Error("thumbnail does not fit its size limit");
    }
    ({ data, info } = await sharp(data, { raw })
      .resize(width, height)
      .raw()
      .toBuffer({ resolveWithObject: true }));
  }
}

/**
 * Uploads one file. `uid` is the new node, or null when the library already held the
 * file, in which case `duplicates` names the photos it already is.
 */
async function uploadOne(
  photos: any,
  path: string,
  framePath: string | undefined,
  shellMedia: ShellMediaInfo | undefined,
  signal: AbortSignal,
  favorite = false,
  sidecar?: SidecarMeta,
  options: {
    mainPhotoNodeUid?: string;
    extraTags?: number[];
    known?: string;
    fresh?: boolean;
    /** Called once the library is known not to have the file, just before it is sent. */
    onCleared?: () => void;
    onProgress?: (sent: number, size: number) => void;
    /**
     * Make a lighter copy to upload in its place. The copy made on a first try is kept here and
     * used again by the next, so a retry does not compress twice.
     */
    compress?: LighterUpload;
  } = {},
): Promise<{ uid: string | null; duplicates: string[]; saved?: number; lighter?: boolean }> {
  const name = basename(path);
  const mediaType = mediaTypeOf(path);
  if (!mediaType) throw new Error("unsupported file type");
  // Already found in the library by the import's review: no second hash of the file.
  if (options.known) return { uid: null, duplicates: [options.known] };

  const info = await stat(path);
  options.onProgress?.(0, info.size);
  const sha1 = await sha1Of(path);

  // A file the import's review has just found new is not asked about a second time. The
  // original is asked about before any copy is made: one another device uploaded as it is is
  // in the library already, and goes up a second time in no form.
  const duplicates: string[] = options.fresh
    ? []
    : await photos.findPhotoDuplicates(name, async () => sha1, signal);
  if (duplicates.length > 0) return { uid: null, duplicates };
  // A lighter copy of this very file went up from here before. A video's copy need not come out
  // the same bytes twice, so the library's check by content could miss it: asked here instead,
  // also for a file the import's review found new, since that check knows only the bytes.
  if (options.compress) {
    const earlier = compressedUploadOf(sha1);
    if (earlier && (await stillInLibrary(photos, earlier)) && (await originalKept(options.compress, path))) {
      return { uid: null, duplicates: [earlier] };
    }
  }

  const exif: ExifFacts = {
    ...(mediaType.startsWith("video/") ? await videoFactsOf(path) : {}),
    ...(await exifFactsOf(path)),
  };
  // Capture time, in order of trust: the file's own EXIF date; for a video with no EXIF
  // date, the mvhd creation time (which exifr rarely reads); then the file's copy time as
  // a last resort, so a timeline date is always set. Without the mvhd step every video
  // lands at the moment it was copied to disk rather than when it was filmed.
  // An export's own record of when the photo was taken outranks the file's, which an
  // export has often lost or reset.
  let captureTime = sidecar?.takenMs ? new Date(sidecar.takenMs) : exif.captureTime;
  if (!captureTime && mediaType.startsWith("video/")) {
    captureTime = (await readMp4CreationTime(path)) ?? undefined;
  }
  if (!captureTime) captureTime = info.mtime;

  // The lighter copy, made once; the same file at the same settings makes the same copy, so one
  // uploaded from here before is found in the library like the original would be.
  let copy: PreparedCopy | null = null;
  if (options.compress && options.compress.kept !== false) {
    if (options.compress.copy === undefined) {
      options.compress.copy = await compressForUpload(path, mediaType, captureTime, signal, options.compress.onProgress);
    }
    copy = options.compress.copy;
  }
  // Where the lighter copy would be all that is left of the photo, the original is kept first;
  // one that cannot be kept goes up as it is.
  if (copy && options.compress && !(await originalKept(options.compress, path))) {
    await rm(copy.path, { force: true }).catch(() => {});
    options.compress.copy = copy = null;
  }
  let sendSha1 = sha1;
  if (copy) {
    sendSha1 = await sha1Of(copy.path);
    const already: string[] = await photos.findPhotoDuplicates(copy.name, async () => sendSha1, signal);
    if (already.length > 0) return { uid: null, duplicates: already, lighter: true };
  }
  const sendPath = copy?.path ?? path;
  const sendSize = copy?.size ?? info.size;
  options.onCleared?.();
  options.onProgress?.(0, sendSize);

  // Dimensions come from whichever side actually opened the file. The shell answered for
  // a video and for the stills sharp has no decoder for; everything else sharp reads
  // itself, off the same file it is about to thumbnail. The two never cover the same
  // file, so neither can contradict the other.
  const shellDims =
    shellMedia?.width && shellMedia?.height
      ? { width: shellMedia.width, height: shellMedia.height }
      : null;
  const dims =
    copy && copy.mediaType.startsWith("image/")
      ? await stillDimensions(copy.path)
      : shellDims
        ? copy
          ? { width: Math.round(shellDims.width * copy.scale), height: Math.round(shellDims.height * copy.scale) }
          : shellDims
        : sharpCanDecode(path, mediaType)
          ? await stillDimensions(path)
          : null;

  const thumbnails = copy?.mediaType.startsWith("image/")
    ? await makeThumbnails(copy.path, copy.mediaType, framePath)
    : await makeThumbnails(path, mediaType, framePath);

  // Blocks here until the SDK's upload queue has capacity. The tags ride along with the
  // rest of the metadata and the SDK commits them with the revision, which is the one
  // moment they can be set without a second round trip.
  const uploader = await photos.getFileUploader(
    copy?.name ?? name,
    {
      mediaType: copy?.mediaType ?? mediaType,
      expectedSize: sendSize,
      expectedSha1: sendSha1,
      modificationTime: info.mtime,
      captureTime,
      tags: [
        ...photoTagsFor(mediaType, name, basename(dirname(path))),
        // Only the original can hold a clip: a lighter copy is never made of a motion photo.
        ...(!copy && (await fileHasMotionClip(path, mediaType)) ? [PhotoTag.MotionPhotos] : []),
        ...(options.extraTags ?? []),
        ...(favorite || sidecar?.favorited ? [PhotoTag.Favorites] : []),
      ],
      // Set on a Live Photo's video: Drive keeps it with that photo as one item.
      mainPhotoNodeUid: options.mainPhotoNodeUid,
      // The SDK writes the `Common` block itself and merges this beside it, so this
      // carries only what it does not already know. A file nothing could be learned
      // about passes `undefined` and uploads with exactly the attributes it always had.
      additionalMetadata: mediaAttributes({
        width: dims?.width,
        height: dims?.height,
        durationSec: shellMedia?.durationSec,
        latitude: sidecar?.latitude ?? exif.latitude,
        longitude: sidecar?.longitude ?? exif.longitude,
        device: exif.device,
      }),
    },
    signal,
  );

  // The SDK wants a web ReadableStream; Node gives us one straight off the disk
  // stream, so a large photo is never buffered in memory.
  const stream = Readable.toWeb(createReadStream(sendPath)) as any;
  // The SDK counts what has gone up, a block at a time, thumbnails included.
  const controller = await uploader.uploadFromStream(stream, thumbnails, (sent: number) =>
    options.onProgress?.(Math.min(sent, sendSize), sendSize),
  );
  const { nodeUid } = await controller.completion();
  if (copy) rememberCompressedUpload(sha1, nodeUid);
  return { uid: nodeUid, duplicates: [], saved: copy ? copy.sourceSize - copy.size : undefined, lighter: !!copy };
}

/**
 * How one file goes up lighter. `keepOriginal`, where it is set, puts the original somewhere it
 * can be had back before the library is left with only the lighter copy; `kept` is its answer,
 * asked once per file so a retry does not ask again.
 */
type LighterUpload = {
  copy?: PreparedCopy | null;
  onProgress?: (value: number) => void;
  keepOriginal?: (path: string) => Promise<boolean>;
  kept?: boolean;
};

/** Whether the original is safe to let go of for a lighter copy: kept, or nothing asked it be. */
async function originalKept(lighter: LighterUpload, path: string): Promise<boolean> {
  if (!lighter.keepOriginal) return true;
  if (lighter.kept === undefined) lighter.kept = await lighter.keepOriginal(path).catch(() => false);
  return lighter.kept;
}

/**
 * A file put in the Linux file manager's Proton Photos goes up from the host's staged copy, and
 * the file manager has already deleted the original it moved in. Before it goes up lighter, the
 * host puts the full-quality bytes in the desktop's trash, as the File Explorer folder sends its
 * original to the Recycle Bin. False when they could not be put there.
 */
async function keepDropOriginal(path: string, signal: AbortSignal): Promise<boolean> {
  await hostCall("keepDropOriginal", { path }, undefined, signal);
  return true;
}

/** The node `uid` as Drive has it now, or null when it cannot be read. */
async function nodeNow(photos: any, uid: string): Promise<any> {
  const got = await freshNode(photos, uid);
  return got?.ok === false ? null : (got?.value ?? got ?? null);
}

/**
 * The videos Drive keeps with the library photo `stillUid`, read from Drive rather than the
 * cache: whether it keeps any that is not in the trash, and whether one of them holds the bytes
 * whose SHA-1 `sha1` gives. A video that cannot be read counts as kept. Without the photo root's
 * hash key no bytes are matched.
 */
export async function videosKeptWith(
  photos: any,
  stillUid: string,
  sha1: () => Promise<string>,
): Promise<{ any: boolean; same: boolean }> {
  const still = await nodeNow(photos, stillUid);
  if (!still) throw new Error("its photo could not be read");
  const related: string[] = still.photo?.relatedPhotoNodeUids ?? [];
  if (related.length === 0) return { any: false, same: false };
  const key = await photoRootHashKey(photos);
  const hash = key ? contentHashOf(await sha1(), key) : null;
  let any = false;
  let same = false;
  for (const uid of related) {
    const video = await nodeNow(photos, uid).catch(() => null);
    if (video?.trashTime) continue;
    any = true;
    if (hash && video?.photo?.contentHash === hash) same = true;
  }
  return { any, same };
}

/** Whether the photo `uid` is still in the library: there, and not in the trash. */
async function stillInLibrary(photos: any, uid: string): Promise<boolean> {
  try {
    const got = await photos.getNode(uid);
    const node = got?.ok === false ? null : (got?.value ?? got);
    return !!node && !node.trashTime;
  } catch {
    return false;
  }
}

/**
 * Turns dropped paths into groups, one per album: each folder's own photos go into an album
 * named after that folder, so a folder of folders makes one album per folder.
 */
async function planGroups(paths: string[]): Promise<Group[]> {
  const dropped: { path: string; files: string[] }[] = [];
  for (const path of paths) {
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) dropped.push({ path, files: await listMedia(path) });
    else if (mediaTypeOf(path)) dropped.push({ path, files: [path] });
  }
  return albumGroups(dropped).map(({ album, files }) => ({
    album,
    files,
    startIndex: 0,
    frames: new Map(),
    media: new Map(),
  }));
}

/**
 * Sorts the files of each dropped path into albums. A file in a dropped folder goes into the
 * album of the folder it sits in; a file dropped on its own, or one in a folder that is no
 * album (a timeline bucket such as "Photos from 2019"), goes to the timeline group, which
 * comes last. Albums whose names differ only in case or padding are one, under the first
 * spelling seen.
 */
export function albumGroups(dropped: { path: string; files: string[] }[]): { album: string | null; files: string[] }[] {
  const byKey = new Map<string, { album: string; files: string[] }>();
  const timeline: string[] = [];
  for (const { path, files } of dropped) {
    for (const file of files) {
      const album = file === path ? null : folderAlbum(basename(dirname(file)));
      if (album === null) {
        timeline.push(file);
        continue;
      }
      const key = album.toLocaleLowerCase();
      const group = byKey.get(key);
      if (group) group.files.push(file);
      else byKey.set(key, { album, files: [file] });
    }
  }
  const groups: { album: string | null; files: string[] }[] = [...byKey.values()];
  if (timeline.length > 0) groups.push({ album: null, files: timeline });
  return groups;
}

// How many files a single upload works on at once. Bounds the per-file prep (hash, EXIF,
// thumbnails) so a large folder cannot pile its buffers up behind the SDK's own 5-wide
// upload gate and run the process out of memory. Deliberately small; raising it trades
// memory for a throughput the SDK gate caps anyway.
const UPLOAD_CONCURRENCY = 4;

// Set once a block has taken long enough that the uplink sets the pace: from then on one
// file goes up at a time, so the files no longer split a slow line between them and each
// get too little of it to finish a block in time. Cleared when the queue next starts.
let slowLink = false;

/** Photos sent to an album per step: a step that fails costs only these. */
const ALBUM_CHUNK = 500;
/** How long an album or favourite step may go without an answer before it is given up. */
const STEP_STALL_MS = 120_000;
/** The API's answer for a photo the album already holds. */
const ALREADY_EXISTS = 2500;
/** The API's answer when an album holds as many photos as it may. */
const ALBUM_FULL = 200300;
/** The most parts an album is split into ("Name (2)" and on). */
const ALBUM_PARTS_MAX = 20;

const isAlbumFull = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === ALBUM_FULL;

function noteAlbum(note: AlbumNote): void {
  status.albumNotes = [...(status.albumNotes ?? []), note];
}

/**
 * The parts an album was split into before ("Name (2)" and on), the fullest of each number,
 * with the photos they hold, so photos already in one are not put in another.
 */
async function albumParts(photos: any, name: string): Promise<{ parts: Map<number, string>; members: Set<string> }> {
  const base = name.trim().toLocaleLowerCase();
  const found = new Map<number, { uid: string; count: number }>();
  for (const album of await listAlbums(photos)) {
    const m = /^(.*) \((\d+)\)$/.exec(album.name.trim());
    if (!m || m[1].trim().toLocaleLowerCase() !== base) continue;
    const n = Number(m[2]);
    if (n < 2 || n > ALBUM_PARTS_MAX) continue;
    const had = found.get(n);
    if (!had || album.photoCount > had.count) found.set(n, { uid: album.uid, count: album.photoCount });
  }
  const parts = new Map<number, string>();
  const members = new Set<string>();
  for (const [n, { uid }] of found) {
    parts.set(n, uid);
    for (const p of await listAlbumPhotos(photos, uid)) members.add(p.uid);
  }
  return { parts, members };
}

/**
 * Puts `uids` into an album, a chunk at a time, with its progress in the status and the log.
 * When the server answers that the album is full (code 200300), the rest go into "Name (2)"
 * and on, found or made. A chunk that fails or stalls is tried once more for what it had not
 * put in; what still will not go in is counted, and those photos stay in the library, not in
 * the album.
 */
export async function addAllToAlbum(
  photos: any,
  albumUid: string,
  name: string,
  uids: string[],
  limits: { chunk: number; stallMs: number } = { chunk: ALBUM_CHUNK, stallMs: STEP_STALL_MS },
): Promise<void> {
  const { chunk: chunkSize, stallMs } = limits;
  /** Still to put in. */
  let rest = uids.slice();
  /** How many have been dealt with: put in, found already there, or given up on. */
  let dealt = 0;
  let failed = 0;
  const show = (inFlight = 0) => {
    status.albumStep = { album: name, added: dealt + inFlight, total: uids.length };
  };
  show();
  let target = albumUid;
  let full = false;
  let part = 1;
  let putInPart = 0;
  /** Whether this run made the part it is filling, so one left empty is taken away again. */
  let madeHere = false;
  let parts: Map<number, string> | null = null;
  let loggedAt = 0;
  const leavePart = async () => {
    if (part > 1 && putInPart > 0) noteAlbum({ kind: "split", album: name, part: `${name} (${part})`, moved: putInPart });
    if (madeHere && putInPart === 0) {
      await deleteAlbum(photos, target).catch((e) =>
        process.stderr.write(`[upload] empty album part not removed: ${(e as Error).message}\n`),
      );
    }
    putInPart = 0;
    madeHere = false;
  };
  try {
    while (rest.length > 0) {
      if (full) {
        full = false;
        // A part this run made that took nothing is refused from the start: no point in more.
        if (part >= ALBUM_PARTS_MAX || (madeHere && putInPart === 0)) break;
        if (!parts) {
          // Read once, at the first full answer: an import run again finds its earlier parts here.
          const found = await albumParts(photos, name);
          parts = found.parts;
          const before = rest.length;
          rest = rest.filter((u) => !found.members.has(u));
          dealt += before - rest.length;
          show();
          if (rest.length === 0) break;
        }
        await leavePart();
        part++;
        const known = parts.get(part);
        if (known) target = known;
        else {
          target = (await createAlbum(photos, `${name} (${part})`)).uid;
          madeHere = true;
        }
        continue;
      }
      const chunk = rest.slice(0, chunkSize);
      const settled = new Set<string>();
      /** Refused because the album is full: they go on in the next part. */
      const overflow = new Set<string>();
      let refused = 0;
      let error: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        // What the first try put in is not sent again: in the next part it would be in two.
        const todo = chunk.filter((u) => !settled.has(u) && !overflow.has(u));
        if (todo.length === 0) {
          error = null;
          break;
        }
        const stop = new AbortController();
        try {
          const added = photos.addPhotosToAlbum(target, todo, stop.signal);
          for await (const result of withStallGuard<any>(added, stallMs, "addPhotosToAlbum")) {
            if (!result.ok && isAlbumFull(result.error)) {
              overflow.add(result.uid);
              continue;
            }
            settled.add(result.uid);
            if (result.ok) putInPart++;
            else if (result.error?.code === ALREADY_EXISTS || result.error?.name === "PhotoAlreadyInTargetError") {
              // Already in it: a step that stalled after its request went through, asked again.
            } else if (++refused === 1) {
              process.stderr.write(`[upload] album add refused (${result.error?.name} ${result.error?.code ?? ""})\n`);
            }
            show(settled.size);
          }
          error = null;
          break;
        } catch (e) {
          stop.abort();
          error = e as Error;
          process.stderr.write(`[upload] album add step failed (${error.name} ${(error as any).code ?? ""})\n`);
          // The server's no is not changed by asking again.
          if (error.name === "ValidationError" || isAlbumFull(error)) break;
        }
      }
      failed += refused;
      full = overflow.size > 0 || (error !== null && isAlbumFull(error));
      if (!error) {
        // Every photo was answered for; one the SDK passed over without a word did not go in.
        for (const u of chunk) {
          if (settled.has(u) || overflow.has(u)) continue;
          failed++;
          settled.add(u);
        }
      }
      rest = rest.filter((u) => !settled.has(u));
      dealt += settled.size;
      show();
      if (full) continue;
      if (error) {
        // Anything else that will not go in (no connection, no answer, the server saying no)
        // would say no to the rest too: they are counted, and an import run again puts them in.
        failed += rest.length;
        dealt += rest.length;
        rest = [];
        show();
        break;
      }
      if (dealt - loggedAt >= 500 || rest.length === 0) {
        loggedAt = dealt;
        process.stderr.write(`[upload] album add ${dealt}/${uids.length}\n`);
      }
    }
    await leavePart();
    failed += rest.length;
    if (failed > 0) {
      process.stderr.write(`[upload] add to album failed for ${failed} photo(s)\n`);
      noteAlbum({ kind: "failed", album: name, count: failed });
    }
  } catch (e) {
    process.stderr.write(`[upload] addPhotosToAlbum: ${(e as Error).message}\n`);
    await leavePart().catch(() => {});
    noteAlbum({ kind: "failed", album: name, count: rest.length + failed });
  } finally {
    status.albumStep = undefined;
  }
}

async function drain(photos: any): Promise<void> {
  draining = true;
  status.running = true;
  slowLink = false;
  watchSlowUploads(() => {
    if (slowLink) return;
    slowLink = true;
    process.stderr.write("[upload] slow uplink: one file at a time\n");
  });

  try {
    while (queue.length > 0 && !abort.signal.aborted) {
      const group = queue.shift()!;
      // However this group ends, its frames go with it. A duplicate never reaches the
      // thumbnailer that would have spent one, an album that could not be created skips
      // the whole group, and a cancel leaves the rest untouched.
      try {
        // Never log the album name: it is the user's own folder name, which is
        // routinely a person's name. The destination kind and the count are enough
        // to follow an upload in the log.
        process.stderr.write(
          `[upload] start ${group.album ? "album" : "timeline"}: ${group.files.length} files\n`,
        );

        let albumUid: string | null = group.albumUid ?? null;
        // Created for this group alone, so it is removed again if nothing ends up in it.
        let albumIsNew = false;
        if (group.album && !albumUid) {
          try {
            // A folder uploaded again goes back into its album rather than making
            // another one of the same name.
            albumUid = await findAlbumByName(photos, group.album).then(
              (album) => album?.uid ?? null,
              (e) => {
                process.stderr.write(`[upload] album lookup: ${(e as Error).message}\n`);
                return null;
              },
            );
            if (!albumUid) {
              albumUid = (await createAlbum(photos, group.album)).uid;
              albumIsNew = true;
            }
          } catch (e) {
            // Without the album these photos would silently land on the timeline,
            // which is not what was asked for, so fail the group instead.
            for (let i = 0; i < group.files.length; i++) {
              const item = status.items[group.startIndex + i];
              item.status = "failed";
              item.error = `could not create album: ${(e as Error).message}`;
              status.failed++;
            }
            continue;
          }
        }

        const uploaded: string[] = [];
        // What goes into the album: the new uploads, and the photos the library already
        // had, since the folder holds them too. Never one the album already contains.
        const toAlbum: string[] = [];
        const toAlbumSet = new Set<string>();
        const inAlbum = new Set<string>();
        if (albumUid && !albumIsNew) {
          try {
            for (const photo of await listAlbumPhotos(photos, albumUid)) inAlbum.add(photo.uid);
          } catch (e) {
            process.stderr.write(`[upload] album members: ${(e as Error).message}\n`);
          }
        }
        const intoAlbum = (uid: string) => {
          if (albumUid && !inAlbum.has(uid) && !toAlbumSet.has(uid)) {
            toAlbumSet.add(uid);
            toAlbum.push(uid);
          }
        };
        // A photo the library already had, copied into the Favorites folder: what was
        // asked for is that photo as a favourite.
        const toFavorite: string[] = [];
        const toFavoriteSet = new Set<string>();

        // A bounded worker pool over the group's files. The SDK's own queue caps the
        // uploads at 5 concurrent, but the expensive per-file PREP (hashing, EXIF read,
        // sharp thumbnails) runs BEFORE that gate, so firing the whole folder at once
        // piles every file's hash job and thumbnail buffers up behind those 5 slots and
        // exhausts memory on a large drop. Capping the whole per-file job keeps only a
        // handful resident at a time. (The sibling Android import learned the same at 3.)
        const processFile = async (file: string, i: number) => {
          if (group.albumOnly) {
            const uid = group.uidOf?.get(file) ?? group.known?.get(file);
            if (uid) intoAlbum(uid);
            return;
          }
          const item = status.items[group.itemOf?.get(file) ?? group.startIndex + i];
          if (abort.signal.aborted) return;
          const fileStarted = Date.now();
          item.status = "uploading";
          const progress = (sent: number, size: number) => {
            item.sent = sent;
            item.size = size;
          };
          const videos = group.related?.get(file) ?? [];
          const video = videos[0];
          let mainUid: string | null = null;
          let stillWentUp = false;
          // In the library as a lighter copy, uploaded now or found there.
          let wentLighter = false;
          // Not a Live Photo's still: its video is matched to it as it was taken.
          const compress: LighterUpload | undefined =
            group.compress && !video
            ? {
                onProgress: (value: number) => {
                  item.compressing = value;
                },
                keepOriginal:
                  group.fromDrive && process.platform === "linux"
                    ? (path: string) => keepDropOriginal(path, abort.signal)
                    : undefined,
              }
            : undefined;
          try {
            const key = frameKey(file);
            let attempt = 0;
            let cleared = false;
            const { uid, duplicates, saved, lighter } = await withRetry(
              () =>
                uploadOne(
                  photos,
                  file,
                  group.frames.get(key),
                  group.media.get(key),
                  abort.signal,
                  group.favorite,
                  group.sidecars?.get(file),
                  {
                    known: group.known?.get(file),
                    // A try after a failure asks the library first: the failed one may
                    // have finished on the server with only its answer lost.
                    fresh: attempt++ === 0 && group.fresh?.has(file),
                    onCleared: () => {
                      cleared = true;
                    },
                    extraTags: video ? [PhotoTag.LivePhotos] : [],
                    onProgress: progress,
                    compress,
                  },
                ),
              UPLOAD_RETRY_MS,
              abort.signal,
            );
            mainUid = uid ?? duplicates[0] ?? null;
            // Up now, or found on a retry after an earlier try of this run had found nothing
            // there and begun sending it (its answer lost): either way, a still this run put
            // there. A try that failed before asking proves nothing, so it does not count.
            stillWentUp = uid !== null || cleared;
            wentLighter = !!lighter && mainUid !== null;
            if (mainUid) group.uidOf?.set(file, mainUid);
            if (uid) {
              uploaded.push(uid);
              intoAlbum(uid);
              item.status = "done";
              status.done++;
              if (saved && saved > 0) {
                item.saved = saved;
                status.saved = (status.saved ?? 0) + saved;
              }
            } else {
              // Bytes the library already has, from a folder uploaded again or a photo
              // copied into an album folder in the file manager: what was asked for is
              // that photo in that album, so it goes in, and only once.
              if (duplicates[0]) intoAlbum(duplicates[0]);
              if (duplicates[0] && group.favorite && !toFavoriteSet.has(duplicates[0])) {
                toFavoriteSet.add(duplicates[0]);
                toFavorite.push(duplicates[0]);
              }
              item.status = "skipped";
              item.error = "already in your library";
              status.skipped++;
            }
          } catch (e) {
            item.status = "failed";
            item.error = failureText(e);
            status.failed++;
          } finally {
            item.compressing = undefined;
            const made = compress?.copy;
            if (made) await rm(made.path, { force: true }).catch(() => {});
            diag.record("upload", "file", Date.now() - fileStarted, item.status !== "failed", {
              outcome: item.status,
              kb: Math.round((item.size ?? 0) / 1024),
            });
            // A file put in the File Explorer folder that went up as a lighter copy: the one
            // in the folder is no longer the photo's, so the host takes it out for the photo.
            if (group.fromDrive && wentLighter && process.platform === "win32") {
              noteDropReplaced(file);
            }
            // Gone only once the photo is in the library, uploaded now or already there.
            // A failed one stays staged, since a move into the drive has already deleted
            // the original, and the host uploads it again at the next unlock.
            if (group.fromDrive && item.status !== "failed") await discardStaged(file);
            // An unpacked export's copy is only ever a copy: gone as soon as it is used,
            // so a large export never holds the disk for longer than it must.
            if (group.staging && isStagedImport(file)) await rm(file, { force: true }).catch(() => {});
          }
          for (const [n, liveVideo] of videos.entries()) await processLiveVideo(liveVideo, file, mainUid, stillWentUp, n > 0);
        };

        /**
         * A Live Photo's video, after the photo that went up or was found just before it. It is
         * already there only when a library photo or a video Drive keeps with that photo holds
         * its bytes. Any other video goes up: joined to the photo when that photo has no video,
         * else on its own. `afterAnother`: a video of the same photo came before it in this run.
         */
        const processLiveVideo = async (
          video: string,
          photo: string,
          mainUid: string | null,
          stillWentUp: boolean,
          afterAnother: boolean,
        ) => {
          const item = status.items[group.itemOf?.get(video) ?? -1];
          if (!item || abort.signal.aborted) return;
          try {
            if (!mainUid) throw new Error("its photo did not upload");
            let known = group.known?.get(video);
            let joined = false;
            if (!known && stillWentUp) joined = !afterAnother;
            else if (!known) {
              const kept = await withRetry(() => videosKeptWith(photos, mainUid, () => sha1Of(video)), UPLOAD_RETRY_MS, abort.signal);
              if (kept.same) known = mainUid;
              else joined = !afterAnother && !kept.any;
            }
            item.status = "uploading";
            const progress = (sent: number, size: number) => {
              item.sent = sent;
              item.size = size;
            };
            const key = frameKey(video);
            let attempt = 0;
            const { uid, duplicates } = await withRetry(
              () =>
                uploadOne(
                  photos,
                  video,
                  group.frames.get(key),
                  group.media.get(key),
                  abort.signal,
                  false,
                  group.sidecars?.get(photo),
                  {
                    mainPhotoNodeUid: joined ? mainUid! : undefined,
                    known,
                    fresh: attempt++ === 0 && group.fresh?.has(video),
                    onProgress: progress,
                  },
                ),
              UPLOAD_RETRY_MS,
              abort.signal,
            );
            // The SDK leaves the still's cached node without the video joined to it.
            if (uid && joined) await freshNode(photos, mainUid).catch(() => {});
            // The photo the video is in the library as: joined, its still; on its own, itself.
            const became = uid ? (joined ? mainUid : uid) : (duplicates[0] ?? null);
            if (became) group.uidOf?.set(video, became);
            // On its own, it goes into the album as its photo would have.
            if (!joined && became) intoAlbum(became);
            if (uid) {
              item.status = "done";
              status.done++;
            } else {
              item.status = "skipped";
              item.error = "already in your library";
              status.skipped++;
            }
          } catch (e) {
            item.status = "failed";
            item.error = failureText(e);
            status.failed++;
          } finally {
            if (group.staging && isStagedImport(video)) await rm(video, { force: true }).catch(() => {});
          }
        };
        let nextFile = 0;
        // Videos put off while another one is being transcoded, so the photos behind them go on.
        const putOff: number[] = [];
        const waitsForLane = (file: string) =>
          !!group.compress && !group.related?.has(file) && (mediaTypeOf(file)?.startsWith("video/") ?? false) && wouldCompress(mediaTypeOf(file)!);
        // On a slow line every worker but the first stops once its file is done.
        const worker = async (n: number) => {
          for (;;) {
            if (n > 0 && slowLink) return;
            if (abort.signal.aborted) return;
            let i: number | undefined;
            if (nextFile < group.files.length) {
              i = nextFile++;
              if (waitsForLane(group.files[i]) && videoLaneBusy() && nextFile < group.files.length) {
                putOff.push(i);
                continue;
              }
            } else {
              i = putOff.shift();
            }
            if (i === undefined) return;
            await processFile(group.files[i], i);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(UPLOAD_CONCURRENCY, group.files.length) }, (_, n) => worker(n)),
        );

        if (toFavorite.length > 0) {
          try {
            const updates = toFavorite.map((nodeUid) => ({ nodeUid, tagsToAdd: [PhotoTag.Favorites], tagsToRemove: [] }));
            for await (const result of withStallGuard<any>(photos.updatePhotos(updates), STEP_STALL_MS, "updatePhotos")) {
              if (!(result as any).ok) process.stderr.write(`[upload] favourite not set on a photo already there
`);
            }
          } catch (e) {
            process.stderr.write(`[upload] favourite: ${(e as Error).message}
`);
          }
        }

        if (albumUid && toAlbum.length > 0) {
          // Add the files that DID upload to their album even if the user cancelled:
          // they are already in the cloud, so finishing this beats leaving an empty
          // album with the photos orphaned on the timeline.
          await addAllToAlbum(photos, albumUid, group.album ?? "", toAlbum);
        } else if (albumUid && albumIsNew) {
          // Every file failed or was cancelled: an album made only for them would be left
          // empty, one more of the same name at each retry.
          try {
            await deleteAlbum(photos, albumUid);
          } catch (e) {
            process.stderr.write(`[upload] empty album not removed: ${(e as Error).message}\n`);
          }
        }
        process.stderr.write(
          `[upload] done ${group.album ? "album" : "timeline"}: ${uploaded.length}/${group.files.length} uploaded\n`,
        );
      } finally {
        await discardFrames(group);
        if (group.staging) await releaseStaging(group.staging);
      }
    }
  } catch (e) {
    process.stderr.write(`[upload] drain failed: ${(e as Error).stack ?? String(e)}\n`);
  } finally {
    watchSlowUploads(null);
    draining = false;
    status.running = false;
    if (abort.signal.aborted) abort = new AbortController(); // ready for the next drop
    // A cancel aborts the while loop even when a new batch was appended during
    // the abort->finally window; pick that pending work up instead of stranding it.
    if (queue.length > 0) void drain(photos);
  }
}

/**
 * Plain files land on the timeline. A folder becomes an album named after it,
 * and the media inside is uploaded into that album. Safe to call while an
 * upload is already running: the new work is appended.
 *
 * `frames` maps a path to a picture of it the host staged, for the files sharp cannot
 * open by itself. It is optional in the strictest sense: without it every video uploads
 * exactly as it did before, thumbnail and all missing. `media` is what the shell knew
 * about those same files and is optional on the same terms.
 */
export function startUpload(
  photos: any,
  paths: string[],
  given: Record<string, string> = {},
  media: Record<string, ShellMediaInfo> = {},
  album?: { uid: string; name: string },
): void {
  const frames = ownFrames(given);
  void (async () => {
    const planned = await planGroups(paths);
    // Picked from inside an album, everything goes into that one album, the files of a
    // folder included, rather than each folder making an album of its own.
    const groups: Group[] =
      album && planned.length > 0
        ? [
            {
              album: album.name.trim() || "Album",
              albumUid: album.uid,
              files: planned.flatMap((g) => g.files),
              startIndex: 0,
              frames: new Map(),
              media: new Map(),
            },
          ]
        : planned;
    if (groups.length === 0) {
      status.emptyDrops = (status.emptyDrops ?? 0) + 1;
      // Nothing in this drop is uploadable, so nothing will ever spend these.
      for (const frame of Object.values(frames)) {
        await rm(frame, { force: true }).catch(() => {});
      }
      return;
    }

    for (const group of groups) {
      group.startIndex = status.items.length;
      group.frames = framesForFiles(group.files, frames);
      group.media = framesForFiles(group.files, media);
      group.compress = true;
      for (const file of group.files) {
        status.items.push({ name: basename(file), album: group.album, status: "pending" });
      }
      queue.push(group);
    }
    status.total = status.items.length;

    if (!draining) void drain(photos);
  })();
}

/**
 * A drop onto the file-manager drive, from the host alone: its staged copies of the
 * files, and the album they go into when they were dropped into an album's folder (made
 * by the host beforehand, so a folder copied in file by file becomes one album rather
 * than one per file). Uploads through the same queue as an in-app drop, so it shows in
 * the same panel. Each staged copy is deleted once it is in the library; one whose upload
 * failed is kept, for the host to upload again.
 */
export function startDropUpload(
  photos: any,
  paths: string[],
  given: Record<string, string> = {},
  media: Record<string, ShellMediaInfo> = {},
  albumUid?: string,
  albumName?: string,
  favorite = false,
): void {
  const frames = ownFrames(given);
  // Only the host's staging folder is ever consumed, so a path from anywhere else is
  // not part of a drive drop at all and is refused rather than uploaded.
  const files = paths.filter((p) => isStagedDrop(p) && mediaTypeOf(p));
  for (const p of paths) if (!files.includes(p)) void discardStaged(p);
  if (files.length === 0) return;

  const group: Group = {
    album: albumUid ? (albumName?.trim() || "Album") : null,
    files,
    startIndex: status.items.length,
    frames: framesForFiles(files, frames),
    media: framesForFiles(files, media),
    albumUid: albumUid || undefined,
    fromDrive: true,
    favorite,
    // Only with the folder's own setting on: the lighter copy that goes up is what the folder
    // then holds, so the file put there is compressed with it. Off, it goes up as it is.
    compress: compression().local,
  };
  const kept = new Set(group.frames.values());
  for (const frame of Object.values(frames)) {
    if (!kept.has(frame)) void rm(frame, { force: true }).catch(() => {});
  }
  for (const file of files) {
    status.items.push({ name: basename(file), album: group.album, status: "pending" });
  }
  queue.push(group);
  status.total = status.items.length;
  if (!draining) void drain(photos);
}

/**
 * Folders brought in from My files: the Drive file each downloaded copy came from, the album
 * each goes into, and whether the originals go to the Drive trash once they are in Photos.
 */
type MyFilesJob = { client: any; move: boolean; sourceOf: Map<string, string>; albumOf: Map<string, string | null> };

/** The export made ready and waiting for the host's frames, if one is. */
let pendingImport: { roots: string[]; staged: string[]; myFiles?: MyFilesJob } | null = null;
let importAbort: AbortController | null = null;

/**
 * Starts importing a Google Takeout or Ente export: zips are unpacked, folders are read
 * where they are. Returns at once. When the files are on disk the status says `ready`
 * with the folders to read, the host makes video frames from them, and `prepareImport`
 * reads the export into a review.
 */
export function startImport(paths: string[]): void {
  if (status.importing) throw new Error("An import is already being prepared.");
  const zips = paths.filter(isZip);
  status.importError = undefined;
  if (!status.running) status.albumNotes = undefined;
  status.importing = { phase: "unpacking", done: 0, total: 0, part: 0, parts: zips.length };
  void sweepStaleStaging();
  const controller = new AbortController();
  importAbort = controller;

  void (async () => {
    const roots: string[] = [];
    const staged: string[] = [];
    try {
      let part = 0;
      for (const path of paths) {
        if (!isZip(path)) {
          roots.push(path);
          continue;
        }
        part++;
        const root = await unpackZip(
          path,
          (name) => !!mediaTypeOf(name),
          (done, total) => {
            status.importing = { phase: "unpacking", done, total, part, parts: zips.length };
          },
          controller.signal,
        );
        staged.push(root);
        roots.push(root);
      }
      if (controller.signal.aborted) throw new Error("cancelled");
      pendingImport = { roots, staged };
      status.importing = { phase: "ready", done: 0, total: 0, part, parts: zips.length, roots };
    } catch (e) {
      for (const root of staged) await discardStagedImport(root);
      status.importing = undefined;
      if (!controller.signal.aborted) status.importError = (e as Error).message;
    } finally {
      if (importAbort === controller) importAbort = null;
    }
  })();
}

/**
 * Starts bringing in the photos and videos of folders in My files: they download into the
 * staging folder, keeping the folders, and the import then reads them as it reads an export,
 * each folder's own photos as an album named after it, through the same review. With `move`, each original goes
 * to the Drive trash once its photo is in the library. Returns at once.
 */
export function startMyFilesImport(
  client: any,
  folders: { uid: string; name: string }[],
  files: { uid: string; folder: string }[],
  move: boolean,
): void {
  if (status.importing) throw new Error("An import is already being prepared.");
  if (folders.length === 0 && files.length === 0) return;
  status.importError = undefined;
  status.moveResult = undefined;
  if (!status.running) status.albumNotes = undefined;
  status.importing = { phase: "downloading", done: 0, total: 0, part: 0, parts: 0 };
  const controller = new AbortController();
  importAbort = controller;

  void (async () => {
    let root: string | null = null;
    try {
      const items = await planMyFiles(client, folders, (name) => !!mediaTypeOf(name), controller.signal, files);
      if (items.length === 0) throw new Error("No photos or videos were found in the chosen folders.");
      const total = items.reduce((sum, item) => sum + item.size, 0);
      diag.log("myfiles", "plan", { folders: folders.length, files_chosen: files.length, items: items.length, mb: Math.round(total / 1048576), move });
      await ensureFreeSpace(total);
      root = join(importStagingDir(), `myfiles-${Date.now().toString(36)}`);
      const sourceOf = new Map<string, string>();
      const albumOf = new Map<string, string | null>();
      let done = 0;
      let fetched = 0;
      status.importing = { phase: "downloading", done: 0, total, part: 0, parts: items.length };
      await downloadMyFiles(
        client,
        items,
        root,
        (item, path) => {
          sourceOf.set(path, item.nodeUid);
          albumOf.set(path, item.album);
          done += item.size;
          fetched++;
          status.importing = { phase: "downloading", done, total, part: fetched, parts: items.length };
          process.stderr.write(`[import] my files: ${fetched}/${items.length} downloaded
`);
        },
        controller.signal,
      );
      if (controller.signal.aborted) throw new Error("cancelled");
      pendingImport = { roots: [root], staged: [root], myFiles: { client, move, sourceOf, albumOf } };
      status.importing = { phase: "ready", done: 0, total: 0, part: 0, parts: 0, roots: [root] };
    } catch (e) {
      process.stderr.write(`[import] my files stopped: ${(e as Error).name}: ${(e as Error).message}
`);
      if (root) await discardStagedImport(root);
      status.importing = undefined;
      if (!controller.signal.aborted) status.importError = (e as Error).message;
    } finally {
      if (importAbort === controller) importAbort = null;
    }
  })();
}

/**
 * When an imported photo was taken: its own EXIF date, a video's recorded time, the date its
 * file name gives, or else when the file was last changed (a zip entry's own time once unpacked).
 */
async function capturedAt(path: string): Promise<number> {
  const exif = await exifFactsOf(path);
  if (exif.captureTime) return exif.captureTime.getTime();
  if ((mediaTypeOf(path) ?? "").startsWith("video/")) {
    const recorded = await readMp4CreationTime(path).catch(() => null);
    if (recorded) return recorded.getTime();
  }
  return dateFromName(basename(path)) ?? (await stat(path)).mtimeMs;
}

/**
 * Sends to the Drive trash the originals whose photos are in the library now: each file that
 * uploaded or was found already there, once its photo has been looked up and seen.
 */
async function trashMovedOriginals(
  photos: any,
  job: MyFilesJob,
  outcomes: { source: string; settled: boolean; photo: string | null }[],
): Promise<void> {
  const asked = [...new Set(outcomes.filter((o) => o.settled && o.photo).map((o) => o.photo!))];
  const seen = new Set<string>();
  for await (const node of photos.iterateNodes(asked)) {
    if (node?.uid && !node.missingUid && !node.trashTime) seen.add(node.uid);
  }
  const toTrash = sourcesToTrash(outcomes, seen);
  let moved = 0;
  for await (const result of job.client.trashNodes(toTrash)) if (result?.ok) moved++;
  const kept = new Set(outcomes.map((o) => o.source)).size - moved;
  status.moveResult = { moved, kept, failed: moved < toTrash.length };
  process.stderr.write(`[import] moved from My files: ${moved}, kept: ${kept}\n`);
}

/** One item of an export under review, as the review screen draws it. */
export type ReviewItem = {
  id: number;
  path: string;
  name: string;
  album: string | null;
  video: boolean;
  takenMs?: number;
  latitude?: number;
  longitude?: number;
  description?: string;
  /** A Live Photo: its video, which uploads with this photo as one item. */
  live?: { path: string; name: string };
  favorite?: boolean;
  /** The other albums it joins, beside `album`. */
  alsoIn?: string[];
};

/**
 * What the library check found for one item: not yet checked, new, or already there (the same
 * bytes, under any name, in the library or earlier in the export). One already there is not
 * uploaded: the photo the library has goes into the album instead.
 */
export type ReviewCheck = "pending" | "new" | "already";

/** Why an item is already there: the library has its bytes, or the export holds them before it. */
export type ReviewReason = "same_file" | "same_in_export";

/** The export under review, between `prepareImport` and `confirmImport` or `discardImport`. */
let review: {
  items: ReviewItem[];
  plan: ExportItem[];
  staged: string[];
  frames: Record<string, string>;
  media: Record<string, ShellMediaInfo>;
  checks: ReviewCheck[];
  /** Why each item was found already there. */
  reasons: (ReviewReason | null)[];
  /** The photo already in the library, for an item found there, and for its Live video. */
  found: Map<string, string>;
  /** Items whose match is a hidden photo: left out, so the hidden one is not put in an album. */
  hiddenMatch: Set<string>;
  /** An item whose bytes another item of the export has: by its id, that item's id. */
  copyOf: Map<number, number>;
  /** Files the check asked about and the library does not have: their upload skips asking. */
  verifiedNew: Set<string>;
  abort: AbortController;
  myFiles?: MyFilesJob;
} | null = null;

/**
 * Reads the export `startImport` made ready into a review: every item with the date,
 * place and album it will upload with, and Live Photos paired. Nothing uploads until
 * `confirmImport`. Meanwhile each item is checked against the library in the background,
 * so the review can mark what is already there.
 */
export function prepareImport(
  photos: any,
  given: Record<string, string> = {},
  media: Record<string, ShellMediaInfo> = {},
  library?: () => Promise<LibraryIndex | null>,
): void {
  const job = pendingImport;
  if (!job) return;
  pendingImport = null;
  const frames = ownFrames(given);
  status.importing = { phase: "planning", done: 0, total: 0, part: 0, parts: 0 };

  void (async () => {
    try {
      const plan = await planExport(job.roots, (name) => !!mediaTypeOf(name));
      for (const item of plan.items) {
        if (job.myFiles) item.album = job.myFiles.albumOf.get(item.file) ?? null;
        if (!item.sidecar?.takenMs) item.sidecar = { favorited: false, ...item.sidecar, takenMs: await capturedAt(item.file) };
      }
      if (plan.items.length === 0) {
        for (const frame of Object.values(frames)) await rm(frame, { force: true }).catch(() => {});
        for (const root of job.staged) await discardStagedImport(root);
        status.importError = "No photos or videos were found in this export.";
        status.importing = undefined;
        return;
      }
      const items: ReviewItem[] = plan.items.map((p, id) => ({
        id,
        path: p.file,
        name: basename(p.file),
        album: p.album,
        video: (mediaTypeOf(p.file) ?? "").startsWith("video/"),
        takenMs: p.sidecar?.takenMs,
        latitude: p.sidecar?.latitude,
        longitude: p.sidecar?.longitude,
        description: p.sidecar?.description,
        live: p.liveVideo ? { path: p.liveVideo, name: basename(p.liveVideo) } : undefined,
        favorite: p.sidecar?.favorited || undefined,
        alsoIn: p.alsoIn,
      }));
      const albums = new Set(plan.items.map((p) => p.album).filter((a) => a !== null)).size;
      const current = {
        items,
        plan: plan.items,
        staged: job.staged,
        frames,
        media,
        checks: items.map((): ReviewCheck => "pending"),
        reasons: items.map((): ReviewReason | null => null),
        found: new Map<string, string>(),
        hiddenMatch: new Set<string>(),
        copyOf: new Map<number, number>(),
        verifiedNew: new Set<string>(),
        abort: new AbortController(),
        myFiles: job.myFiles,
      };
      review = current;
      status.importing = {
        phase: "review",
        done: 0,
        total: 0,
        part: 0,
        parts: albums,
        items: items.length,
        checked: 0,
        already: 0,
      };
      void checkReview(photos, current, library);
    } catch (e) {
      for (const root of job.staged) await discardStagedImport(root);
      status.importError = (e as Error).message;
      status.importing = undefined;
    }
  })();
}

/**
 * How many export files the library check works on at once. Each is read whole for its hash,
 * and a disk is read fastest by a few.
 */
const HASH_CONCURRENCY = 3;

/**
 * Marks each reviewed item new or already in the library, by its bytes only: the library's
 * content hashes find the same file under any name, and Proton's own check by name and bytes
 * covers the rest. The same bytes twice in the export go up once. A file whose check fails
 * counts as new, and is asked about again when it uploads.
 */
async function checkReview(
  photos: any,
  current: NonNullable<typeof review>,
  library?: () => Promise<LibraryIndex | null>,
): Promise<void> {
  // The library's own record of every photo's content, when it can be had: one listing,
  // instead of a question to the server per file that only finds files under the same name.
  const loaded = library ? await library().catch(() => null) : null;
  const index = loaded?.canMatchContent() ? loaded : null;
  diag.log("upload", "import_check", { items: current.plan.length, by_content: index ? 1 : 0 });
  if (review === current && status.importing?.phase === "review") status.importing.byContent = !!index;
  const signal = current.abort.signal;
  const counted = new Set<number>();
  const settled = (i: number) => {
    counted.add(i);
    if (review !== current || status.importing?.phase !== "review") return;
    status.importing.checked = (status.importing.checked ?? 0) + 1;
    if (current.checks[i] === "already") status.importing.already = (status.importing.already ?? 0) + 1;
  };
  /** The library photo with these bytes: by content under any name, else by name and bytes. */
  const inLibrary = async (path: string, sha1: string): Promise<string | null> =>
    index?.sameFile(sha1) ?? (await findInLibrary(photos, path, signal, sha1));
  /** The first item with these bytes, and what the library check found for it. */
  const firstOf = new Map<string, { index: number; found: Promise<string | null> }>();
  /** The SHA-1 of each Live video a kept still has, by its item. */
  const videoSha1sOf = new Map<ExportItem, Set<string>>();
  /** The library photo a Live video is, or else a new file to upload. */
  const checkVideo = async (video: string, sha1: string): Promise<void> => {
    const found = await inLibrary(video, sha1);
    if (found) current.found.set(video, found);
    else current.verifiedNew.add(video);
  };
  /**
   * Takes `videos` of the same still into `kept`'s other videos, each checked against the
   * library, less any whose bytes one of `kept`'s videos already holds.
   */
  const takeVideos = async (kept: ExportItem, videos: string[]): Promise<void> => {
    const own = kept.liveVideo;
    if (!own || videos.length === 0) return;
    const ownSha1 = await sha1Of(own);
    const sha1s = await Promise.all(videos.map((v) => sha1Of(v)));
    const held = videoSha1sOf.get(kept) ?? new Set([ownSha1]);
    videoSha1sOf.set(kept, held);
    const taken: [string, string][] = [];
    videos.forEach((video, n) => {
      if (held.has(sha1s[n])) return;
      held.add(sha1s[n]);
      taken.push([video, sha1s[n]]);
    });
    if (taken.length === 0) return;
    kept.moreVideos = [...(kept.moreVideos ?? []), ...taken.map(([video]) => video)];
    for (const [video, sha1] of taken) await checkVideo(video, sha1);
  };
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= current.plan.length || signal.aborted) return;
      const item = current.plan[i];
      try {
        const sha1 = await sha1Of(item.file);
        if (signal.aborted) return;
        const seen = firstOf.get(sha1);
        if (seen !== undefined) {
          // The same bytes under another name in this export: one upload, in both albums.
          const first = seen.index;
          const kept = current.plan[first];
          const albumsOf = [item.album, ...(item.alsoIn ?? [])].filter((a): a is string => !!a);
          kept.alsoIn = [...new Set([...(kept.alsoIn ?? []), ...albumsOf.filter((a) => a !== kept.album)])];
          current.checks[i] = "already";
          current.reasons[i] = "same_in_export";
          current.copyOf.set(i, first);
          // Without the library's hashes Proton finds a file only under its own name, and the
          // library may have these bytes under this one.
          if (!index && !(await seen.found)) {
            const exact = await findInLibrary(photos, item.file, signal, sha1);
            if (exact && current.checks[first] === "new") {
              current.found.set(kept.file, exact);
              current.verifiedNew.delete(kept.file);
              current.checks[first] = "already";
              current.reasons[first] = "same_file";
              if (counted.has(first) && review === current && status.importing?.phase === "review") {
                status.importing.already = (status.importing.already ?? 0) + 1;
              }
            }
          }
          // Its Live Photo videos go up with the kept still: the first as its own when that one
          // has none, every other one whose bytes the kept still's videos do not hold beside it.
          const videos = item.liveVideo ? [item.liveVideo, ...(item.moreVideos ?? [])] : [];
          if (videos.length > 0 && !kept.liveVideo) {
            const first = videos.shift()!;
            kept.liveVideo = first;
            await checkVideo(first, await sha1Of(first));
          }
          await takeVideos(kept, videos);
        } else {
          // Videos of copies of this still that the export's listing merged into it, taken again below.
          const merged = item.moreVideos ?? [];
          item.moreVideos = undefined;
          const lookup = inLibrary(item.file, sha1);
          firstOf.set(sha1, { index: i, found: lookup.catch(() => null) });
          const exact = await lookup;
          if (exact) {
            current.found.set(item.file, exact);
            current.checks[i] = "already";
            current.reasons[i] = "same_file";
            if (index?.hidden(exact)) current.hiddenMatch.add(item.file);
          } else {
            current.checks[i] = "new";
            current.verifiedNew.add(item.file);
          }
          // A Live Photo's video by its own bytes, whatever its still: the same video in the
          // library is never uploaded again.
          if (item.liveVideo) await checkVideo(item.liveVideo, await sha1Of(item.liveVideo));
          await takeVideos(item, merged);
        }
      } catch {
        // Unchecked is not a verdict: the upload asks again, so this only loses the mark.
        if (!signal.aborted && current.checks[i] === "pending") current.checks[i] = "new";
      }
      if (current.checks[i] !== "pending") settled(i);
    }
  };
  await Promise.all(Array.from({ length: HASH_CONCURRENCY }, worker));
}

/**
 * The photo in the library with this exact name and these bytes, if there is one. The SDK asks
 * the server by name first and hashes the file only when a name matches.
 */
async function findInLibrary(photos: any, path: string, signal: AbortSignal, sha1?: string): Promise<string | null> {
  const duplicates: string[] = await photos.findPhotoDuplicates(basename(path), async () => sha1 ?? sha1Of(path), signal);
  return duplicates[0] ?? null;
}

/** The longest edge of a review tile's picture. */
const REVIEW_THUMB_EDGE = 320;

/**
 * Pictures for the review's tiles, as small JPEG data URLs: of the file itself, or of the frame
 * the host made for a video or a still sharp cannot open. Null where neither can be drawn, and
 * for any path that is not a file of the export under review, which is all this reads.
 */
export async function importThumbnails(paths: string[]): Promise<(string | null)[]> {
  const current = review;
  if (!current) return paths.map(() => null);
  const known = new Set(current.items.map((i) => i.path));
  const frames = new Map(Object.entries(current.frames).map(([path, frame]) => [frameKey(path), frame]));
  const asked = paths.slice(0, 32);
  const out: (string | null)[] = asked.map(() => null);
  // A few at a time: the review's own check reads the export on the same threads.
  let next = 0;
  const worker = async () => {
    for (;;) {
      const k = next++;
      if (k >= asked.length) return;
      const path = asked[k];
      if (!known.has(path)) continue;
      const source = frames.get(frameKey(path)) ?? path;
      try {
        const jpeg = await sharp(source, { failOn: "none", limitInputPixels: 300_000_000 })
          .rotate()
          .resize(REVIEW_THUMB_EDGE, REVIEW_THUMB_EDGE, { fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 72 })
          .toBuffer();
        out[k] = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      } catch {
        /* no picture to draw */
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

/** The export under review, for the review screen; null when there is none. */
export function getImportReview(): { items: ReviewItem[] } | null {
  return review ? { items: review.items } : null;
}

/** What the library check has found so far, one entry per reviewed item. */
export function getImportChecks(): { checks: ReviewCheck[]; reasons: (ReviewReason | null)[] } | null {
  return review ? { checks: review.checks, reasons: review.reasons } : null;
}

/**
 * Queues the reviewed export, less what was left out. `albums` false puts everything on
 * the timeline; `live` false uploads a Live Photo's two files as two separate items. An item
 * whose library copy is a hidden photo is left out, so the hidden photo is not put in an album.
 */
export function confirmImport(
  photos: any,
  exclude: number[] = [],
  albums = true,
  live = true,
): void {
  const current = review;
  if (!current) return;
  // Every item is checked first: one not checked yet could go up although the library has it.
  if (current.checks.some((c) => c === "pending")) throw new Error("The check against your library has not finished.");
  review = null;
  current.abort.abort();
  status.importing = undefined;

  const left = new Set(exclude);
  const leftByUser = new Set(exclude);
  // Of the copies of a first item the user left out, one goes in its place, carrying the
  // albums of the others, which stay out: the same bytes still go up once.
  const standInFor = new Map<number, number>();
  for (const [id, first] of [...current.copyOf].sort((a, b) => a[0] - b[0])) {
    if (!leftByUser.has(first) || leftByUser.has(id)) continue;
    const taken = standInFor.get(first);
    if (taken === undefined) {
      standInFor.set(first, id);
      continue;
    }
    const keeper = current.plan[taken];
    const item = current.plan[id];
    const albumsOf = [item.album, ...(item.alsoIn ?? [])].filter((a): a is string => !!a && a !== keeper.album);
    keeper.alsoIn = [...new Set([...(keeper.alsoIn ?? []), ...albumsOf])];
  }
  current.plan.forEach((item, id) => {
    // Its bytes go up once, as the other item, which carries its albums too; but in its place
    // when that one was left out, as that one would have gone.
    const first = current.copyOf.get(id);
    if (first !== undefined) {
      if (standInFor.get(first) !== id) {
        left.add(id);
        return;
      }
      current.checks[id] = current.checks[first];
      current.reasons[id] = current.reasons[first];
      const firstFile = current.plan[first].file;
      const found = current.found.get(firstFile);
      if (found) current.found.set(item.file, found);
      if (current.hiddenMatch.has(firstFile)) current.hiddenMatch.add(item.file);
      if (current.verifiedNew.has(firstFile)) current.verifiedNew.add(item.file);
    }
    if (current.hiddenMatch.has(item.file)) left.add(id);
  });
  const kept = current.plan.filter((_, id) => !left.has(id));
  // Left-out files are never uploaded, so their unpacked copies go now, but not a video a kept
  // still took over from a copy of itself.
  const goingUp = new Set(kept.flatMap((item) => [item.file, ...liveVideosOf(item)]));
  for (const item of current.plan.filter((_, id) => left.has(id))) {
    for (const file of [item.file, ...liveVideosOf(item)]) {
      if (file && !goingUp.has(file) && isStagedImport(file)) void rm(file, { force: true }).catch(() => {});
    }
  }
  const byAlbum = new Map<string, ExportItem[]>();
  for (const item of kept) {
    const key = albums && item.album !== null ? `a:${item.album}` : "";
    const list = byAlbum.get(key);
    if (list) list.push(item);
    else byAlbum.set(key, [item]);
  }
  if (byAlbum.size === 0) {
    for (const frame of Object.values(current.frames)) void rm(frame, { force: true }).catch(() => {});
    for (const root of current.staged) void discardStagedImport(root);
    return;
  }

  const sidecars = new Map<string, SidecarMeta>();
  for (const item of kept) if (item.sidecar) sidecars.set(item.file, item.sidecar);
  const uidOf = new Map<string, string>();
  // What the review checked and found new; anything unchecked, or whose check failed, is
  // checked at upload as before.
  const fresh = current.verifiedNew;
  const staging: Staging | undefined =
    current.staged.length > 0 ? { roots: current.staged, groupsLeft: byAlbum.size } : undefined;
  // Each file's row in the status, for how it ended.
  const rowOf = new Map<string, number>();
  const job = current.myFiles;
  if (staging && job?.move) {
    staging.onDone = () => {
      const outcomes = moveOutcomes(
        kept,
        job.sourceOf,
        (file) => status.items[rowOf.get(file) ?? -1]?.status,
        (file) => uidOf.get(file) ?? current.found.get(file) ?? null,
      );
      return trashMovedOriginals(photos, job, outcomes);
    };
  }

  for (const [key, list] of byAlbum) {
    const album = key ? list[0].album : null;
    const files: string[] = [];
    const related = new Map<string, string[]>();
    const itemOf = new Map<string, number>();
    for (const item of list) {
      files.push(item.file);
      itemOf.set(item.file, status.items.length);
      rowOf.set(item.file, status.items.length);
      status.items.push({ name: basename(item.file), album, status: "pending" });
      const videos = liveVideosOf(item);
      if (videos.length > 0) {
        if (live) related.set(item.file, videos);
        else files.push(...videos);
      }
      for (const video of videos) {
        itemOf.set(video, status.items.length);
        rowOf.set(video, status.items.length);
        status.items.push({ name: basename(video), album, status: "pending" });
      }
    }
    const every = list.flatMap((item) => [item.file, ...liveVideosOf(item)]);
    queue.push({
      album,
      files,
      startIndex: itemOf.get(files[0]) ?? status.items.length,
      frames: framesForFiles(every, current.frames),
      media: framesForFiles(every, current.media),
      sidecars,
      staging,
      known: current.found,
      related,
      itemOf,
      uidOf,
      fresh,
      // A move from My files trashes each original once it is in: what is kept is what went up.
      compress: !job?.move,
    });
  }
  // The other albums a photo was copied into, once every photo has gone up: by then each
  // file's photo is known, and these only add it.
  if (albums) {
    const extra = new Map<string, string[]>();
    for (const item of kept) {
      for (const album of item.alsoIn ?? []) {
        const list = extra.get(album);
        if (list) list.push(item.file);
        else extra.set(album, [item.file]);
      }
    }
    for (const [album, files] of extra) {
      queue.push({
        album,
        files,
        startIndex: status.items.length,
        frames: new Map(),
        media: new Map(),
        known: current.found,
        uidOf,
        albumOnly: true,
      });
    }
  }
  status.total = status.items.length;
  if (!draining) void drain(photos);
}

/** A Live Photo's videos: its own, then the other ones copies of its still in the export had. */
function liveVideosOf(item: { liveVideo?: string; moreVideos?: string[] }): string[] {
  return item.liveVideo ? [item.liveVideo, ...(item.moreVideos ?? [])] : [];
}

/**
 * What became of each original of a move from My files, for `sourcesToTrash`: settled when it
 * went up, or was skipped as a file the library has, with the photo it is in the library as (a
 * Live video joined to its photo is that photo). Only what went up, or the library's exact copy,
 * lets an original go: never a file skipped with no photo of its own to point to.
 */
export function moveOutcomes(
  kept: { file: string; liveVideo?: string; moreVideos?: string[] }[],
  sourceOf: ReadonlyMap<string, string>,
  stateOf: (file: string) => UploadItemStatus | undefined,
  photoOf: (file: string) => string | null,
): { source: string; settled: boolean; photo: string | null }[] {
  const outcomes: { source: string; settled: boolean; photo: string | null }[] = [];
  for (const item of kept) {
    for (const file of [item.file, ...liveVideosOf(item)]) {
      const source = sourceOf.get(file);
      const state = stateOf(file);
      const photo = photoOf(file);
      const settled = (state === "done" || state === "skipped") && !!photo;
      if (source) outcomes.push({ source, settled, photo });
    }
  }
  return outcomes;
}

/** Drops the export under review and deletes what was unpacked for it. */
export function discardImport(): void {
  const current = review;
  if (!current) return;
  review = null;
  current.abort.abort();
  for (const frame of Object.values(current.frames)) void rm(frame, { force: true }).catch(() => {});
  for (const root of current.staged) void discardStagedImport(root);
  status.importing = undefined;
}

/** Stops an import that is still being made ready, and deletes what it unpacked. */
function cancelImport(): void {
  importAbort?.abort();
  discardImport();
  const job = pendingImport;
  pendingImport = null;
  if (job) {
    for (const root of job.staged) void discardStagedImport(root);
    status.importing = undefined;
  }
}
