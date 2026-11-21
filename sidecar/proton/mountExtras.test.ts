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

import { describe, expect, it, vi } from "vitest";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

import { ProtonSession } from "./session.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session sharing `albums` with this account; an album named "broken" fails to list. */
function withSharedAlbums(albums: string[]) {
  let listing = 0;
  let most = 0;
  const photos = {
    async *iterateAlbum(uid: string) {
      listing++;
      most = Math.max(most, listing);
      try {
        // Later albums answer sooner, so an answer's place cannot come from its arrival.
        await pause(5 * (albums.length - albums.indexOf(uid)));
        if (uid === "broken") throw new Error("the listing broke");
        yield { nodeUid: `${uid}-photo`, captureTime: new Date(0) };
      } finally {
        listing--;
      }
    },
    async *iterateNodes() {},
  };
  const session = new ProtonSession();
  (session as any).photos = photos;
  (session as any).trash.get = async () => [];
  (session as any).getShared = async () => albums.map((uid) => ({ uid, name: `Album ${uid}`, type: "album", mediaType: null }));
  return { session, most: () => most };
}

describe("listing the albums shared with this account for the drive", () => {
  it("lists three at a time and keeps their order", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const { session, most } = withSharedAlbums(names);
    const out = await session.listExtrasForMount();
    expect(out.sharedAlbums.map((a) => a.uid)).toEqual(names);
    expect(most()).toBe(3);
  });

  it("keeps an album that failed to list in its place, empty", async () => {
    const { session } = withSharedAlbums(["a", "broken", "c"]);
    const out = await session.listExtrasForMount();
    expect(out.sharedAlbums.map((a) => [a.uid, a.photos.length])).toEqual([
      ["a", 0],
      ["broken", 0],
      ["c", 0],
    ]);
  });
});
