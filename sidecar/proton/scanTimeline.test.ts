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

/** An SDK client whose timeline takes `gap` ms to read, counting how often it is read. */
function fakePhotos(gap = 0) {
  const photos = {
    reads: 0,
    getMyPhotosRootFolder: async () => ({ uid: "root" }),
    async *iterateTimeline() {
      photos.reads++;
      if (gap) await new Promise((r) => setTimeout(r, gap));
      for (let i = 0; i < 3; i++) yield { nodeUid: `uid-${i}`, captureTime: new Date(1_700_000_000_000 - i * 1000), tags: [] };
    },
  };
  return photos;
}

function signedIn(photos: unknown): ProtonSession {
  const session = new ProtonSession();
  (session as any).photos = photos;
  return session;
}

const scanList = (session: ProtonSession): Promise<{ uid: string }[]> => (session as any).timelineForScan();

describe("the face scan's listing of the library", () => {
  it("takes the window's read under way instead of reading again", async () => {
    const photos = fakePhotos(30);
    const session = signedIn(photos);
    session.startTimeline();
    const items = await scanList(session);
    expect(items.map((i) => i.uid)).toEqual(["uid-0", "uid-1", "uid-2"]);
    expect(photos.reads).toBe(1);
  });

  it("reads its own when the window's read began before the scan's last listing", async () => {
    const photos = fakePhotos();
    const session = signedIn(photos);
    session.startTimeline();
    await scanList(session);
    await scanList(session);
    expect(photos.reads).toBe(2);
  });

  it("reads its own when the window's read is old", async () => {
    const photos = fakePhotos();
    const session = signedIn(photos);
    session.startTimeline();
    await vi.waitFor(() => expect((session as any).timelineRun.done).toBe(true));
    (session as any).timelineRun.startedAt = Date.now() - 11 * 60_000;
    await scanList(session);
    expect(photos.reads).toBe(2);
  });

  it("never takes the photos kept offline for the library", async () => {
    const photos = fakePhotos();
    const session = signedIn(photos);
    (session as any).timelineRun = { id: 1, items: [{ uid: "kept", captureTime: 0, tags: [] }], done: true, error: null, offline: true };
    const items = await scanList(session);
    expect(items.map((i) => i.uid)).toEqual(["uid-0", "uid-1", "uid-2"]);
    expect(photos.reads).toBe(1);
  });

  it("follows a read replaced by a newer one, and reads its own when it is dropped", async () => {
    const photos = fakePhotos(30);
    const session = signedIn(photos);
    session.startTimeline();
    const followed = scanList(session);
    session.startTimeline();
    await followed;
    expect(photos.reads).toBe(2);

    session.startTimeline();
    const dropped = scanList(session);
    (session as any).timelineRun = null;
    await dropped;
    expect(photos.reads).toBe(4);
  });

  it("reads its own when the window's read failed", async () => {
    const photos = fakePhotos();
    const session = signedIn(photos);
    session.startTimeline();
    await vi.waitFor(() => expect((session as any).timelineRun.done).toBe(true));
    (session as any).timelineRun.error = "the listing broke";
    await scanList(session);
    expect(photos.reads).toBe(2);
  });
});
