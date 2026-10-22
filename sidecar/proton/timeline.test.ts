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

// The session imports the SDK's photos client from a path the test resolver does not
// follow; the timeline read never builds one, so a stand-in is enough.
vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

import { ProtonSession } from "./session.ts";

/** An SDK client whose timeline arrives in pages, one each `gap` ms, or fails after `failAfter`. */
function fakePhotos(total: number, perPage: number, gap: number, failAfter?: number) {
  return {
    getMyPhotosRootFolder: async () => ({ uid: "root" }),
    async *iterateTimeline() {
      for (let i = 0; i < total; i++) {
        if (failAfter !== undefined && i === failAfter) throw new Error("the listing broke");
        if (i > 0 && i % perPage === 0) await new Promise((r) => setTimeout(r, gap));
        yield { nodeUid: `uid-${i}`, captureTime: new Date(1_700_000_000_000 - i * 1000), tags: i % 5 ? [] : [0] };
      }
    },
  };
}

function signedIn(photos: unknown): ProtonSession {
  const session = new ProtonSession();
  (session as any).photos = photos;
  return session;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reading the timeline in pages", () => {
  it("hands out what has arrived before the read has finished", async () => {
    const session = signedIn(fakePhotos(1000, 100, 40));
    const { run } = session.startTimeline();
    await pause(10);

    const first = session.timelinePage(run, 0, 20_000);

    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(1000);
    expect(first.done).toBe(false);
    expect(first.items[0]).toEqual({ uid: "uid-0", captureTime: 1_700_000_000_000, tags: [0] });
  });

  it("ends with everything, in order, and says it is done", async () => {
    const session = signedIn(fakePhotos(1000, 100, 5));
    const { run } = session.startTimeline();
    const all: { uid: string }[] = [];
    for (let guard = 0; guard < 500; guard++) {
      const page = session.timelinePage(run, all.length, 300);
      all.push(...page.items);
      if (page.done) break;
      if (page.items.length === 0) await pause(5);
    }

    expect(all.map((i) => i.uid)).toEqual(Array.from({ length: 1000 }, (_, i) => `uid-${i}`));
    expect(session.timelinePage(run, 1000, 300)).toEqual({ items: [], done: true, error: null });
  });

  it("refuses a page of a read that a newer one replaced", async () => {
    const session = signedIn(fakePhotos(10, 100, 0));
    const { run: old } = session.startTimeline();
    session.startTimeline();

    expect(() => session.timelinePage(old, 0, 10)).toThrow(/replaced/);
  });

  it("reports a read that broke halfway once its last page is taken", async () => {
    const session = signedIn(fakePhotos(500, 100, 5, 250));
    const { run } = session.startTimeline();
    let taken = 0;
    let last = session.timelinePage(run, 0, 1);
    for (let guard = 0; guard < 500 && !last.done; guard++) {
      await pause(5);
      last = session.timelinePage(run, taken, 1000);
      taken += last.items.length;
    }

    expect(taken).toBe(250);
    expect(last.error).toBe("the listing broke");
  });
});

describe("renaming a photo", () => {
  it("leaves the cached name the folder lists it under up to date", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { initStore, setDataKey, metaGet, metaPut } = await import("./store.ts");
    initStore(mkdtempSync(join(tmpdir(), "pfp-rename-test-")));
    setDataKey(Buffer.alloc(32, 7));
    metaPut("uid-1", { name: "old.jpg", mediaType: "image/jpeg", size: 10 });
    const session = signedIn({
      renameNode: async (uid: string, name: string) => ({ uid, name: { ok: true, value: name } }),
    });

    await session.renamePhoto("uid-1", "new.jpg");

    expect(metaGet("uid-1")).toEqual({ name: "new.jpg", mediaType: "image/jpeg", size: 10 });
  });
});
