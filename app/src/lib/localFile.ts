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

import { invoke } from "@tauri-apps/api/core";
import type { SaveFormat } from "./editorRender";

/**
 * A file on this machine, which the app can show without a Proton session.
 * Everything here comes from the Rust host reading the file itself, so none of
 * it depends on the sidecar being up or the vault being unlocked.
 */

export type LocalFileInfo = {
  path: string;
  name: string;
  size: number;
  modified: number | string | null;
  created?: number | string | null;
  mime: string;
  width?: number;
  height?: number;
  captureTime?: number | string | null;
  camera?: string | null;
};

export const localFileInfo = (path: string) => invoke<LocalFileInfo>("local_file_info", { path });

/** A URL the webview can load for this file. */
export const localFileUrl = (path: string) => invoke<string>("local_file_url", { path });

/** A URL for a rendering the webview can draw, for the formats it cannot decode. */
export const decodePreview = (path: string) => invoke<string>("decode_preview", { path });

export const renameLocalFile = (path: string, newName: string) =>
  invoke<string>("rename_local_file", { path, newName });

/** Send the file to the recycle bin. Rejects with "cancelled" if the user backed out. */
export const deleteLocalFile = (path: string) => invoke<void>("delete_local_file", { path });

/**
 * The editor's source: the file's pixels as a same-origin `data:` URL (upright, full
 * resolution, so a canvas can read them back without the cross-origin taint an asset URL
 * would carry), plus the metadata the saved copy has to keep.
 */
export type EditorSource = {
  dataUrl: string;
  width: number;
  height: number;
  captureTime: number | null;
  camera: string | null;
  latitude: number | null;
  longitude: number | null;
};

export const localEditorSource = (path: string) =>
  invoke<EditorSource>("local_editor_source", { path });

/**
 * Write the edited image as a new copy beside the original, re-attaching the source's
 * metadata (date, GPS, camera) with orientation reset. Returns the new file's path.
 * `imageBase64` is the canvas output, already encoded as `format`.
 */
export const saveLocalEdit = (srcPath: string, imageBase64: string, format: SaveFormat) =>
  invoke<string>("save_local_edit", { srcPath, imageBase64, format });

/** The format a copy of this file defaults to: its own where it can be written, else JPEG. */
export function copyFormatFor(path: string): SaveFormat {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ext === "png" ? "png" : ext === "webp" ? "webp" : "jpeg";
}

/**
 * Formats the engine has no decoder for, which go straight to the host rather
 * than being tried in the webview first and failing visibly.
 */
const NEEDS_DECODE = new Set([".heic", ".heif", ".dng", ".tif", ".tiff"]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".3gp"]);

/**
 * What the upload queue accepts, mirrored from the sidecar so the button can say
 * no up front. The sidecar is still the authority: it drops anything else from
 * the plan silently, which from here looks like an upload that never starts.
 */
const UPLOADABLE = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".avif",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".dng",
  ...VIDEO_EXTENSIONS,
]);

export function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return dot > separator ? path.slice(dot).toLowerCase() : "";
}

export function baseName(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

export const needsDecode = (path: string): boolean => NEEDS_DECODE.has(extensionOf(path));
export const looksLikeVideo = (path: string): boolean => VIDEO_EXTENSIONS.has(extensionOf(path));
export const canUpload = (path: string): boolean => UPLOADABLE.has(extensionOf(path));

export type OpenFailure = "missing" | "unreadable" | "unknown";

/**
 * Which of the two failures worth telling apart this is.
 *
 * Rust prints the Windows error code into the message verbatim ("(os error 2)"),
 * and that number is the same whichever language the OS ships in, so it beats
 * matching text that changes with the install.
 */
export function classifyFailure(error: unknown): OpenFailure {
  const message = String(error);
  if (/os error (2|3)\b/.test(message) || /\bnot found\b/i.test(message)) return "missing";
  // 5 is access denied, 32 is another program holding the file open.
  if (/os error (5|32)\b/.test(message)) return "unreadable";
  return "unknown";
}

/**
 * Whether a failed decode means Windows itself has no codec for the format, as
 * opposed to the file being broken. The host raises its own sentinel for this;
 * the pattern covers the family it can be spelled with rather than one exact
 * string, because getting this wrong sends someone to the Microsoft Store for a
 * file that was corrupt all along.
 */
export function isMissingCodec(error: unknown): boolean {
  return /no[_ -]?codec|codec[_ -]?missing|missing[_ -]?codec|no[_ -]?decoder|unsupported[_ -]?format/i.test(
    String(error),
  );
}

/**
 * The host's timestamps cross as JSON, where an instant can arrive as epoch
 * milliseconds, epoch seconds or an ISO string depending on how it was
 * serialised. Normalising on the way in keeps a date that is wrong by a factor
 * of a thousand out of the details panel.
 */
export function toMillis(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  // Below this a millisecond timestamp would land in 1973, so it is seconds.
  return value < 1e11 ? value * 1000 : value;
}
