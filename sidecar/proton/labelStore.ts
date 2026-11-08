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

// The labels kept on this computer: up to five free-text labels a photo, by the photo's Drive
// link id, the same labels the Android app keeps. Each change carries when it was made, so this
// computer's labels and another device's copy on Drive can be put together without losing an
// edit made on either side.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { LabelCopy } from "./driveData.ts";
import { LABELS_DIR, readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

/** At most this many labels a photo, each at most this many characters, as on the phone. */
export const MAX_LABELS = 5;
export const MAX_LENGTH = 24;

const BLANKS = /[\s\p{Z}\p{Cc}]+/gu;

/** A label as compared: blanks collapsed, case and accents aside. */
export function foldLabel(label: string): string {
  return label.replace(BLANKS, " ").trim().normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** One label made clean, or null when nothing is left or it holds a comma, as the phone rules it. */
export function cleanLabel(raw: string): string | null {
  if (raw.includes(",")) return null;
  const collapsed = raw.replace(BLANKS, " ").trim();
  const cut = [...collapsed].slice(0, MAX_LENGTH).join("").trimEnd();
  return cut && foldLabel(cut) ? cut : null;
}

/** Clean, distinct labels in order, the first spelling kept. */
function distinct(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const label = cleanLabel(raw);
    if (!label || seen.has(foldLabel(label))) continue;
    seen.add(foldLabel(label));
    out.push(label);
  }
  return out;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

export type LabelState = {
  /** Each photo's labels and when they last changed; an empty list is a photo whose labels were taken off. */
  photos: Record<string, { l: string[]; t: number }>;
  /** Labels made by name, by their fold: they stay in the list at no photos, as on the phone. */
  names: Record<string, { n: string; t: number }>;
  /** Labels deleted, by their fold, and when. */
  deleted: Record<string, { n: string; t: number }>;
  /** Each other device's copy taken in, by device id, at the time that copy was made. */
  applied: Record<string, number>;
};

export function emptyLabels(): LabelState {
  return { photos: {}, names: {}, deleted: {}, applied: {} };
}

/** Whether a label deleted at its time still holds over a part changed at `t`. */
const outlives = (deleted: { t: number } | undefined, t: number) => !!deleted && deleted.t >= t;

const carried = (state: LabelState, fold: string) =>
  Object.values(state.photos).some((p) => p.l.some((l) => foldLabel(l) === fold));

/** A label put back on purpose clears its deletion. */
function undelete(state: LabelState, label: string, at: number): void {
  const fold = foldLabel(label);
  if (state.deleted[fold] && state.deleted[fold].t <= at) delete state.deleted[fold];
}

/** Sets a photo's labels to `labels`, as of `at`. Answers whether anything changed. */
export function setLabels(state: LabelState, key: string, labels: string[], at: number): boolean {
  const next = distinct(labels).slice(0, MAX_LABELS);
  const now = state.photos[key];
  if (now ? sameList(now.l, next) : next.length === 0) return false;
  state.photos[key] = { l: next, t: at };
  for (const label of next) undelete(state, label, at);
  return true;
}

/**
 * Moves a photo's labels to the link of the copy that replaced it. The old link keeps an empty entry
 * as of `at`, so an older copy from another device does not put them back on it. Answers whether
 * anything moved.
 */
export function rekeyLabels(state: LabelState, oldKey: string, newKey: string, at: number): boolean {
  const from = state.photos[oldKey];
  if (oldKey === newKey || !from || from.l.length === 0) return false;
  setLabels(state, newKey, [...(state.photos[newKey]?.l ?? []), ...from.l], at);
  state.photos[oldKey] = { l: [], t: at };
  return true;
}

/**
 * Adds `labels` to each photo of `keys` after the ones it carries, as far as there is room.
 * Answers how many photos changed and how many could not take every label.
 */
export function addLabels(state: LabelState, keys: string[], labels: string[], at: number): { changed: number; full: number } {
  let changed = 0;
  let full = 0;
  const incoming = distinct(labels);
  for (const key of keys) {
    const merged = distinct([...(state.photos[key]?.l ?? []), ...incoming]);
    if (merged.length > MAX_LABELS) full++;
    if (setLabels(state, key, merged.slice(0, MAX_LABELS), at)) changed++;
  }
  return { changed, full };
}

/** Takes `labels` off each photo of `keys`. Answers how many photos changed. */
export function removeLabels(state: LabelState, keys: string[], labels: string[], at: number): number {
  const gone = new Set(labels.map(foldLabel));
  let changed = 0;
  for (const key of keys) {
    const current = state.photos[key]?.l;
    if (!current) continue;
    if (setLabels(state, key, current.filter((l) => !gone.has(foldLabel(l))), at)) changed++;
  }
  return changed;
}

/** Makes a label by name, which stays in the list at no photos. Answers its clean spelling, or
 *  null when it is not a label. */
export function createLabel(state: LabelState, raw: string, at: number): string | null {
  const label = cleanLabel(raw);
  if (!label) return null;
  const fold = foldLabel(label);
  undelete(state, label, at);
  if (!state.names[fold]) state.names[fold] = { n: label, t: at };
  return label;
}

/** Deletes a label from every photo and the list. Answers whether it was there. */
export function deleteLabel(state: LabelState, label: string, at: number): boolean {
  const fold = foldLabel(label);
  let found = !!state.names[fold];
  delete state.names[fold];
  for (const [key, photo] of Object.entries(state.photos)) {
    if (!photo.l.some((l) => foldLabel(l) === fold)) continue;
    found = true;
    state.photos[key] = { l: photo.l.filter((l) => foldLabel(l) !== fold), t: at };
  }
  if (found) state.deleted[fold] = { n: label, t: at };
  return found;
}

/**
 * Renames a label on every photo that carries it; a photo that already has the new name keeps it
 * once. The old name counts as deleted, so another device's older copy does not bring it back.
 * Answers the new spelling, or null when it is not a label.
 */
export function renameLabel(state: LabelState, from: string, to: string, at: number): string | null {
  const label = cleanLabel(to);
  if (!label) return null;
  const oldFold = foldLabel(from);
  const swap = (l: string) => (foldLabel(l) === oldFold ? label : l);
  if (oldFold === foldLabel(label)) {
    // Only the spelling changes: every place the label shows takes the new one.
    for (const [key, photo] of Object.entries(state.photos)) {
      if (photo.l.some((l) => foldLabel(l) === oldFold && l !== label)) state.photos[key] = { l: photo.l.map(swap), t: at };
    }
    if (state.names[oldFold]) state.names[oldFold] = { n: label, t: at };
    return label;
  }
  const hadName = !!state.names[oldFold];
  for (const [key, photo] of Object.entries(state.photos)) {
    if (photo.l.some((l) => foldLabel(l) === oldFold)) setLabels(state, key, photo.l.map(swap), at);
  }
  delete state.names[oldFold];
  // Just before the photos changed, so another device takes the deletion and then the new lists.
  state.deleted[oldFold] = { n: from, t: at - 1 };
  if (hadName) createLabel(state, label, at);
  else undelete(state, label, at);
  return label;
}

/**
 * Puts another device's copy together with these labels, once per copy: a photo whose labels
 * changed there later than here takes that device's list, a label deleted there comes off every
 * photo labelled before the deletion, and a label made there with no photo is added. An edit made
 * here after the other device's is kept. Answers whether anything changed.
 */
export function takeInLabels(state: LabelState, copy: LabelCopy, ownDeviceId: string): boolean {
  if (!copy.deviceId || copy.deviceId === ownDeviceId) return false;
  if ((state.applied[copy.deviceId] ?? -1) >= copy.createdAt) return false;
  let changed = false;
  // The photos a deletion of the copy just stamped, with its time: a copy whose deletion and photo
  // change carry the same time (a rename) still brings the photo's new list.
  const stamped = new Map<string, number>();
  for (const d of copy.deleted) {
    const fold = foldLabel(d.name);
    if (!fold || outlives(state.deleted[fold], d.at)) continue;
    state.deleted[fold] = { n: d.name, t: d.at };
    if (state.names[fold] && state.names[fold].t <= d.at) delete state.names[fold];
    for (const [key, photo] of Object.entries(state.photos)) {
      if (photo.t > d.at || !photo.l.some((l) => foldLabel(l) === fold)) continue;
      state.photos[key] = { l: photo.l.filter((l) => foldLabel(l) !== fold), t: d.at };
      stamped.set(key, d.at);
    }
    changed = true;
  }
  for (const photo of copy.photos) {
    const here = state.photos[photo.key];
    if (here && (here.t > photo.changedAt || (here.t === photo.changedAt && stamped.get(photo.key) !== photo.changedAt))) continue;
    const labels = distinct(photo.labels)
      .filter((l) => !outlives(state.deleted[foldLabel(l)], photo.changedAt))
      .slice(0, MAX_LABELS);
    if (!here && labels.length === 0) continue;
    if (here && sameList(here.l, labels)) {
      here.t = photo.changedAt;
      continue;
    }
    state.photos[photo.key] = { l: labels, t: photo.changedAt };
    changed = true;
  }
  for (const name of copy.names) {
    const label = cleanLabel(name.name);
    if (!label) continue;
    const fold = foldLabel(label);
    if (state.names[fold] || outlives(state.deleted[fold], name.changedAt)) continue;
    state.names[fold] = { n: label, t: name.changedAt };
    changed = true;
  }
  state.applied[copy.deviceId] = copy.createdAt;
  return changed;
}

/** Every label with the photos that carry it, most photos first; a label with no photo has none. */
export function labelList(state: LabelState): { name: string; keys: string[] }[] {
  const byFold = new Map<string, { name: string; keys: string[] }>();
  for (const [key, photo] of Object.entries(state.photos)) {
    for (const label of photo.l) {
      const fold = foldLabel(label);
      let entry = byFold.get(fold);
      if (!entry) byFold.set(fold, (entry = { name: label, keys: [] }));
      entry.keys.push(key);
    }
  }
  for (const [fold, name] of Object.entries(state.names)) if (!byFold.has(fold)) byFold.set(fold, { name: name.n, keys: [] });
  return [...byFold.values()].sort((a, b) => b.keys.length - a.keys.length || a.name.localeCompare(b.name));
}

/** These labels as this install's copy on Drive. */
export function labelsForDrive(state: LabelState, deviceId: string, deviceLabel: string, at: number): LabelCopy {
  return {
    deviceId,
    deviceLabel,
    createdAt: at,
    photos: Object.entries(state.photos).map(([key, p]) => ({ key, labels: p.l, changedAt: p.t })),
    // As the phone writes `m`: the labels made by name that no photo carries.
    names: Object.entries(state.names)
      .filter(([fold]) => !carried(state, fold))
      .map(([, n]) => ({ name: n.n, changedAt: n.t })),
    deleted: Object.values(state.deleted).map((d) => ({ name: d.n, at: d.t })),
  };
}

const FILE = "labels.enc";

/** The labels, sealed in the store, loaded on first use and written back after each change. */
export class LabelStore {
  private state: LabelState | null = null;
  /** Bumped by every change, so the window and the save know when to look again. */
  version = 0;

  private path(): string {
    return join(storeDir(), LABELS_DIR, FILE);
  }

  get(): LabelState {
    if (!this.state) {
      const raw = readSealedOrDiscard(this.path());
      let parsed = emptyLabels();
      if (raw) {
        try {
          parsed = { ...emptyLabels(), ...(JSON.parse(raw.toString("utf8")) as Partial<LabelState>) };
        } catch {
          /* a file that will not parse starts the labels over */
        }
      }
      this.state = parsed;
    }
    return this.state;
  }

  /** Runs `change` on the labels and writes them back when `changed` says it changed something. */
  change<T>(change: (state: LabelState) => T, changed: (result: T) => boolean): T {
    const result = change(this.get());
    if (changed(result)) {
      this.write();
      this.version++;
    }
    return result;
  }

  /** Writes the labels as they stand. */
  write(): void {
    if (!this.state) return;
    mkdirSync(join(storeDir(), LABELS_DIR), { recursive: true });
    writeSealedAtomic(this.path(), Buffer.from(JSON.stringify(this.state), "utf8"));
  }

  /** Forgets what is held in memory, after a sign-out wiped the file. */
  unload(): void {
    this.state = null;
    this.version++;
  }
}

export const labelStore = new LabelStore();
