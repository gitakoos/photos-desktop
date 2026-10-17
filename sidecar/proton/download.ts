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

// Download engine.
//
// The bytes come from the SDK's `getFileDownloader`. Anything with a file for a
// destination streams straight to disk, so a large photo never sits in memory
// whole; only in-app video playback buffers, and a size cap bounds that.
//
// The mount's uid list is module state, the way the upload queue is. It is one
// account's data, so `resetDownloadState` drops it and the session calls that
// when it locks.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { WritableStream } from "node:stream/web";

import { PhotoTag } from "@protontech/drive-sdk";

import { isOfflineReady } from "./offline.ts";
import { nodeDurationMs, nodeName, toMillis } from "./nodes.ts";
import { SDK_STALL_MS, withStallGuard } from "./stallGuard.ts";
import { decryptOriginalTo, metaGet, metaPut, originalGet, originalSize } from "./store.ts";
import { guarded, writeChunk } from "./fileWrites.ts";

// Cap for in-memory video playback. A larger file would strain the sidecar heap
// and the JSON-RPC channel, so past it the app offers a download instead.
const MAX_INMEMORY_VIDEO = 150 * 1024 * 1024;

/**
 * The size at which the viewer stops handing originals over the RPC channel and
 * stages them on disk instead.
 *
 * Measured on this machine, sealed-blob read + AES-GCM decrypt + base64 + JSON
 * round trip to the host, median of five: 5.5 ms/MB, near perfectly linear
 * (1 MB 5.5 ms, 5 MB 28 ms, 10 MB 55 ms, 16 MB 89 ms, 24 MB 104 ms, 64 MB 266 ms).
 * The host's gate is strictly one request in flight, so that time is exactly how
 * long an `Interactive` caller — the next photo's preview — can be held up behind
 * one transfer. 16 MiB is where that stays under 100 ms, which is the budget the
 * gate exists to defend, and it is above anything a camera writes as a JPEG or PNG.
 * Past it the staged-file route still wins on both counts, so it keeps that work.
 */
const MAX_INMEMORY_ORIGINAL = 16 * 1024 * 1024;

export type VideoBytes = { base64: string; mime: string };
export type MountItem = {
  uid: string;
  name: string;
  size: number;
  captureTime: number;
  favorite: boolean;
};
export type MountPage = { items: MountItem[]; total: number };
export type HydratedFile = { path: string; size: number };

/**
 * Where the viewer's full-resolution upgrade reports itself. `unsupported` is a
 * settled answer, not a failure: the webview cannot draw that format, so the photo
 * keeps its preview and nothing is downloaded.
 *
 * A ready original arrives by one of two routes (see `MAX_INMEMORY_ORIGINAL`):
 * `memory` hands back a token the host redeems for the bytes, and nothing decrypted
 * touches the disk; `file` names a staged file for the asset protocol to read.
 */
export type OriginalStatus =
  | { state: "loading" }
  | { state: "ready"; via: "memory"; token: string; size: number; mime: string }
  | { state: "ready"; via: "file"; path: string; size: number }
  | { state: "unsupported" }
  | { state: "error" };

// Save-to-folder progress. RPC is request/response, so this is state the UI polls,
// the way the upload queue is polled: a save returns at once and the counts climb
// here as each original lands, instead of one long call that reports only at the end.
export type SaveStatus = { running: boolean; total: number; done: number; failed: number };

let mountUids: { uid: string; captureTime: number; favorite: boolean }[] | null = null;

const saveState: SaveStatus = { running: false, total: 0, done: 0, failed: 0 };

/** The live save progress for the UI to poll. Cheap: it hands back the state as-is. */
export function getSaveStatus(): SaveStatus {
  return saveState;
}

/**
 * Drops the cached mount listing and the save progress, so one account's snapshot or
 * a finished run can never serve the next. The session calls this when it locks.
 */
export function resetDownloadState(): void {
  mountUids = null;
  saveState.running = false;
  saveState.total = 0;
  saveState.done = 0;
  saveState.failed = 0;
  // A locked account must leave no decrypted photo behind: drop the staged original
  // and empty the staging directory outright.
  releaseOriginal();
  clearViewDir();
}

/**
 * A cloud-provided name made safe as a bare file name in the destination folder.
 *
 * The name is chosen by whoever owns the photo, which for a shared-with-me item is
 * not the person saving it, so it is untrusted: the characters Windows forbids and any
 * path separator become "_", leading/trailing whitespace and dots are stripped, and an
 * empty result falls back to a fixed stem. Without this a name like "..\..\evil.jpg"
 * would escape the chosen folder when joined onto it. Mirrors the mount's own
 * `sanitize_name` (cloud_mount.rs) so both download modes name a file the same way.
 */
export function safeFileName(name: string): string {
  const cleaned = Array.from(name)
    .map((c) => ('\\/:*?"<>|'.includes(c) || c.charCodeAt(0) < 32 ? "_" : c))
    .join("");
  const trimmed = cleaned.trim().replace(/^\.+|\.+$/g, "").trim();
  if (!trimmed) return "photo";
  // `NUL.jpg` or `COM1` names a device, not a file, in any Windows folder.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed) ? `_${trimmed}` : trimmed;
}

/** Every extension a photo or video is known by, lowercased with its dot. */
const MEDIA_EXTENSIONS = new Set(
  (
    ".jpg .jpeg .jpe .png .webp .gif .avif .bmp .tif .tiff .heic .heif .jxl .dng .cr2 .cr3 .nef " +
    ".arw .raf .orf .rw2 .pef .srw .raw .mp4 .mov .m4v .webm .mkv .3gp .3g2 .avi .wmv .mpg .mpeg " +
    ".ts .mts .m2ts"
  ).split(" "),
);

/** The extension a file of this media type is saved with when its name carries none. */
const EXTENSION_FOR_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/tiff": ".tif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/x-adobe-dng": ".dng",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-m4v": ".m4v",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/3gpp": ".3gp",
};

/**
 * A photo's name that opens as a photo, whatever it was called in the cloud.
 *
 * The name is chosen by whoever uploaded the file, which for a shared album is someone
 * else, and the bytes behind it are whatever they uploaded. Saved or shown in a file
 * manager as `holiday.exe` or `invoice.pdf.lnk`, a double-click would run it. So a name
 * that does not end in a photo or video extension gets one: `holiday.exe.jpg`, which
 * opens in a viewer and, if the bytes are not a picture, fails there harmlessly.
 */
export function withMediaExtension(name: string, mediaType?: string | null): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  if (MEDIA_EXTENSIONS.has(ext)) return name;
  const type = (mediaType ?? "").toLowerCase();
  return name + (EXTENSION_FOR_TYPE[type] ?? (type.startsWith("video/") ? ".mp4" : ".jpg"));
}

/**
 * Mark a saved file as having come from the internet, as a browser marks a download, so
 * Windows' own checks (SmartScreen, Office's Protected View) treat it that way. Silent on
 * a disk with no alternate streams (FAT32, exFAT) and everywhere but Windows.
 */
function markFromInternet(path: string): void {
  if (process.platform !== "win32") return;
  try {
    writeFileSync(`${path}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
  } catch {
    /* no streams on this disk */
  }
}

/** A destination filename in `dir` that does not overwrite an existing file. */
function uniqueFileName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

// ---- Full-file download: in-memory video playback, and save-to-folder ----

/**
 * Full video bytes for in-app playback, kept in memory and returned as base64
 * so nothing decrypted is written to disk. Bounded by a size cap: a very large
 * file would strain the sidecar heap and the JSON-RPC channel, so past the cap
 * the caller is told to download the file instead.
 */
export async function getVideo(photos: any, uid: string): Promise<VideoBytes> {
  // Kept offline: the bytes are already in the sealed store, so playback needs no
  // network. Still bounded by the same cap, since the channel carries them either way,
  // and measured from the blob's length before anything is read, because reading it
  // costs the sealed bytes and the plaintext at once, the very cost the cap refuses.
  // Nothing filters a pin by media type, so a pinned trip video lands here as a matter
  // of course rather than as an edge case.
  if (isOfflineReady(uid)) {
    const storedSize = originalSize(uid);
    if (storedSize !== null && storedSize > MAX_INMEMORY_VIDEO) throw new Error("VIDEO_TOO_LARGE");
    const stored = originalGet(uid);
    if (stored) {
      if (stored.length > MAX_INMEMORY_VIDEO) throw new Error("VIDEO_TOO_LARGE");
      return { base64: stored.toString("base64"), mime: metaGet(uid)?.mediaType || "video/mp4" };
    }
  }
  const node = await photos.getNode(uid);
  const mime = (node as any).mediaType || "video/mp4";
  const downloader = await photos.getFileDownloader(uid);
  const claimed = downloader.getClaimedSizeInBytes?.() ?? 0;
  if (claimed && claimed > MAX_INMEMORY_VIDEO) throw new Error("VIDEO_TOO_LARGE");

  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      total += chunk.byteLength;
      if (total > MAX_INMEMORY_VIDEO) throw new Error("VIDEO_TOO_LARGE");
      chunks.push(chunk);
    },
  });
  await downloader.downloadToStream(stream as any).completion();
  return { base64: Buffer.concat(chunks).toString("base64"), mime };
}

/**
 * Stream one original straight to the folder the user picked and return whether it
 * landed. The run continues past a single failure, and a partial file from a failed
 * download is removed. Never throws, so one bad file cannot sink the batch.
 */
async function saveOne(photos: any, uid: string, destDir: string): Promise<boolean> {
  let dest: string | null = null;
  let file: ReturnType<typeof createWriteStream> | null = null;
  try {
    const node = await photos.getNode(uid);
    const name = uniqueFileName(
      destDir,
      withMediaExtension(safeFileName(nodeName(node) || uid), (node as any).mediaType),
    );
    dest = join(destDir, name);
    const downloader = await photos.getFileDownloader(uid);
    file = guarded(createWriteStream(dest));
    const handle = file;
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        // Respect backpressure so a large file does not balloon the write buffer.
        return writeChunk(handle, chunk);
      },
      abort() {
        handle.destroy();
      },
    });
    await downloader.downloadToStream(stream as any).completion();
    // Close the file ourselves and wait for the flush. Waiting on the SDK to call
    // the stream's close() could hang forever and, since RPC is serialized, froze
    // the whole app; end(cb) cannot.
    await new Promise<void>((resolve, reject) => {
      handle.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    markFromInternet(dest);
    // Stamp the file with the photo's original capture time so Explorer shows the
    // real date, not the moment it was downloaded.
    const whenMs = toMillis((node as any).photo?.captureTime) || toMillis((node as any).creationTime);
    if (whenMs > 0) {
      try {
        utimesSync(dest, new Date(whenMs), new Date(whenMs));
      } catch {
        /* a timestamp failure must not fail the download */
      }
    }
    return true;
  } catch {
    // Close our own write handle before deleting the partial file: on Windows an open
    // handle blocks the delete, so cleanup cannot lean on the SDK aborting the stream.
    if (file && !file.destroyed) {
      const handle = file;
      await new Promise<void>((resolve) => {
        handle.once("close", () => resolve());
        handle.destroy();
      });
    }
    if (dest) {
      try {
        rmSync(dest, { force: true });
      } catch {
        /* a cleanup failure must not mask the original error */
      }
    }
    return false;
  }
}

/**
 * Save the originals for the given photos into a folder the user picked, in the
 * background. Returns at once; the UI polls `getSaveStatus` for the climbing count.
 * This is what Download means with the Explorer mount off: there is no placeholder to
 * keep offline, so the photos become ordinary files the user owns. Streaming one file
 * at a time keeps the single RPC channel free for the polls and the rest of the app,
 * where one blocking call for the whole batch would hold it until the last byte.
 */
export function startSaveOriginals(photos: any, uids: string[], destDir: string): boolean {
  // One save at a time. The status is a single shared record, so a second run started
  // while one is going would reset its counters and interleave a second loop against
  // them, ending both polls early with wrong counts (and, into the same folder, a
  // filename-collision race that could clobber a file). Refuse instead; the caller
  // learns nothing started and can retry once the first finishes.
  if (saveState.running) return false;
  saveState.running = true;
  saveState.total = uids.length;
  saveState.done = 0;
  saveState.failed = 0;
  void (async () => {
    // The count is enough to follow a save in the log; never the photo names or the
    // destination path, which are the user's own.
    process.stderr.write(`[download] save start: ${uids.length} files\n`);
    try {
      for (const uid of uids) {
        if (await saveOne(photos, uid, destDir)) saveState.done++;
        else saveState.failed++;
      }
    } finally {
      saveState.running = false;
      process.stderr.write(`[download] save done: ${saveState.done}/${saveState.total} saved\n`);
    }
  })();
  return true;
}

/**
 * Names and claimed sizes for a page of mount photos, cache-first and in one round-trip.
 *
 * A node is immutable — a re-upload is a new uid — so once its name and the revision's
 * claimedSize are known they never change. The encrypted meta cache is therefore
 * authoritative whenever it holds a positive size: that value was written from the very
 * claimedSize this pass would compute, so the size the mount hands the reconcile guard is
 * byte-for-byte the cloud size either way.
 *
 * Cache misses — a fresh uid, or an entry the search index wrote before it recorded sizes
 * (name + media type, no size) — are resolved together through one `iterateNodes` call.
 * That decrypts each node exactly as a per-uid getNode would (getNode is a one-element
 * iterateNodes internally, sharing the same revision and the same XAttr size), so the
 * claimedSize is identical; batching only folds N round-trips into one. Each result is
 * written back with its size, so a later pass and the search index both reuse it and
 * neither decrypts the name again. A uid whose node carries no positive-size revision, or
 * that vanished server-side, is omitted — the same photos the old inline path skipped.
 */
export async function resolveMountMetaBatch(
  photos: any,
  uids: string[],
): Promise<Map<string, { name: string; size: number; mediaType: string | null }>> {
  const out = new Map<string, { name: string; size: number; mediaType: string | null }>();
  const missing: string[] = [];
  for (const uid of uids) {
    const cached = metaGet(uid);
    if (cached && typeof cached.size === "number" && cached.size > 0) {
      out.set(uid, { name: cached.name || uid, size: cached.size, mediaType: cached.mediaType ?? null });
    } else {
      missing.push(uid);
    }
  }
  if (missing.length === 0) return out;

  try {
    for await (const node of withStallGuard(photos.iterateNodes(missing), SDK_STALL_MS, "iterateNodes")) {
      const n: any = node;
      if (n.missingUid) continue; // vanished server-side
      const revision = n.activeRevision?.ok ? n.activeRevision.value : null;
      const size = Number(revision?.claimedSize ?? 0);
      if (size <= 0) continue; // no positive-size revision: never cache a zero
      const name = nodeName(n) || n.uid;
      // This decrypt already holds the revision, so take the video length off it while
      // it is here. The grid's own resolver then finds it cached and never spends a
      // second decrypt on a node the mount has already been through.
      metaPut(n.uid, {
        name,
        mediaType: n.mediaType ?? null,
        size,
        durationMs: nodeDurationMs(n) ?? 0,
      });
      out.set(n.uid, { name, size, mediaType: n.mediaType ?? null });
    }
  } catch {
    // A lookup that fails partway still returns what it resolved; the rest carry no size
    // yet, so they are simply left out of this page and retried on the next pass.
  }
  return out;
}

/**
 * Video lengths in milliseconds for a batch of uids, cache-first and in one round-trip.
 *
 * The SDK exposes no duration of its own: it lives in the node's decrypted extended
 * attributes, which means a node decrypt per video. So this rides the same encrypted
 * meta cache the mount and the search index already fill — a uid either of those has
 * been through is answered from disk with no lookup at all — and resolves whatever is
 * left through a single `iterateNodes`, never one call per photo.
 *
 * A resolved length is cached, and so is the absence of one (as a zero): an image, or a
 * video uploaded before the attribute existed, is asked about exactly once instead of on
 * every scroll past it. Only positive lengths are returned, because only those have a
 * pill to draw.
 */
export async function resolveDurationsBatch(
  photos: any,
  uids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const missing: string[] = [];
  for (const uid of uids) {
    const cached = metaGet(uid);
    if (cached && typeof cached.durationMs === "number") {
      if (cached.durationMs > 0) out.set(uid, cached.durationMs);
    } else {
      missing.push(uid);
    }
  }
  if (missing.length === 0) return out;

  try {
    for await (const node of withStallGuard(photos.iterateNodes(missing), SDK_STALL_MS, "iterateNodes")) {
      const n: any = node;
      if (n.missingUid) continue; // vanished server-side
      const revision = n.activeRevision?.ok ? n.activeRevision.value : null;
      const size = Number(revision?.claimedSize ?? 0);
      const durationMs = nodeDurationMs(n) ?? 0;
      const name = nodeName(n) || n.uid;
      // A zero size is never written: the mount reads `size` as the cloud size and a
      // zero there would be taken for a real one.
      metaPut(n.uid, {
        name,
        mediaType: n.mediaType ?? null,
        durationMs,
        ...(size > 0 ? { size } : {}),
      });
      if (durationMs > 0) out.set(n.uid, durationMs);
    }
  } catch {
    // Whatever resolved before the failure still counts; the rest stay uncached and are
    // asked for again the next time those cells come round.
  }
  return out;
}

/**
 * Media types for a batch of uids, cache-first and in one round-trip.
 *
 * This is what tells the grid and the viewer that a photo is really a video. The tag
 * would be cheaper, since the timeline already carries it, but it is not the truth: a
 * file uploaded by a client that set no tag has none, and nothing about the tag being
 * absent says the file is a still. The media type is the file's own account of itself
 * and is the same for every client that ever wrote it.
 *
 * The timeline listing does not carry it. The server's photo listing returns the link id,
 * the capture time, the hashes and the tags, and nothing more, so it has to be resolved
 * per node. That is done here rather than by widening the timeline, which walks
 * the whole library: this rides the same encrypted meta cache the mount, the search index
 * and the duration resolver already fill, so a uid any of them has been through costs no
 * lookup at all, and the callers ask only for what is on screen.
 *
 * A resolved absence is cached as a null, so a node that will not answer is asked about
 * once rather than on every scroll past it.
 */
export async function resolveMediaTypesBatch(
  photos: any,
  uids: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const missing: string[] = [];
  for (const uid of uids) {
    const cached = metaGet(uid);
    if (cached) out.set(uid, cached.mediaType);
    else missing.push(uid);
  }
  if (missing.length === 0) return out;

  try {
    for await (const node of withStallGuard(photos.iterateNodes(missing), SDK_STALL_MS, "iterateNodes")) {
      const n: any = node;
      if (n.missingUid) continue; // vanished server-side
      const revision = n.activeRevision?.ok ? n.activeRevision.value : null;
      const size = Number(revision?.claimedSize ?? 0);
      const mediaType = n.mediaType ?? null;
      // This decrypt already holds the revision, so the length and the claimed size go in
      // beside it: the grid's pill and the Explorer mount then find them cached and spend
      // no second decrypt on a node this has already been through.
      metaPut(n.uid, {
        name: nodeName(n) || n.uid,
        mediaType,
        durationMs: nodeDurationMs(n) ?? 0,
        ...(size > 0 ? { size } : {}),
      });
      out.set(n.uid, mediaType);
    }
  } catch {
    // Whatever resolved before the failure still counts; the rest stay uncached and are
    // asked for again the next time those cells come round.
  }
  return out;
}

/**
 * One page of cloud photos as {uid, name, size, captureTime} for the Explorer mount.
 * `offset === 0` (re)builds the lightweight uid list once (a single cheap timeline pass);
 * later pages slice it. Names and claimed sizes come from `resolveMountMetaBatch`, which
 * decrypts only the page's cache misses and does so in one lookup, so a startup with no
 * new photos does zero node decrypts and returns in milliseconds. Paging still lets the
 * Rust host release the RPC lock between pages so thumbnails keep loading on a cold run.
 */
export async function listForMount(photos: any, offset: number, limit: number): Promise<MountPage> {
  if (offset === 0 || !mountUids) {
    const picks: { uid: string; captureTime: number; favorite: boolean }[] = [];
    for await (const item of withStallGuard(
      photos.iterateTimeline(),
      SDK_STALL_MS,
      "iterateTimeline(listForMount)",
    )) {
      const uid = (item as any).nodeUid ?? (item as any).uid;
      if (!uid) continue;
      const ct = (item as any).captureTime;
      const tags: number[] = (item as any).tags ?? [];
      picks.push({
        uid,
        captureTime: ct instanceof Date ? ct.getTime() : Number(ct) * 1000,
        favorite: tags.includes(PhotoTag.Favorites),
      });
    }
    mountUids = picks;
  }

  const slice = mountUids.slice(offset, offset + limit);
  const resolved = await resolveMountMetaBatch(photos, slice.map((p) => p.uid));
  const items: MountItem[] = [];
  for (const p of slice) {
    const m = resolved.get(p.uid);
    if (m) {
      // Both drives show this name as a file a double-click opens, so it always ends
      // in what it is: see `withMediaExtension`.
      items.push({
        uid: p.uid,
        name: withMediaExtension(m.name, m.mediaType),
        size: m.size,
        captureTime: p.captureTime,
        favorite: p.favorite,
      });
    }
  }
  return { items, total: mountUids.length };
}

/**
 * Stream one file's decrypted bytes to a temp file on disk and return its path,
 * for the host to transfer into the Explorer placeholder in small chunks. The full
 * file is never resident in memory: buffering it (plus a base64 copy for the RPC)
 * needed several times the file size at once, so a run of large videos starved the
 * single-threaded sidecar and stalled the whole app. Streaming keeps memory flat,
 * so there is also no size cap. The host deletes the temp file after the transfer.
 *
 * `dir` is the Linux drive's own staging folder: the sandbox's /tmp is a RAM-backed tmpfs
 * too small for a long video, so the host names a folder on disk instead. Only a folder
 * named for that purpose is taken, so this can never be pointed at anywhere else.
 */
export function hydrateDir(dir?: string): string {
  return dir && isAbsolute(dir) && basename(dir) === "pfp-hyd" ? dir : tmpdir();
}

/** A streamed download's state, by the file it is written to. */
type Streaming = { done: boolean; error: string | null; started: number; cancelled: boolean };
const streaming = new Map<string, Streaming>();

/**
 * Start downloading one file into `dir` and answer at once with where it is going: the
 * Linux drive serves the bytes while they arrive, so a video starts playing rather than
 * waiting for all of it. The file exists (empty) before this returns, and
 * `hydrateProgress` says when it is complete or failed. A failed one is deleted.
 */
export function startHydrate(photos: any, uid: string, dir?: string): { path: string } {
  const now = Date.now();
  for (const [path, s] of streaming) {
    if ((s.done || s.error) && now - s.started > 60 * 60_000) streaming.delete(path);
  }
  const base = hydrateDir(dir);
  if (base !== tmpdir()) mkdirSync(base, { recursive: true, mode: 0o700 });
  const dest = join(base, `pfp-hyd-${randomUUID()}.bin`);
  const state: Streaming = { done: false, error: null, started: now, cancelled: false };
  streaming.set(dest, state);
  const file = guarded(createWriteStream(dest, { fd: openSync(dest, "w", 0o600) }));
  void (async () => {
    try {
      const downloader = await photos.getFileDownloader(uid);
      const stream = new WritableStream<Uint8Array>({
        write(chunk) {
          // Refusing the next chunk is what stops a download nobody wants any more.
          if (state.cancelled) throw new Error("cancelled");
          return writeChunk(file, chunk);
        },
        abort() {
          file.destroy();
        },
      });
      await downloader.downloadToStream(stream as any).completion();
      await new Promise<void>((resolve, reject) => {
        file.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
      state.done = true;
    } catch (e) {
      if (!file.destroyed) {
        await new Promise<void>((resolve) => {
          file.once("close", () => resolve());
          file.destroy();
        });
      }
      rmSync(dest, { force: true });
      state.error = (e as Error).message || "download failed";
    }
  })();
  return { path: dest };
}

/** Stop a download `startHydrate` began, when its file has been let go of. */
export function cancelHydrate(path: string): void {
  const s = streaming.get(path);
  if (s && !s.done) s.cancelled = true;
}

/** Where a download `startHydrate` began stands. An unknown path reads as failed. */
export function hydrateProgress(path: string): { done: boolean; error: string | null } {
  const s = streaming.get(path);
  if (!s) return { done: false, error: "unknown download" };
  return { done: s.done, error: s.error };
}

export async function hydrateFile(photos: any, uid: string, dir?: string): Promise<HydratedFile> {
  const base = hydrateDir(dir);
  if (base !== tmpdir()) mkdirSync(base, { recursive: true, mode: 0o700 });
  const dest = join(base, `pfp-hyd-${randomUUID()}.bin`);
  const downloader = await photos.getFileDownloader(uid);
  const file = guarded(createWriteStream(dest));
  let total = 0;
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      total += chunk.byteLength;
      // Respect backpressure so a large file cannot balloon the write buffer.
      return writeChunk(file, chunk);
    },
    abort() {
      file.destroy();
    },
  });
  try {
    await downloader.downloadToStream(stream as any).completion();
    // Close ourselves and wait for the flush; end(cb) cannot hang the way waiting
    // on the SDK to call the stream's close() could (which froze the serial RPC).
    await new Promise<void>((resolve, reject) => {
      file.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    // Close our own handle and WAIT for it before deleting: on Windows an open handle
    // blocks the delete, so a bare destroy() then rmSync races the still-open fd, fails,
    // and strands a partial decrypted file (swept only at next startup). Same
    // close-before-delete the save path uses.
    if (!file.destroyed) {
      const handle = file;
      await new Promise<void>((resolve) => {
        handle.once("close", () => resolve());
        handle.destroy();
      });
    }
    try {
      rmSync(dest, { force: true });
    } catch {
      /* a cleanup failure must not mask the original error */
    }
    throw e;
  }
  return { path: dest, size: total };
}

// ---- Full-resolution originals for the viewer ----
//
// The viewer shows three things in turn: the grid thumbnail at once, then the Type2
// preview, then the photo's own bytes. That last step is a whole file, so it never
// travels over the JSON-RPC channel — base64 would inflate it by a third and pin the
// single channel for the whole transfer. It is streamed to a temp file exactly the way
// a placeholder hydration is, and the webview reads that file over the asset protocol.
//
// The transfer runs OFF the channel too: `getOriginal` starts it and returns at once,
// and the viewer polls the same call for the outcome, the way a save-to-folder run is
// polled. A blocking call would hold the channel for the length of a 50 MB download and
// stall the next photo's preview behind it.
//
// Exactly one original exists at a time. Asking for a different photo aborts the one in
// flight and deletes its file, so decrypted copies never pile up on disk.

/**
 * Where the decrypted originals are staged. A directory of its own, rather than loose
 * files in the temp dir: it lets the asset protocol be scoped to that one folder instead
 * of anywhere the app can write, and it lets the startup sweep empty the lot outright.
 */
// One fixed folder in the app. The tests give each of their processes its own through
// PFP_VIEW_DIR, since test files run side by side and one file's sweep would otherwise
// delete what another is in the middle of writing.
export const VIEW_DIR = process.env.PFP_VIEW_DIR || join(tmpdir(), "pfp-view");

/**
 * What the webview can actually draw. HEIC, RAW and most TIFF are absent on purpose:
 * the browser engine cannot decode them, so fetching the original would spend the
 * bandwidth and still leave a broken image — those photos keep their preview. SVG is
 * left off as well; a photo library has no use for it and it is the one image type
 * that carries markup.
 */
const VIEWABLE_MEDIA = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/apng",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-ms-bmp",
]);

const VIEWABLE_EXT = new Set(["jpg", "jpeg", "jpe", "png", "apng", "gif", "webp", "avif", "bmp"]);

/** The extension of `name`, lowercased, or "" when it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Whether the webview can draw this photo's own bytes.
 *
 * Either signal is enough. The media type is the better one, but a photo stored without
 * one — or with a generic one a re-upload stamped on it — would never upgrade if that
 * were the only test, so the filename extension can vouch for it too. A format neither
 * signal recognises is refused: keeping the preview beats downloading a file that cannot
 * be drawn.
 */
export function isViewableOriginal(mediaType: string | null | undefined, name: string): boolean {
  const mt = (mediaType ?? "").toLowerCase().split(";")[0].trim();
  return VIEWABLE_MEDIA.has(mt) || VIEWABLE_EXT.has(extensionOf(name));
}

/** A real extension for the staged file, so its type is right even without magic bytes. */
function stagedExtension(mediaType: string | null | undefined, name: string): string {
  const ext = extensionOf(name);
  if (VIEWABLE_EXT.has(ext)) return ext;
  const mt = (mediaType ?? "").toLowerCase().split(";")[0].trim();
  return mt.startsWith("image/") ? mt.slice("image/".length).replace(/[^a-z0-9]/g, "") || "img" : "img";
}

/** Extension to media type, for a photo stored without one the webview can use. */
const EXT_MEDIA: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  png: "image/png",
  apng: "image/apng",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

/**
 * What the host should label the bytes as. The stored media type wins; a photo
 * without a usable one falls back to its extension, and to JPEG past that — the
 * route is only ever taken for a format `isViewableOriginal` already vouched for.
 */
function mediaTypeFor(mediaType: string | null | undefined, name: string): string {
  const mt = (mediaType ?? "").toLowerCase().split(";")[0].trim();
  if (VIEWABLE_MEDIA.has(mt)) return mt;
  return EXT_MEDIA[extensionOf(name)] ?? "image/jpeg";
}

type ViewEntry = {
  uid: string;
  status: OriginalStatus;
  /** The staged plaintext file, when this one took the file route. */
  path: string | null;
  /** The decrypted bytes, when this one took the in-memory route. */
  bytes: Buffer | null;
  /**
   * What the host redeems for those bytes. Unguessable and single-photo, so a URL
   * the webview kept from an earlier photo resolves to nothing rather than to
   * whatever is staged now.
   */
  token: string | null;
};

// The one original that exists at a time. Replacing it is what cancels the previous
// transfer: every step of a transfer checks that it is still the current entry.
let viewing: ViewEntry | null = null;

/**
 * Delete a staged original, retrying briefly. On Windows a file cannot be deleted while
 * it is open, and the webview may still be reading the one it was just handed, so a
 * first attempt can legitimately fail. After the retries the startup sweep is the
 * backstop — a decrypted photo is never left on disk on purpose.
 */
function removeStaged(path: string, attempt = 0): void {
  try {
    rmSync(path, { force: true });
  } catch {
    if (attempt < 5) {
      setTimeout(() => removeStaged(path, attempt + 1), 200).unref();
    }
  }
}

/** Empty the staging directory. Used when an account locks, and on a fresh start. */
export function clearViewDir(): void {
  try {
    rmSync(VIEW_DIR, { recursive: true, force: true });
  } catch {
    /* a sweep failure must not fail the caller; startup sweeps it again */
  }
}

/**
 * Stream one original for the viewer. Detached: the caller returns to the app
 * immediately and the entry's status carries the outcome. Aborts as soon as the viewer
 * moves on, so stepping through photos never pays for bytes nobody will look at.
 *
 * Ordinary photos are collected in memory and handed to the host over the channel, so
 * no decrypted copy is written anywhere. The staged-file route is kept for the ones too
 * large for that (see `MAX_INMEMORY_ORIGINAL`), and for a photo whose claimed size is
 * unknown, since guessing wrong there is what the spill below has to catch.
 */
async function streamOriginal(
  photos: any,
  entry: ViewEntry,
  ext: string,
  mime: string,
): Promise<void> {
  const dest = join(VIEW_DIR, `${randomUUID()}.${ext}`);
  let file: ReturnType<typeof createWriteStream> | null = null;
  let buffered: Buffer[] | null = null;
  try {
    const downloader = await photos.getFileDownloader(entry.uid);
    if (viewing !== entry) return; // moved on while the downloader was being set up

    const claimed = Number(downloader.getClaimedSizeInBytes?.() ?? 0);
    // Unknown size takes the file route: it is the one that cannot be caught out by
    // a photo that turns out to be far larger than it claimed.
    if (claimed > 0 && claimed <= MAX_INMEMORY_ORIGINAL) buffered = [];

    /**
     * Move to the staged file, carrying over whatever is already buffered. The
     * carried write does not wait on drain the way the steady-state one below does:
     * what it hands over is bounded by `MAX_INMEMORY_ORIGINAL`, so it is one finite
     * burst rather than something that could grow with the file.
     */
    const spill = async (chunks: Buffer[]): Promise<void> => {
      mkdirSync(VIEW_DIR, { recursive: true });
      file = guarded(createWriteStream(dest));
      entry.path = dest; // recorded before the first byte, so an abort can clean up
      for (const chunk of chunks) file.write(chunk);
      buffered = null;
    };

    if (!buffered) await spill([]);

    let total = 0;
    const stream = new WritableStream<Uint8Array>({
      async write(chunk) {
        if (viewing !== entry) throw new Error("SUPERSEDED");
        total += chunk.byteLength;
        if (buffered) {
          buffered.push(Buffer.from(chunk));
          // The claimed size was wrong and this no longer belongs in memory. Carry
          // what we have to disk and finish there rather than fail the upgrade.
          if (total > MAX_INMEMORY_ORIGINAL) await spill(buffered);
          return;
        }
        const handle = file as ReturnType<typeof createWriteStream>;
        // Respect backpressure so a large file cannot balloon the write buffer.
        return writeChunk(handle, chunk);
      },
      abort() {
        file?.destroy();
      },
    });
    await downloader.downloadToStream(stream as any).completion();

    if (file) {
      const handle: ReturnType<typeof createWriteStream> = file;
      // Close ourselves and wait for the flush; end(cb) cannot hang the way waiting on
      // the SDK to call the stream's close() could.
      await new Promise<void>((resolve, reject) => {
        handle.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }

    if (viewing !== entry) {
      if (file) removeStaged(dest);
      return;
    }
    if (buffered) {
      entry.bytes = Buffer.concat(buffered);
      entry.token = randomUUID();
      entry.status = { state: "ready", via: "memory", token: entry.token, size: total, mime };
    } else {
      entry.status = { state: "ready", via: "file", path: dest, size: total };
    }
    // The byte count and the route are enough to follow an upgrade in the log; never
    // the photo itself.
    process.stderr.write(
      `[view] original ready: ${total} bytes via ${buffered ? "memory" : "file"}\n`,
    );
  } catch {
    // Close our own write handle before deleting: on Windows an open handle blocks the
    // delete, so cleanup cannot lean on the SDK aborting the stream.
    if (file) {
      const handle: ReturnType<typeof createWriteStream> = file;
      if (!handle.destroyed) {
        await new Promise<void>((resolve) => {
          handle.once("close", () => resolve());
          handle.destroy();
        });
      }
      removeStaged(dest);
    }
    if (viewing === entry) {
      entry.path = null;
      entry.bytes = null;
      entry.token = null;
      entry.status = { state: "error" };
    }
  }
}

/**
 * Write a pinned original to the staging folder, decrypting it as it goes.
 *
 * The other half of `openOffline`. Past the in-memory cap the bytes cannot go over the
 * channel, but the photo still has to open with no network, which is the whole reason
 * it was pinned. So it takes the same staged-file route the network path takes at this
 * size: the same folder, the same naming, and the same cleanup, which is what lets a
 * release, a lock and the host's startup sweep take it without knowing where it came
 * from. Detached like that path too, so a large decrypt never holds the channel.
 */
async function stageOffline(entry: ViewEntry): Promise<void> {
  const meta = metaGet(entry.uid);
  const ext = stagedExtension(meta?.mediaType, meta?.name ?? "");
  const dest = join(VIEW_DIR, `${randomUUID()}.${ext}`);
  try {
    mkdirSync(VIEW_DIR, { recursive: true });
    entry.path = dest; // recorded before the first byte, so a release can clean up
    const size = await decryptOriginalTo(entry.uid, dest, () => viewing !== entry);
    if (viewing !== entry) {
      removeStaged(dest);
      return;
    }
    entry.status = { state: "ready", via: "file", path: dest, size };
    process.stderr.write(`[view] offline original ready: ${size} bytes via file\n`);
  } catch {
    removeStaged(dest);
    if (viewing === entry) {
      entry.path = null;
      entry.bytes = null;
      entry.status = { state: "error" };
    }
  }
}

/**
 * Serve a photo kept offline straight from the sealed store: no node lookup and no
 * transfer, nothing but a local read and a decrypt, so it works with the network away
 * entirely. Ordinary photos settle on the viewer's first call instead of after a poll.
 *
 * Past the in-memory cap it answers `loading` and stages the bytes to a file instead,
 * because the host admits one call at a time and holds it for the whole base64
 * hand-over. Both invariants then hold at once: the channel stays inside its budget and
 * a pinned photo still opens with nothing but the disk.
 *
 * Returns null only when nothing usable is stored, which does mean "fall through to the
 * network" and is the honest answer to that.
 */
function openOffline(uid: string): ViewEntry | null {
  if (!isOfflineReady(uid)) return null;
  const meta = metaGet(uid);
  const name = meta?.name ?? "";
  if (!isViewableOriginal(meta?.mediaType, name)) {
    return { uid, status: { state: "unsupported" }, path: null, bytes: null, token: null };
  }
  // Read from the blob's length rather than its contents, so the route is chosen before
  // anything is decrypted; the staged path then never holds the whole photo at all.
  const storedSize = originalSize(uid);
  if (storedSize === null) return null;
  if (storedSize > MAX_INMEMORY_ORIGINAL) {
    return { uid, status: { state: "loading" }, path: null, bytes: null, token: null };
  }
  const bytes = originalGet(uid);
  if (!bytes) return null;
  const token = randomUUID();
  return {
    uid,
    status: {
      state: "ready",
      via: "memory",
      token,
      size: bytes.length,
      mime: mediaTypeFor(meta?.mediaType, name),
    },
    path: null,
    bytes,
    token,
  };
}

/**
 * Redeem a token for the bytes the host is about to serve. Base64 because the channel
 * is JSON; only the in-memory route ever gets here, and it is bounded by
 * `MAX_INMEMORY_ORIGINAL` precisely so this stays a short hold on the channel.
 *
 * A token that is not the current one answers null rather than anything else's bytes.
 */
export function readOriginalBytes(token: string): { base64: string; mime: string } | null {
  if (!viewing || !viewing.token || viewing.token !== token || !viewing.bytes) return null;
  const status = viewing.status;
  return {
    base64: viewing.bytes.toString("base64"),
    mime: status.state === "ready" && status.via === "memory" ? status.mime : "image/jpeg",
  };
}

/**
 * Start (or report on) the full-resolution original for one photo.
 *
 * Idempotent per photo: the first call kicks the transfer off and answers `loading`,
 * and every later call for the same photo reads the outcome back, so the viewer can
 * poll this one method. Asking for a different photo releases the previous one first.
 *
 * Returns without downloading anything when the format is one the webview cannot draw,
 * so a library of HEIC or RAW files costs nothing beyond the node lookup.
 */
export async function getOriginal(photos: any, uid: string): Promise<OriginalStatus> {
  if (viewing?.uid === uid) return viewing.status;
  releaseOriginal();

  // A photo kept offline is already here. Answering before the node lookup is what
  // lets it open with no network, and what makes it skip straight to full quality
  // instead of climbing the preview step first.
  const offline = openOffline(uid);
  if (offline) {
    viewing = offline;
    // Started only once `viewing` holds this entry, so the write's own cancel check
    // compares against the right one from its first chunk.
    if (offline.status.state === "loading") void stageOffline(offline);
    return offline.status;
  }

  let node: any;
  try {
    node = await photos.getNode(uid);
  } catch {
    viewing = { uid, status: { state: "error" }, path: null, bytes: null, token: null };
    return viewing.status;
  }

  const name = nodeName(node) || "";
  if (!isViewableOriginal(node?.mediaType, name)) {
    viewing = { uid, status: { state: "unsupported" }, path: null, bytes: null, token: null };
    return viewing.status;
  }

  const entry: ViewEntry = {
    uid,
    status: { state: "loading" },
    path: null,
    bytes: null,
    token: null,
  };
  viewing = entry;
  void streamOriginal(
    photos,
    entry,
    stagedExtension(node?.mediaType, name),
    mediaTypeFor(node?.mediaType, name),
  );
  return entry.status;
}

/**
 * Drop the original the viewer was holding: aborts a transfer still running, deletes a
 * staged file and releases the in-memory bytes. Called when the viewer steps to another
 * photo or closes, so a decrypted copy lives only as long as it is on screen. With a uid
 * it releases only that photo, so a release racing a step to the next one cannot take
 * the new photo's copy with it.
 */
export function releaseOriginal(uid?: string): void {
  if (!viewing) return;
  if (uid !== undefined && viewing.uid !== uid) return;
  const path = viewing.path;
  viewing = null; // this is what the in-flight transfer sees as its cancel
  if (path) removeStaged(path);
}

