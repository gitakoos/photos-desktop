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

// The photo order inside each album, kept by the album's Drive link id: how the album lists its
// photos (newest, oldest or custom) and its hand-made order, each half with when it last changed,
// so this computer's orders can be put together with the phone's, the later change winning. The
// same rule and format as the phone's, so either app draws the same order from either copy.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { ALBUM_PHOTO_MODES, type AlbumOrderCopy, type AlbumOrderEntry, type AlbumPhotoMode } from "./driveData.ts";
import { ALBUM_ORDER_FILE, readSealedOrSetAside, storeDir, writeSealedAtomic } from "./store.ts";

export const PLATFORM = "desktop";

export type AlbumOrderState = {
  modes: Record<string, { m: AlbumPhotoMode; t: number }>;
  orders: Record<string, { o: string[]; t: number }>;
};

type Saved = AlbumOrderState & {
  v: 1;
  /** The per-album choices kept in the settings before this file existed were taken over. */
  seeded: boolean;
};

/** One album's order as the window reads it: its mode (null follows the default) and its arrangement. */
export type AlbumOrderView = { mode: AlbumPhotoMode | null; order: string[]; version: number };

/** The Drive link id of a uid, `volume~link`; a bare link id stays as it is. */
export const linkOf = (uid: string): string => uid.slice(uid.lastIndexOf("~") + 1);

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const isMode = (x: unknown): x is AlbumPhotoMode => ALBUM_PHOTO_MODES.includes(x as AlbumPhotoMode);

/**
 * Takes `copy` into `state`, the phone's rule: per album, the mode and the order each on their own,
 * the later time wins; on an equal time a differing value from the larger device id wins; a value
 * absent here counts as time -1, so time 0 only fills a gap. A copy written as `readsAs` is passed
 * over: that is this install's own, except on a read-back. Answers the albums that changed.
 */
export function takeInAlbumOrder(state: AlbumOrderState, copy: AlbumOrderCopy, readsAs: string, own: string): string[] {
  if (!copy.deviceId || copy.deviceId === readsAs) return [];
  const wins = (at: number, held: number, differs: boolean) => at > held || (at === held && differs && copy.deviceId > own);
  const changed = new Set<string>();
  for (const e of copy.albums) {
    if (isMode(e.mode) && e.modeAt !== undefined) {
      const held = state.modes[e.key];
      if (wins(e.modeAt, held?.t ?? -1, held?.m !== e.mode)) {
        state.modes[e.key] = { m: e.mode, t: e.modeAt };
        changed.add(e.key);
      }
    }
    if (e.order && e.orderAt !== undefined) {
      const held = state.orders[e.key];
      if (wins(e.orderAt, held?.t ?? -1, !held || !sameList(held.o, e.order))) {
        state.orders[e.key] = { o: [...e.order], t: e.orderAt };
        changed.add(e.key);
      }
    }
  }
  return [...changed];
}

/**
 * `state` as this install's copy, ordered by album link id. With `albums` given (the albums of a
 * complete listing), an album outside it is left out, which is how a deleted album ages out.
 */
export function albumOrderForDrive(
  state: AlbumOrderState,
  deviceId: string,
  deviceLabel: string,
  createdAt: number,
  albums?: ReadonlySet<string>,
): AlbumOrderCopy {
  const keys = [...new Set([...Object.keys(state.modes), ...Object.keys(state.orders)])]
    .filter((k) => !albums || albums.has(k))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    deviceId,
    platform: PLATFORM,
    deviceLabel,
    createdAt,
    albums: keys.map((key) => {
      const entry: AlbumOrderEntry = { key };
      const mode = state.modes[key];
      const order = state.orders[key];
      if (mode) {
        entry.mode = mode.m;
        entry.modeAt = mode.t;
      }
      if (order) {
        entry.order = order.o;
        entry.orderAt = order.t;
      }
      return entry;
    }),
  };
}

const empty = (): Saved => ({ v: 1, seeded: false, modes: {}, orders: {} });

export class AlbumOrderStore {
  private state: Saved | null = null;
  /** Moves on every change that a copy on Drive would show. */
  version = 0;

  constructor(private readonly persist = true) {}

  private path(): string {
    return join(storeDir(), ALBUM_ORDER_FILE);
  }

  private get(): Saved {
    if (this.state) return this.state;
    let state = empty();
    const raw = this.persist ? readSealedOrSetAside(this.path()) : null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as Partial<Saved>;
        state = { v: 1, seeded: parsed.seeded === true, modes: parsed.modes ?? {}, orders: parsed.orders ?? {} };
      } catch {
        /* a file that will not parse starts over */
      }
    }
    this.state = state;
    return state;
  }

  private write(): void {
    this.version++;
    if (!this.persist || !this.state) return;
    mkdirSync(storeDir(), { recursive: true });
    writeSealedAtomic(this.path(), Buffer.from(JSON.stringify(this.state), "utf8"));
  }

  /** One album's order, by its uid or link id. */
  view(album: string): AlbumOrderView {
    const s = this.get();
    const link = linkOf(album);
    return { mode: s.modes[link]?.m ?? null, order: s.orders[link]?.o ?? [], version: this.version };
  }

  /** Picks how an album lists its photos. */
  setMode(album: string, mode: AlbumPhotoMode, at = Date.now()): void {
    if (!isMode(mode)) return;
    this.get().modes[linkOf(album)] = { m: mode, t: at };
    this.write();
  }

  /** A Done in arrange mode: `order` (photo link ids) becomes the album's order, and the album follows it. */
  saveCustom(album: string, order: string[], at = Date.now()): void {
    const s = this.get();
    const link = linkOf(album);
    s.orders[link] = { o: [...new Set(order.map(linkOf).filter((k) => k.trim() !== ""))], t: at };
    s.modes[link] = { m: "custom", t: at };
    this.write();
  }

  /**
   * Takes over the per-album choices the settings held before this file existed, once, at time 0,
   * so a choice from another device wins. An album with a mode of its own keeps it. Answers
   * whether anything was added.
   */
  seed(modes: Record<string, unknown>): boolean {
    const s = this.get();
    if (s.seeded) return false;
    let added = false;
    for (const [album, mode] of Object.entries(modes)) {
      const link = linkOf(album);
      if (!isMode(mode) || !link || s.modes[link]) continue;
      s.modes[link] = { m: mode, t: 0 };
      added = true;
    }
    s.seeded = true;
    this.write();
    return added;
  }

  /** Puts another device's copy together with this computer's. Answers whether anything changed. */
  takeIn(copy: AlbumOrderCopy, readsAs: string, own: string): boolean {
    const changed = takeInAlbumOrder(this.get(), copy, readsAs, own);
    if (changed.length === 0) return false;
    this.write();
    return true;
  }

  forDrive(deviceId: string, deviceLabel: string, createdAt: number, albums?: ReadonlySet<string>): AlbumOrderCopy {
    return albumOrderForDrive(this.get(), deviceId, deviceLabel, createdAt, albums);
  }

  isEmpty(): boolean {
    const s = this.get();
    return Object.keys(s.modes).length + Object.keys(s.orders).length === 0;
  }

  /** Forgets what is held in memory, after a sign-out wiped the file. */
  unload(): void {
    this.state = null;
    this.version++;
  }
}

export const albumOrderStore = new AlbumOrderStore();
