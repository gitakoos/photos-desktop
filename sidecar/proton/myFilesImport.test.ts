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

import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  albumOfRel,
  checkMyFolders,
  downloadMyFiles,
  listMyFolder,
  planMyFiles,
  uniqueRel,
  safeName,
  sourcesToTrash,
} from "./myFilesImport.ts";

const isMedia = (name: string) => /\.(jpe?g|png|mp4)$/i.test(name);

type FakeNode = { uid: string; name: string; type: "file" | "folder"; children?: FakeNode[]; trashed?: boolean; size?: number; bytes?: string };

/** A stand-in for the My files client over a small tree. */
function fakeDrive(tree: FakeNode[]) {
  const all = new Map<string, FakeNode>();
  const root: FakeNode = { uid: "root", name: "", type: "folder", children: tree };
  const index = (n: FakeNode) => {
    all.set(n.uid, n);
    n.children?.forEach(index);
  };
  index(root);
  const entity = (n: FakeNode) => ({
    uid: n.uid,
    name: { ok: true, value: n.name },
    type: n.type,
    trashTime: n.trashed ? new Date() : undefined,
    activeRevision: { ok: true, value: { claimedSize: n.size ?? 0, claimedModificationTime: new Date(2021, 4, 6, 7, 8, 9) } },
  });
  return {
    getMyFilesRootFolder: async () => entity(root),
    getNode: async (uid: string) => entity(all.get(uid)!),
    iterateFolderChildren: async function* (uid: string) {
      for (const child of all.get(uid)!.children ?? []) yield entity(child);
    },
    getFileDownloader: async (uid: string) => ({
      downloadToStream: (sink: WritableStream<Uint8Array>) => ({
        completion: async () => {
          const writer = sink.getWriter();
          await writer.write(new TextEncoder().encode(all.get(uid)!.bytes ?? uid));
          await writer.close();
        },
      }),
    }),
  };
}

const drive = () =>
  fakeDrive([
    {
      uid: "trip",
      name: "Trip",
      type: "folder",
      children: [
        { uid: "a", name: "a.jpg", type: "file", size: 10 },
        { uid: "notes", name: "notes.txt", type: "file", size: 5 },
        { uid: "gone", name: "gone.jpg", type: "file", trashed: true },
        { uid: "day1", name: "Day 1", type: "folder", children: [{ uid: "b", name: "b.mp4", type: "file", size: 20 }] },
      ],
    },
    { uid: "other", name: "Trip", type: "folder", children: [{ uid: "c", name: "c:1.png", type: "file", size: 3 }] },
    {
      uid: "docs",
      name: "Docs",
      type: "folder",
      children: [
        { uid: "pdf", name: "a.pdf", type: "file" },
        { uid: "deep", name: "Deep", type: "folder", children: [{ uid: "txt", name: "b.txt", type: "file" }] },
      ],
    },
  ]);

describe("My files", () => {
  it("lists a folder's sub-folders and the photos straight in it, and says later which hold photos", async () => {
    const listing = await listMyFolder(drive(), isMedia, "trip");
    expect(listing.folders).toEqual([{ uid: "day1", name: "Day 1", holds: undefined }]);
    expect(listing.files.map((f) => [f.uid, f.name, f.size])).toEqual([["a", "a.jpg", 10]]);
    const known = new Map<string, boolean>();
    const top = await listMyFolder(drive(), isMedia, undefined, known);
    expect(await checkMyFolders(drive(), top.folders.map((f) => f.uid), isMedia, known)).toEqual({
      docs: false,
      other: true,
      trip: true,
    });
    expect((await listMyFolder(drive(), isMedia, undefined, known)).folders.map((f) => [f.name, f.holds])).toEqual([
      ["Docs", false],
      ["Trip", true],
      ["Trip", true],
    ]);
  });

  it("answers within its time, and settles more folders on every ask", async () => {
    // A tree with no photo in it at all: 20 folders of 20 folders, each of them empty.
    const deep: FakeNode[] = Array.from({ length: 20 }, (_, i) => ({
      uid: `d${i}`,
      name: `D${i}`,
      type: "folder" as const,
      children: Array.from({ length: 20 }, (_, j) => ({ uid: `d${i}-${j}`, name: `E${j}`, type: "folder" as const, children: [] })),
    }));
    const client = fakeDrive([{ uid: "top", name: "Top", type: "folder", children: deep }]);
    let clock = 0;
    const tick = () => (clock += 10);
    const known = new Map<string, boolean>();
    const first = await checkMyFolders(client, ["top"], isMedia, known, 50, tick);
    expect(first).toEqual({});
    const settledAfterOne = known.size;
    expect(settledAfterOne).toBeGreaterThan(0);
    let answer: Record<string, boolean> = {};
    for (let asks = 0; asks < 200 && !("top" in answer); asks++) {
      answer = await checkMyFolders(client, ["top"], isMedia, known, 50, tick);
    }
    expect(answer).toEqual({ top: false });
  });

  it("walks the chosen folders, sub-folders included, under the chosen folder's name", async () => {
    const items = await planMyFiles(
      drive(),
      [
        { uid: "trip", name: "Trip" },
        { uid: "other", name: "Trip" },
      ],
      isMedia,
    );
    expect(items.map((i) => [i.nodeUid, i.rel, i.size])).toEqual([
      ["a", "Trip/a.jpg", 10],
      ["b", "Trip/Day 1/b.mp4", 20],
      ["c", "Trip (2)/c_1.png", 3],
    ]);
    expect(items.map((i) => albumOfRel(i.rel))).toEqual(["Trip", "Trip", "Trip (2)"]);
  });

  it("gives two files whose names differ only in case a path each, so neither is downloaded over the other", async () => {
    const client = fakeDrive([
      {
        uid: "cam",
        name: "Camera",
        type: "folder",
        children: [
          { uid: "up", name: "IMG.JPG", type: "file", size: 1 },
          { uid: "low", name: "img.jpg", type: "file", size: 2 },
        ],
      },
      { uid: "cam2", name: "Camera", type: "folder", children: [{ uid: "other", name: "x.jpg", type: "file", size: 3 }] },
    ]);
    const items = await planMyFiles(client, [{ uid: "cam", name: "Camera" }], isMedia, undefined, [
      { uid: "other", folder: "Camera" },
    ]);
    expect(items.map((i) => [i.nodeUid, i.rel])).toEqual([
      ["up", "Camera/IMG.JPG"],
      ["low", "Camera/img (2).jpg"],
      ["other", "Camera (2)/x.jpg"],
    ]);
    expect(new Set(items.map((i) => i.rel.toLowerCase())).size).toBe(items.length);
  });

  it("numbers a taken path before its extension", () => {
    const used = new Set<string>();
    expect(uniqueRel("A/b.jpg", used)).toBe("A/b.jpg");
    expect(uniqueRel("A/B.JPG", used)).toBe("A/B (2).JPG");
    expect(uniqueRel("A/b.jpg", used)).toBe("A/b (3).jpg");
    expect(uniqueRel("A.d/noext", used)).toBe("A.d/noext");
    expect(uniqueRel("A.d/noext", used)).toBe("A.d/noext (2)");
  });

  it("adds the files chosen one by one under their folder's name, once", async () => {
    const items = await planMyFiles(drive(), [{ uid: "trip", name: "Trip" }], isMedia, undefined, [
      { uid: "a", folder: "Trip" },
      { uid: "c", folder: "Trip" },
      { uid: "pdf", folder: "Docs" },
    ]);
    expect(items.map((i) => [i.nodeUid, i.rel])).toEqual([
      ["a", "Trip/a.jpg"],
      ["b", "Trip/Day 1/b.mp4"],
      ["c", "Trip (2)/c_1.png"],
    ]);
  });

  it("downloads each file to its place, dated as it was on Drive", async () => {
    const client = drive();
    const items = await planMyFiles(client, [{ uid: "trip", name: "Trip" }], isMedia);
    const root = mkdtempSync(join(tmpdir(), "pfp-myfiles-"));
    const done: string[] = [];
    await downloadMyFiles(client, items, root, (item, path) => done.push(path));
    expect(readFileSync(join(root, "Trip", "Day 1", "b.mp4"), "utf8")).toBe("b");
    expect(statSync(done[0]).mtime.getTime()).toBe(new Date(2021, 4, 6, 7, 8, 9).getTime());
  });

  it("gives up a download that brings nothing, and leaves no half file", async () => {
    const client = { ...drive(), getFileDownloader: async () => ({ downloadToStream: () => ({ completion: () => new Promise(() => {}) }) }) };
    const root = mkdtempSync(join(tmpdir(), "pfp-myfiles-"));
    const items = [{ nodeUid: "a", rel: "Trip/a.jpg", size: 1, modifiedMs: null }];
    await expect(downloadMyFiles(client, items, root, () => {}, undefined, 50)).rejects.toThrow(/produced nothing/);
    expect(existsSync(join(root, "Trip", "a.jpg"))).toBe(false);
  });

  it("makes names Windows can hold", () => {
    expect(safeName('a<b>:"c"|?*.jpg')).toBe("a_b___c____.jpg");
    expect(safeName("trailing. ")).toBe("trailing");
    expect(safeName("..")).toBe("_");
    expect(safeName("CON.jpg")).toBe("_CON.jpg");
  });
});

describe("moving the originals", () => {
  it("sends to the trash only what ended in the library and was seen there", () => {
    const outcomes = [
      { source: "uploaded", settled: true, photo: "p1" },
      { source: "already", settled: true, photo: "p2" },
      { source: "failed", settled: false, photo: null },
      { source: "unseen", settled: true, photo: "p3" },
      { source: "noPhoto", settled: true, photo: null },
      { source: "left-out", settled: false, photo: "p4" },
    ];
    expect(sourcesToTrash(outcomes, new Set(["p1", "p2", "p4"]))).toEqual(["uploaded", "already"]);
  });
});
