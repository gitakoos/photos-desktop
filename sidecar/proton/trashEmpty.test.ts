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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { countTrashed, emptyTrash } from "./trash.ts";

/** A photos trash holding `held`, which writes down every delete it is asked for. */
function trashHolding(held: string[]) {
  const deleted: string[][] = [];
  const photos: any = {
    iterateTrashedNodeUids: async function* () {
      yield* held;
    },
    deleteNodes: async function* (uids: string[]) {
      deleted.push([...uids]);
      for (const uid of uids) yield { uid, ok: true };
    },
    emptyTrash: async () => {
      throw new Error("the whole trash must never be emptied");
    },
  };
  return { photos, deleted };
}

describe("emptying the trash", () => {
  it("destroys only what the window listed, leaving a photo trashed since on another device", async () => {
    const { photos, deleted } = trashHolding(["a", "b", "late"]);
    const results = await emptyTrash(photos, ["a", "b"]);
    expect(deleted).toEqual([["a", "b"]]);
    expect(results).toEqual([
      { uid: "a", ok: true },
      { uid: "b", ok: true },
    ]);
  });

  it("leaves alone a listed photo that was put back since", async () => {
    const { photos, deleted } = trashHolding(["a"]);
    await emptyTrash(photos, ["a", "restored"]);
    expect(deleted).toEqual([["a"]]);
  });

  it("destroys nothing when nothing was listed", async () => {
    const { photos, deleted } = trashHolding(["a", "b"]);
    expect(await emptyTrash(photos, [])).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("destroys nothing when none of what was listed is still in the trash", async () => {
    const { photos, deleted } = trashHolding(["late"]);
    expect(await emptyTrash(photos, ["a"])).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("reports a photo the server would not delete as failed", async () => {
    const { photos } = trashHolding(["a", "shared"]);
    photos.deleteNodes = async function* (uids: string[]) {
      for (const uid of uids) yield uid === "shared" ? { uid, ok: false, error: new Error("Not the owner") } : { uid, ok: true };
    };
    expect(await emptyTrash(photos, ["a", "shared"])).toEqual([
      { uid: "a", ok: true },
      { uid: "shared", ok: false, error: "Not the owner" },
    ]);
  });
});

describe("counting the trash while it empties", () => {
  it("counts everything in the trash when no photos are named", async () => {
    const { photos } = trashHolding(["a", "b", "late"]);
    expect(await countTrashed(photos)).toBe(3);
  });

  it("counts only the named photos still in the trash", async () => {
    const { photos } = trashHolding(["a", "late"]);
    expect(await countTrashed(photos, ["a", "b"])).toBe(1);
  });
});
