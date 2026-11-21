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

// The settings that ride the shared backup, as the window keeps them: each sync id (the same list
// as the sidecar's `settingsSync.ts`) against its key in `AppSettings`, with the check a value
// must pass before it is taken in. Only the ids named here ever leave this computer or are taken
// from Drive; every other setting stays where it is.

import type { AppSettings } from "../views/Settings";
import { readAlbumOrder } from "./albumView";

/** The settings the sync touches, apart from the rest of `AppSettings`. */
export type SyncedSettings = Pick<
  AppSettings,
  | "theme"
  | "palette"
  | "amoled"
  | "hideAlbumPhotos"
  | "albumSort"
  | "albumOrder"
  | "lang"
  | "compressPhotos"
  | "compressHdr"
  | "compressTier"
  | "compressVideos"
  | "compressVideoTier"
  | "compressCodec"
>;

export type SyncedKey = keyof SyncedSettings;
type Key = SyncedKey;

/** What a value is checked against, besides its own type. */
type Context = {
  /** The defaults a reset (a null from Drive) goes back to, and what counts as chosen. */
  defaults: SyncedSettings;
  /** The languages this app has. A tag from a phone that is not one of them is left alone. */
  langs: readonly string[];
};

type Entry = { id: string; key: Key; valid: (x: unknown, ctx: Context) => boolean };

const bool = (x: unknown): boolean => typeof x === "boolean";
const oneOf = (list: readonly string[]) => (x: unknown): boolean => typeof x === "string" && list.includes(x);

const THEMES = ["system", "light", "dark"];
/** The palettes the phone has; the legacy "amoled" one is a switch now and never travels. */
const PALETTES = ["default", "forest", "sunset", "sea", "sepia", "mono", "lavender", "rose", "mint", "gold", "ruby"];
const TIERS = ["high", "balanced", "small"];
const CODECS = ["auto", "avc", "hevc", "av1", "keep"];
const ALBUM_SORTS = ["custom", "name", "activity", "count", "newest"];
/** The album arrangement as the phone carries it: album link ids, none blank, no '|' in any. */
const albumIds = (x: unknown): boolean =>
  Array.isArray(x) &&
  x.length <= 20_000 &&
  x.every((e) => typeof e === "string" && e.trim() !== "" && e.length <= 512 && !e.includes("|"));

const ENTRIES: Entry[] = [
  { id: "appearance.theme", key: "theme", valid: oneOf(THEMES) },
  { id: "appearance.palette", key: "palette", valid: oneOf(PALETTES) },
  { id: "appearance.amoled", key: "amoled", valid: bool },
  { id: "albums.hidePhotosInAlbums", key: "hideAlbumPhotos", valid: bool },
  { id: "albums.sortMode", key: "albumSort", valid: oneOf(ALBUM_SORTS) },
  { id: "albums.order", key: "albumOrder", valid: albumIds },
  // "system" means "follow the phone's language", which this app has no such thing as.
  { id: "appearance.language", key: "lang", valid: (x, ctx) => typeof x === "string" && x !== "system" && ctx.langs.includes(x) },
  { id: "upload.compressPhotos", key: "compressPhotos", valid: bool },
  { id: "upload.compressHdr", key: "compressHdr", valid: bool },
  { id: "upload.compressTier", key: "compressTier", valid: oneOf(TIERS) },
  { id: "upload.compressVideos", key: "compressVideos", valid: bool },
  { id: "upload.compressVideoTier", key: "compressVideoTier", valid: oneOf(TIERS) },
  { id: "upload.compressCodec", key: "compressCodec", valid: oneOf(CODECS) },
];

/** One setting to report: its sync id and value. */
export type SyncValue = { id: string; x: boolean | string | string[] };

/** A setting taken in from Drive: its sync id, value (null puts it back to the default) and time. */
export type AppliedValue = { id: string; x: unknown; t: number };

export const SYNC_IDS: readonly string[] = ENTRIES.map((e) => e.id);

/**
 * A setting's value as it is reported: the legacy AMOLED palette is the default palette, black,
 * and the album arrangement is its album link ids, each once.
 */
function reported(entry: Entry, s: SyncedSettings): unknown {
  const v = s[entry.key];
  if (entry.key === "albumOrder") return readAlbumOrder(v);
  return entry.key === "palette" && v === "amoled" ? "default" : v;
}

/** Two reported values alike, a list item by item. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/** The synced settings that differ between `before` and `after`, each with its new value. */
export function changedValues(before: SyncedSettings, after: SyncedSettings, ctx: Context): SyncValue[] {
  const out: SyncValue[] = [];
  for (const e of ENTRIES) {
    const was = reported(e, before);
    const now = reported(e, after);
    if (same(was, now) || !e.valid(now, ctx)) continue;
    out.push({ id: e.id, x: now as SyncValue["x"] });
  }
  return out;
}

/** The synced settings that are not at their default, for the first stamp of what is already chosen. */
export function chosenValues(s: SyncedSettings, ctx: Context): SyncValue[] {
  const out: SyncValue[] = [];
  for (const e of ENTRIES) {
    const now = reported(e, s);
    if (same(now, reported(e, ctx.defaults)) || !e.valid(now, ctx)) continue;
    out.push({ id: e.id, x: now as SyncValue["x"] });
  }
  return out;
}

/**
 * `s` with the values taken in from Drive set. An id this app does not map, or a value that does
 * not pass, is left out; a null puts the setting back to its default. `changed` lists the keys
 * that ended up different.
 */
export function applyValues<S extends SyncedSettings>(
  s: S,
  applied: AppliedValue[],
  ctx: Context,
): { next: S; changed: Key[] } {
  const next = { ...s };
  const changed: Key[] = [];
  for (const a of applied) {
    const e = ENTRIES.find((entry) => entry.id === a.id);
    if (!e) continue;
    if (a.x !== null && !e.valid(a.x, ctx)) continue;
    const value = a.x === null ? ctx.defaults[e.key] : e.key === "albumOrder" ? readAlbumOrder(a.x) : a.x;
    if (same(reported(e, next), value)) continue;
    (next as unknown as Record<Key, unknown>)[e.key] = value;
    if (!changed.includes(e.key)) changed.push(e.key);
  }
  return { next, changed };
}
