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

import { readHiddenCopy, writeHiddenCopy, hiddenFileDevice, hiddenFileName } from "./driveData.ts";
import { HiddenStore, linkOf } from "./hidden.ts";
import { initStore, setDataKey, wipeCache } from "./store.ts";

beforeAll(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-hidden-")));
  setDataKey(randomBytes(32));
});

describe("hidden photos and albums", () => {
  it("keys every photo and album by its Drive link id, as the phone does", () => {
    expect(linkOf("vol==~link-a")).toBe("link-a");
    expect(linkOf("link-a")).toBe("link-a");
    const store = new HiddenStore(false);
    store.set("photos", ["vol~p1", "vol~p2"], true);
    expect(store.snapshot().photos.sort()).toEqual(["p1", "p2"]);
    const hidden = store.hiddenPhotoTest();
    expect(hidden("vol~p1")).toBe(true);
    expect(hidden("other~p1")).toBe(true);
    expect(hidden("vol~p3")).toBe(false);
  });

  it("hides an album's photos with it, and shows them again with it", () => {
    const store = new HiddenStore(false);
    store.set("albums", ["vol~a1"], true, 1, new Map([["vol~a1", ["vol~x", "vol~y"]]]));
    expect(store.snapshot()).toMatchObject({ albums: ["vol~a1"], albumPhotos: ["vol~x", "vol~y"] });
    expect(store.hiddenPhotoTest()("vol~x")).toBe(true);
    expect(store.isHiddenAlbum("vol~a1")).toBe(true);
    store.setMembers("vol~a1", ["vol~x", "vol~z"]);
    expect(store.hiddenPhotoTest()("vol~y")).toBe(false);
    expect(store.hiddenPhotoTest()("vol~z")).toBe(true);
    store.set("albums", ["vol~a1"], false, 2);
    expect(store.snapshot()).toMatchObject({ albums: [], albumPhotos: [] });
    expect(store.hiddenPhotoTest()("vol~z")).toBe(false);
  });

  it("hides a photo put into a hidden album at once, without a restart", () => {
    const store = new HiddenStore(false);
    store.set("albums", ["vol~a1"], true, 1, new Map([["vol~a1", ["vol~x"]]]));
    const v = store.version;
    store.addMembers("vol~a1", ["vol~new", "vol~x"]);
    expect(store.hiddenPhotoTest()("vol~new")).toBe(true);
    expect(store.snapshot().albumPhotos).toEqual(["vol~x", "vol~new"]);
    expect(store.version).toBe(v + 1);
    store.addMembers("vol~a2", ["vol~other"]);
    expect(store.hiddenPhotoTest()("vol~other")).toBe(false);
  });

  it("does not take in the photos of an album that is not hidden", () => {
    const store = new HiddenStore(false);
    store.setMembers("vol~a9", ["vol~x"]);
    expect(store.hiddenPhotoTest()("vol~x")).toBe(false);
  });

  it("keeps the list sealed across a restart, with when each changed", () => {
    const first = new HiddenStore(true);
    first.set("photos", ["vol~p1", "vol~p2"], true, 100);
    first.set("photos", ["vol~p2"], false, 200);
    first.set("albums", ["vol~a1"], true, 300, new Map([["vol~a1", ["vol~m"]]]));
    const second = new HiddenStore(true);
    expect(second.snapshot()).toMatchObject({ photos: ["p1"], albums: ["vol~a1"], albumPhotos: ["vol~m"] });
    wipeCache();
    expect(new HiddenStore(true).snapshot()).toMatchObject({ photos: [], albums: [] });
  });

  it("moves its version on every change, so the window knows to read it again", () => {
    const store = new HiddenStore(false);
    const v = store.version;
    store.set("photos", ["vol~p1"], true);
    expect(store.version).toBe(v + 1);
  });
});

describe("the hidden list on Drive", () => {
  const PHONE = "11111111-2222-3333-4444-555555555555";
  const PC = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("is one file per device, JSON v1 with a link id, hidden or not, and a time per entry", () => {
    expect(hiddenFileName(PC)).toBe(`hidden-${PC}.pfphd`);
    expect(hiddenFileDevice(`hidden-${PC}.pfphd`)).toBe(PC);
    expect(hiddenFileDevice(`labels-${PC}.pfplb`)).toBeNull();
    const store = new HiddenStore(false);
    store.set("photos", ["vol~p1"], true, 10);
    store.set("photos", ["vol~p2"], true, 11);
    store.set("photos", ["vol~p2"], false, 12);
    store.set("albums", ["vol~a1"], true, 13);
    const json = JSON.parse(writeHiddenCopy(store.forDrive(PC, "PC", 99)).toString("utf8"));
    expect(json).toEqual({
      v: 1,
      d: PC,
      n: "PC",
      c: 99,
      p: [
        { k: "p1", h: true, t: 10 },
        { k: "p2", h: false, t: 12 },
      ],
      a: [{ k: "a1", h: true, t: 13 }],
    });
  });

  it("reads a copy defensively: no device keys, no entries without a state, a missing time as 0", () => {
    const plain = Buffer.from(
      JSON.stringify({ v: 1, d: PHONE, n: "Phone", c: 5, p: [{ k: "p1", h: true }, { k: "content://x", h: true, t: 1 }, { k: "p2" }], a: [] }),
    );
    expect(readHiddenCopy(plain).photos).toEqual([{ key: "p1", hidden: true, changedAt: 0 }]);
    expect(() => readHiddenCopy(Buffer.from(JSON.stringify({ v: 2, p: [], a: [] })))).toThrow();
  });

  it("takes in the later change to each photo and album, and leaves a later local one", () => {
    const pc = new HiddenStore(false);
    pc.set("photos", ["vol~mine"], true, 100);
    pc.set("photos", ["vol~both"], true, 100);
    const newAlbums = pc.takeIn({
      deviceId: PHONE,
      deviceLabel: "Phone",
      createdAt: 1,
      photos: [
        { key: "theirs", hidden: true, changedAt: 50 },
        { key: "both", hidden: false, changedAt: 200 },
        { key: "mine", hidden: false, changedAt: 50 },
      ],
      albums: [{ key: "album", hidden: true, changedAt: 60 }],
    });
    expect(newAlbums).toEqual(["album"]);
    const hidden = pc.hiddenPhotoTest();
    expect(hidden("vol~theirs")).toBe(true);
    expect(hidden("vol~both")).toBe(false);
    expect(hidden("vol~mine")).toBe(true);
    expect(pc.isHiddenAlbum("vol~album")).toBe(true);
    // The same copy again changes nothing.
    expect(pc.takeIn({ deviceId: PHONE, deviceLabel: "Phone", createdAt: 1, photos: [{ key: "theirs", hidden: true, changedAt: 50 }], albums: [] })).toBeNull();
  });

  it("brings two devices to the same list once each has taken in the other's copy through Drive", () => {
    const phone = new HiddenStore(false);
    const pc = new HiddenStore(false);
    phone.set("photos", ["v~a", "v~b"], true, 10);
    pc.set("photos", ["v~b"], false, 20);
    pc.set("photos", ["v~c"], true, 30);
    pc.set("albums", ["v~x"], true, 31);
    phone.set("albums", ["v~x"], false, 40);
    const through = (store: HiddenStore, id: string) => readHiddenCopy(writeHiddenCopy(store.forDrive(id, id, 1)));
    pc.takeIn(through(phone, PHONE));
    phone.takeIn(through(pc, PC));
    const sorted = (st: HiddenStore) => ({ ...st.snapshot(), photos: [...st.snapshot().photos].sort(), version: 0 });
    expect(sorted(phone)).toEqual(sorted(pc));
    expect(sorted(pc).photos).toEqual(["a", "c"]);
    expect(pc.isHiddenAlbum("v~x")).toBe(false);
  });
});
