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

// The desktop's own People index as the window sees it: the sidecar's merged replica of every
// device's copy, this PC's scans and the edits made here. Photos are named by Drive link id.

import { rpc } from "./rpc";

export type FaceBox = [number, number, number, number];

export type MlPerson = {
  /** `n:<name>` for a named person, `g:<face id>` for a group still to name. */
  id: string;
  name: string | null;
  faces: string[];
  keys: string[];
  cover: { key: string; box: FaceBox | null } | null;
  /** Where each of `faces` sits in its photo, in the same order. */
  boxes?: FaceBox[];
};

export type MlSuggestion = { name: string; group: string; score: number; faces: string[]; boxes?: FaceBox[] };

export type MlView = {
  people: MlPerson[];
  suggestions: MlSuggestion[];
  scanned: number;
  searchable: number;
  names: string[];
};

export type MlEdit =
  | { action: "name"; person: string; name: string }
  | { action: "removePhotos"; person: string; keys: string[] }
  | { action: "movePhotos"; person: string; keys: string[]; name: string }
  | { action: "addPhotos"; name: string; keys: string[] }
  | { action: "setCover"; name: string; key: string }
  | { action: "hide"; person: string }
  | { action: "acceptSuggestion"; group: string; name: string }
  | { action: "dismissSuggestion"; group: string; name: string }
  | { action: "nameFaces"; faces: string[]; name: string };

/** One face on a photo, for the viewer: who it is (a person id and name), if anyone. */
export type PhotoFace = { face: string; box: FaceBox; person: string | null; name: string | null };

export type IndexStatus = {
  running: boolean;
  phase: "idle" | "listing" | "scanning" | "saving";
  done: number;
  total: number;
  faces: number;
  failed: number;
  finishedAt: number | null;
  error: string | null;
};

export type ModelsStatus = { missing: number; downloading: { done: number; total: number } | null; failed: string | null };

export type SyncStatus = {
  savedAt: number | null;
  saving: boolean;
  pending: boolean;
  error: string | null;
  sources: { device: string; kind: "faces" | "search"; savedAt: number }[];
  unreadable: number;
};

export const loadPeople = () => rpc<MlView>("mlView");
export const editPeople = (edit: MlEdit) => rpc<MlView>("mlEdit", edit as unknown as Record<string, unknown>);
export const suggestionsFor = (name: string) => rpc<MlSuggestion[]>("mlSuggestions", { name });
export const photoFaces = (uid: string) => rpc<PhotoFace[]>("mlPhotoFaces", { uid });

/** The person's photo keys as timeline uids, newest first, through the library's link-id map. */
export function personUids<T extends { uid: string; captureTime: number }>(keys: string[], byLink: Map<string, T>): string[] {
  return keys
    .map((k) => byLink.get(k))
    .filter((it): it is T => !!it)
    .sort((a, b) => b.captureTime - a.captureTime)
    .map((it) => it.uid);
}

/** A timeline uid (`volume~link`) as the link id the index names photos by. */
export const linkOf = (uid: string) => uid.slice(uid.indexOf("~") + 1);
