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

// The video editor's calls: the host's ffmpeg (`video_edit.rs`) for the work, the sidecar for what
// is on Drive.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { rpc } from "./rpc";
import type { EditRequest } from "./videoEdit";

/** What the host reads of a video it opened for editing. */
export type VideoInfo = {
  path: string;
  /** A URL the window can play the file from. */
  url: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  hasAudio: boolean;
  hdr: boolean;
  transfer: "sdr" | "pq" | "hlg";
  /** The turn a player applies; `width` and `height` are as stored. */
  rotation: number;
  /** Unix milliseconds of the capture, from the file. */
  captureMs: number | null;
  size: number;
};

export const openVideo = (path: string) => invoke<VideoInfo>("video_edit_open", { path });

/** A strip of `count` frames across the video, as one JPEG data URL. */
export const videoStrip = (path: string, count: number, hdr: boolean) =>
  invoke<string>("video_edit_strip", { path, count, hdr });

export type PickedAudio = { path: string; name: string; durationMs: number };

/** The music file picker; null when it was cancelled. */
export const pickAudio = (title: string) => invoke<PickedAudio | null>("video_edit_pick_audio", { title });

export type EditResult = {
  path: string;
  thumb: string | null;
  size: number;
  kind: "video" | "gif" | "frame";
  ext: "mp4" | "gif" | "jpg";
  width: number | null;
  height: number | null;
  durationMs: number | null;
};

/** Makes one edit; rejects with "cancelled" after `cancelEdit`. */
export const runEdit = (jobId: string, edit: EditRequest) => invoke<EditResult>("video_edit_run", { jobId, edit });

export const cancelEdit = (jobId: string) => invoke<void>("video_edit_cancel", { jobId });

/** Deletes the folder an edit's file or a staged source sits in. */
export const discardStaged = (path: string) => invoke<void>("video_edit_discard", { path }).catch(() => {});

/**
 * Writes an edit's file beside the original, or where the save dialog says for a file that
 * cannot take a copy beside it, and returns the copy's path. Rejects with "cancelled" when
 * the dialog is dismissed.
 */
export const saveLocalCopy = (srcPath: string, editedPath: string, captureMs: number | null, pickTitle?: string) =>
  invoke<string>("video_edit_save_local", { srcPath, editedPath, captureMs, pickTitle });

/** Reports of a running edit, 0 to 1. Resolves to the function that stops listening. */
export const onEditProgress = (jobId: string, report: (value: number) => void) =>
  listen<{ jobId: string; value: number }>("video-edit-progress", (e) => {
    if (e.payload.jobId === jobId) report(e.payload.value);
  });

// ---- Drive ----

export type DriveVideoSource = {
  path: string;
  name: string;
  ext: string;
  captureTime: number | null;
  camera: string | null;
  latitude: number | null;
  longitude: number | null;
};

const POLL_MS = 400;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downloads a Drive video to the editor's staging folder and answers where it is, with what the
 * copy keeps of it. `cancelled` is read between polls; a download dropped that way is stopped.
 */
export async function downloadDriveVideo(
  uid: string,
  cancelled: () => boolean,
): Promise<{ path: string; source: DriveVideoSource } | null> {
  const source = await rpc<DriveVideoSource>("videoEditSource", { uid });
  for (;;) {
    if (cancelled()) {
      void rpc("videoEditCancel", { path: source.path }).catch(() => {});
      return null;
    }
    const state = await rpc<{ done: boolean; error: string | null }>("videoEditProgress", { path: source.path });
    if (state.error) throw new Error(state.error);
    if (state.done) break;
    await pause(POLL_MS);
  }
  if (cancelled()) {
    void rpc("videoEditCancel", { path: source.path }).catch(() => {});
    return null;
  }
  const staged = await rpc<{ path: string }>("videoEditStage", { path: source.path, ext: source.ext });
  if (cancelled()) {
    void discardStaged(staged.path);
    return null;
  }
  return { path: staged.path, source };
}

export type DriveSaveInput = {
  path: string;
  thumb: string | null;
  name: string;
  captureTime: number | null;
  camera: string | null;
  latitude: number | null;
  longitude: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** The album the editor was opened from, which the copy joins. */
  albumUid?: string;
};

/**
 * Uploads an edit's file as a new item carrying the source's capture time. `albumFailed`
 * means the copy is saved but did not get into `albumUid`.
 */
export const saveEditedMedia = (input: DriveSaveInput) =>
  rpc<{ uid: string; size: number; albumFailed?: boolean }>("saveEditedMedia", { ...input });
