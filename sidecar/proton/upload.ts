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
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";

import exifr from "exifr";
import sharp from "sharp";

import { createAlbum, deleteAlbum, findAlbumByName, listAlbumPhotos } from "./albums.ts";
import {
  discardStagedImport,
  isStagedImport,
  isZip,
  planExport,
  unpackZip,
  type ExportItem,
} from "./importer.ts";
import type { SidecarMeta } from "./takeout.ts";
import { readMp4CreationTime } from "./mp4Date.ts";
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
};

/**
 * An export being made ready, before any of it is queued: zips unpacking, then the
 * files waiting for the host's video frames, then being read into albums.
 */
export type ImportState = {
  phase: "unpacking" | "ready" | "planning" | "review";
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
};

export type UploadStatus = {
  running: boolean;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  items: UploadItem[];
  /** Present while an export is being made ready. */
  importing?: ImportState;
  /** Why the last import could not start, until the record is cleared. */
  importError?: string;
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
  /** A Live Photo's video, by its photo: uploaded right after it, as part of it. */
  related?: Map<string, string>;
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
};

/** Unpacked exports shared by the groups read from them. */
type Staging = { roots: string[]; groupsLeft: number };

/** Counts a group off its unpacked export, and deletes the export after the last one. */
async function releaseStaging(staging: Staging): Promise<void> {
  if (--staging.groupsLeft > 0) return;
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
  status.items = [];
  status.total = 0;
  status.done = 0;
  status.skipped = 0;
  status.failed = 0;
}

function mediaTypeOf(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return IMAGE_TYPES[ext] ?? VIDEO_TYPES[ext] ?? null;
}

/**
 * The Drive photo tags that apply to one file, from its media type and its name alone.
 *
 * Without these a video uploaded here reached Proton carrying no tag at all, and the
 * clients that read video-ness off the tag then showed it as a still photo.
 *
 * Only tags that follow from what is already known are set. Video and Raw are exact:
 * one is the media type, the other the container. Screenshot is a filename convention
 * rather than a fact about the bytes, and is the same rule the Android client uses, so
 * the same file classifies alike whichever client sent it.
 *
 * Deliberately absent: Live/Motion photo and Panorama, which live in the file's XMP and
 * would need a prefix read this never does; and Favorite, Selfie, Portrait and Burst,
 * which nothing on a desktop can determine. Guessing any of them from aspect ratio or
 * size would only be an invention.
 */
export function photoTagsFor(mediaType: string, name: string): number[] {
  const tags: number[] = [];
  const mime = mediaType.toLowerCase();
  const lower = name.toLowerCase();
  const ext = extname(lower);

  if (mime.startsWith("image/") && (lower.startsWith("screenshot") || lower.startsWith("screen_shot"))) {
    tags.push(TAG_SCREENSHOT);
  }
  if (mime.startsWith("video/")) tags.push(TAG_VIDEO);
  if (RAW_EXTENSIONS.has(ext)) tags.push(TAG_RAW);

  return tags;
}

/**
 * Every media file under `dir`, walked into sub-folders so a dropped folder-of-folders
 * (e.g. Pictures\2023\, 2024\) uploads its photos instead of silently uploading nothing.
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
    if (e.isSymbolicLink()) continue;
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
    createReadStream(path)
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
  const lat = Number(info.latitude);
  const lon = Number(info.longitude);
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
async function exifFactsOf(path: string): Promise<ExifFacts> {
  const facts: ExifFacts = {};
  try {
    const exif = await exifr.parse(path, {
      pick: ["DateTimeOriginal", "CreateDate", "Make", "Model", "latitude", "longitude"],
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
  const [small, preview] = await Promise.all([
    jpegWithinBudget(source, THUMB_SMALL_PX, THUMB_SMALL_MAX_BYTES),
    jpegWithinBudget(source, THUMB_PREVIEW_PX, THUMB_PREVIEW_MAX_BYTES),
  ]);
  return [
    { type: ThumbnailType.Type1, thumbnail: new Uint8Array(small) },
    { type: ThumbnailType.Type2, thumbnail: new Uint8Array(preview) },
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
  let { data, info } = await source
    .clone()
    .resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true })
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
  options: { mainPhotoNodeUid?: string; extraTags?: number[]; known?: string; fresh?: boolean } = {},
): Promise<{ uid: string | null; duplicates: string[] }> {
  const name = basename(path);
  const mediaType = mediaTypeOf(path);
  if (!mediaType) throw new Error("unsupported file type");
  // Already found in the library by the import's review: no second hash of the file.
  if (options.known) return { uid: null, duplicates: [options.known] };

  const info = await stat(path);
  const sha1 = await sha1Of(path);

  // A file the import's review has just found new is not asked about a second time.
  const duplicates: string[] = options.fresh
    ? []
    : await photos.findPhotoDuplicates(name, async () => sha1, signal);
  if (duplicates.length > 0) return { uid: null, duplicates };

  const exif = await exifFactsOf(path);
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

  // Dimensions come from whichever side actually opened the file. The shell answered for
  // a video and for the stills sharp has no decoder for; everything else sharp reads
  // itself, off the same file it is about to thumbnail. The two never cover the same
  // file, so neither can contradict the other.
  const dims =
    shellMedia?.width && shellMedia?.height
      ? { width: shellMedia.width, height: shellMedia.height }
      : sharpCanDecode(path, mediaType)
        ? await stillDimensions(path)
        : null;

  const thumbnails = await makeThumbnails(path, mediaType, framePath);

  // Blocks here until the SDK's upload queue has capacity. The tags ride along with the
  // rest of the metadata and the SDK commits them with the revision, which is the one
  // moment they can be set without a second round trip.
  const uploader = await photos.getFileUploader(
    name,
    {
      mediaType,
      expectedSize: info.size,
      expectedSha1: sha1,
      modificationTime: info.mtime,
      captureTime,
      tags: [
        ...photoTagsFor(mediaType, name),
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
  const stream = Readable.toWeb(createReadStream(path)) as any;
  const controller = await uploader.uploadFromStream(stream, thumbnails);
  const { nodeUid } = await controller.completion();
  return { uid: nodeUid, duplicates: [] };
}

/** Turns dropped paths into groups. A folder is one group, loose files another. */
async function planGroups(paths: string[]): Promise<Group[]> {
  const groups: Group[] = [];
  const loose: string[] = [];

  for (const path of paths) {
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      const files = await listMedia(path);
      if (files.length > 0) {
        groups.push({
          album: basename(path),
          files,
          startIndex: 0,
          frames: new Map(),
          media: new Map(),
        });
      }
    } else if (mediaTypeOf(path)) {
      loose.push(path);
    }
  }
  if (loose.length > 0) {
    groups.push({ album: null, files: loose, startIndex: 0, frames: new Map(), media: new Map() });
  }
  return groups;
}

// How many files a single upload works on at once. Bounds the per-file prep (hash, EXIF,
// thumbnails) so a large folder cannot pile its buffers up behind the SDK's own 5-wide
// upload gate and run the process out of memory. Deliberately small; raising it trades
// memory for a throughput the SDK gate caps anyway.
const UPLOAD_CONCURRENCY = 4;

async function drain(photos: any): Promise<void> {
  draining = true;
  status.running = true;

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
        const inAlbum = new Set<string>();
        if (albumUid && !albumIsNew) {
          try {
            for (const photo of await listAlbumPhotos(photos, albumUid)) inAlbum.add(photo.uid);
          } catch (e) {
            process.stderr.write(`[upload] album members: ${(e as Error).message}\n`);
          }
        }
        const intoAlbum = (uid: string) => {
          if (albumUid && !inAlbum.has(uid) && !toAlbum.includes(uid)) toAlbum.push(uid);
        };

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
          item.status = "uploading";
          const video = group.related?.get(file);
          let mainUid: string | null = null;
          try {
            const key = frameKey(file);
            const { uid, duplicates } = await uploadOne(
              photos,
              file,
              group.frames.get(key),
              group.media.get(key),
              abort.signal,
              group.favorite,
              group.sidecars?.get(file),
              {
                known: group.known?.get(file),
                fresh: group.fresh?.has(file),
                extraTags: video ? [PhotoTag.LivePhotos] : [],
              },
            );
            mainUid = uid ?? duplicates[0] ?? null;
            if (mainUid) group.uidOf?.set(file, mainUid);
            if (uid) {
              uploaded.push(uid);
              intoAlbum(uid);
              item.status = "done";
              status.done++;
            } else {
              // Bytes the library already has, from a folder uploaded again or a photo
              // copied into an album folder in the file manager: what was asked for is
              // that photo in that album, so it goes in, and only once.
              if (duplicates[0]) intoAlbum(duplicates[0]);
              item.status = "skipped";
              item.error = "already in your library";
              status.skipped++;
            }
          } catch (e) {
            item.status = "failed";
            item.error = (e as Error).message;
            status.failed++;
          } finally {
            // Gone only once the photo is in the library, uploaded now or already there.
            // A failed one stays staged, since a move into the drive has already deleted
            // the original, and the host uploads it again at the next unlock.
            if (group.fromDrive && item.status !== "failed") await discardStaged(file);
            // An unpacked export's copy is only ever a copy: gone as soon as it is used,
            // so a large export never holds the disk for longer than it must.
            if (group.staging && isStagedImport(file)) await rm(file, { force: true }).catch(() => {});
          }
          if (video) await processLiveVideo(video, file, mainUid);
        };

        /** A Live Photo's video, uploaded as part of the photo that went up just before it. */
        const processLiveVideo = async (video: string, photo: string, mainUid: string | null) => {
          const item = status.items[group.itemOf?.get(video) ?? -1];
          if (!item || abort.signal.aborted) return;
          try {
            if (!mainUid) throw new Error("its photo did not upload");
            item.status = "uploading";
            const key = frameKey(video);
            const { uid } = await uploadOne(
              photos,
              video,
              group.frames.get(key),
              group.media.get(key),
              abort.signal,
              false,
              group.sidecars?.get(photo),
              { mainPhotoNodeUid: mainUid, known: group.known?.get(video), fresh: group.fresh?.has(video) },
            );
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
            item.error = (e as Error).message;
            status.failed++;
          } finally {
            if (group.staging && isStagedImport(video)) await rm(video, { force: true }).catch(() => {});
          }
        };
        let nextFile = 0;
        const worker = async () => {
          for (;;) {
            const i = nextFile++;
            if (i >= group.files.length || abort.signal.aborted) return;
            await processFile(group.files[i], i);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(UPLOAD_CONCURRENCY, group.files.length) }, worker),
        );

        if (albumUid && toAlbum.length > 0) {
          // Add the files that DID upload to their album even if the user cancelled:
          // they are already in the cloud, so finishing this beats leaving an empty
          // album with the photos orphaned on the timeline. A fresh signal, so the
          // cancel that stopped the uploads does not also abort this last step.
          const addSignal = new AbortController().signal;
          try {
            let failed = 0;
            for await (const result of photos.addPhotosToAlbum(albumUid, toAlbum, addSignal)) {
              if (!result.ok) failed++;
            }
            if (failed > 0) {
              process.stderr.write(`[upload] add to album failed for ${failed} photo(s)\n`);
            }
          } catch (e) {
            process.stderr.write(`[upload] addPhotosToAlbum: ${(e as Error).message}\n`);
          }
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

/** The export made ready and waiting for the host's frames, if one is. */
let pendingImport: { roots: string[]; staged: string[] } | null = null;
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
  status.importing = { phase: "unpacking", done: 0, total: 0, part: 0, parts: zips.length };
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

/** What the library check found for one item: not yet checked, new, or already there. */
export type ReviewCheck = "pending" | "new" | "already";

/** The export under review, between `prepareImport` and `confirmImport` or `discardImport`. */
let review: {
  items: ReviewItem[];
  plan: ExportItem[];
  staged: string[];
  frames: Record<string, string>;
  media: Record<string, ShellMediaInfo>;
  checks: ReviewCheck[];
  /** The photo already in the library, for an item found there, and for its Live video. */
  found: Map<string, string>;
  /** Files the check asked about and the library does not have: their upload skips asking. */
  verifiedNew: Set<string>;
  abort: AbortController;
} | null = null;

/**
 * How many items the library check asks about at once. Each is one small request and,
 * only when the name matches something, a hash of the file, so the wait is mostly the
 * network and a few in flight together is what makes a large export quick to check.
 */
const CHECK_CONCURRENCY = 8;

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
): void {
  const job = pendingImport;
  if (!job) return;
  pendingImport = null;
  const frames = ownFrames(given);
  status.importing = { phase: "planning", done: 0, total: 0, part: 0, parts: 0 };

  void (async () => {
    try {
      const plan = await planExport(job.roots, (name) => !!mediaTypeOf(name));
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
        found: new Map<string, string>(),
        verifiedNew: new Set<string>(),
        abort: new AbortController(),
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
      void checkReview(photos, current);
    } catch (e) {
      for (const root of job.staged) await discardStagedImport(root);
      status.importError = (e as Error).message;
      status.importing = undefined;
    }
  })();
}

/** Marks each reviewed item new or already in the library, a few at a time. */
async function checkReview(photos: any, current: NonNullable<typeof review>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= current.plan.length || current.abort.signal.aborted) return;
      const item = current.plan[i];
      try {
        const existing = await findInLibrary(photos, item.file, current.abort.signal);
        if (existing) current.found.set(item.file, existing);
        else current.verifiedNew.add(item.file);
        if (item.liveVideo) {
          const video = await findInLibrary(photos, item.liveVideo, current.abort.signal);
          if (video) current.found.set(item.liveVideo, video);
          else current.verifiedNew.add(item.liveVideo);
        }
        current.checks[i] = existing ? "already" : "new";
      } catch {
        // Unchecked is not a verdict: the upload checks again, so this only loses the mark.
        current.checks[i] = "new";
      }
      if (review === current && status.importing?.phase === "review") {
        status.importing.checked = (status.importing.checked ?? 0) + 1;
        if (current.checks[i] === "already") {
          status.importing.already = (status.importing.already ?? 0) + 1;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
}

/**
 * The photo in the library with these exact bytes, if there is one. The SDK asks the
 * server by name first and hashes the file only when a name matches, which in an import
 * is rare: hashing every file up front was most of what made the check slow.
 */
async function findInLibrary(photos: any, path: string, signal: AbortSignal): Promise<string | null> {
  const duplicates: string[] = await photos.findPhotoDuplicates(basename(path), () => sha1Of(path), signal);
  return duplicates[0] ?? null;
}

/** The export under review, for the review screen; null when there is none. */
export function getImportReview(): { items: ReviewItem[] } | null {
  return review ? { items: review.items } : null;
}

/** What the library check has found so far, one entry per reviewed item. */
export function getImportChecks(): { checks: ReviewCheck[] } | null {
  return review ? { checks: review.checks } : null;
}

/**
 * Queues the reviewed export, less what was left out. `albums` false puts everything on
 * the timeline; `live` false uploads a Live Photo's two files as two separate items.
 */
export function confirmImport(photos: any, exclude: number[] = [], albums = true, live = true): void {
  const current = review;
  if (!current) return;
  review = null;
  current.abort.abort();
  status.importing = undefined;

  const left = new Set(exclude);
  const kept = current.plan.filter((_, id) => !left.has(id));
  // Left-out files are never uploaded, so their unpacked copies go now.
  for (const item of current.plan.filter((_, id) => left.has(id))) {
    for (const file of [item.file, item.liveVideo]) {
      if (file && isStagedImport(file)) void rm(file, { force: true }).catch(() => {});
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
  const staging =
    current.staged.length > 0 ? { roots: current.staged, groupsLeft: byAlbum.size } : undefined;

  for (const [key, list] of byAlbum) {
    const album = key ? list[0].album : null;
    const files: string[] = [];
    const related = new Map<string, string>();
    const itemOf = new Map<string, number>();
    for (const item of list) {
      files.push(item.file);
      itemOf.set(item.file, status.items.length);
      status.items.push({ name: basename(item.file), album, status: "pending" });
      if (item.liveVideo) {
        if (live) related.set(item.file, item.liveVideo);
        else files.push(item.liveVideo);
        itemOf.set(item.liveVideo, status.items.length);
        status.items.push({ name: basename(item.liveVideo), album, status: "pending" });
      }
    }
    const every = list.flatMap((item) => (item.liveVideo ? [item.file, item.liveVideo] : [item.file]));
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
