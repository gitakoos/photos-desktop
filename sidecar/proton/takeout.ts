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
 * Reading a Google Takeout or Ente export: the small JSON each one keeps beside a photo,
 * which file that JSON belongs to, and which album a photo was in.
 *
 * Both write the same JSON shape. Takeout puts it next to the photo under an awkward,
 * often clipped name; Ente puts it in the album's `metadata/` folder under the photo's
 * own name plus `.json`. The JSON holds the real capture date, place and caption, which
 * the file itself has frequently lost, so an import trusts it over the file.
 *
 * Everything here is pure: no files, no network.
 */

export type SidecarMeta = {
  /** The capture time in ms, or undefined when the JSON has no believable one. */
  takenMs?: number;
  latitude?: number;
  longitude?: number;
  description?: string;
  title?: string;
  favorited: boolean;
};

/** A real sidecar is a few kilobytes; anything far past this is not one. */
export const MAX_SIDECAR_BYTES = 1_000_000;

/** Google clips the whole sidecar name near this length, a long photo name with it. */
const GOOGLE_NAME_CAP = 46;

/** The tag Takeout puts before `.json`; a clipped one is any leading part of it. */
const SUPPLEMENTAL = "supplemental-metadata";

/** Localised stems of Google's edited-copy suffix; an edited copy shares the original's JSON. */
const EDIT_TOKENS = ["edited", "bearbeitet", "modifi", "bewerkt", "editado", "modificato", "redigerad"];

const TRAILING_COUNTER = /\((\d+)\)$/;
const TIMELINE_YEAR = /^photos from \d{4}$/;

/** The export's wrapper folders: a photo straight inside one is in no album. */
const EXPORT_CONTAINERS = new Set(["takeout", "google photos", "google fotos"]);

/**
 * Folders that are a timeline rather than an album: Google's year, archive and trash
 * buckets, and Ente's Uncategorized, which holds the photos no album claims.
 */
const TIMELINE_BUCKETS = new Set(["archive", "trash", "bin", "uncategorized"]);

/** Ente's folder for the JSON of every photo in an album. */
export const ENTE_METADATA_DIR = "metadata";

const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

/**
 * What a sidecar's JSON says, or null when it is not a sidecar at all. Never throws: a
 * malformed file, or one unreadable field, comes back as null or as that field missing.
 * `photoTakenTime` is the capture date; `creationTime` is when it was uploaded, and is
 * ignored. Google's 0, 0 means no place.
 */
export function parseSidecar(text: string): SidecarMeta | null {
  if (!text.trim() || text.length > MAX_SIDECAR_BYTES) return null;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(root)) return null;

  const meta: SidecarMeta = { favorited: root.favorited === true };
  const taken = takenMs(root.photoTakenTime);
  if (taken !== undefined) meta.takenMs = taken;
  const place = livePlace(root.geoData) ?? livePlace(root.geoDataExif);
  if (place) {
    meta.latitude = place[0];
    meta.longitude = place[1];
  }
  const description = typeof root.description === "string" ? root.description.trim() : "";
  if (description) meta.description = description;
  const title = typeof root.title === "string" ? root.title.trim() : "";
  if (title) meta.title = title;
  return meta;
}

/**
 * The one key a sidecar's file name stands for: `.json` off, any clipped
 * `supplemental-metadata` off, a `(n)` counter in one place, lowercased. Every sidecar
 * goes into the index under this.
 */
export function sidecarKey(jsonName: string): string {
  let rest = jsonName.trim();
  if (rest.toLowerCase().endsWith(".json")) rest = rest.slice(0, -5);
  // A counter can sit after the tag (`...supplemental-metadata(1)`); pulled aside, it
  // lands where the photo's own counter does.
  const [untagged, tagCounter] = pullCounter(rest);
  let core = stripSupplemental(untagged);
  if (tagCounter !== null) core += `(${tagCounter})`;
  const [stem, ext, counter] = decompose(core);
  return keyOf(stem, ext, counter);
}

/**
 * The keys to look a photo up by, most exact first: its name, the name without an
 * edited suffix, both again without the extension (a sidecar sometimes drops it), and
 * last a clipped prefix for a name Google cut short.
 */
export function candidateMediaKeys(mediaName: string): string[] {
  const [stemFull, ext, counter] = decompose(mediaName.trim());
  const stemBase = stripEdited(stemFull);
  const out = new Set<string>();
  const literalWithExt = keyOf(stemFull, ext, counter);
  const literalNoExt = keyOf(stemFull, "", counter);
  out.add(literalWithExt);
  out.add(keyOf(stemBase, ext, counter));
  out.add(literalNoExt);
  out.add(keyOf(stemBase, "", counter));
  if (literalWithExt.length > GOOGLE_NAME_CAP) out.add(literalWithExt.slice(0, GOOGLE_NAME_CAP));
  if (literalNoExt.length > GOOGLE_NAME_CAP) out.add(literalNoExt.slice(0, GOOGLE_NAME_CAP));
  return [...out];
}

/**
 * The album a photo at `relPath` (relative to the export's top) was in, or null for none.
 * That is the folder it sits in, for both layouts: Takeout's
 * `Takeout/Google Photos/<Album>/<file>` and Ente's `<Album>/<file>`. A timeline bucket,
 * the wrapper folders and the export's top are no album.
 */
export function albumFolderOf(relPath: string): string | null {
  const segments = relPath
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const parent = segments[segments.length - 2];
  const lower = parent.toLowerCase();
  if (EXPORT_CONTAINERS.has(lower)) return null;
  if (TIMELINE_BUCKETS.has(lower) || TIMELINE_YEAR.test(lower)) return null;
  return parent;
}

/**
 * The folder a sidecar describes photos in: its own, or for Ente's `metadata/` the album
 * folder above it. Paths use `/` and are relative to the export's top.
 */
export function sidecarScope(relJsonPath: string): string {
  const parts = relJsonPath.replace(/\\/g, "/").split("/");
  parts.pop();
  if (parts.length > 0 && parts[parts.length - 1].toLowerCase() === ENTE_METADATA_DIR) parts.pop();
  return parts.join("/").toLowerCase();
}

/**
 * Every sidecar of an export, looked up by the photo it belongs to. A photo's own folder
 * is searched first, so two albums holding an `IMG_0001.jpg` each keep their own dates;
 * the whole export after that, because Takeout can split a photo and its JSON across two
 * archives and two folders.
 */
export class SidecarIndex {
  private readonly scoped = new Map<string, SidecarMeta>();
  private readonly anywhere = new Map<string, SidecarMeta>();

  get size(): number {
    return this.scoped.size;
  }

  add(relJsonPath: string, meta: SidecarMeta): void {
    const name = relJsonPath.replace(/\\/g, "/").split("/").pop() ?? "";
    const key = sidecarKey(name);
    this.scoped.set(`${sidecarScope(relJsonPath)}|${key}`, meta);
    if (!this.anywhere.has(key)) this.anywhere.set(key, meta);
  }

  find(relMediaPath: string): SidecarMeta | undefined {
    const parts = relMediaPath.replace(/\\/g, "/").split("/");
    const name = parts.pop() ?? "";
    const scope = parts.join("/").toLowerCase();
    const keys = candidateMediaKeys(name);
    for (const key of keys) {
      const hit = this.scoped.get(`${scope}|${key}`);
      if (hit) return hit;
    }
    for (const key of keys) {
      const hit = this.anywhere.get(key);
      if (hit) return hit;
    }
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{ "timestamp": "<unix seconds>" }` as ms, if it is a believable capture time. */
function takenMs(v: unknown): number | undefined {
  if (!isObject(v)) return undefined;
  const raw = v.timestamp;
  const seconds =
    typeof raw === "string" && /^\d{1,12}$/.test(raw.trim())
      ? Number(raw)
      : typeof raw === "number"
        ? raw
        : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const ms = seconds * 1000;
  const year = new Date(ms).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR ? ms : undefined;
}

/** A place that is real: finite, on the globe, and not Google's 0, 0 for none. */
function livePlace(v: unknown): [number, number] | null {
  if (!isObject(v)) return null;
  const lat = v.latitude;
  const lng = v.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (lat === 0 && lng === 0) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
}

/** A name's stem, extension and duplicate counter. */
function decompose(raw: string): [string, string, string | null] {
  let [name, counter] = pullCounter(raw);
  let stem = name;
  let ext = "";
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const cand = name.slice(dot + 1);
    if (isExtLike(cand)) {
      stem = name.slice(0, dot);
      ext = cand;
    }
  }
  // A counter before the extension (`IMG_1234(1).jpg`) is now at the stem's end.
  if (counter === null) {
    const [rest, stemCounter] = pullCounter(stem);
    if (stemCounter !== null) {
      stem = rest;
      counter = stemCounter;
    }
  }
  return [stem, ext, counter];
}

function pullCounter(s: string): [string, string | null] {
  const m = TRAILING_COUNTER.exec(s);
  return m ? [s.slice(0, m.index), m[1]] : [s, null];
}

function stripSupplemental(s: string): string {
  const dot = s.lastIndexOf(".");
  if (dot < 0) return s;
  const seg = s.slice(dot + 1).toLowerCase();
  return seg && seg.length <= SUPPLEMENTAL.length && SUPPLEMENTAL.startsWith(seg) ? s.slice(0, dot) : s;
}

function stripEdited(stem: string): string {
  const dash = stem.lastIndexOf("-");
  if (dash <= 0) return stem;
  const seg = stem.slice(dash + 1).toLowerCase();
  return EDIT_TOKENS.some((t) => seg.startsWith(t)) ? stem.slice(0, dash) : stem;
}

/** A media extension: 1 to 5 letters or digits, at least one a letter. */
function isExtLike(s: string): boolean {
  return /^[\p{L}\p{N}]{1,5}$/u.test(s) && /\p{L}/u.test(s);
}

function keyOf(stem: string, ext: string, counter: string | null): string {
  let key = stem.toLowerCase();
  if (ext) key += `.${ext.toLowerCase()}`;
  if (counter !== null) key += `(${counter})`;
  return key;
}
