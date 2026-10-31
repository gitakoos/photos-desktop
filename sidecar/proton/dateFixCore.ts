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

// Cloud capture-date fix upload primitives.
//
// Proton Drive has no metadata-edit API, so the only way to change a cloud photo's date is
// the corrected-copy replace the Android app's metadata editor uses: download the original
// bytes, upload a corrected copy that carries the new capture time, re-add that copy to
// every album the original belonged to, carry the original's own tags and photo
// attributes over, and only then move the original to the trash.
//
// The copy is not byte for byte the original. Uploaded unchanged, Drive took it for the
// photo already there and served it under the old capture time, which real runs showed
// every time. So the date is written into the file's own metadata first (`embedDate.ts`):
// the EXIF dates of a JPEG, a PNG's creation time, a video's header times. Only metadata
// changes — the picture or video stream is never decoded or re-encoded.
//
// The trash step is the one that can lose an album, so it is fenced the way the Android
// path is: the original is trashed ONLY after the upload has returned a new link AND that
// link has joined every album the original was in. If any album re-add fails the original
// is left in place, which leaves a recoverable duplicate rather than a photo silently
// dropped from an album.
//
// The date also travels in the upload's capture-time field, which is the one every date
// surface in this app reads (the timeline, memories, the map's grouping, the viewer's
// "Taken"), and in the signed camera claim Proton's web shows first. A Live Photo's still
// and video are one photo dated together, so neither half is ever replaced alone.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { webcrypto } from "node:crypto";
import { Readable } from "node:stream";
import { WritableStream } from "node:stream/web";

import { ThumbnailType } from "@protontech/drive-sdk";

import { downloadToBuffer } from "./editor.ts";
import { embedCaptureDate } from "./embedDate.ts";
import { nodeName, toMillis } from "./nodes.ts";
import { SDK_STALL_MS, withStallGuard } from "./stallGuard.ts";

/**
 * One photo to re-date, with its capture instant and cached size estimate. `withTime` is
 * the filename reader's honesty flag: false when the name records only a day (the instant
 * then sits at local noon), so Drive is compared by calendar day instead of by second.
 */
export type DateFixItem = { uid: string; captureTime: number; expectedSize?: number; withTime?: boolean };

/**
 * Per-photo outcome; cancelled items were never started, so they are not failures, and
 * unchanged ones already carried the filename date on Drive, so nothing was written.
 */
export type DateFixResult = {
  uid: string;
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  unchanged?: boolean;
};

export type UploadedDateFixCopy = {
  item: DateFixItem;
  newUid: string;
  albumUids: string[];
};

/**
 * Marks a node stale so the next `getNode` reads it from the API again, not from the
 * entities cache. A write made outside the SDK creates no event the cache listens for,
 * so the read-back of a just-written date must not trust what the cache kept from
 * before the write. Best-effort: a cache miss lands here as nothing to invalidate.
 */
async function markNodeStale(photos: any, uid: string): Promise<void> {
  const access = photos?.nodes?.access;
  if (typeof access?.notifyNodeChanged === "function") {
    try {
      await access.notifyNodeChanged(uid);
    } catch {
      /* the read-back will still see whatever the cache serves */
    }
  }
}

/**
 * Whether a capture time on Drive falls on the calendar day the filename names. The day
 * is all the fix answers for: a filename's time of day, where it has one, is the clock
 * of whatever device saved it, and Drive's clear-text capture time has been written two
 * ways over the years. Proton's own uploaders long stored the camera's wall clock as if
 * it were UTC (a photo taken at 04:17 reads `04:17Z`), and newer ones store the real
 * instant. So the cloud date counts as the named day when either reading of it — UTC or
 * this machine's zone — lands on that day; comparing instants to the second instead is
 * what flagged thousands of correctly dated photos as wrong, hours apart only by zone.
 * `wantedMs` is the filename's date as the app parses it: its local calendar day is the
 * day the name records.
 */
export function sameCaptureDay(wantedMs: number, cloudMs: number): boolean {
  if (!(wantedMs > 0) || !(cloudMs > 0)) return false;
  const named = new Date(wantedMs);
  const cloud = new Date(cloudMs);
  const [y, m, d] = [named.getFullYear(), named.getMonth(), named.getDate()];
  return (
    (cloud.getFullYear() === y && cloud.getMonth() === m && cloud.getDate() === d) ||
    (cloud.getUTCFullYear() === y && cloud.getUTCMonth() === m && cloud.getUTCDate() === d)
  );
}

/**
 * Whether the node on Drive already shows the day the filename claims — the same rule
 * the app applies before offering the fix, re-checked here against the node itself so a
 * stale timeline, a re-run after an interrupted batch, or a photo another device fixed
 * meanwhile never costs a write.
 */
export function driveAlreadyCarries(node: any, item: DateFixItem): boolean {
  return sameCaptureDay(Number(item.captureTime), toMillis(node?.photo?.captureTime));
}

/**
 * `ms` as the ISO string a camera would claim: its wall clock in this machine's zone,
 * with that zone's offset (`2024-11-17T04:17:56.000-03:00`), the form Proton's clients
 * parse a claimed capture time from.
 */
export function claimedCaptureString(ms: number): string {
  const at = new Date(ms);
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/**
 * The original's claimed metadata with its camera capture time replaced by the new one.
 * Proton's web shows a photo's date from this claimed time before the clear-text capture
 * time, so a copy that carried the old claim over would keep showing the old date there
 * even with the right capture time on Drive.
 */
export function withClaimedCaptureTime(claimed: any, captureMs: number): Record<string, unknown> {
  const base = claimed && typeof claimed === "object" ? claimed : {};
  const camera = base.Camera && typeof base.Camera === "object" ? base.Camera : {};
  return { ...base, Camera: { ...camera, CaptureTime: claimedCaptureString(captureMs) } };
}

function activeRevision(node: any): any {
  return node?.activeRevision?.ok ? node.activeRevision.value : null;
}

/**
 * The thumbnails the original node already carries, handed to the uploader so the corrected
 * copy keeps the exact pictures the grid shows today. Best-effort: a thumbnail read that
 * fails or stalls leaves the copy to upload without that one, never failing the fix over a
 * picture Drive can regenerate.
 */
async function storedThumbnails(photos: any, uid: string): Promise<any[]> {
  const out: any[] = [];
  try {
    for (const type of [ThumbnailType.Type1, ThumbnailType.Type2]) {
      for await (const r of withStallGuard(
        photos.iterateThumbnails([uid], type),
        SDK_STALL_MS,
        "iterateThumbnails",
      )) {
        const result = r as any;
        if (result.ok) out.push({ type, thumbnail: result.thumbnail });
      }
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * The diagnostic the SDK hides in its error objects: a server reply carries its API code
 * and, when the backend caught an exception, the server-side file, line and trace. A fix
 * that fails says nothing from its message alone ("Invalid manifest signature." could be
 * refused at the draft, the blocks or the commit), so these travel to sidecar.log beside
 * it, redacted by the same choke point every stderr line passes.
 */
function dumpErrorDiagnostics(uid: string, error: unknown): void {
  const err = error as any;
  if (err?.code != null && typeof err.code === "number") {
    process.stderr.write(`[datefix:diag] for ${uid}: ${err.name} api code ${err.code}\n`);
  }
  if (err?.debug != null) {
    process.stderr.write(`[datefix:diag] for ${uid}: server debug ${JSON.stringify(err.debug)}\n`);
  }
  if (err instanceof Error && err.stack) {
    process.stderr.write(`[datefix:diag] for ${uid}: ${err.stack.split("\n").join(" | ")}\n`);
  }
}

/**
 * Uploads one corrected copy and returns its album memberships, or null when Drive already
 * carries the filename date and there is nothing to replace. Album additions and trash are
 * deliberately left to the batch coordinator: it groups those API operations after uploads
 * finish, reducing round-trips while preserving the original-photo trash fence.
 */
export async function uploadDateFixCopy(photos: any, item: DateFixItem): Promise<UploadedDateFixCopy | null> {
  const captureMs = Number(item.captureTime);
  if (!Number.isFinite(captureMs) || captureMs <= 0) throw new Error("no readable date in the name");

  const node: any = await photos.getNode(item.uid);
  // A Live Photo's halves are dated together by Drive, so replacing one half alone would
  // leave the pair split across the old date and the new. Neither is ever a fix target.
  if (node?.photo?.mainPhotoNodeUid || (node?.photo?.relatedPhotoNodeUids ?? []).length > 0) {
    throw new Error("a live photo's still and video are dated together; neither is replaced alone");
  }
  if (driveAlreadyCarries(node, item)) return null;
  const name = nodeName(node);
  const mediaType = node?.mediaType;
  if (!name) throw new Error("the photo has no readable name");
  if (!mediaType) throw new Error("the photo has no media type");

  // Read membership before the copy is sent; the coordinator will batch-add the new link
  // to every recorded album before it is allowed to trash this original.
  const albumUids = [
    ...new Set(
      ((node?.photo?.albums ?? []) as any[])
        .map((a) => String(a?.nodeUid ?? ""))
        .filter(Boolean),
    ),
  ];

  // The correction inherits the original name, tags and photo attributes unchanged.
  const revision = activeRevision(node);
  const original = await downloadToBuffer(photos, item.uid);
  // The date goes into the file itself (losslessly: metadata only, never the picture), so
  // the upload is not folded into the photo already on Drive as a duplicate of its bytes.
  const embedded = embedCaptureDate(original, captureMs);
  if (!embedded) throw new Error("this file type cannot carry a new date");
  const bytes = embedded.bytes;
  // A zero-copy view lets WebCrypto hash asynchronously instead of blocking the
  // sidecar event loop on a large synchronous SHA-1 update.
  const digestInput = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const sha1 = Buffer.from(await webcrypto.subtle.digest("SHA-1", digestInput)).toString("hex");
  const modified = toMillis(revision?.claimedModificationTime);
  const uploader = await photos.getFileUploader(
    name,
    {
      mediaType,
      expectedSize: bytes.byteLength,
      expectedSha1: sha1,
      ...(modified > 0 ? { modificationTime: new Date(modified) } : {}),
      captureTime: new Date(captureMs),
      tags: (node?.photo?.tags ?? []) as any[],
      additionalMetadata: withClaimedCaptureTime(revision?.claimedAdditionalMetadata, captureMs),
    },
    new AbortController().signal,
  );

  const stream = Readable.toWeb(Readable.from(bytes)) as any;
  const controller = await uploader.uploadFromStream(stream, await storedThumbnails(photos, item.uid));
  const { nodeUid: newUid } = await controller.completion();
  // The corrected copy must be a new photo: the original is trashed below.
  if (!newUid) throw new Error("upload returned no link id");
  if (newUid === item.uid) throw new Error("upload returned the original photo; original kept");
  process.stderr.write(`[datefix] uploaded corrected copy for ${item.uid} (${embedded.how})\n`);
  return { item, newUid, albumUids };
}

/**
 * Read-back the trash fence rests on: the node on Drive is fetched afresh (the cache is dropped for it first) and it
 * must land on the day the filename names (see `sameCaptureDay`).
 */
export async function verifyDateFixNode(photos: any, uid: string, captureMs: number): Promise<void> {
  await markNodeStale(photos, uid);
  let node: any;
  try {
    node = await photos.getNode(uid);
  } catch (error) {
    throw new Error(`the photo could not be read back: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cloudMs = toMillis(node?.photo?.captureTime);
  if (!(cloudMs > 0)) throw new Error("the photo carries no readable capture time");
  if (!sameCaptureDay(Number(captureMs), cloudMs)) {
    throw new Error(`the photo kept an old capture time (${new Date(cloudMs).toISOString()})`);
  }
}

/**
 * Reads the copy back once the upload's completion has answered, so the batch only ever
 * trashes an original whose replacement carries the date on Drive: a copy that never
 * appears, or that the server filed under another time, fails here instead of costing
 * the photo.
 */
export async function verifyDateFixCopy(photos: any, item: DateFixItem, newUid: string): Promise<void> {
  try {
    await verifyDateFixNode(photos, newUid, item.captureTime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`the corrected copy could not be confirmed: ${message}`);
  }
}

export { dumpErrorDiagnostics };
