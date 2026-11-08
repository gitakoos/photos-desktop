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

import { listAlbumsForMount } from "./albums.ts";

/** A stand-in for the photos client with `count` albums of two photos each. */
function photosWith(count: number) {
  const uids = Array.from({ length: count }, (_, i) => `v~album${i}`);
  let reads = 0;
  return {
    reads: () => reads,
    client: {
      experimental: {
        iterateAlbumUids: async function* () {
          yield* uids;
        },
      },
      iterateNodes: async function* (asked: string[]) {
        for (const uid of asked) yield { uid, name: { ok: true, value: `Album ${uid.slice(7)}` } };
      },
      iterateAlbum: async function* (uid: string) {
        reads++;
        yield { nodeUid: `${uid}-a` };
        yield { nodeUid: `${uid}-b` };
      },
    },
  };
}

describe("the albums for the Explorer folder", () => {
  it("come a page at a time, with how many there are in all", async () => {
    const { client, reads } = photosWith(30);
    const first = await listAlbumsForMount(client, 0, 12);
    expect(first.total).toBe(30);
    expect(first.items.map((a) => a.uid)).toEqual(Array.from({ length: 12 }, (_, i) => `v~album${i}`));
    expect(first.items[3]).toEqual({ uid: "v~album3", name: "Album 3", uids: ["v~album3-a", "v~album3-b"] });
    expect(reads()).toBe(12);
    const last = await listAlbumsForMount(client, 24, 12);
    expect(last.items.map((a) => a.uid)).toEqual(Array.from({ length: 6 }, (_, i) => `v~album${24 + i}`));
    expect((await listAlbumsForMount(client, 36, 12)).items).toEqual([]);
  });
});
