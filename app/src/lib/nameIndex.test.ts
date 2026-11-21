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
import { indexNames, unsettledUids, type IndexedName } from "./nameIndex";

const items = (...uids: string[]) => uids.map((uid) => ({ uid }));
const named = (uid: string): IndexedName => ({ uid, name: `${uid}.jpg`, mediaType: "image/jpeg" });

/** Runs the index over `list` and returns what it asked for and what it took in. */
async function run(list: string[], settled: Set<string>, opts: { fail?: (b: string[]) => boolean; skip?: string[]; size?: number; cancelAfter?: number } = {}) {
  const asked: string[][] = [];
  const taken: Record<string, IndexedName> = {};
  let answers = 0;
  await indexNames(
    unsettledUids(items(...list), settled),
    settled,
    async (b) => {
      asked.push(b);
      answers++;
      if (opts.fail?.(b)) throw new Error("offline");
      return b.filter((u) => !opts.skip?.includes(u)).map(named);
    },
    (a) => a.forEach((m) => (taken[m.uid] = m)),
    () => opts.cancelAfter !== undefined && answers >= opts.cancelAfter,
    opts.size ?? 2,
  );
  return { asked, taken };
}

describe("the name index", () => {
  it("indexes the whole timeline once, a batch at a time", async () => {
    const settled = new Set<string>();
    const first = await run(["a", "b", "c", "d", "e"], settled);
    expect(first.asked).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(Object.keys(first.taken).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect((await run(["a", "b", "c", "d", "e"], settled)).asked).toEqual([]);
  });

  it("asks only for photos that arrive at the top of an indexed timeline", async () => {
    const settled = new Set<string>();
    await run(["a", "b", "c"], settled);
    const next = await run(["new2", "new1", "a", "b", "c"], settled);
    expect(next.asked).toEqual([["new2", "new1"]]);
    expect(Object.keys(next.taken)).toEqual(["new2", "new1"]);
  });

  it("finds a photo that took a removed one's place, the timeline keeping its length", async () => {
    const settled = new Set<string>();
    await run(["a", "b", "c"], settled);
    expect((await run(["new", "a", "c"], settled)).asked).toEqual([["new"]]);
  });

  it("asks nothing when the timeline only changes order or loses photos", async () => {
    const settled = new Set<string>();
    await run(["a", "b", "c", "d"], settled);
    expect((await run(["d", "c", "b", "a"], settled)).asked).toEqual([]);
    expect((await run(["b", "d"], settled)).asked).toEqual([]);
  });

  it("does not ask again for photos Drive did not name or a batch that failed", async () => {
    const settled = new Set<string>();
    const first = await run(["a", "b", "c", "d"], settled, { skip: ["b"], fail: (b) => b.includes("c") });
    expect(Object.keys(first.taken)).toEqual(["a"]);
    expect((await run(["a", "b", "c", "d"], settled)).asked).toEqual([]);
  });

  it("leaves a batch answered after a cancel unsettled, and carries on from there", async () => {
    const settled = new Set<string>();
    const cut = await run(["a", "b", "c", "d", "e"], settled, { cancelAfter: 2 });
    expect(cut.asked).toEqual([["a", "b"], ["c", "d"]]);
    expect(Object.keys(cut.taken)).toEqual(["a", "b"]);
    expect((await run(["a", "b", "c", "d", "e"], settled)).asked).toEqual([["c", "d"], ["e"]]);
  });

  it("indexes everything again after a reload clears what was settled", async () => {
    const settled = new Set<string>();
    await run(["a", "b"], settled);
    settled.clear();
    expect((await run(["a", "b"], settled)).asked).toEqual([["a", "b"]]);
  });

  it("lists a photo the timeline holds twice once", () => {
    expect(unsettledUids(items("a", "b", "a"), new Set(["b"]))).toEqual(["a"]);
  });
});
