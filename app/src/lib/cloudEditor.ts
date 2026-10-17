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

import { rpc } from "./rpc";
import type { EditorSource } from "./localFile";

/** The source metadata the saved copy carries, handed back by the editor at save time. */
export type CloudEditMeta = {
  name: string;
  captureTime: number | null;
  camera: string | null;
  latitude: number | null;
  longitude: number | null;
};

/**
 * The editor's source for a cloud photo: the pixels as a same-origin data URL (so the
 * canvas can read them back), upright and capped, plus the metadata the copy keeps. The
 * same shape the local-file editor returns, so one editor component serves both.
 */
export const cloudEditorSource = (uid: string) => rpc<EditorSource>("cloudEditorSource", { uid });

/**
 * Save an edited cloud photo as a new node on the timeline, carrying the source's date,
 * place and camera. Resolves with the new node's uid once it has uploaded. The original
 * is never touched: Drive has no in-place overwrite for a photo.
 */
export const saveCloudEdit = (jpegBase64: string, meta: CloudEditMeta) =>
  rpc<{ uid: string }>("saveCloudEdit", { jpegBase64, meta });

/**
 * Whether the cloud editor can open this photo. The sidecar decodes with sharp, which has
 * no decoder for HEIC, HEIF or DNG, so the Edit button is hidden for those rather than
 * offering an edit that would fail. Everything the web engine draws, sharp can decode.
 */
const UNEDITABLE_MEDIA = new Set(["image/heic", "image/heif", "image/x-adobe-dng"]);
const EDITABLE_EXT = new Set([
  "jpg",
  "jpeg",
  "jpe",
  "png",
  "webp",
  "gif",
  "avif",
  "bmp",
  "tif",
  "tiff",
]);

export function isEditableImage(mediaType: string | null | undefined, name: string): boolean {
  const mt = (mediaType ?? "").toLowerCase().split(";")[0].trim();
  if (UNEDITABLE_MEDIA.has(mt)) return false;
  if (mt.startsWith("image/")) return true;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return EDITABLE_EXT.has(ext);
}
