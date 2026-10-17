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

// What Download means, decided in one place.
//
// Either way the result is an ordinary file the rest of Windows can read, which is
// what separates Download from `offline.ts`: that one keeps the app's own encrypted
// copy and never writes to the Proton Photos folder. Nothing here is called offline.
//
// With the Explorer mount on, every photo already has a placeholder under the sync
// root, so Download fills that copy in and Windows marks it with the green check.
// With the mount off there is no placeholder to fill, so Download asks for a folder
// and writes the originals into it: ordinary files, carrying no cloud status because
// they are not placeholders and never were. Both are real modes.
//
// The host owns the preference, so every caller asks it here. Inferring the mode
// from anything the UI can see is what let the whole feature fail silently: with the
// mount off nothing is indexed, so the pin ran against an empty index, skipped every
// photo, and still reported the full count as downloaded.

import { invoke } from "@tauri-apps/api/core";

import { rpc } from "./rpc";

/** What Download did. `cancelled` is the folder picker dismissed, which says nothing. */
export type DownloadResult =
  | { mode: "explorer"; kept: number; total: number }
  | { mode: "saved"; ok: number; failed: number }
  | { mode: "cancelled" };

/** Live save-to-folder progress: how many originals have landed, and how many failed. */
export type SaveProgress = { done: number; failed: number; total: number };

// The sidecar's save status; `running` false ends the poll. Same shape the upload
// panel reads, so progress is polled on an interval rather than pushed.
type SaveStatus = SaveProgress & { running: boolean };

// How often a running save is polled. A read is cheap, so this stays snappy without
// pinning the host's single, one-in-flight RPC channel.
const SAVE_POLL_MS = 300;

/**
 * The folder to save into, picked through the host: a save is refused for any folder the
 * host did not see picked, so the picker has to be its own. Null when dismissed.
 */
const pickSaveFolder = () => invoke<string | null>("pick_save_folder").catch(() => null);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Whether the Explorer mount is the active mode. Everything automatic (the "download
 * new photos" setting, an album that downloads itself) can only work through the
 * mount, so this also gates those.
 */
export async function explorerMode(): Promise<boolean> {
  return invoke<boolean>("show_in_explorer").catch(() => false);
}

/**
 * Poll the background save until it stops, reporting every reading. The poll is a
 * cheap status read, so it never holds the host's single RPC channel the way awaiting
 * the whole batch would; a transient read error is tolerated, but a run of them ends
 * the poll so a dead sidecar cannot spin here forever.
 */
async function pollSave(
  onProgress?: (p: SaveProgress) => void,
): Promise<{ done: number; failed: number }> {
  let misses = 0;
  for (;;) {
    let s: SaveStatus;
    try {
      s = await rpc<SaveStatus>("saveStatus");
    } catch (e) {
      if (++misses > 5) throw e;
      await delay(SAVE_POLL_MS);
      continue;
    }
    misses = 0;
    onProgress?.({ done: s.done, failed: s.failed, total: s.total });
    if (!s.running) return { done: s.done, failed: s.failed };
    await delay(SAVE_POLL_MS);
  }
}

/**
 * Download the photos in whichever mode the preference selects. `onStart` fires when
 * the transfer actually begins — after the folder picker, in the save mode — so the
 * caller's progress readout never sits behind the picker waiting on the user, and
 * `onProgress` reports the save's climbing count as each original lands.
 */
export async function downloadPhotos(
  uids: string[],
  handlers?: { onStart?: () => void; onProgress?: (p: SaveProgress) => void },
): Promise<DownloadResult> {
  if (await explorerMode()) {
    handlers?.onStart?.();
    const { kept, missing } = await invoke<{ kept: number; missing: string[] }>("pin_selected", {
      uids,
    });
    // Everything had a placeholder to fill in place: the ordinary mount download.
    if (missing.length === 0) return { mode: "explorer", kept, total: uids.length };
    // Some of the selection has no placeholder under the mount (a photo shared with
    // me, or one that lives only inside an album), so it cannot be pinned in place.
    // Save those as ordinary files in a folder instead.
    const dir = await pickSaveFolder();
    if (typeof dir !== "string") {
      // Folder picker dismissed: report the copies that did pin in place, rather than
      // hiding them behind a cancel. If none pinned, that reads as "nothing downloaded".
      return kept > 0 ? { mode: "explorer", kept, total: uids.length } : { mode: "cancelled" };
    }
    const { started } = await rpc<{ started: boolean }>("startSaveOriginals", {
      uids: missing,
      destDir: dir,
    });
    // Another save already holds the single status record. Don't poll it as if it were
    // ours; report the copies that pinned in place, or nothing, rather than a stranger's
    // count. (In practice the per-view button guards make this rare.)
    if (!started) {
      return kept > 0 ? { mode: "explorer", kept, total: uids.length } : { mode: "cancelled" };
    }
    const { done, failed } = await pollSave(handlers?.onProgress);
    // The copies pinned in place are downloaded too, so they count toward the total.
    return { mode: "saved", ok: kept + done, failed };
  }
  const dir = await pickSaveFolder();
  if (typeof dir !== "string") return { mode: "cancelled" };
  handlers?.onStart?.();
  // Start the save and let it run in the background; the counts come from polling,
  // not from one long call that would pin the channel for the whole batch.
  const { started } = await rpc<{ started: boolean }>("startSaveOriginals", { uids, destDir: dir });
  if (!started) return { mode: "cancelled" }; // a save is already running; leave it be
  const { done, failed } = await pollSave(handlers?.onProgress);
  return { mode: "saved", ok: done, failed };
}

/**
 * The result as a message: the key to translate and its variables, or null when
 * there is nothing to report. Every caller says what actually happened, never what
 * was asked for.
 */
export function downloadMessage(
  result: DownloadResult,
): { key: string; vars?: Record<string, number> } | null {
  switch (result.mode) {
    case "cancelled":
      return null;
    case "explorer":
      if (result.kept === 0) return { key: "download.doneNone" };
      if (result.kept < result.total) {
        return { key: "download.donePartial", vars: { ok: result.kept, total: result.total } };
      }
      return { key: "download.done", vars: { count: result.kept } };
    case "saved":
      if (result.failed > 0) {
        return { key: "download.partial", vars: { ok: result.ok, failed: result.failed } };
      }
      return { key: "download.saved", vars: { count: result.ok } };
  }
}
