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

// Folders of the account's Proton Drive "My files", for bringing their photos and videos into
// Photos: listed for the picker, walked for what they hold, and downloaded into the import's
// staging folder, where the import reads them as it reads an export. A photo in My files is a
// plain file, not a photo: it becomes one by being uploaded again, as a photo.

import { mkdir, open, rm, utimes } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { diag } from "./diag.ts";
import { activeRevisionOf, nodeName } from "./nodes.ts";
import { SDK_STALL_MS, StallError } from "./stallGuard.ts";

/** A photo or video of My files, as the picker shows it. */
export type MyFileEntry = { uid: string; name: string; size: number; modifiedMs: number | null };

/**
 * A folder the picker shows: its sub-folders, each with whether it holds a photo or video
 * somewhere when that is already known, and the photos and videos straight in it.
 */
export type MyFolderListing = {
  uid: string;
  name: string;
  folders: { uid: string; name: string; holds?: boolean }[];
  /** The photos and videos straight in it. */
  files: MyFileEntry[];
};

/** One file to bring in: where it is on Drive, where it goes under the staging folder. */
export type MyFileItem = {
  nodeUid: string;
  /** The path under the staging folder, the chosen folder first. */
  rel: string;
  size: number;
  /** When the file was last changed, as the device that put it on Drive said. */
  modifiedMs: number | null;
};

const sizeOf = (node: any): number => {
  const rev = activeRevisionOf(node);
  return Number(rev?.claimedSize ?? rev?.storageSize ?? node?.totalStorageSize ?? 0) || 0;
};

const modifiedOf = (node: any): number | null => {
  const rev = activeRevisionOf(node);
  const at = rev?.claimedModificationTime ?? node?.modificationTime;
  const ms = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const isFile = (node: any) => node?.type === "file" && !node?.trashTime;
const isFolder = (node: any) => node?.type === "folder" && !node?.trashTime;

/** How many sub-folders are looked into at once for whether they hold a photo. */
const LOOK_AHEAD = 8;

/** How long one call looks into folders before it answers with what it has. */
export const CHECK_BUDGET_MS = 1500;

/** A look into the folders that ran out of time; what it learned is kept for the next. */
class OutOfTime extends Error {}

/**
 * Whether each of these folders holds a photo or video somewhere, a few looked into at once,
 * for about `budgetMs`: a folder not settled by then is left out of the answer, to be asked
 * again. What was found under it is kept in `known`, and every call settles at least one more
 * folder, so asking again always gets further. Keeps each call short, so the window's other
 * calls are not held up behind a deep tree.
 */
export async function checkMyFolders(
  client: any,
  uids: string[],
  isMedia: (name: string) => boolean,
  known: Map<string, boolean>,
  budgetMs = CHECK_BUDGET_MS,
  now: () => number = Date.now,
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  const deadline = now() + budgetMs;
  for (let i = 0; i < uids.length; i += LOOK_AHEAD) {
    if (i > 0 && now() > deadline) break;
    const batch = uids.slice(i, i + LOOK_AHEAD);
    const answers = await Promise.all(
      batch.map((uid) =>
        holdsMedia(client, uid, isMedia, known, deadline, now).catch((e) => (e instanceof OutOfTime ? undefined : true)),
      ),
    );
    batch.forEach((uid, j) => {
      if (answers[j] !== undefined) out[uid] = answers[j]!;
    });
  }
  return out;
}

/**
 * Whether a folder holds a photo or video anywhere under it: the first one found answers, so
 * only a folder with none is walked to its end. Answers are kept in `known`.
 */
export async function holdsMedia(
  client: any,
  uid: string,
  isMedia: (name: string) => boolean,
  known: Map<string, boolean>,
  deadline = Number.POSITIVE_INFINITY,
  now: () => number = Date.now,
): Promise<boolean> {
  const cached = known.get(uid);
  if (cached !== undefined) return cached;
  const folders: string[] = [];
  let found = false;
  for await (const node of client.iterateFolderChildren(uid)) {
    if (isFile(node) && isMedia(nodeName(node))) {
      found = true;
      break;
    }
    if (isFolder(node)) folders.push(node.uid);
  }
  // What an earlier look already settled answers at once; only the rest is walked.
  if (!found) found = folders.some((f) => known.get(f) === true);
  const open = folders.filter((f) => !known.has(f));
  for (let i = 0; !found && i < open.length; i += LOOK_AHEAD) {
    // The first few unsettled sub-folders are always looked into, so time running out never
    // stops a look before it got further than the one before it.
    if (i > 0 && now() > deadline) throw new OutOfTime();
    const answers = await Promise.all(
      open.slice(i, i + LOOK_AHEAD).map((f) => holdsMedia(client, f, isMedia, known, deadline, now)),
    );
    found = answers.some(Boolean);
  }
  known.set(uid, found);
  return found;
}

/**
 * A folder of My files as the picker shows it, the top of My files when `uid` is not given: its
 * sub-folders, and the photos and videos straight in it. Which sub-folders hold a photo is asked
 * after, with `checkMyFolders`, so the folder opens at once however many sub-folders it has.
 */
export async function listMyFolder(
  client: any,
  isMedia: (name: string) => boolean,
  uid?: string,
  known: Map<string, boolean> = new Map(),
): Promise<MyFolderListing> {
  const folder = uid ? await client.getNode(uid) : await client.getMyFilesRootFolder();
  const listing: MyFolderListing = { uid: folder.uid, name: uid ? nodeName(folder) : "", folders: [], files: [] };
  for await (const node of client.iterateFolderChildren(folder.uid)) {
    const name = nodeName(node);
    if (isFolder(node)) listing.folders.push({ uid: node.uid, name, holds: known.get(node.uid) });
    else if (isFile(node) && isMedia(name)) {
      listing.files.push({ uid: node.uid, name, size: sizeOf(node), modifiedMs: modifiedOf(node) });
    }
  }
  listing.folders.sort((a, b) => a.name.localeCompare(b.name));
  listing.files.sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0) || a.name.localeCompare(b.name));
  return listing;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A name made safe to be a file or folder name on Windows. */
export function safeName(name: string): string {
  let out = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  if (!out || out === "." || out === "..") out = "_";
  if (RESERVED.test(out)) out = `_${out}`;
  return out;
}

/**
 * Every photo and video in the chosen folders, their sub-folders included, each under the
 * chosen folder's name, and the files chosen one by one, each under the name of the folder it
 * is in. Two chosen folders of the same name are told apart by a number.
 */
export async function planMyFiles(
  client: any,
  folders: { uid: string; name: string }[],
  isMedia: (name: string) => boolean,
  signal?: AbortSignal,
  files: { uid: string; folder: string }[] = [],
): Promise<MyFileItem[]> {
  const items: MyFileItem[] = [];
  const tops = new Set<string>();
  const taken = new Set<string>();
  // Every file gets a path of its own, case aside as Windows sees it: two that would share one would be
  // downloaded over each other, and a Move would then trash an original whose content never arrived.
  const rels = new Set<string>();
  for (const folder of folders) {
    let top = safeName(folder.name);
    for (let n = 2; tops.has(top.toLowerCase()); n++) top = `${safeName(folder.name)} (${n})`;
    tops.add(top.toLowerCase());
    const walk = async (uid: string, path: string): Promise<void> => {
      for await (const node of client.iterateFolderChildren(uid)) {
        if (signal?.aborted) throw new Error("cancelled");
        const name = nodeName(node);
        if (isFolder(node)) await walk(node.uid, `${path}/${safeName(name)}`);
        else if (isFile(node) && isMedia(name)) {
          items.push({ nodeUid: node.uid, rel: uniqueRel(`${path}/${safeName(name)}`, rels), size: sizeOf(node), modifiedMs: modifiedOf(node) });
        }
      }
    };
    await walk(folder.uid, top);
  }
  for (const item of items) taken.add(item.nodeUid);
  const byFolder = new Map<string, string>();
  for (const file of files) {
    if (taken.has(file.uid) || signal?.aborted) continue;
    taken.add(file.uid);
    const node = await client.getNode(file.uid);
    const name = nodeName(node);
    if (!isFile(node) || !isMedia(name)) continue;
    let top = byFolder.get(file.folder);
    if (!top) {
      top = safeName(file.folder || "My files");
      for (let n = 2; tops.has(top.toLowerCase()); n++) top = `${safeName(file.folder || "My files")} (${n})`;
      tops.add(top.toLowerCase());
      byFolder.set(file.folder, top);
    }
    items.push({ nodeUid: node.uid, rel: uniqueRel(`${top}/${safeName(name)}`, rels), size: sizeOf(node), modifiedMs: modifiedOf(node) });
  }
  return items;
}

/** `rel`, or `name (2).ext`, `name (3).ext`, ... when `used` holds it already, case aside; noted in `used`. */
export function uniqueRel(rel: string, used: Set<string>): string {
  const slash = rel.lastIndexOf("/");
  const dot = rel.lastIndexOf(".");
  const stem = dot > slash + 1 ? rel.slice(0, dot) : rel;
  const ext = dot > slash + 1 ? rel.slice(dot) : "";
  let candidate = rel;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** The album a file brought in goes into: the chosen folder it was found under. */
export function albumOfRel(rel: string): string | null {
  const top = rel.split("/")[0];
  return top ? top : null;
}

/**
 * Downloads each file to its place under `root`, dated as it was on Drive, so a photo with no
 * date of its own keeps the one it had there. `onFile` hears each file done and its bytes.
 */
export async function downloadMyFiles(
  client: any,
  items: MyFileItem[],
  root: string,
  onFile: (item: MyFileItem, path: string) => void,
  signal?: AbortSignal,
  stallMs = SDK_STALL_MS,
): Promise<void> {
  for (const item of items) {
    if (signal?.aborted) throw new Error("cancelled");
    const dest = resolve(root, ...item.rel.split("/"));
    if (!dest.startsWith(root + sep)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await diag.time("myfiles", "download", () => downloadOne(client, item.nodeUid, dest, stallMs, signal), {
      kb: Math.round(item.size / 1024),
    });
    if (item.modifiedMs) {
      const at = new Date(item.modifiedMs);
      await utimes(dest, at, at).catch(() => {});
    }
    onFile(item, dest);
  }
}

/**
 * One file into `dest`, written as its pieces arrive. A download that brings nothing for
 * `stallMs` is given up, and what it wrote is removed.
 */
async function downloadOne(client: any, uid: string, dest: string, stallMs: number, signal?: AbortSignal): Promise<void> {
  const file = await open(dest, "w");
  let last = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const downloader = await client.getFileDownloader(uid, signal);
    const sink = new WritableStream<Uint8Array>({
      async write(chunk) {
        last = Date.now();
        await file.write(chunk);
      },
    });
    const stalled = new Promise<never>((_, fail) => {
      timer = setInterval(() => {
        if (Date.now() - last > stallMs) fail(new StallError("a download from My files", stallMs));
      }, Math.min(5000, stallMs));
    });
    await Promise.race([downloader.downloadToStream(sink).completion(), stalled]);
    await file.close();
  } catch (e) {
    await file.close().catch(() => {});
    await rm(dest, { force: true }).catch(() => {});
    throw e;
  } finally {
    clearInterval(timer);
  }
}

/**
 * Which originals may go to the Drive trash once an import is over: each whose file ended in
 * the library, uploaded or found there already, and whose photo was then seen in the library.
 * Anything left out, failed, cancelled or not seen stays where it is.
 */
export function sourcesToTrash(
  outcomes: { source: string; settled: boolean; photo: string | null }[],
  seen: Set<string>,
): string[] {
  const out = new Set<string>();
  for (const o of outcomes) if (o.settled && o.photo && seen.has(o.photo)) out.add(o.source);
  return [...out];
}
