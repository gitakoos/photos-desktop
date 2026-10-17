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

// Cloud photo editor backend.
//
// Two halves. `cloudEditorSource` hands the editor a same-origin copy of a photo's
// pixels: a canvas that has drawn a cross-origin asset URL cannot be read back, so the
// bytes come as a data: URL instead, decoded and turned upright here so the editor works
// in device pixels. `saveCloudEdit` uploads the edited image as a NEW node on the
// timeline, carrying the source's date, place and camera.
//
// The edit is always a new photo, never an overwrite: Drive has no in-place revision for
// a photo (the server refuses it), and a copy is what the Android app and the local-file
// editor both do. The upload reuses the tested engine's metadata shaping (`mediaAttributes`)
// and rides the SDK's own uploader, exactly as the drop-upload path does.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { WritableStream } from "node:stream/web";

import sharp from "sharp";

import { toMillis } from "./nodes.ts";
import { mediaAttributes, thumbnailPair } from "./upload.ts";

/** The longest edge the editor works at, matching the local-file editor's working cap. */
const EDIT_MAX_EDGE = 4096;

/**
 * What the editor needs to open a cloud photo: the pixels as a same-origin data URL, the
 * size they came out at, and the metadata the saved copy has to keep. The same shape the
 * local-file editor returns, so one editor component serves both.
 */
export type CloudEditorSource = {
  dataUrl: string;
  width: number;
  height: number;
  captureTime: number | null;
  camera: string | null;
  latitude: number | null;
  longitude: number | null;
};

/** The metadata the frontend hands back at save time, taken from the source above. */
export type CloudEditMeta = {
  name: string;
  captureTime: number | null;
  camera: string | null;
  latitude: number | null;
  longitude: number | null;
};

/**
 * Media types sharp has no decoder for, so a cloud photo of this kind cannot be edited
 * here. The frontend gates the Edit button on the same rule; this is the backstop.
 */
const CANNOT_DECODE = new Set(["image/heic", "image/heif", "image/x-adobe-dng"]);

function activeRevision(node: any): any {
  return node?.activeRevision?.ok ? node.activeRevision.value : null;
}

/**
 * A latitude/longitude pair from a node's decrypted attributes, both halves or neither.
 * Casing varies between the clients that write the block, so both spellings are read.
 */
export function locationOf(extra: any): { latitude: number | null; longitude: number | null } {
  const loc = extra?.Location ?? extra?.location;
  const lat = Number(loc?.Latitude ?? loc?.latitude);
  const lon = Number(loc?.Longitude ?? loc?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    return { latitude: lat, longitude: lon };
  }
  return { latitude: null, longitude: null };
}

/** The camera device name from a node's decrypted attributes, or null. */
export function cameraOf(extra: any): string | null {
  const dev = String(extra?.Camera?.Device ?? extra?.camera?.device ?? "").trim();
  return dev || null;
}

/**
 * The edited copy's filename: the source stem with an `_edit_<timestamp>` suffix and a
 * `.jpg` extension, matching the local-file editor's naming. Pure, so it is unit-tested.
 */
export function editedName(sourceName: string, when: Date): string {
  const dot = sourceName.lastIndexOf(".");
  const stem = (dot > 0 ? sourceName.slice(0, dot) : sourceName).trim() || "photo";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `_${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `${stem}_edit_${stamp}.jpg`;
}

/** Download one node's decrypted original into a Buffer. */
async function downloadToBuffer(photos: any, uid: string): Promise<Buffer> {
  const downloader = await photos.getFileDownloader(uid);
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  await downloader.downloadToStream(stream as any).completion();
  return Buffer.concat(chunks);
}

/**
 * A same-origin copy of a cloud photo's pixels for the editor: upright (EXIF orientation
 * baked in), capped to `EDIT_MAX_EDGE`, and served as a data: URL so the editor's canvas
 * can read it back. Throws `UNSUPPORTED` for a format sharp cannot decode.
 */
export async function cloudEditorSource(photos: any, uid: string): Promise<CloudEditorSource> {
  const node = await photos.getNode(uid);
  const mediaType = String(node?.mediaType ?? "").toLowerCase().split(";")[0].trim();
  if (CANNOT_DECODE.has(mediaType)) throw new Error("UNSUPPORTED");

  const bytes = await downloadToBuffer(photos, uid);
  let out: Buffer;
  let width = 0;
  let height = 0;
  try {
    const image = sharp(bytes, { failOn: "none" }).rotate(); // bake in EXIF orientation
    out = await image
      .resize(EDIT_MAX_EDGE, EDIT_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 95 })
      .toBuffer();
    const meta = await sharp(out).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    throw new Error("UNSUPPORTED");
  }

  const extra = activeRevision(node)?.claimedAdditionalMetadata ?? null;
  const { latitude, longitude } = locationOf(extra);
  return {
    dataUrl: `data:image/jpeg;base64,${out.toString("base64")}`,
    width,
    height,
    captureTime: node?.photo?.captureTime ? toMillis(node.photo.captureTime) : null,
    camera: cameraOf(extra),
    latitude,
    longitude,
  };
}

/**
 * A small grid thumbnail and an HD preview for the edited JPEG, from its own bytes. Empty
 * on failure: a missing thumbnail is never worth failing the save over. The canvas output
 * is already upright, so nothing is rotated here.
 */
async function editThumbnails(jpeg: Buffer): Promise<any[]> {
  try {
    return await thumbnailPair(sharp(jpeg, { failOn: "none" }));
  } catch {
    return [];
  }
}

/**
 * Save an edited cloud photo as a NEW node on the timeline, carrying the source's date,
 * place and camera. The original is never touched. Returns the new node's uid.
 *
 * `jpegBase64` is the editor's canvas output (already quality ~0.92 and upright). Its
 * capture time is set to the source's, so it sorts next to the original rather than
 * jumping to the moment it was saved.
 */
export async function saveCloudEdit(
  photos: any,
  jpegBase64: string,
  meta: CloudEditMeta,
): Promise<{ uid: string }> {
  const jpeg = Buffer.from(jpegBase64, "base64");
  if (jpeg.byteLength === 0) throw new Error("empty image");

  const sha1 = createHash("sha1").update(jpeg).digest("hex");
  const captureTime = meta.captureTime ? new Date(meta.captureTime) : new Date();
  const name = editedName(meta.name || "photo", new Date());
  const dims = await sharp(jpeg).metadata().catch(() => null);
  const thumbnails = await editThumbnails(jpeg);

  const uploader = await photos.getFileUploader(
    name,
    {
      mediaType: "image/jpeg",
      expectedSize: jpeg.byteLength,
      expectedSha1: sha1,
      modificationTime: new Date(),
      captureTime,
      tags: [],
      additionalMetadata: mediaAttributes({
        width: dims?.width,
        height: dims?.height,
        latitude: meta.latitude,
        longitude: meta.longitude,
        device: meta.camera,
      }),
    },
    new AbortController().signal,
  );

  // A web ReadableStream off the in-memory buffer, the shape the SDK's uploader wants.
  const stream = Readable.toWeb(Readable.from(jpeg)) as any;
  const controller = await uploader.uploadFromStream(stream, thumbnails);
  const { nodeUid } = await controller.completion();
  process.stderr.write(`[editor] saved edited copy: ${jpeg.byteLength} bytes\n`);
  return { uid: nodeUid };
}
