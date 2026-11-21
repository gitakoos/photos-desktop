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
import { bulkMarkable, markEvery, marksWithout, planTrashCalls, plannedCount, unmarkedBulkGroups, type BulkGroup } from "./duplicateBulk";
import type { Marks } from "./duplicateMarks";

const identical: BulkGroup = { key: "a|b", kind: "identical", uids: ["a", "b"] };
const triple: BulkGroup = { key: "c|d|e", kind: "identical", uids: ["c", "d", "e"] };
const similar: BulkGroup = { key: "j|k", kind: "similar", uids: ["j", "k"] };

describe("marking every group at once", () => {
  it("takes identical copies only, never similar photos", () => {
    expect([identical, triple, similar].filter(bulkMarkable)).toEqual([identical, triple]);
  });

  it("keeps the oldest identical copy and leaves the other marks alone", () => {
    const before: Marks = new Map([[similar.key, new Set(["k"])]]);
    const marks = markEvery(before, [identical, triple, similar]);
    expect([...marks.get(identical.key)!]).toEqual(["b"]);
    expect([...marks.get(triple.key)!]).toEqual(["d", "e"]);
    expect([...marks.get(similar.key)!]).toEqual(["k"]);
  });

  it("never marks a similar group that had no marks", () => {
    expect(markEvery(new Map(), [similar]).has(similar.key)).toBe(false);
  });

  it("keeps the marks of an identical group that already had some", () => {
    const before: Marks = new Map([[triple.key, new Set(["c"])]]);
    const marks = markEvery(before, [identical, triple]);
    expect([...marks.get(triple.key)!]).toEqual(["c"]);
    expect([...marks.get(identical.key)!]).toEqual(["b"]);
  });

  it("names only the identical groups with nothing marked", () => {
    const before: Marks = new Map([[triple.key, new Set(["c"])]]);
    expect(unmarkedBulkGroups(before, [identical, triple, similar])).toEqual([identical]);
  });

  it("names a group whose marks were all taken off again", () => {
    const before: Marks = new Map([[identical.key, new Set<string>()]]);
    expect(unmarkedBulkGroups(before, [identical])).toEqual([identical]);
  });

  it("names nothing once every identical group has marks", () => {
    const before: Marks = new Map([
      [identical.key, new Set(["a"])],
      [triple.key, new Set(["e"])],
    ]);
    expect(unmarkedBulkGroups(before, [identical, triple, similar])).toEqual([]);
    expect(markEvery(before, [identical, triple, similar])).toEqual(before);
  });

  it("never names a group of one copy", () => {
    const single: BulkGroup = { key: "z", kind: "identical", uids: ["z"] };
    expect(unmarkedBulkGroups(new Map(), [single])).toEqual([]);
  });
});

describe("moving the marked copies in parts", () => {
  const marks: Marks = new Map([
    [identical.key, new Set(["b"])],
    [triple.key, new Set(["c", "e"])],
    [similar.key, new Set(["k"])],
  ]);

  it("splits whole groups into calls of about the chunk size, each naming its groups", () => {
    const calls = planTrashCalls(marks, [identical, triple, similar], 2);
    expect(calls.map((c) => c.keys)).toEqual([[identical.key, triple.key], [similar.key]]);
    expect(calls[0].groups).toEqual([
      { uids: ["a", "b"], keep: ["a"] },
      { uids: ["c", "d", "e"], keep: ["d"] },
    ]);
    expect(calls.map(plannedCount)).toEqual([3, 1]);
  });

  it("keeps the marks of the groups a stopped move never sent", () => {
    const [first] = planTrashCalls(marks, [identical, triple, similar], 2);
    const left = marksWithout(marks, first.keys);
    expect([...left.keys()]).toEqual([similar.key]);
  });
});
