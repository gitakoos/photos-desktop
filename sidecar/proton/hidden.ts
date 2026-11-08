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

// The photos and albums hidden on this computer, as the phone hides cloud photos: by the Drive
// link id of each, on this side only. Nothing is moved or changed on Drive, so a photo reappears
// as it was when it is shown again. A hidden album hides its photos everywhere too, and is
// reachable only from the locked Hidden page. Each entry keeps when it changed, and a photo or
// album shown again keeps when that was, so this computer's list can later be merged with the
// phone's, the latest change winning.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { HiddenCopy, HiddenEntry } from "./driveData.ts";
import { HIDDEN_FILE, readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

export type HiddenKind = "photos" | "albums";

type Saved = {
  v: 1;
  /** Hidden photos and albums: link id to when it was hidden. */
  photos: Record<string, number>;
  albums: Record<string, number>;
  /** Shown again: link id to when. */
  shown: { photos: Record<string, number>; albums: Record<string, number> };
  /** Each hidden album's photos (uids), as last read. */
  members: Record<string, string[]>;
};

export type HiddenState = {
  /** Link ids of the photos hidden one by one. */
  photos: string[];
  /** Uids of the hidden albums, and of the photos in them. */
  albums: string[];
  albumPhotos: string[];
  version: number;
};

/** The Drive link id of a uid, `volume~link`; a bare link id stays as it is. */
export const linkOf = (uid: string): string => uid.slice(uid.lastIndexOf("~") + 1);

const empty = (): Saved => ({ v: 1, photos: {}, albums: {}, shown: { photos: {}, albums: {} }, members: {} });

export class HiddenStore {
  private state: Saved | null = null;
  /** Hidden album uids, by link id, as they were hidden; the uid is what the window lists albums by. */
  private albumUids = new Map<string, string>();
  version = 0;

  constructor(private readonly persist = true) {}

  private path(): string {
    return join(storeDir(), HIDDEN_FILE);
  }

  private get(): Saved {
    if (this.state) return this.state;
    let state = empty();
    const raw = this.persist ? readSealedOrDiscard(this.path()) : null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as Partial<Saved> & { albumUids?: Record<string, string> };
        state = {
          v: 1,
          photos: parsed.photos ?? {},
          albums: parsed.albums ?? {},
          shown: { photos: parsed.shown?.photos ?? {}, albums: parsed.shown?.albums ?? {} },
          members: parsed.members ?? {},
        };
        for (const [link, uid] of Object.entries(parsed.albumUids ?? {})) this.albumUids.set(link, uid);
      } catch {
        /* a file that will not parse starts the list over */
      }
    }
    this.state = state;
    return state;
  }

  private write(): void {
    this.version++;
    if (!this.persist || !this.state) return;
    mkdirSync(storeDir(), { recursive: true });
    const saved = { ...this.state, albumUids: Object.fromEntries(this.albumUids) };
    writeSealedAtomic(this.path(), Buffer.from(JSON.stringify(saved), "utf8"));
  }

  /** Hides or shows `uids` of one kind; for a hidden album, `members` are its photos as read now. */
  set(kind: HiddenKind, uids: string[], hidden: boolean, at = Date.now(), members?: Map<string, string[]>): void {
    const s = this.get();
    for (const uid of uids) {
      const link = linkOf(uid);
      if (hidden) {
        s[kind][link] = at;
        delete s.shown[kind][link];
        if (kind === "albums") {
          this.albumUids.set(link, uid);
          const found = members?.get(uid);
          if (found) s.members[link] = found;
        }
      } else {
        delete s[kind][link];
        s.shown[kind][link] = at;
        if (kind === "albums") {
          delete s.members[link];
          this.albumUids.delete(link);
        }
      }
    }
    this.write();
  }

  /**
   * Hides the copy that replaced a hidden photo, and lists it in every hidden album the photo was in.
   * Answers whether anything changed.
   */
  rekeyPhoto(oldUid: string, newUid: string, at = Date.now()): boolean {
    const s = this.get();
    const oldLink = linkOf(oldUid);
    const newLink = linkOf(newUid);
    let changed = false;
    if (oldLink in s.photos && !(newLink in s.photos)) {
      s.photos[newLink] = at;
      delete s.shown.photos[newLink];
      changed = true;
    }
    for (const [album, uids] of Object.entries(s.members)) {
      if (!uids.includes(oldUid) || uids.includes(newUid)) continue;
      s.members[album] = [...uids, newUid];
      changed = true;
    }
    if (changed) this.write();
    return changed;
  }

  /** Keeps a hidden album's photos up to date with what it holds now. */
  setMembers(albumUid: string, uids: string[]): void {
    const s = this.get();
    const link = linkOf(albumUid);
    if (!(link in s.albums)) return;
    const before = s.members[link] ?? [];
    if (before.length === uids.length && before.every((u, i) => u === uids[i])) return;
    s.members[link] = uids;
    this.write();
  }

  /** Photos just put into a hidden album, hidden with it at once. */
  addMembers(albumUid: string, uids: string[]): void {
    const s = this.get();
    const link = linkOf(albumUid);
    if (!(link in s.albums) || uids.length === 0) return;
    const before = s.members[link] ?? [];
    const added = uids.filter((u) => !before.includes(u));
    if (added.length === 0) return;
    s.members[link] = [...before, ...added];
    this.write();
  }

  /** The hidden albums' uids, for reading their photos again. */
  hiddenAlbumUids(): string[] {
    const s = this.get();
    return Object.keys(s.albums).map((link) => this.albumUids.get(link) ?? link);
  }

  isHiddenAlbum(uid: string): boolean {
    return linkOf(uid) in this.get().albums;
  }

  /** Whether a photo is hidden, on its own or by a hidden album it is in. */
  hiddenPhotoTest(): (uid: string) => boolean {
    const s = this.get();
    const inAlbums = new Set(Object.values(s.members).flat());
    const own = s.photos;
    return (uid) => linkOf(uid) in own || inAlbums.has(uid);
  }

  snapshot(): HiddenState {
    const s = this.get();
    return {
      photos: Object.keys(s.photos),
      albums: this.hiddenAlbumUids(),
      albumPhotos: [...new Set(Object.values(s.members).flat())],
      version: this.version,
    };
  }

  /**
   * Takes in another device's list: for each photo and album, the later change wins, here or
   * there, and an entry without a time (0) only fills a gap. Answers the albums newly hidden by
   * it, by link id, whose photos have still to be read; null when nothing changed.
   */
  takeIn(copy: HiddenCopy): string[] | null {
    const s = this.get();
    let changed = false;
    const newAlbums: string[] = [];
    const apply = (kind: HiddenKind, entries: HiddenEntry[]) => {
      for (const e of entries) {
        const local = Math.max(s[kind][e.key] ?? -1, s.shown[kind][e.key] ?? -1);
        if (e.changedAt <= local) continue;
        const was = e.key in s[kind];
        if (e.hidden) {
          s[kind][e.key] = e.changedAt;
          delete s.shown[kind][e.key];
          if (kind === "albums" && !was) newAlbums.push(e.key);
        } else {
          delete s[kind][e.key];
          s.shown[kind][e.key] = e.changedAt;
          if (kind === "albums") {
            delete s.members[e.key];
            this.albumUids.delete(e.key);
          }
        }
        changed = true;
      }
    };
    apply("photos", copy.photos);
    apply("albums", copy.albums);
    if (!changed) return null;
    this.write();
    return newAlbums;
  }

  /** Names a hidden album known only by its link id, so its photos can be read. */
  setAlbumUid(uid: string): void {
    const link = linkOf(uid);
    if (link in this.get().albums && this.albumUids.get(link) !== uid) {
      this.albumUids.set(link, uid);
      this.write();
    }
  }

  /** This computer's list as its copy on Drive: every entry, hidden or shown again, with its time. */
  forDrive(deviceId: string, deviceLabel: string, createdAt: number): HiddenCopy {
    const s = this.get();
    const entries = (kind: HiddenKind): HiddenEntry[] => [
      ...Object.entries(s[kind]).map(([key, t]) => ({ key, hidden: true, changedAt: t })),
      ...Object.entries(s.shown[kind]).map(([key, t]) => ({ key, hidden: false, changedAt: t })),
    ];
    return { deviceId, deviceLabel, createdAt, photos: entries("photos"), albums: entries("albums") };
  }

  /** Whether there is anything at all to save. */
  isEmpty(): boolean {
    const s = this.get();
    return (
      Object.keys(s.photos).length + Object.keys(s.albums).length +
        Object.keys(s.shown.photos).length + Object.keys(s.shown.albums).length ===
      0
    );
  }

  /** Forgets what is held in memory, after a sign-out wiped the file. */
  unload(): void {
    this.state = null;
    this.albumUids.clear();
    this.version++;
  }
}

export const hiddenStore = new HiddenStore();
