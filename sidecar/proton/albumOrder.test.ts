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

// The same cases as the phone's album-order tests, so both apps read, merge and write the
// album-order copy alike.

import "@protontech/crypto/polyfill";
import { beforeAll, describe, expect, it } from "vitest";

import { CryptoProxy, initCrypto } from "./crypto.ts";
import {
  albumOrderFileDevice,
  albumOrderFileName,
  openEnvelope,
  readAlbumOrderCopy,
  sealEnvelope,
  writeAlbumOrderCopy,
  type AlbumOrderCopy,
  type AlbumOrderEntry,
} from "./driveData.ts";
import { AlbumOrderStore, albumOrderForDrive, takeInAlbumOrder, type AlbumOrderState } from "./albumOrder.ts";

const DEVICE_A = "0b5f3c2e-1111-4a4a-9c9c-123456789abc";
const DEVICE_B = "1b5f3c2e-2222-4a4a-9c9c-123456789abc";
const DEVICE_C = "2b5f3c2e-3333-4a4a-9c9c-123456789abc";

const entry = (key: string, mode?: AlbumOrderEntry["mode"], modeAt?: number, order?: string[], orderAt?: number): AlbumOrderEntry => {
  const e: AlbumOrderEntry = { key };
  if (mode !== undefined) e.mode = mode;
  if (modeAt !== undefined) e.modeAt = modeAt;
  if (order !== undefined) e.order = order;
  if (orderAt !== undefined) e.orderAt = orderAt;
  return e;
};
const copy = (device: string, ...albums: AlbumOrderEntry[]): AlbumOrderCopy => ({
  deviceId: device,
  platform: "android",
  deviceLabel: "Phone",
  createdAt: 5,
  albums,
});
const state = (modes: AlbumOrderState["modes"] = {}, orders: AlbumOrderState["orders"] = {}): AlbumOrderState => ({ modes, orders });

describe("the file format", () => {
  it("carries the short field names and leaves an absent half out", () => {
    const snapshot = copy(DEVICE_A, entry("album1", "custom", 10, ["p2", "p1"], 11), entry("album2", "oldest", 12));
    const text = writeAlbumOrderCopy(snapshot).toString("utf8");
    expect(text).toBe(
      `{"v":1,"d":"${DEVICE_A}","p":"android","n":"Phone","c":5,"a":[` +
        `{"k":"album1","m":"custom","mt":10,"o":["p2","p1"],"ot":11},{"k":"album2","m":"oldest","mt":12}]}`,
    );
    expect(readAlbumOrderCopy(Buffer.from(text))).toEqual(snapshot);
  });

  it("passes over a newer format version and refuses what is not one", () => {
    expect(readAlbumOrderCopy(Buffer.from(`{"v":2,"d":"x","n":"x","c":1,"a":[]}`))).toBeNull();
    expect(() => readAlbumOrderCopy(Buffer.from("not json"))).toThrow();
    expect(() => readAlbumOrderCopy(Buffer.from(`{"v":1,"a":[]}`))).toThrow();
    expect(() => readAlbumOrderCopy(Buffer.from("null"))).toThrow();
    expect(readAlbumOrderCopy(Buffer.from(`{"d":"x","n":"x","c":1}`))).toEqual({ deviceId: "x", platform: "", deviceLabel: "x", createdAt: 1, albums: [] });
  });

  it("drops a broken half, blank and repeated ids, and an entry with nothing left", () => {
    const text = `{"v":1,"d":"x","n":"x","c":1,"extra":true,"a":[
      {"k":"a","m":"sideways","mt":1,"o":["p1","","p1","p2"],"ot":2},
      {"k":"b","m":"newest"},
      {"k":"","m":"newest","mt":3},
      {"k":"c","o":["p1"]}
    ]}`;
    expect(readAlbumOrderCopy(Buffer.from(text))!.albums).toEqual([entry("a", undefined, undefined, ["p1", "p2"], 2)]);
  });

  it("reads a negative time as 0", () => {
    const text = `{"v":1,"d":"x","n":"x","c":1,"a":[{"k":"a","m":"oldest","mt":-4}]}`;
    expect(readAlbumOrderCopy(Buffer.from(text))!.albums).toEqual([entry("a", "oldest", 0)]);
  });

  it("names the file by the install id", () => {
    const name = albumOrderFileName(DEVICE_A);
    expect(name).toBe(`album-order-${DEVICE_A}.pfpao`);
    expect(albumOrderFileDevice(name)).toBe(DEVICE_A);
    expect(albumOrderFileDevice(`labels-${DEVICE_A}.pfplb`)).toBeNull();
    expect(albumOrderFileDevice("album-order-nope.pfpao")).toBeNull();
    expect(() => albumOrderFileName("nope")).toThrow();
  });
});

describe("the merge", () => {
  it("takes the later time for the mode and the order each on their own", () => {
    // Here the mode is newer and the order older than the copy's: the copy brings its order, not its mode.
    const held = state({ album: { m: "oldest", t: 20 } }, { album: { o: ["p1", "p2"], t: 5 } });
    const changed = takeInAlbumOrder(held, copy(DEVICE_B, entry("album", "custom", 10, ["p2", "p1"], 15)), DEVICE_A, DEVICE_A);
    expect(held.modes.album).toEqual({ m: "oldest", t: 20 });
    expect(held.orders.album).toEqual({ o: ["p2", "p1"], t: 15 });
    expect(changed).toEqual(["album"]);
  });

  it("gives an equal time to the larger device id, and only when the value differs", () => {
    const e = entry("album", "custom", 10);
    const fromLarger = state({ album: { m: "newest", t: 10 } });
    takeInAlbumOrder(fromLarger, copy(DEVICE_B, e), DEVICE_A, DEVICE_A);
    expect(fromLarger.modes.album.m).toBe("custom");

    const fromSmaller = state({ album: { m: "newest", t: 10 } });
    takeInAlbumOrder(fromSmaller, copy(DEVICE_A, e), DEVICE_B, DEVICE_B);
    expect(fromSmaller.modes.album.m).toBe("newest");

    const same = state({ album: { m: "custom", t: 10 } });
    expect(takeInAlbumOrder(same, copy(DEVICE_B, e), DEVICE_A, DEVICE_A)).toEqual([]);
  });

  it("lets time zero only fill a gap", () => {
    const held = state({ a: { m: "oldest", t: 0 } });
    takeInAlbumOrder(held, copy(DEVICE_A, entry("a", "newest", 0), entry("b", "oldest", 0)), DEVICE_B, DEVICE_B);
    expect(held.modes.a.m).toBe("oldest");
    expect(held.modes.b).toEqual({ m: "oldest", t: 0 });
  });

  it("passes over the install's own copy unless it reads as an earlier install", () => {
    const incoming = copy(DEVICE_A, entry("album", "custom", 10));
    expect(takeInAlbumOrder(state(), incoming, DEVICE_A, DEVICE_A)).toEqual([]);
    const restored = state();
    takeInAlbumOrder(restored, incoming, "", DEVICE_A);
    expect(restored.modes.album).toEqual({ m: "custom", t: 10 });
  });

  it("merges two devices' files to the same state in either order, and taking one twice changes nothing", () => {
    const fromA = copy(DEVICE_A, entry("x", "custom", 30, ["1", "2", "3"], 30), entry("y", "oldest", 5));
    const fromB = copy(DEVICE_B, entry("x", "newest", 40, ["3", "2", "1"], 20), entry("y", "newest", 6));
    const one = state();
    takeInAlbumOrder(one, fromA, DEVICE_C, DEVICE_C);
    takeInAlbumOrder(one, fromB, DEVICE_C, DEVICE_C);
    const other = state();
    takeInAlbumOrder(other, fromB, DEVICE_C, DEVICE_C);
    takeInAlbumOrder(other, fromA, DEVICE_C, DEVICE_C);
    expect(one).toEqual(other);
    expect(one.modes.x).toEqual({ m: "newest", t: 40 });
    expect(one.orders.x).toEqual({ o: ["1", "2", "3"], t: 30 });
    expect(one.modes.y).toEqual({ m: "newest", t: 6 });
    expect(takeInAlbumOrder(one, fromA, DEVICE_C, DEVICE_C)).toEqual([]);
  });

  it("sorts the Drive copy by album and leaves out an album the listing no longer has", () => {
    const held = state({ zeta: { m: "oldest", t: 1 }, gone: { m: "custom", t: 2 } }, { alpha: { o: ["p"], t: 3 } });
    const snapshot = albumOrderForDrive(held, DEVICE_A, "PC", 9, new Set(["alpha", "zeta"]));
    expect(snapshot.albums).toEqual([entry("alpha", undefined, undefined, ["p"], 3), entry("zeta", "oldest", 1)]);
    expect(snapshot.platform).toBe("desktop");
    expect(albumOrderForDrive(held, DEVICE_A, "PC", 9).albums.length).toBe(3);
  });
});

describe("the round trip", () => {
  let key: any;
  let otherKey: any;
  beforeAll(async () => {
    initCrypto();
    key = await CryptoProxy.generateKey({ userIDs: [{ name: "Owner", email: "owner@example.com" }] } as any);
    otherKey = await CryptoProxy.generateKey({ userIDs: [{ name: "Other", email: "other@example.com" }] } as any);
  }, 30_000);

  it("brings an order arranged on one device to another, sealed", async () => {
    const onA = state({ x: { m: "custom", t: 100 } }, { x: { o: ["p3", "p1", "p2"], t: 100 } });
    const sealed = await sealEnvelope(writeAlbumOrderCopy(albumOrderForDrive(onA, DEVICE_A, "A", 101)), key, key, 64);
    const opened = await openEnvelope(sealed, [key], [key]);
    expect(opened.ok).toBe(true);
    const onB = state({ x: { m: "newest", t: 50 } });
    const read = readAlbumOrderCopy((opened as { ok: true; plain: Buffer }).plain)!;
    expect(takeInAlbumOrder(onB, read, DEVICE_B, DEVICE_B)).toEqual(["x"]);
    expect(onB.modes.x.m).toBe("custom");
    expect(onB.orders.x.o).toEqual(["p3", "p1", "p2"]);
  }, 30_000);

  it("does not open with another account's key", async () => {
    const sealed = await sealEnvelope(writeAlbumOrderCopy(copy(DEVICE_A, entry("x", "oldest", 1))), key, key, 64);
    const opened = await openEnvelope(sealed, [otherKey], [otherKey]);
    expect(opened.ok).toBe(false);
  }, 30_000);
});

describe("the store", () => {
  it("saves a hand-made order by link id and switches the album to it", () => {
    const store = new AlbumOrderStore(false);
    expect(store.isEmpty()).toBe(true);
    store.saveCustom("vol~album", ["vol~p2", "p1", "p2", ""], 7);
    expect(store.view("album")).toMatchObject({ mode: "custom", order: ["p2", "p1"] });
    expect(store.forDrive(DEVICE_A, "PC", 9).albums).toEqual([entry("album", "custom", 7, ["p2", "p1"], 7)]);
  });

  it("keeps the order when another mode is picked, so Custom brings it back", () => {
    const store = new AlbumOrderStore(false);
    store.saveCustom("album", ["b", "a"], 7);
    store.setMode("vol~album", "oldest", 8);
    expect(store.view("album")).toMatchObject({ mode: "oldest", order: ["b", "a"] });
  });

  it("takes over the old per-album choices once, at time 0, keeping a mode chosen since", () => {
    const store = new AlbumOrderStore(false);
    store.setMode("kept", "newest", 3);
    expect(store.seed({ "vol~old": "oldest", "vol~kept": "oldest", bad: "sideways" })).toBe(true);
    expect(store.forDrive(DEVICE_A, "PC", 1).albums).toEqual([entry("kept", "newest", 3), entry("old", "oldest", 0)]);
    expect(store.seed({ "vol~later": "oldest" })).toBe(false);
    expect(store.view("later").mode).toBeNull();
  });

  it("moves its version on every change a copy would show", () => {
    const store = new AlbumOrderStore(false);
    const before = store.version;
    expect(store.takeIn(copy(DEVICE_B, entry("x", "oldest", 4)), DEVICE_A, DEVICE_A)).toBe(true);
    expect(store.version).toBeGreaterThan(before);
    const after = store.version;
    expect(store.takeIn(copy(DEVICE_B, entry("x", "oldest", 4)), DEVICE_A, DEVICE_A)).toBe(false);
    expect(store.version).toBe(after);
  });
});
