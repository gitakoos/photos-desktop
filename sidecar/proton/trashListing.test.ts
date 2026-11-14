/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, expect, it } from "vitest";
import { TrashListing, type TrashItem } from "./trash.ts";

const row = (uid: string): TrashItem => ({ uid, name: uid, type: "photo", mediaType: "image/jpeg", captureTime: 0, tags: [] });

function counting(rows: TrashItem[] = [row("a")]) {
  let reads = 0;
  const waiting: (() => void)[] = [];
  const load = () => {
    reads++;
    return new Promise<TrashItem[]>((resolve) => waiting.push(() => resolve(rows)));
  };
  return { load, reads: () => reads, finish: () => waiting.splice(0).forEach((go) => go()) };
}

describe("the shared trash listing", () => {
  it("joins a read already under way", async () => {
    const listing = new TrashListing();
    const src = counting();
    const first = listing.get(src.load);
    const second = listing.get(src.load);
    src.finish();
    expect(await first).toEqual([row("a")]);
    expect(await second).toEqual([row("a")]);
    expect(src.reads()).toBe(1);
  });

  it("serves a finished read while it is fresh, and reads again after", async () => {
    let now = 1000;
    const listing = new TrashListing(20_000, () => now);
    const src = counting();
    const first = listing.get(src.load);
    src.finish();
    await first;
    now += 19_000;
    await listing.get(src.load);
    expect(src.reads()).toBe(1);
    now += 2_000;
    const third = listing.get(src.load);
    src.finish();
    await third;
    expect(src.reads()).toBe(2);
  });

  it("never serves a read from before the trash changed, even one still under way", async () => {
    const listing = new TrashListing();
    const src = counting();
    const before = listing.get(src.load);
    listing.changed();
    const after = listing.get(src.load);
    expect(src.reads()).toBe(2);
    src.finish();
    await Promise.all([before, after]);
  });

  it("lets a caller that wants the trash as it is now join a read but not take a finished one", async () => {
    const listing = new TrashListing();
    const src = counting();
    const running = listing.get(src.load);
    const joined = listing.get(src.load, true);
    src.finish();
    await Promise.all([running, joined]);
    expect(src.reads()).toBe(1);
    const fresh = listing.get(src.load, true);
    src.finish();
    await fresh;
    expect(src.reads()).toBe(2);
  });

  it("does not keep a failed read", async () => {
    const listing = new TrashListing();
    await expect(listing.get(() => Promise.reject(new Error("network")))).rejects.toThrow("network");
    expect(await listing.get(async () => [row("b")])).toEqual([row("b")]);
  });
});
