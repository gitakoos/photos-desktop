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

// Albums: reading them, and changing them.
//
// The SDK owns the album tree (`iterateAlbumUids` / `iterateAlbum`), so this
// module stays a thin layer over it. Four SDK constraints shape the rest.
//
// A photo count and a cover are only true if they come from the albums endpoint.
// The SDK carries both on the album node as well, but a node is served from an
// in-memory cache that only refreshes when something marks it stale, and the
// mount's own album walk re-caches nodes behind the user's back. `iterateAlbums`
// reads the node and would hand back whatever that pass happened to see;
// `iterateAlbumUids` reads the endpoint, which always reflects the current
// state, and folds the count, the cover and the activity time into the cached
// node on the way past. So the uids come from there and the node is only asked
// for the name, which is the part that has to be decrypted.
//
// Adding and removing take the whole photo array. The server caps a request at
// ten and the SDK batches to that itself, so chunking here would only fight its
// accounting — an accounting the two do differently. Adding spends the ten on
// links, and a photo brings its related parts (a live photo's video, a motion
// photo's frames) along for the ride, so ten photos can be more than one
// request. Removing does not reach for those parts, and spends the ten on the
// photos themselves.
//
// Removal reports per batch, not per photo. The API answers once for the whole
// request, so the SDK marks every uid in a failed batch failed. The counts hold
// (a request that failed removed nothing), but the blame does not: which photo
// sank the batch is not knowable, so callers report totals and never accuse one.
// Adding does better, because there the API answers per link.
//
// Deleting an album skips the trash. Photos already on the timeline survive it,
// but photos that live only in the album do not, so `deleteAlbum` reports that
// case back instead of guessing which way the user meant it.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { collectResults, nodeName, toMillis, type NodeOpResult } from "./nodes.ts";
import { SDK_STALL_MS, withStallGuard } from "./stallGuard.ts";

export type AlbumSummary = {
  uid: string;
  name: string;
  photoCount: number;
  coverUid: string | null;
  lastActivityTime: number;
};

export type AlbumPhoto = { uid: string; captureTime: number };

/** One album and its members, for the Explorer mount's `Albums\` subfolders. */
export type AlbumMount = { uid: string; name: string; uids: string[] };

export type AlbumResult = NodeOpResult;

/**
 * What a delete attempt did. `photosNotInTimeline` is the server refusing to
 * destroy photos that exist nowhere else until the caller says which way to go:
 * `saveToTimeline` keeps them, `force` deletes them with the album.
 */
export type DeleteAlbumOutcome =
  | { status: "deleted" }
  | { status: "photosNotInTimeline"; count: number };

/**
 * The uid list carried by the server's refusal to delete an album holding
 * photos that are not on the timeline. The SDK does not export the error class
 * and leaves its `name` as the base `ValidationError`, so neither `instanceof`
 * nor the name can pick it out: this list is the only sound signal.
 */
function photosOnlyInAlbum(e: unknown): string[] | null {
  const uids = (e as any)?.photosOnlyInAlbumNodeUids;
  return Array.isArray(uids) ? (uids as string[]) : null;
}

// ---- Reading ----

/** Albums, most recently active first. The SDK carries them as nodes of type "album". */
export async function listAlbums(photos: any): Promise<AlbumSummary[]> {
  const uids = await listAlbumUids(photos);
  if (uids.length === 0) return [];

  const out: AlbumSummary[] = [];
  for await (const node of withStallGuard(photos.iterateNodes(uids), SDK_STALL_MS, "iterateNodes")) {
    // An album deleted between the two calls is reported rather than yielded.
    if ((node as any).missingUid) continue;
    const album = (node as any).album;
    out.push({
      uid: (node as any).uid,
      name: nodeName(node),
      photoCount: album?.photoCount ?? 0,
      coverUid: album?.coverPhotoNodeUid ?? null,
      lastActivityTime: toMillis(album?.lastActivityTime),
    });
  }
  out.sort((a, b) => b.lastActivityTime - a.lastActivityTime);
  return out;
}

/**
 * The album uids, straight from the albums endpoint.
 *
 * Draining this is also what makes a later node read tell the truth about the
 * count and the cover: the SDK refreshes the cached node from the endpoint as it
 * goes. It does that without awaiting, into a cache that is in memory, so one
 * turn of the event loop is enough to settle every write it started.
 */
async function listAlbumUids(photos: any): Promise<string[]> {
  const uids: string[] = [];
  for await (const uid of withStallGuard(
    photos.experimental.iterateAlbumUids(),
    SDK_STALL_MS,
    "iterateAlbumUids",
  )) {
    uids.push(uid as string);
  }
  await new Promise((resolve) => setImmediate(resolve));
  return uids;
}

/**
 * Every photo uid that belongs to at least one album.
 *
 * Android keeps a join table for this because a photo's parent is the photos
 * root, not the album. The SDK gives us the same edges through `iterateAlbum`,
 * so we walk the albums once and collect the membership. Only the uids are
 * needed to do that, so the album nodes are never loaded or decrypted here.
 */
export async function listAlbumPhotoUids(photos: any): Promise<string[]> {
  const albumUids = await listAlbumUids(photos);

  const members = new Set<string>();
  for (const albumUid of albumUids) {
    try {
      for await (const item of withStallGuard(
        photos.iterateAlbum(albumUid),
        SDK_STALL_MS,
        "iterateAlbum",
      )) {
        members.add((item as any).nodeUid);
      }
    } catch (e) {
      process.stderr.write(`[albums] iterateAlbum failed: ${(e as Error).message}\n`);
    }
  }
  return [...members];
}

/** The photos inside one album, newest first. */
export async function listAlbumPhotos(photos: any, uid: string): Promise<AlbumPhoto[]> {
  const out: AlbumPhoto[] = [];
  for await (const item of withStallGuard(photos.iterateAlbum(uid), SDK_STALL_MS, "iterateAlbum")) {
    out.push({ uid: (item as any).nodeUid, captureTime: toMillis((item as any).captureTime) });
  }
  out.sort((a, b) => b.captureTime - a.captureTime);
  return out;
}

/**
 * Albums with their member photo uids, for the Explorer mount's `Albums\`
 * subfolders. Names and sizes are not resolved here — the mount reuses the
 * metadata gathered in the main photo pass — so this stays a cheap membership
 * walk (the album uids, then iterateAlbum per album).
 *
 * This runs on a background thread at startup and behind the tray's "Sync now",
 * which is why it takes the same uid route as the list: reading the album nodes
 * any other way leaves the cache holding whatever this pass saw.
 */
export async function listAlbumsForMount(photos: any): Promise<AlbumMount[]> {
  const albumUids = await listAlbumUids(photos);
  if (albumUids.length === 0) return [];

  const out: AlbumMount[] = [];
  for await (const albumNode of withStallGuard(
    photos.iterateNodes(albumUids),
    SDK_STALL_MS,
    "iterateNodes",
  )) {
    if ((albumNode as any).missingUid) continue;
    const albumUid = (albumNode as any).uid;
    const uids: string[] = [];
    try {
      for await (const item of withStallGuard(
        photos.iterateAlbum(albumUid),
        SDK_STALL_MS,
        "iterateAlbum",
      )) {
        const u = (item as any).nodeUid;
        if (u) uids.push(u);
      }
    } catch (e) {
      process.stderr.write(`[albums] iterateAlbum failed: ${(e as Error).message}\n`);
    }
    out.push({ uid: albumUid, name: nodeName(albumNode) || "Album", uids });
  }
  return out;
}

// ---- Changing ----

/**
 * Creates an empty album. The SDK rejects an empty name and anything over 255
 * characters; the trim is ours, so a name of spaces is refused rather than
 * created and left unreadable in the list.
 */
export async function createAlbum(photos: any, name: string): Promise<AlbumSummary> {
  const node = await photos.createAlbum(name.trim());
  return {
    uid: (node as any).uid,
    name: nodeName(node),
    photoCount: 0,
    coverUid: null,
    lastActivityTime: toMillis((node as any).creationTime) || Date.now(),
  };
}

/**
 * The user's own album a folder of this name belongs in, matched ignoring case and the
 * spaces around it, or null. With several of that name the fullest wins, so a folder
 * joins the copy holding its photos rather than an empty leftover.
 */
export async function findAlbumByName(photos: any, name: string): Promise<AlbumSummary | null> {
  const wanted = name.trim().toLocaleLowerCase();
  if (!wanted) return null;
  let best: AlbumSummary | null = null;
  for (const album of await listAlbums(photos)) {
    if (album.name.trim().toLocaleLowerCase() !== wanted) continue;
    if (!best || album.photoCount > best.photoCount) best = album;
  }
  return best;
}

/** Renames an album. Same name rules as creating one. */
export async function renameAlbum(
  photos: any,
  uid: string,
  name: string,
): Promise<{ uid: string; name: string }> {
  const node = await photos.updateAlbum(uid, { name: name.trim() });
  return { uid, name: nodeName(node) };
}

/**
 * Points the album's cover at one of its photos.
 *
 * The requested uid is echoed back rather than read off the returned node: the
 * SDK sends the cover to the API but does not fold it into the node it hands
 * back, so that node still carries the previous cover.
 */
export async function setAlbumCover(
  photos: any,
  uid: string,
  coverUid: string,
): Promise<{ uid: string; coverUid: string }> {
  await photos.updateAlbum(uid, { coverPhotoNodeUid: coverUid });
  return { uid, coverUid };
}

/**
 * Deletes an album, skipping the trash.
 *
 * Called with neither option this is the safe probe: the server refuses if the
 * album holds photos that are on no timeline, and that refusal comes back as
 * `photosNotInTimeline` with the number at stake so the caller can ask. Answer
 * it with `saveToTimeline` to keep those photos, or `force` to destroy them.
 */
export async function deleteAlbum(
  photos: any,
  uid: string,
  options: { force?: boolean; saveToTimeline?: boolean } = {},
): Promise<DeleteAlbumOutcome> {
  try {
    await photos.deleteAlbum(uid, options);
    return { status: "deleted" };
  } catch (e) {
    const stranded = photosOnlyInAlbum(e);
    // Only the probe turns this into a question. Once the caller has chosen, a
    // refusal is a real failure and belongs to them. An empty list is not a
    // question either: the SDK only rescues photos it can name, so with none
    // named `saveToTimeline` would fail anyway and the choice would be offered
    // over a count of nothing.
    if (stranded && stranded.length > 0 && !options.force && !options.saveToTimeline) {
      return { status: "photosNotInTimeline", count: stranded.length };
    }
    throw e;
  }
}

/**
 * Adds photos to an album. The whole array goes to the SDK, which batches it to
 * the server's ten-link cap itself.
 *
 * An album holds 10,000 photos; past that the server refuses the request. The
 * SDK does not check the ceiling before sending, so it surfaces as a failure
 * here rather than something this module can promise in advance.
 */
export async function addPhotosToAlbum(
  photos: any,
  albumUid: string,
  uids: string[],
): Promise<AlbumResult[]> {
  return collectResults(photos.addPhotosToAlbum(albumUid, uids));
}

/**
 * Takes photos out of an album without deleting them: one that was on the
 * timeline stays there.
 *
 * Results are per uid but only batch-deep. Every uid in a batch that failed is
 * reported failed, which is true of all of them, so callers may total these and
 * must not read a single photo's fate out of one.
 */
export async function removePhotosFromAlbum(
  photos: any,
  albumUid: string,
  uids: string[],
): Promise<AlbumResult[]> {
  return collectResults(photos.removePhotosFromAlbum(albumUid, uids));
}
