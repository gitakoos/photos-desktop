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

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  readSettingsCopy,
  settingsFileDevice,
  settingsFileName,
  writeSettingsCopy,
  type SettingsCopy,
  type SettingsValue,
} from "./driveData.ts";
import { settingsReadBackDone } from "./backupFlags.ts";
import { DESKTOP_REGISTRY, SettingsSyncStore, type Registry } from "./settingsSync.ts";
import { initStore, setDataKey, wipeCache } from "./store.ts";

beforeAll(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-settings-sync-")));
  setDataKey(randomBytes(32));
});

const PC = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PC2 = "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee";
const PHONE = "11111111-2222-3333-4444-555555555555";

/** The desktop's registry and one set-shaped setting, as the phone has them. */
const WITH_SET: Registry = {
  ...DESKTOP_REGISTRY,
  sets: [{ id: "timeline.excludedAlbums", scope: "shared" }],
};

const copy = (
  deviceId: string,
  platform: string,
  scalars: [string, SettingsValue, number][] = [],
  elements: [string, string, boolean, number][] = [],
): SettingsCopy => ({
  deviceId,
  platform,
  deviceLabel: deviceId,
  createdAt: 1,
  scalars: scalars.map(([key, value, changedAt]) => ({ key, value, changedAt })),
  elements: elements.map(([key, element, present, changedAt]) => ({ key, element, present, changedAt })),
});

const valueOf = (store: SettingsSyncStore, id: string): SettingsValue | undefined =>
  store.forDrive(PC, "PC", 1).scalars.find((s) => s.key === id)?.value;

describe("putting settings from Drive together with this computer's", () => {
  it("takes a newer remote value", () => {
    const store = new SettingsSyncStore(false);
    store.stamp([{ id: "appearance.theme", x: "dark" }], PC, 100);
    expect(store.takeIn(copy(PHONE, "android", [["appearance.theme", "light", 200]]))).toEqual(["appearance.theme"]);
    expect(valueOf(store, "appearance.theme")).toBe("light");
  });

  it("keeps a newer local value over an older remote one", () => {
    const store = new SettingsSyncStore(false);
    store.stamp([{ id: "appearance.theme", x: "dark" }], PC, 300);
    expect(store.takeIn(copy(PHONE, "android", [["appearance.theme", "light", 200]]))).toBeNull();
    expect(valueOf(store, "appearance.theme")).toBe("dark");
  });

  it("settles an equal time by the larger device id, from either side", () => {
    const low = new SettingsSyncStore(false);
    low.stamp([{ id: "appearance.palette", x: "forest" }], PHONE, 100);
    low.takeIn(copy(PC, "android", [["appearance.palette", "sea", 100]]));
    expect(valueOf(low, "appearance.palette")).toBe("sea");

    const high = new SettingsSyncStore(false);
    high.stamp([{ id: "appearance.palette", x: "forest" }], PC, 100);
    expect(high.takeIn(copy(PHONE, "android", [["appearance.palette", "sea", 100]]))).toBeNull();
    expect(valueOf(high, "appearance.palette")).toBe("forest");
  });

  it("fills a value that was never set with any time, and lets a later choice beat a time of 0", () => {
    const store = new SettingsSyncStore(false);
    store.takeIn(copy(PHONE, "android", [["appearance.amoled", true, 0]]));
    expect(valueOf(store, "appearance.amoled")).toBe(true);
    store.stamp([{ id: "appearance.amoled", x: false }], PC, 50);
    store.takeIn(copy(PHONE, "android", [["appearance.amoled", true, 0]]));
    expect(valueOf(store, "appearance.amoled")).toBe(false);
  });

  it("takes a null as a reset to the default, with its time", () => {
    const store = new SettingsSyncStore(false);
    store.stamp([{ id: "appearance.theme", x: "dark" }], PC, 100);
    store.takeIn(copy(PHONE, "android", [["appearance.theme", null, 200]]));
    expect(valueOf(store, "appearance.theme")).toBeNull();
    expect(store.pending()).toEqual([{ id: "appearance.theme", x: null, t: 200 }]);
    // An older value does not undo the reset.
    store.takeIn(copy(PC2, "android", [["appearance.theme", "light", 150]]));
    expect(valueOf(store, "appearance.theme")).toBeNull();
  });

  it("merges a set member added on two devices, and lets a later removal win", () => {
    const store = new SettingsSyncStore(false, WITH_SET);
    store.takeIn(copy(PHONE, "android", [], [["timeline.excludedAlbums", "album-a", true, 10]]));
    store.takeIn(copy(PC2, "desktop", [], [["timeline.excludedAlbums", "album-b", true, 20]]));
    expect(store.members("timeline.excludedAlbums").sort()).toEqual(["album-a", "album-b"]);
    store.takeIn(copy(PHONE, "android", [], [["timeline.excludedAlbums", "album-a", false, 30]]));
    expect(store.members("timeline.excludedAlbums")).toEqual(["album-b"]);
    // The removal is kept with its time, so an older add does not bring it back.
    store.takeIn(copy(PC2, "desktop", [], [["timeline.excludedAlbums", "album-a", true, 25]]));
    expect(store.members("timeline.excludedAlbums")).toEqual(["album-b"]);
    const out = store.forDrive(PC, "PC", 1).elements;
    expect(out).toEqual([
      { key: "timeline.excludedAlbums", element: "album-a", present: false, changedAt: 30 },
      { key: "timeline.excludedAlbums", element: "album-b", present: true, changedAt: 20 },
    ]);
  });

  it("ignores a platform setting from another PC", () => {
    const store = new SettingsSyncStore(false);
    expect(store.takeIn(copy(PC2, "desktop", [["appearance.language", "hu", 100], ["upload.compressPhotos", true, 100]]), PC)).toBeNull();
    expect(valueOf(store, "appearance.language")).toBeUndefined();
    expect(valueOf(store, "upload.compressPhotos")).toBeUndefined();
  });

  it("takes a platform setting from this install's own copy", () => {
    const store = new SettingsSyncStore(false);
    store.takeIn(copy(PC, "desktop", [["appearance.language", "hu", 100], ["upload.compressPhotos", true, 100]]), PC);
    expect(valueOf(store, "appearance.language")).toBe("hu");
    expect(valueOf(store, "upload.compressPhotos")).toBe(true);
  });

  it("takes a shared setting from another PC", () => {
    const store = new SettingsSyncStore(false);
    store.takeIn(copy(PC2, "desktop", [["appearance.theme", "dark", 100]]), PC);
    expect(valueOf(store, "appearance.theme")).toBe("dark");
  });

  it("ignores a platform setting from an android copy, and takes the shared one", () => {
    const store = new SettingsSyncStore(false);
    store.takeIn(
      copy(PHONE, "android", [["appearance.language", "de", 100], ["upload.compressPhotos", true, 100], ["appearance.theme", "light", 100]]),
      PC,
    );
    expect(valueOf(store, "appearance.language")).toBeUndefined();
    expect(valueOf(store, "upload.compressPhotos")).toBeUndefined();
    expect(valueOf(store, "appearance.theme")).toBe("light");
  });

  it("restores the own platform settings in a read-back round once seeded, not before", () => {
    const own = copy(PC, "desktop", [["appearance.language", "hu", 100]]);
    // A round with the store unseeded or the backup off takes nothing in: the flag stays open.
    expect(settingsReadBackDone(true, false, 0)).toBe(false);
    const store = new SettingsSyncStore(false);
    store.seed([], PC);
    expect(store.takeIn(own, PC)).toEqual(["appearance.language"]);
    expect(valueOf(store, "appearance.language")).toBe("hu");
    expect(settingsReadBackDone(true, true, 0)).toBe(true);
  });

  it("ignores an id it does not know and a value the id does not allow", () => {
    const store = new SettingsSyncStore(false);
    expect(
      store.takeIn(
        copy(PHONE, "android", [
          ["android.clockFormat", "24h", 100],
          ["appearance.theme", "purple", 100],
          ["appearance.amoled", "yes", 100],
          ["appearance.palette", "amoled", 100],
          ["appearance.language", "system", 100],
          ["upload.compressTier", 2, 100],
        ]),
      ),
    ).toBeNull();
    expect(store.hasStamps()).toBe(false);
    expect(store.forDrive(PC, "PC", 1).scalars).toEqual([]);
  });

  it("passes over a file of another version", () => {
    expect(() => readSettingsCopy(Buffer.from(JSON.stringify({ v: 2, d: PHONE, p: "android", s: [], l: [] })))).toThrow();
  });

  it("does not take the same copy in twice, and reports a newer time on the same value as no change to show", () => {
    const store = new SettingsSyncStore(false);
    const first = copy(PHONE, "android", [["appearance.theme", "light", 100]]);
    expect(store.takeIn(first)).toEqual(["appearance.theme"]);
    expect(store.takeIn(first)).toBeNull();
    store.acknowledge(store.pending());
    store.takeIn(copy(PHONE, "android", [["appearance.theme", "light", 120]]));
    expect(store.pending()).toEqual([]);
    expect(store.forDrive(PC, "PC", 1).scalars[0].changedAt).toBe(120);
  });

  it("brings two devices to the same values once each has taken in the other's copy through Drive", () => {
    const a = new SettingsSyncStore(false);
    const b = new SettingsSyncStore(false);
    a.stamp([{ id: "appearance.theme", x: "dark" }, { id: "appearance.palette", x: "sea" }], PC, 10);
    b.stamp([{ id: "appearance.theme", x: "light" }, { id: "appearance.amoled", x: true }], PHONE, 20);
    const through = (store: SettingsSyncStore, id: string) =>
      readSettingsCopy(writeSettingsCopy(store.forDrive(id, id, 1)));
    a.takeIn(through(b, PHONE));
    b.takeIn(through(a, PC));
    const view = (s: SettingsSyncStore) => s.forDrive("x", "x", 0).scalars;
    expect(view(a)).toEqual(view(b));
    expect(valueOf(a, "appearance.theme")).toBe("light");
    expect(valueOf(a, "appearance.palette")).toBe("sea");
    expect(valueOf(a, "appearance.amoled")).toBe(true);
  });
});

describe("what this computer stamps", () => {
  it("stamps a user's choice now, and passes over an id or value outside the list", () => {
    const store = new SettingsSyncStore(false);
    expect(
      store.stamp(
        [
          { id: "appearance.theme", x: "dark" },
          { id: "app.lock", x: true },
          { id: "upload.compressTier", x: "huge" },
        ],
        PC,
        100,
      ),
    ).toBe(true);
    expect(store.forDrive(PC, "PC", 1).scalars).toEqual([{ key: "appearance.theme", value: "dark", changedAt: 100 }]);
    expect(store.stamp([{ id: "nothing", x: 1 }], PC, 200)).toBe(false);
  });

  it("stamps the choices made before the feature once, at 0, and beats nothing chosen since", () => {
    const store = new SettingsSyncStore(false);
    expect(store.isSeeded()).toBe(false);
    store.stamp([{ id: "appearance.theme", x: "light" }], PC, 500);
    expect(
      store.seed(
        [
          { id: "appearance.theme", x: "dark" },
          { id: "appearance.palette", x: "forest" },
          { id: "unknown.id", x: true },
        ],
        PC,
      ),
    ).toBe(true);
    expect(store.forDrive(PC, "PC", 1).scalars).toEqual([
      { key: "appearance.palette", value: "forest", changedAt: 0 },
      { key: "appearance.theme", value: "light", changedAt: 500 },
    ]);
    expect(store.isSeeded()).toBe(true);
    // Seeded already: a setting not stamped yet, such as one a newer build syncs, is stamped at 0
    // the first time it is reported; one stamped stays as it is.
    expect(store.seed([{ id: "appearance.palette", x: "mint" }], PC)).toBe(false);
    expect(store.seed([{ id: "appearance.amoled", x: true }], PC)).toBe(true);
    expect(store.forDrive(PC, "PC", 1).scalars).toContainEqual({ key: "appearance.amoled", value: true, changedAt: 0 });
    expect(valueOf(store, "appearance.palette")).toBe("forest");
  });

  it("syncs the album list's sort and arrangement with every device", () => {
    const store = new SettingsSyncStore(false);
    store.seed([], PC);
    const phone = {
      deviceId: "phone",
      platform: "android",
      deviceLabel: "Pixel",
      createdAt: 1,
      scalars: [
        { key: "albums.sortMode", value: "custom", changedAt: 9 },
        { key: "albums.order", value: ["b", "a"], changedAt: 9 },
      ],
      elements: [],
    };
    expect(store.takeIn(phone, PC)?.sort()).toEqual(["albums.order", "albums.sortMode"]);
    expect(valueOf(store, "albums.order")).toEqual(["b", "a"]);
    const bad = { ...phone, scalars: [{ key: "albums.order", value: ["a|b"], changedAt: 20 }, { key: "albums.sortMode", value: "size", changedAt: 20 }] };
    expect(store.takeIn(bad, PC)).toBeNull();
  });

  it("writes nothing for a computer that stamped nothing", () => {
    const store = new SettingsSyncStore(false);
    expect(store.hasStamps()).toBe(false);
    store.seed([], PC);
    expect(store.hasStamps()).toBe(false);
  });

  it("does not echo a value it took in: it keeps the remote time and is not stamped as new", () => {
    const store = new SettingsSyncStore(false);
    store.takeIn(copy(PHONE, "android", [["appearance.theme", "light", 100]]));
    expect(store.forDrive(PC, "PC", 9).scalars).toEqual([{ key: "appearance.theme", value: "light", changedAt: 100 }]);
  });

  it("hands the window what was taken in until it has shown it, and keeps one taken in since", () => {
    const store = new SettingsSyncStore(false);
    store.takeIn(copy(PHONE, "android", [["appearance.theme", "light", 100]]));
    const [first] = store.pending();
    expect(first).toEqual({ id: "appearance.theme", x: "light", t: 100 });
    const v = store.version;
    store.takeIn(copy(PHONE, "android", [["appearance.theme", "dark", 200]]));
    store.acknowledge([{ id: "appearance.theme", t: first.t }]);
    expect(store.pending()).toEqual([{ id: "appearance.theme", x: "dark", t: 200 }]);
    store.acknowledge([{ id: "appearance.theme", t: 200 }]);
    expect(store.pending()).toEqual([]);
    expect(store.version).toBe(v + 1);
    // A choice made here is not handed back.
    store.takeIn(copy(PHONE, "android", [["appearance.palette", "sea", 300]]));
    store.stamp([{ id: "appearance.palette", x: "rose" }], PC, 400);
    expect(store.pending()).toEqual([]);
  });

  it("moves its version on every change, so the window knows to save again", () => {
    const store = new SettingsSyncStore(false);
    const v = store.version;
    store.stamp([{ id: "appearance.amoled", x: true }], PC, 1);
    expect(store.version).toBe(v + 1);
  });

  it("keeps the stamps sealed across a restart and drops them at sign-out", () => {
    const first = new SettingsSyncStore(true);
    first.seed([{ id: "appearance.palette", x: "mint" }], PC);
    first.stamp([{ id: "appearance.theme", x: "light" }], PC, 100);
    first.takeIn(copy(PHONE, "android", [["albums.hidePhotosInAlbums", true, 200]]));
    const second = new SettingsSyncStore(true);
    expect(second.isSeeded()).toBe(true);
    expect(second.forDrive(PC, "PC", 1).scalars).toEqual([
      { key: "albums.hidePhotosInAlbums", value: true, changedAt: 200 },
      { key: "appearance.palette", value: "mint", changedAt: 0 },
      { key: "appearance.theme", value: "light", changedAt: 100 },
    ]);
    expect(second.pending()).toEqual([{ id: "albums.hidePhotosInAlbums", x: true, t: 200 }]);
    wipeCache();
    const third = new SettingsSyncStore(true);
    expect(third.isSeeded()).toBe(false);
    expect(third.hasStamps()).toBe(false);
  });
});

describe("the settings file on Drive", () => {
  it("is one file per device, JSON v1 with the platform, each setting's value and time, and set members", () => {
    expect(settingsFileName(PC)).toBe(`settings-${PC}.pfpst`);
    expect(settingsFileDevice(`settings-${PC}.pfpst`)).toBe(PC);
    expect(settingsFileDevice(`hidden-${PC}.pfphd`)).toBeNull();
    expect(() => settingsFileName("not-an-id")).toThrow();
    const store = new SettingsSyncStore(false, WITH_SET);
    store.stamp([{ id: "appearance.theme", x: "dark" }], PC, 10);
    store.takeIn(copy(PHONE, "android", [], [["timeline.excludedAlbums", "a1", true, 7]]));
    const json = JSON.parse(writeSettingsCopy(store.forDrive(PC, "PC", 99)).toString("utf8"));
    expect(json).toEqual({
      v: 1,
      d: PC,
      p: "desktop",
      n: "PC",
      c: 99,
      s: [{ k: "appearance.theme", t: 10, x: "dark" }],
      l: [{ k: "timeline.excludedAlbums", e: "a1", h: true, t: 7 }],
    });
  });

  it("is read defensively: no value of another shape, no member without a state, a missing time as 0", () => {
    const plain = Buffer.from(
      JSON.stringify({
        v: 1,
        d: PHONE,
        p: "android",
        n: "Phone",
        c: 5,
        s: [
          { k: "appearance.theme", x: "dark" },
          { k: "appearance.amoled", t: 3, x: { nested: true } },
          { k: "android.landingTab", t: 4, x: 2 },
          { k: "appearance.palette", t: 5, x: null },
          { t: 6, x: true },
          { k: "android.rail.order", t: 7, x: ["a", "b"] },
        ],
        l: [{ k: "timeline.excludedAlbums", e: "a1", h: true, t: 1 }, { k: "timeline.excludedAlbums", e: "a2" }],
      }),
    );
    const read = readSettingsCopy(plain);
    expect(read.platform).toBe("android");
    expect(read.scalars).toEqual([
      { key: "appearance.theme", value: "dark", changedAt: 0 },
      { key: "android.landingTab", value: 2, changedAt: 4 },
      { key: "appearance.palette", value: null, changedAt: 5 },
      { key: "android.rail.order", value: ["a", "b"], changedAt: 7 },
    ]);
    expect(read.elements).toEqual([{ key: "timeline.excludedAlbums", element: "a1", present: true, changedAt: 1 }]);
  });

  it("takes in a copy read from a file the way it was written", () => {
    const phone = new SettingsSyncStore(false);
    phone.stamp([{ id: "appearance.theme", x: "light" }, { id: "appearance.language", x: "de" }], PHONE, 100);
    const pc = new SettingsSyncStore(false);
    // The phone's id is a platform "desktop" here only because this store is the PC's registry.
    pc.takeIn(readSettingsCopy(writeSettingsCopy({ ...phone.forDrive(PHONE, "Phone", 1), platform: "android" })));
    expect(valueOf(pc, "appearance.theme")).toBe("light");
    expect(valueOf(pc, "appearance.language")).toBeUndefined();
  });
});
