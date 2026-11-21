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

import { beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addAllToAlbum, cancelUpload, clearFinishedUploads, getUploadStatus, startImport } from "./upload.ts";

type Album = { uid: string; name: string; photos: string[] };

/** The SDK's error for a request the server refused with this code (a 422). */
const refusal = (code: number) => Object.assign(new Error("refused"), { name: "ValidationError", code });

/**
 * A library's albums: each holds at most `cap` photos, past which the server refuses a request
 * with code 200300, as the SDK throws it for a batch; `fail` decides a request's fate.
 */
function library(cap: number, fail: (album: Album, batch: string[]) => "ok" | "throw" | "hang" = () => "ok") {
  const albums: Album[] = [{ uid: "a1", name: "Camera", photos: [] }];
  const photos: any = {
    async *addPhotosToAlbum(uid: string, uids: string[], signal?: AbortSignal) {
      const album = albums.find((a) => a.uid === uid)!;
      const fate = fail(album, uids);
      if (fate === "throw") throw refusal(2011);
      if (fate === "hang") {
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      for (const u of uids) {
        if (album.photos.length >= cap) throw refusal(200300);
        album.photos.push(u);
        yield { uid: u, ok: true };
      }
    },
    experimental: {
      async *iterateAlbumUids() {
        for (const a of albums) yield a.uid;
      },
    },
    async *iterateAlbums() {
      for (const a of albums) yield { ok: true, value: { uid: a.uid, name: a.name, photoCount: a.photos.length } };
    },
    async *iterateNodes(list: string[]) {
      for (const a of albums.filter((x) => list.includes(x.uid))) {
        yield { uid: a.uid, name: { ok: true, value: a.name }, album: { photoCount: a.photos.length } };
      }
    },
    async *iterateAlbum(uid: string) {
      for (const p of albums.find((a) => a.uid === uid)?.photos ?? []) yield { nodeUid: p };
    },
    async createAlbum(name: string) {
      const album = { uid: `a${albums.length + 1}`, name, photos: [] };
      albums.push(album);
      return { uid: album.uid, name: { ok: true, value: name } };
    },
  };
  return { photos, albums };
}

const uids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const limits = { chunk: 4, stallMs: 1000 };

describe("putting an upload's photos in their album", () => {
  beforeEach(() => clearFinishedUploads());

  it("goes on in Name (2) when the server answers that the album is full, and says so", async () => {
    const { photos, albums } = library(10);
    await addAllToAlbum(photos, "a1", "Camera", uids(25), limits);
    expect(albums.map((a) => [a.name, a.photos.length])).toEqual([
      ["Camera", 10],
      ["Camera (2)", 10],
      ["Camera (3)", 5],
    ]);
    expect(new Set(albums.flatMap((a) => a.photos)).size).toBe(25);
    const notes = getUploadStatus().albumNotes ?? [];
    expect(notes.filter((n) => n.kind === "split")).toEqual([
      { kind: "split", album: "Camera", part: "Camera (2)", moved: 10 },
      { kind: "split", album: "Camera", part: "Camera (3)", moved: 5 },
    ]);
    expect(notes.some((n) => n.kind === "failed")).toBe(false);
    expect(getUploadStatus().albumStep).toBeUndefined();
  });

  it("goes on in Name (2) when one photo's own answer says the album is full", async () => {
    const { photos, albums } = library(100);
    photos.addPhotosToAlbum = async function* (uid: string, list: string[]) {
      const album = albums.find((a) => a.uid === uid)!;
      for (const u of list) {
        if (album.photos.length >= 3) yield { uid: u, ok: false, error: { name: "APICodeError", code: 200300 } };
        else {
          album.photos.push(u);
          yield { uid: u, ok: true };
        }
      }
    };
    await addAllToAlbum(photos, "a1", "Camera", uids(5), limits);
    expect(albums.map((a) => [a.name, a.photos.length])).toEqual([
      ["Camera", 3],
      ["Camera (2)", 2],
    ]);
    expect(getUploadStatus().albumNotes?.some((n) => n.kind === "failed")).toBe(false);
  });

  it("never splits on any other refusal, however full the album is: it counts what did not go in", async () => {
    let calls = 0;
    const { photos, albums } = library(100, () => (++calls > 1 ? "throw" : "ok"));
    await addAllToAlbum(photos, "a1", "Camera", uids(12), limits);
    expect(albums).toHaveLength(1);
    expect(albums[0].photos).toHaveLength(4);
    expect(getUploadStatus().albumNotes).toEqual([{ kind: "failed", album: "Camera", count: 8 }]);
  });

  it("does not put a photo the full album took mid-step in the next part too", async () => {
    const { photos, albums } = library(9);
    await addAllToAlbum(photos, "a1", "Camera", uids(14), limits);
    const all = albums.flatMap((a) => a.photos);
    expect(all).toHaveLength(14);
    expect(new Set(all).size).toBe(14);
    expect(getUploadStatus().albumNotes?.some((n) => n.kind === "failed")).toBe(false);
  });

  it("run again, puts nothing in a second part twice", async () => {
    const { photos, albums } = library(10);
    await addAllToAlbum(photos, "a1", "Camera", uids(25), limits);
    clearFinishedUploads();
    // Only the main album's members are known to the caller, as in an import run again.
    const rest = uids(25).filter((u) => !albums[0].photos.includes(u));
    await addAllToAlbum(photos, "a1", "Camera", rest, limits);
    expect(albums.map((a) => a.photos.length)).toEqual([10, 10, 5]);
    expect(getUploadStatus().albumNotes ?? []).toEqual([]);
  });

  it("does not count as failed a photo the album already holds", async () => {
    const { photos } = library(100);
    const add = photos.addPhotosToAlbum;
    photos.addPhotosToAlbum = async function* (uid: string, list: string[], signal?: AbortSignal) {
      for (const u of list) {
        if (u === "p1") yield { uid: u, ok: false, error: { name: "ValidationError", code: 2500 } };
        else yield* add(uid, [u], signal);
      }
    };
    await addAllToAlbum(photos, "a1", "Camera", uids(3), limits);
    expect(getUploadStatus().albumNotes ?? []).toEqual([]);
  });

  it("does not take a lost connection for a full album", async () => {
    let calls = 0;
    const { photos, albums } = library(100, () => (++calls > 2 ? "hang" : "ok"));
    await addAllToAlbum(photos, "a1", "Camera", uids(12), { chunk: 4, stallMs: 50 });
    expect(albums).toHaveLength(1);
    expect(getUploadStatus().albumNotes).toEqual([{ kind: "failed", album: "Camera", count: 4 }]);
  });

  it("takes away a part it made when nothing went into it, and makes no more", async () => {
    const { photos, albums } = library(4, (album) => (album.uid !== "a1" ? "throw" : "ok"));
    photos.deleteAlbum = async (uid: string) => albums.splice(albums.findIndex((a) => a.uid === uid), 1);
    await addAllToAlbum(photos, "a1", "Camera", uids(12), limits);
    expect(albums.map((a) => a.name)).toEqual(["Camera"]);
    expect(getUploadStatus().albumNotes).toEqual([{ kind: "failed", album: "Camera", count: 8 }]);
  });

  it("stops making parts when a new one is full from the start", async () => {
    const { photos, albums } = library(4);
    photos.createAlbum = async (name: string) => {
      const album = { uid: `a${albums.length + 1}`, name, photos: [] as string[] };
      albums.push(album);
      return { uid: album.uid };
    };
    const add = photos.addPhotosToAlbum;
    photos.addPhotosToAlbum = async function* (uid: string, list: string[], signal?: AbortSignal) {
      if (uid !== "a1") throw refusal(200300);
      yield* add(uid, list, signal);
    };
    photos.deleteAlbum = async (uid: string) => albums.splice(albums.findIndex((a) => a.uid === uid), 1);
    await addAllToAlbum(photos, "a1", "Camera", uids(12), limits);
    expect(albums.map((a) => a.name)).toEqual(["Camera"]);
    expect(getUploadStatus().albumNotes).toEqual([{ kind: "failed", album: "Camera", count: 8 }]);
  });

  it("gives up a step that never answers instead of waiting for ever", async () => {
    const { photos } = library(100, () => "hang");
    const started = Date.now();
    await addAllToAlbum(photos, "a1", "Camera", uids(3), { chunk: 4, stallMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(getUploadStatus().albumNotes).toEqual([{ kind: "failed", album: "Camera", count: 3 }]);
  });

  it("forgets the last import's album notes when another import starts", async () => {
    const { photos } = library(10);
    await addAllToAlbum(photos, "a1", "Camera", uids(15), limits);
    expect(getUploadStatus().albumNotes?.length).toBeGreaterThan(0);
    startImport([join(tmpdir(), "pfp-no-such-export")]);
    try {
      expect(getUploadStatus().albumNotes).toBeUndefined();
    } finally {
      cancelUpload();
    }
  });
});
