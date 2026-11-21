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

import { describe, expect, it } from "vitest";
import {
  dragTo,
  forSave,
  gather,
  moveAfter,
  moveBefore,
  moveOnto,
  moveToEnd,
  moveToStart,
  newestOf,
  nudge,
  nudgeBlock,
  orderPhotos,
  readAlbumLayout,
  readAlbumOrder,
  readAlbumSort,
  readPhotoOrders,
  sortAlbums,
  viewerIndexAfterRemoval,
} from "./albumView";

const a = (uid: string, name: string, photoCount: number, lastActivityTime: number) => ({
  uid,
  name,
  photoCount,
  lastActivityTime,
});
const albums = [a("1", "Beach", 5, 100), a("2", "alps", 20, 300), a("3", "City 10", 1, 200), a("4", "City 2", 1, 200)];
const ids = (list: { uid: string }[]) => list.map((x) => x.uid);

describe("sortAlbums", () => {
  it("orders by last activity, name (natural), and count", () => {
    expect(ids(sortAlbums(albums, "activity"))).toEqual(["2", "3", "4", "1"]);
    expect(ids(sortAlbums(albums, "name"))).toEqual(["2", "1", "4", "3"]);
    expect(ids(sortAlbums(albums, "count"))).toEqual(["2", "1", "3", "4"]);
  });
  it("orders by newest photo, the unread ones after by activity", () => {
    const newest = new Map([
      ["1", 900],
      ["4", 500],
    ]);
    expect(ids(sortAlbums(albums, "newest", [], newest))).toEqual(["1", "4", "2", "3"]);
  });
  it("follows the arrangement, new albums first, forgotten ids harmless", () => {
    expect(ids(sortAlbums(albums, "custom", ["4", "gone", "1", "2"]))).toEqual(["3", "4", "1", "2"]);
    expect(ids(sortAlbums(albums, "custom", []))).toEqual(["2", "3", "4", "1"]);
  });
  it("matches the arrangement on the album link id, the id every device shares", () => {
    const inVolume = albums.map((x) => ({ ...x, uid: `vol~${x.uid}` }));
    expect(ids(sortAlbums(inVolume, "custom", ["4", "1", "2"]))).toEqual(["vol~3", "vol~4", "vol~1", "vol~2"]);
  });
  it("leaves its input alone", () => {
    const copy = [...albums];
    sortAlbums(albums, "name");
    expect(albums).toEqual(copy);
  });
});

describe("moveOnto and nudge", () => {
  it("moves an album onto another's place, backwards and forwards", () => {
    expect(moveOnto(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveOnto(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(moveOnto(["a", "b", "c", "d"], "a", "d")).toEqual(["b", "c", "d", "a"]);
  });
  it("ignores a move onto itself or an unknown id", () => {
    const o = ["a", "b"];
    expect(moveOnto(o, "a", "a")).toBe(o);
    expect(moveOnto(o, "a", "x")).toBe(o);
  });
  it("steps one place and stops at the ends", () => {
    expect(nudge(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(nudge(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    const o = ["a", "b"];
    expect(nudge(o, "a", -1)).toBe(o);
    expect(nudge(o, "b", 1)).toBe(o);
  });
});

describe("photos", () => {
  const photos = [{ captureTime: 2 }, { captureTime: 9 }, { captureTime: 5 }];
  it("orders newest or oldest first and finds the newest", () => {
    expect(orderPhotos(photos, "newest").map((p) => p.captureTime)).toEqual([9, 5, 2]);
    expect(orderPhotos(photos, "oldest").map((p) => p.captureTime)).toEqual([2, 5, 9]);
    expect(newestOf(photos)).toBe(9);
    expect(newestOf([])).toBeNull();
  });
});

describe("a hand-made photo order", () => {
  const p = (link: string, captureTime: number) => ({ uid: `vol~${link}`, captureTime });
  const keys = (list: { uid: string }[]) => list.map((x) => x.uid.slice(4));
  const abcde = ["a", "b", "c", "d", "e"];
  const set = (...k: string[]) => new Set(k);

  it("keeps the arranged photos in their order and puts new ones at the end, oldest first, ties on the id", () => {
    expect(keys(orderPhotos([p("a", 1), p("b", 2), p("c", 3)], "custom", ["c", "a", "b"]))).toEqual(["c", "a", "b"]);
    const items = [p("new2", 50), p("a", 1), p("new1", 40), p("b", 2), p("new0", 40)];
    expect(keys(orderPhotos(items, "custom", ["b", "a"]))).toEqual(["b", "a", "new0", "new1", "new2"]);
    expect(keys(orderPhotos([p("a", 1), p("c", 3)], "custom", ["c", "b", "a"]))).toEqual(["c", "a"]);
    expect(keys(orderPhotos([p("b", 2), p("a", 1)], "custom", []))).toEqual(["a", "b"]);
    expect(orderPhotos([], "custom", ["a"])).toEqual([]);
    expect(keys(orderPhotos([p("p1", 1), p("new", 0), p("p2", 2), p("p3", 3)], "custom", ["p3", "p1", "p2"]))).toEqual([
      "p3",
      "p1",
      "p2",
      "new",
    ]);
  });
  it("moves a selection to the start or end as one block in its own order", () => {
    expect(moveToStart(abcde, set("d", "b"))).toEqual(["b", "d", "a", "c", "e"]);
    expect(moveToEnd(abcde, set("d", "b"))).toEqual(["a", "c", "e", "b", "d"]);
    expect(moveToStart(abcde, set())).toBe(abcde);
  });
  it("moves before and after a photo, and not onto the selection or an unknown key", () => {
    expect(moveBefore(abcde, set("a"), "e")).toEqual(["b", "c", "d", "a", "e"]);
    expect(moveAfter(abcde, set("a"), "e")).toEqual(["b", "c", "d", "e", "a"]);
    expect(moveAfter(abcde, set("b", "c"), "e")).toEqual(["a", "d", "e", "b", "c"]);
    expect(moveBefore(abcde, set("d"), "a")).toEqual(["d", "a", "b", "c", "e"]);
    expect(moveBefore(abcde, set("b", "c"), "c")).toEqual(abcde);
    expect(moveAfter(abcde, set("b"), "zzz")).toEqual(abcde);
  });
  it("gathers a scattered selection where the held photo stands", () => {
    expect(gather(abcde, set("b", "d"), "d")).toEqual(["a", "c", "b", "d", "e"]);
    expect(gather(abcde, set("b", "d"), "b")).toEqual(["a", "b", "d", "c", "e"]);
    expect(gather(abcde, set("b"), "b")).toBe(abcde);
    expect(gather(abcde, set("b", "d"), "a")).toBe(abcde);
  });
  it("drops before a photo behind the block and after one ahead of it", () => {
    expect(dragTo(abcde, set("d"), "b")).toEqual(["a", "d", "b", "c", "e"]);
    expect(dragTo(abcde, set("b"), "d")).toEqual(["a", "c", "d", "b", "e"]);
    expect(dragTo(abcde, set("a", "b"), "c")).toEqual(["c", "a", "b", "d", "e"]);
    expect(dragTo(abcde, set("b", "c"), "c")).toBe(abcde);
    expect(dragTo(abcde, set("b"), "zzz")).toBe(abcde);
    expect(dragTo(abcde, set(), "a")).toBe(abcde);
  });
  it("steps a selection one place and stops at the ends", () => {
    expect(nudgeBlock(abcde, set("b", "c"), 1)).toEqual(["a", "d", "b", "c", "e"]);
    expect(nudgeBlock(abcde, set("b", "d"), -1)).toEqual(["b", "d", "a", "c", "e"]);
    expect(nudgeBlock(abcde, set("a"), -1)).toEqual(abcde);
    expect(nudgeBlock(abcde, set("e"), 1)).toEqual(abcde);
    expect(nudgeBlock(abcde, set(), 1)).toBe(abcde);
  });
  it("saves the whole arrangement: unseen photos keep their slot, new ones join, removed ones go", () => {
    expect(forSave(["a", "b", "h", "c"], ["c", "a", "b"])).toEqual(["c", "a", "h", "b"]);
    expect(forSave(["a", "b"], ["b", "n", "a"])).toEqual(["b", "n", "a"]);
    expect(forSave(["a", "left", "unlisted", "b"], ["b", "a"], set("a", "b", "unlisted"))).toEqual(["b", "unlisted", "a"]);
    expect(forSave([], ["c", "b", "a"], set())).toEqual(["c", "b", "a"]);
  });
});

describe("stored values", () => {
  it("falls back for anything unknown", () => {
    expect(readAlbumSort("custom")).toBe("custom");
    expect(readAlbumSort("bogus")).toBe("activity");
    expect(readAlbumLayout("list")).toBe("list");
    expect(readAlbumLayout(7)).toBe("grid");
    expect(readAlbumOrder(["a", "a", 3, "", "b"])).toEqual(["a", "b"]);
    expect(readAlbumOrder("x")).toEqual([]);
    expect(readAlbumOrder(["vol~a", "a", "vol~b"])).toEqual(["a", "b"]);
    expect(readPhotoOrders({ x: "oldest", y: "newest", z: 4 })).toEqual({ x: "oldest" });
    expect(readPhotoOrders([])).toEqual({});
  });
});

describe("viewer after a photo leaves the album", () => {
  it("stays on the slot, which now holds the next photo", () => {
    expect(viewerIndexAfterRemoval(2, 4)).toBe(2);
  });
  it("steps back to the new last photo when the last one left", () => {
    expect(viewerIndexAfterRemoval(4, 4)).toBe(3);
  });
  it("closes when the album is left empty", () => {
    expect(viewerIndexAfterRemoval(0, 0)).toBeNull();
  });
  it("stays closed when no viewer was open", () => {
    expect(viewerIndexAfterRemoval(null, 3)).toBeNull();
  });
});
