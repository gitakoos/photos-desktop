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

/**
 * Getting a Google Takeout or Ente export onto disk and into upload groups.
 *
 * A folder is read where it is. A zip is unpacked first into a folder of its own under
 * the temp directory, because everything downstream works on files: the hash, the
 * thumbnails, and the frames the host makes for videos. Only media and the sidecar JSON
 * come out of a zip, and only after checking the disk can hold them.
 */

import { mkdir, open, readFile, readdir, rm, stat, statfs, utimes, type FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

import { MAX_SIDECAR_BYTES, SidecarIndex, albumFolderOf, parseSidecar, type SidecarMeta } from "./takeout.ts";

/** Room left on the disk beyond the unpacked export, so unpacking never fills it up. */
const FREE_SPACE_MARGIN = 1024 * 1024 * 1024;

/**
 * The staging folder's name. The host names the folder in `PFP_IMPORT_DIR` when it starts the
 * sidecar: on Linux a folder on disk, as /tmp there is often a small RAM disk that a Takeout
 * export does not fit in.
 */
const IMPORT_STAGING = "pfp-import";

/** The folder every unpacked export lives in, and the only one an import may delete. */
export function importStagingDir(): string {
  const named = process.env.PFP_IMPORT_DIR;
  return named && isAbsolute(named) && basename(named) === IMPORT_STAGING
    ? named
    : join(tmpdir(), IMPORT_STAGING);
}

/** Whether `path` is one of this app's unpacked exports, never anything of the user's. */
export function isStagedImport(path: string): boolean {
  const base = importStagingDir() + sep;
  const full = resolve(path);
  return full.startsWith(base) && full.length > base.length;
}

/** Deletes an unpacked export. Anything outside the staging folder is left alone. */
export async function discardStagedImport(root: string): Promise<void> {
  if (isStagedImport(root)) await rm(root, { recursive: true, force: true }).catch(() => {});
}

/** How old an unpacked export must be before a new import clears it as left behind. */
const STALE_STAGING_MS = 24 * 3600_000;

/**
 * Deletes unpacked exports a crash or a forced quit left behind. Only ones older than a day go,
 * so an import another window of this app is still preparing is never touched. On disk, unlike
 * /tmp, nothing else would ever clear them.
 */
export async function sweepStaleStaging(now = Date.now()): Promise<void> {
  const dir = importStagingDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const root = join(dir, name);
    const info = await stat(root).catch(() => null);
    if (info && now - info.mtimeMs > STALE_STAGING_MS) await discardStagedImport(root);
  }
}

/** One photo or video of an export, as it will upload. */
export type ExportItem = {
  /** Full path on disk. */
  file: string;
  /** The album it was in, or null for the timeline. */
  album: string | null;
  sidecar?: SidecarMeta;
  /** A Live Photo's video: uploaded with the photo as one item rather than on its own. */
  liveVideo?: string;
  /** Other videos of the same still, from its copies in the export: each goes up on its own. */
  moreVideos?: string[];
  /** The other albums the export holds a copy of this photo in; it joins those too. */
  alsoIn?: string[];
};

export type ExportPlan = { items: ExportItem[] };

/** The still of a Live Photo: what Apple and Ente export beside the video of the same name. */
const LIVE_STILL = /\.(heic|heif|jpe?g)$/i;
/** The motion of a Live Photo. */
const LIVE_MOTION = /\.(mov|mp4)$/i;

/**
 * Reads exports already on disk into items. Every root is one export, or one part of a
 * split one: they share a single sidecar index, because Takeout can put a photo in one
 * archive and its JSON in another. A photo's album is the folder it sits in, relative to
 * its root.
 *
 * A Live Photo is exported as two files, a still and a video, with the same name in the
 * same folder (`IMG_1234.HEIC` and `IMG_1234.MOV`). Exactly one of each under one name is
 * paired; anything less certain stays two separate items.
 */
export async function planExport(roots: string[], isMedia: (name: string) => boolean): Promise<ExportPlan> {
  const index = new SidecarIndex();
  const media: { full: string; rel: string }[] = [];

  for (const root of roots) {
    const files: string[] = [];
    const enteTops: string[] = [];
    for await (const full of walk(root)) {
      files.push(full);
      if (basename(full).toLowerCase() === ENTE_EXPORT_RECORD) enteTops.push(dirname(full));
    }
    // Ente moves what was deleted since the last export into a Trash folder of its own,
    // album by album: those were deleted, and never upload.
    const enteTrash = enteTops.map((top) => join(top, ENTE_TRASH).toLowerCase() + sep);
    for (const full of files) {
      if (enteTrash.some((trash) => full.toLowerCase().startsWith(trash))) continue;
      const rel = relative(root, full).split(sep).join("/");
      if (full.toLowerCase().endsWith(".json")) {
        const meta = await readSidecar(full);
        if (meta) index.add(rel, meta);
      } else if (isMedia(full)) {
        media.push({ full, rel });
      }
    }
  }

  // Stills and videos by folder and name, to find the pairs.
  const byStem = new Map<string, { stills: string[]; motions: string[] }>();
  for (const { full, rel } of media) {
    const key = rel.replace(/\.[^./]+$/, "").toLowerCase();
    let entry = byStem.get(key);
    if (!entry) byStem.set(key, (entry = { stills: [], motions: [] }));
    if (LIVE_STILL.test(full)) entry.stills.push(full);
    else if (LIVE_MOTION.test(full)) entry.motions.push(full);
  }
  const liveVideoOf = new Map<string, string>();
  const pairedVideos = new Set<string>();
  const sidecarOf = new Map(media.map(({ full, rel }) => [full, index.find(rel)]));
  for (const { stills, motions } of byStem.values()) {
    if (stills.length === 1 && motions.length === 1 && sameMoment(sidecarOf.get(stills[0]), sidecarOf.get(motions[0]))) {
      liveVideoOf.set(stills[0], motions[0]);
      pairedVideos.add(motions[0]);
    }
  }

  const items: ExportItem[] = [];
  const favourites: { item: ExportItem; key: string }[] = [];
  for (const { full, rel } of media) {
    if (pairedVideos.has(full)) continue;
    const item: ExportItem = { file: full, album: albumFolderOf(rel) };
    const meta = index.find(rel);
    if (meta) item.sidecar = meta;
    const video = liveVideoOf.get(full);
    if (video) item.liveVideo = video;
    if (item.album !== null && item.album.toLowerCase() === ENTE_FAVOURITES) {
      favourites.push({ item, key: await sameFileKey(full) });
    } else {
      items.push(item);
    }
  }

  // Ente keeps favourites as a collection of their own, and its export writes a second
  // copy of each favourite into a Favorites folder. They are favourites, not an album:
  // the copy marks the photo it copies, and only a favourite with no other copy uploads
  // from there, onto the timeline.
  if (favourites.length > 0) {
    const byKey = new Map<string, ExportItem>();
    for (const item of items) {
      const key = await sameFileKey(item.file);
      if (!byKey.has(key)) byKey.set(key, item);
    }
    for (const { item, key } of favourites) {
      const target = byKey.get(key) ?? item;
      target.sidecar = { ...(target.sidecar ?? item.sidecar ?? { favorited: false }), favorited: true };
      if (target === item) {
        item.album = null;
        items.push(item);
      }
    }
  }
  return { items: await mergeCopies(items) };
}

/** The file at the top of an Ente export, which tells one apart from any other folder. */
const ENTE_EXPORT_RECORD = "export_status.json";

/** Ente's folder for what was deleted since the last export, under the export's top. */
const ENTE_TRASH = "Trash";

/** How far apart a Live Photo's still and video may be dated and still be one photo. */
const LIVE_DATE_SLACK_MS = 3000;

/**
 * Whether a still and a video of one name were taken together, as far as their sidecars
 * tell: Ente dates both halves of a Live Photo alike. Two photos that only share a name
 * (Ente numbers the second `IMG_1(1).jpg` but its video may keep `IMG_1.mov`) are dated
 * apart. Without a date on both, the name is all there is, and it decides.
 */
function sameMoment(still: SidecarMeta | undefined, motion: SidecarMeta | undefined): boolean {
  if (still?.takenMs === undefined || motion?.takenMs === undefined) return true;
  return Math.abs(still.takenMs - motion.takenMs) <= LIVE_DATE_SLACK_MS;
}

/** Ente's name for the collection of favourites, and so for its folder in an export. */
const ENTE_FAVOURITES = "favorites";

/**
 * What makes two copies of a photo in an export the same file: its name, its size and its
 * first 64 KB. Exports copy a photo byte for byte into every folder that holds it, so
 * these agree for copies and almost never for two different photos that only happen to
 * share a name and a size.
 */
async function sameFileKey(path: string): Promise<string> {
  let size = -1;
  let head = "";
  try {
    const file = await open(path, "r");
    try {
      size = (await file.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
      await file.read(buffer, 0, buffer.length, 0);
      head = createHash("sha1").update(buffer).digest("hex");
    } finally {
      await file.close();
    }
  } catch {
    /* unreadable: its key matches nothing else */
    head = path;
  }
  return `${basename(path).toLowerCase()}|${size}|${head}`;
}

/**
 * One item per photo, however many folders the export copied it into. Ente writes a copy
 * into each album the photo is in, and Takeout puts an album's photos in their year
 * folders as well. The copy in an album is the one kept; the other albums go on its
 * `alsoIn`, so it uploads once and joins every one of them.
 */
async function mergeCopies(items: ExportItem[]): Promise<ExportItem[]> {
  const byKey = new Map<string, ExportItem>();
  const out: ExportItem[] = [];
  for (const item of items) {
    const key = await sameFileKey(item.file);
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, item);
      out.push(item);
      continue;
    }
    // The copy in an album outranks one on the timeline, which an album implies anyway.
    if (kept.album === null && item.album !== null) {
      kept.album = item.album;
      kept.file = item.file;
    } else if (item.album !== null && item.album !== kept.album && !kept.alsoIn?.includes(item.album)) {
      kept.alsoIn = [...(kept.alsoIn ?? []), item.album];
    }
    kept.sidecar = kept.sidecar ?? item.sidecar;
    if (item.sidecar?.favorited && kept.sidecar) kept.sidecar = { ...kept.sidecar, favorited: true };
    // A copy's own video goes up too unless it is the kept one: the review matches the bytes.
    if (!kept.liveVideo) kept.liveVideo = item.liveVideo;
    else if (item.liveVideo && item.liveVideo !== kept.liveVideo) kept.moreVideos = [...(kept.moreVideos ?? []), item.liveVideo];
  }
  return out;
}

/** Progress of an unpack, in bytes of the entries kept. */
export type UnpackProgress = (done: number, total: number) => void;

/** How many bytes of one entry are written between two progress reports. */
const UNPACK_PROGRESS_STEP = 4 * 1024 * 1024;

/**
 * Creates `path` for writing, never over a file already there: two entries whose names differ
 * only in case are one file on a disk that ignores case (APFS, NTFS), and the second would
 * replace the first. The second becomes `name (2).ext`, the next `name (3).ext`, and so on.
 */
export async function openFresh(path: string): Promise<{ handle: FileHandle; path: string }> {
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let n = 1; n <= 10_000; n++) {
    const candidate = n === 1 ? path : `${stem} (${n})${ext}`;
    try {
      return { handle: await open(candidate, "wx"), path: candidate };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error("no free name to unpack an entry to");
}

/**
 * Unpacks the media and sidecars of one zip into a fresh folder under the staging
 * folder, and returns that folder. Refuses before writing anything when the disk cannot
 * hold them with room to spare. On any failure the half-written folder is removed.
 */
export async function unpackZip(
  zipPath: string,
  isMedia: (name: string) => boolean,
  onProgress: UnpackProgress = () => {},
  signal?: AbortSignal,
): Promise<string> {
  const keep = (name: string | null, size: number): name is string =>
    name !== null &&
    !name.endsWith("/") &&
    (isMedia(name) || (name.toLowerCase().endsWith(".json") && size <= MAX_SIDECAR_BYTES));

  // First the central directory alone, to know what unpacking will cost.
  let total = 0;
  await eachEntry(zipPath, async (entry) => {
    if (keep(entryPath(entry), entry.uncompressedSize)) total += entry.uncompressedSize;
  });
  await ensureFreeSpace(total, "to unpack this export");

  const root = join(importStagingDir(), randomBytes(8).toString("hex"));
  await mkdir(root, { recursive: true });
  let done = 0;
  onProgress(0, total);
  try {
    await eachEntry(zipPath, async (entry, zip) => {
      if (signal?.aborted) throw new Error("cancelled");
      const name = entryPath(entry);
      if (!keep(name, entry.uncompressedSize)) return;
      const dest = resolve(root, ...name.split("/"));
      if (!dest.startsWith(root + sep)) return;
      await mkdir(dirname(dest), { recursive: true });
      const { handle, path: file } = await openFresh(dest);
      const stream = await zip.openReadStreamPromise(entry).catch(async (e) => {
        await handle.close();
        throw e;
      });
      // Counted as it is written, so one large video does not hold the bar still until it ends.
      const before = done;
      let written = 0;
      let reported = 0;
      stream.on("data", (chunk: Buffer) => {
        written += chunk.length;
        if (written - reported >= UNPACK_PROGRESS_STEP) {
          reported = written;
          onProgress(before + Math.min(written, entry.uncompressedSize), total);
        }
      });
      await pipeline(stream, handle.createWriteStream());
      const modified = entryModified(entry);
      if (modified) await utimes(file, modified, modified).catch(() => {});
      done = before + entry.uncompressedSize;
      onProgress(done, total);
    });
  } catch (e) {
    await discardStagedImport(root);
    throw e;
  }
  return root;
}

/**
 * Refuses before anything is written when the staging folder's disk cannot hold `bytes` with
 * room to spare. `what` says what the room was for.
 */
export async function ensureFreeSpace(bytes: number, what = "to bring these files in"): Promise<void> {
  await mkdir(importStagingDir(), { recursive: true });
  const free = await statfs(importStagingDir()).then(
    (s) => s.bavail * s.bsize,
    () => Number.POSITIVE_INFINITY,
  );
  if (free < bytes + FREE_SPACE_MARGIN) {
    throw new Error(
      `Not enough free disk space ${what}: it needs ${gigabytes(bytes + FREE_SPACE_MARGIN)}, ${gigabytes(free)} is free.`,
    );
  }
}

/** Whether a picked path is a zip, by its name. */
export function isZip(path: string): boolean {
  return path.toLowerCase().endsWith(".zip");
}

async function readSidecar(path: string): Promise<SidecarMeta | null> {
  try {
    const info = await stat(path);
    if (info.size > MAX_SIDECAR_BYTES) return null;
    return parseSidecar(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Every file under `root`, depth first. Links are not followed. */
async function* walk(root: string): AsyncGenerator<string> {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) pending.push(full);
      else if (e.isFile()) yield full;
    }
  }
}

/**
 * An entry's path inside the zip with any leading slashes dropped, or null when it is not one to
 * unpack: a drive letter, or a `..` step out of the folder. A Dropbox download carries a `/` entry of
 * its own, which the zip reader would otherwise refuse together with the whole archive.
 */
function entryPath(entry: yauzl.Entry): string | null {
  const name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false);
  const path = name.replace(/^\/+/, "");
  if (!path || /^[a-zA-Z]:/.test(path) || path.split("/").includes("..")) return null;
  return path;
}

/** 1980-01-02T00:00:00Z: a zip with no time stores 1 January 1980, which is no date at all. */
const DOS_EPOCH_END_MS = 315_619_200_000;
const FUTURE_SLACK_MS = 24 * 3600_000;

/** When the entry was last changed by the zip's own record, or null when it holds no real time. */
function entryModified(entry: yauzl.Entry, now = Date.now()): Date | null {
  const when = entry.getLastModDate();
  const ms = when.getTime();
  return Number.isFinite(ms) && ms > DOS_EPOCH_END_MS && ms <= now + FUTURE_SLACK_MS ? when : null;
}

/** Visits a zip's entries one at a time, each awaited before the next is read. */
function eachEntry(
  zipPath: string,
  visit: (entry: yauzl.Entry, zip: yauzl.ZipFile) => Promise<void>,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: false }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error("could not open the zip"));
        return;
      }
      let failed = false;
      zip.on("entry", (entry: yauzl.Entry) => {
        visit(entry, zip).then(
          () => zip.readEntry(),
          (e) => {
            failed = true;
            zip.close();
            reject(e);
          },
        );
      });
      zip.on("end", () => {
        if (!failed) resolvePromise();
      });
      zip.on("error", (e) => {
        failed = true;
        reject(e);
      });
      zip.readEntry();
    });
  });
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
