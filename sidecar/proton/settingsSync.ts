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

// The settings that ride the shared backup on Drive. Each has a stable sync id (not the window's
// key, not the phone's) and a scope: a `shared` one is taken from any device's copy, a `platform`
// one only from this install's own earlier copy (same device id, same kind of app), so it is
// restored after a reinstall and never copied from another PC or a phone. The list is an allow list: a setting that is not named here is never saved,
// whatever it is. This keeps when each was last chosen here, so two devices' copies can be put
// together, the later choice winning; a choice made here that nothing has stamped yet does not
// exist as far as Drive is concerned.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { SettingsCopy, SettingsElement, SettingsScalar, SettingsValue } from "./driveData.ts";
import { SETTINGS_SYNC_FILE, readSealedOrSetAside, storeDir, writeSealedAtomic } from "./store.ts";

export const PLATFORM = "desktop";

export type SettingScope = "shared" | "platform";

type ScalarSpec = { id: string; scope: SettingScope; valid: (x: unknown) => boolean };
type SetSpec = { id: string; scope: SettingScope };

/** What a build knows how to sync: single-valued settings and the members of set-shaped ones. */
export type Registry = { scalars: ScalarSpec[]; sets: SetSpec[] };

const bool = (x: unknown): boolean => typeof x === "boolean";
const oneOf = (list: readonly string[]) => (x: unknown): boolean => typeof x === "string" && list.includes(x);
/** A language tag; "system" means "follow the phone", which a PC has no use for. */
const languageTag = (x: unknown): boolean =>
  typeof x === "string" && x !== "system" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(x);

const THEMES = ["system", "light", "dark"] as const;
const PALETTES = ["default", "forest", "sunset", "sea", "sepia", "mono", "lavender", "rose", "mint", "gold", "ruby"] as const;
const TIERS = ["high", "balanced", "small"] as const;
const CODECS = ["auto", "avc", "hevc", "av1", "keep"] as const;
const ALBUM_SORTS = ["custom", "name", "activity", "count", "newest"] as const;
const MAX_ORDER_ITEMS = 20_000;
const MAX_ORDER_ITEM_LENGTH = 512;
/** An ordered list of album link ids, as the phone keeps it: none blank, no '|' in any. */
const albumIds = (x: unknown): boolean =>
  Array.isArray(x) &&
  x.length <= MAX_ORDER_ITEMS &&
  x.every((e) => typeof e === "string" && e.trim() !== "" && e.length <= MAX_ORDER_ITEM_LENGTH && !e.includes("|"));

/** The settings this app syncs. The window maps each id to its own key (`settingsSyncMap.ts`). */
export const DESKTOP_REGISTRY: Registry = {
  scalars: [
    { id: "appearance.theme", scope: "shared", valid: oneOf(THEMES) },
    { id: "appearance.palette", scope: "shared", valid: oneOf(PALETTES) },
    { id: "appearance.amoled", scope: "shared", valid: bool },
    { id: "albums.hidePhotosInAlbums", scope: "shared", valid: bool },
    { id: "albums.sortMode", scope: "shared", valid: oneOf(ALBUM_SORTS) },
    { id: "albums.order", scope: "shared", valid: albumIds },
    { id: "appearance.language", scope: "platform", valid: languageTag },
    { id: "upload.compressPhotos", scope: "platform", valid: bool },
    { id: "upload.compressHdr", scope: "platform", valid: bool },
    { id: "upload.compressTier", scope: "platform", valid: oneOf(TIERS) },
    { id: "upload.compressVideos", scope: "platform", valid: bool },
    { id: "upload.compressVideoTier", scope: "platform", valid: oneOf(TIERS) },
    { id: "upload.compressCodec", scope: "platform", valid: oneOf(CODECS) },
  ],
  sets: [],
};

type Stamp = {
  x: SettingsValue;
  /** When it was chosen, ms; 0 only fills a gap. */
  t: number;
  /** The device whose choice it is, for a tie on `t`. */
  d: string;
  /** A value taken in from Drive that the window has not yet shown. */
  p?: true;
};
type MemberStamp = { h: boolean; t: number; d: string };

type Saved = {
  v: 1;
  /** The existing choices were stamped once, at time 0. */
  seeded: boolean;
  scalars: Record<string, Stamp>;
  sets: Record<string, Record<string, MemberStamp>>;
};

const empty = (): Saved => ({ v: 1, seeded: false, scalars: {}, sets: {} });

const same = (a: SettingsValue, b: SettingsValue): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether a change at (`t`, by `device`) beats one held at (`heldT`, by `heldDevice`). */
const later = (t: number, device: string, heldT: number, heldDevice: string): boolean =>
  t > heldT || (t === heldT && device > heldDevice);

export class SettingsSyncStore {
  private state: Saved | null = null;
  /** Moves on every change that a copy on Drive would show. */
  version = 0;

  constructor(
    private readonly persist = true,
    private readonly registry: Registry = DESKTOP_REGISTRY,
    private readonly platform: string = PLATFORM,
  ) {}

  private path(): string {
    return join(storeDir(), SETTINGS_SYNC_FILE);
  }

  private get(): Saved {
    if (this.state) return this.state;
    let state = empty();
    const raw = this.persist ? readSealedOrSetAside(this.path()) : null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as Partial<Saved>;
        state = { v: 1, seeded: parsed.seeded === true, scalars: parsed.scalars ?? {}, sets: parsed.sets ?? {} };
      } catch {
        /* a file that will not parse starts over */
      }
    }
    this.state = state;
    return state;
  }

  private write(bump = true): void {
    if (bump) this.version++;
    if (!this.persist || !this.state) return;
    mkdirSync(storeDir(), { recursive: true });
    writeSealedAtomic(this.path(), Buffer.from(JSON.stringify(this.state), "utf8"));
  }

  private spec(id: string): ScalarSpec | undefined {
    return this.registry.scalars.find((s) => s.id === id);
  }

  private setSpec(id: string): SetSpec | undefined {
    return this.registry.sets.find((s) => s.id === id);
  }

  /** Whether the choices made before this feature existed have been stamped. */
  isSeeded(): boolean {
    return this.get().seeded;
  }

  /**
   * Stamps the choices that already differ from the defaults at time 0, so they fill a gap on
   * another device without beating anything chosen since: all of them once, and later a setting
   * a newer build started to sync, the first time it is reported. Answers whether it stamped.
   */
  seed(values: { id: string; x: unknown }[], own: string): boolean {
    const s = this.get();
    const first = !s.seeded;
    let added = false;
    for (const { id, x } of values) {
      const spec = this.spec(id);
      if (!spec || x === null || !spec.valid(x) || s.scalars[id]) continue;
      s.scalars[id] = { x: x as SettingsValue, t: 0, d: own };
      added = true;
    }
    if (!first && !added) return false;
    s.seeded = true;
    this.write();
    return true;
  }

  /** Stamps what the user just chose, now. An id not in the registry, or a bad value, is passed over. */
  stamp(changes: { id: string; x: unknown }[], own: string, at = Date.now()): boolean {
    const s = this.get();
    let changed = false;
    for (const { id, x } of changes) {
      const spec = this.spec(id);
      if (!spec || x === null || !spec.valid(x)) continue;
      s.scalars[id] = { x: x as SettingsValue, t: at, d: own };
      changed = true;
    }
    if (changed) this.write();
    return changed;
  }

  /**
   * Takes in another device's copy: for each setting and set member this build knows, the later
   * choice wins, here or there. A `platform` setting is taken only from this install's own earlier
   * copy: `own` is this install's device id, and the copy must carry it and this platform. Without
   * `own`, no `platform` setting is taken. A taken value is kept with the time it was chosen, so it is not stamped as new here and
   * does not travel back as if it were. Answers the ids that changed; null when nothing did.
   */
  takeIn(copy: SettingsCopy, own?: string): string[] | null {
    const s = this.get();
    const fits = (scope: SettingScope) => 
      scope === "shared" || (own !== undefined && copy.deviceId === own && copy.platform === this.platform);
    const changed = new Set<string>();
    for (const e of copy.scalars) {
      const spec = this.spec(e.key);
      if (!spec || !fits(spec.scope) || (e.value !== null && !spec.valid(e.value))) continue;
      const t = Math.max(0, e.changedAt);
      const held = s.scalars[e.key];
      if (held && !later(t, copy.deviceId, held.t, held.d)) continue;
      if (held && same(held.x, e.value) && held.t === t) continue;
      const differs = !held || !same(held.x, e.value);
      s.scalars[e.key] = { x: e.value, t, d: copy.deviceId, ...(differs || held?.p ? { p: true as const } : {}) };
      changed.add(e.key);
    }
    for (const e of copy.elements) {
      const spec = this.setSpec(e.key);
      if (!spec || !fits(spec.scope)) continue;
      const t = Math.max(0, e.changedAt);
      const members = (s.sets[e.key] ??= {});
      const held = members[e.element];
      if (held && !later(t, copy.deviceId, held.t, held.d)) continue;
      if (held && held.h === e.present && held.t === t) continue;
      members[e.element] = { h: e.present, t, d: copy.deviceId };
      changed.add(e.key);
    }
    if (changed.size === 0) return null;
    this.write();
    return [...changed];
  }

  /** The values taken in from Drive that the window has not shown yet. */
  pending(): { id: string; x: SettingsValue; t: number }[] {
    const s = this.get();
    return Object.entries(s.scalars)
      .filter(([id, e]) => e.p && this.spec(id))
      .map(([id, e]) => ({ id, x: e.x, t: e.t }));
  }

  /** The window has shown these (id and time as `pending` gave them); one taken in since stays pending. */
  acknowledge(done: { id: string; t: number }[]): void {
    const s = this.get();
    let any = false;
    for (const { id, t } of done) {
      const e = s.scalars[id];
      if (e?.p && e.t === t) {
        delete e.p;
        any = true;
      }
    }
    if (any) this.write(false);
  }

  /** The members of a set-shaped setting that are present now. */
  members(id: string): string[] {
    return Object.entries(this.get().sets[id] ?? {})
      .filter(([, m]) => m.h)
      .map(([element]) => element);
  }

  /** This computer's settings as its copy on Drive: every stamped setting and set member, with its time. */
  forDrive(deviceId: string, deviceLabel: string, createdAt: number): SettingsCopy {
    const s = this.get();
    const scalars: SettingsScalar[] = Object.entries(s.scalars)
      .filter(([id]) => this.spec(id))
      .map(([key, e]) => ({ key, value: e.x, changedAt: e.t }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const elements: SettingsElement[] = Object.entries(s.sets)
      .filter(([id]) => this.setSpec(id))
      .flatMap(([key, members]) =>
        Object.entries(members).map(([element, m]) => ({ key, element, present: m.h, changedAt: m.t })),
      )
      .sort((a, b) => a.key.localeCompare(b.key) || a.element.localeCompare(b.element));
    return { deviceId, platform: this.platform, deviceLabel, createdAt, scalars, elements };
  }

  /** Whether any setting has been stamped at all; a copy with none is not worth saving. */
  hasStamps(): boolean {
    const s = this.get();
    return (
      Object.keys(s.scalars).some((id) => this.spec(id)) ||
      Object.entries(s.sets).some(([id, members]) => this.setSpec(id) && Object.keys(members).length > 0)
    );
  }

  /** Forgets what is held in memory, after a sign-out wiped the file. */
  unload(): void {
    this.state = null;
    this.version++;
  }
}

export const settingsSyncStore = new SettingsSyncStore();
