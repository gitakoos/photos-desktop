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

import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OFFLINE_LIST_FILE, initStore, metaGet, originalGet, setDataKey } from "./store.ts";
import { getOriginal, getVideo, readOriginalBytes, releaseOriginal } from "./download.ts";
import {
  addToOfflineAlbum,
  isOfflineReady,
  noteOfflineTimes,
  offlineAlbums,
  offlineLibrary,
  offlineStatus,
  pinOffline,
  setAlbumOffline,
  resetOfflineState,
  unpinAllOffline,
  unpinOffline,
} from "./offline.ts";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

/**
 * A photos stand-in for the pin queue. Records every uid it was asked to download, so
 * a photo that must never be fetched twice can be proven not to have been.
 */
function pinPhotos(bytes: Record<string, Buffer>, opts: { failUids?: Set<string> } = {}) {
  const downloaded: string[] = [];
  return {
    downloaded,
    getNode: async (uid: string) => ({
      uid,
      name: { ok: true, value: `${uid}.jpg` },
      mediaType: "image/jpeg",
      activeRevision: { ok: true, value: { claimedSize: bytes[uid]?.length ?? 0 } },
    }),
    getFileDownloader: async (uid: string) => {
      downloaded.push(uid);
      if (opts.failUids?.has(uid)) throw new Error("network blip");
      return {
        getClaimedSizeInBytes: () => bytes[uid]?.length ?? 0,
        downloadToStream: (stream: WritableStream<Uint8Array>) => ({
          completion: async () => {
            const writer = stream.getWriter();
            await writer.write(bytes[uid]);
            await writer.close();
          },
        }),
      };
    },
  };
}

/** Wait for the background queue to settle, the way the UI's poll does. */
async function settle(): Promise<void> {
  for (let i = 0; i < 500 && offlineStatus().running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("pin for offline", () => {
  let dir: string;
  let photoA: Buffer;
  let photoB: Buffer;

  beforeEach(() => {
    resetOfflineState();
    setDataKey(randomBytes(32));
    dir = mkdtempSync(join(tmpdir(), "pfp-offline-test-"));
    initStore(dir);
    photoA = Buffer.concat([JPEG_MAGIC, randomBytes(5000)]);
    photoB = Buffer.concat([JPEG_MAGIC, randomBytes(3000)]);
  });

  it("stores the original, encrypted, and reports what it cost", async () => {
    const photos = pinPhotos({ "uid-A": photoA });

    pinOffline(photos, ["uid-A"]);
    await settle();

    expect(isOfflineReady("uid-A")).toBe(true);
    expect(originalGet("uid-A")?.equals(photoA)).toBe(true);
    const status = offlineStatus();
    expect(status.pinned).toEqual(["uid-A"]);
    expect(status.ready).toBe(1);
    expect(status.bytes).toBe(photoA.length);

    // What actually sits on disk is ciphertext, not the photo.
    const blob = readFileSync(join(dir, "originals", readdirSync(join(dir, "originals"))[0]));
    expect(blob.subarray(0, 4).equals(JPEG_MAGIC)).toBe(false);
    expect(blob.includes(photoA.subarray(0, 64))).toBe(false);
  });

  it("records the name and media type, so opening it later needs no lookup", async () => {
    const photos = pinPhotos({ "uid-A": photoA });

    pinOffline(photos, ["uid-A"]);
    await settle();

    // This is what lets the viewer answer with no network at all.
    expect(metaGet("uid-A")).toEqual({
      name: "uid-A.jpg",
      mediaType: "image/jpeg",
      size: photoA.length,
    });
  });

  it("never fetches the same photo twice", async () => {
    const photos = pinPhotos({ "uid-A": photoA });

    pinOffline(photos, ["uid-A"]);
    await settle();
    pinOffline(photos, ["uid-A", "uid-A"]);
    await settle();

    expect(photos.downloaded).toEqual(["uid-A"]);
  });

  it("unpinning deletes the stored original and drops it from the list", async () => {
    const photos = pinPhotos({ "uid-A": photoA, "uid-B": photoB });
    pinOffline(photos, ["uid-A", "uid-B"]);
    await settle();
    expect(offlineStatus().ready).toBe(2);

    const after = unpinOffline(["uid-A"]);

    expect(after.pinned).toEqual(["uid-B"]);
    expect(after.bytes).toBe(photoB.length);
    expect(isOfflineReady("uid-A")).toBe(false);
    expect(originalGet("uid-A")).toBeNull();
    // The one kept is untouched: unpinning names photos, it does not sweep.
    expect(originalGet("uid-B")?.equals(photoB)).toBe(true);
  });

  it("unpinning everything reclaims all of it", async () => {
    const photos = pinPhotos({ "uid-A": photoA, "uid-B": photoB });
    pinOffline(photos, ["uid-A", "uid-B"]);
    await settle();

    const after = unpinAllOffline();

    expect(after).toEqual({
      pinned: [],
      ready: 0,
      bytes: 0,
      running: false,
      done: 0,
      total: 0,
      failed: 0,
    });
    expect(readdirSync(join(dir, "originals"))).toHaveLength(0);
  });

  it("keeps the list across a restart, and re-reads it through the seal", async () => {
    const photos = pinPhotos({ "uid-A": photoA });
    pinOffline(photos, ["uid-A"]);
    await settle();

    // What a restart looks like from here: the in-memory set is gone, the disk is not.
    resetOfflineState();

    expect(offlineStatus().pinned).toEqual(["uid-A"]);
    expect(isOfflineReady("uid-A")).toBe(true);

    // And the list itself is sealed: the uid does not appear in the clear.
    const listed = readFileSync(join(dir, OFFLINE_LIST_FILE));
    expect(listed.includes(Buffer.from("uid-A"))).toBe(false);
  });

  it("a photo pinned but not yet fetched is retried, not forgotten", async () => {
    const failing = pinPhotos({ "uid-A": photoA }, { failUids: new Set(["uid-A"]) });
    pinOffline(failing, ["uid-A"]);
    await settle();

    // Still the user's choice, just not landed yet, and nothing partial left behind.
    expect(offlineStatus().pinned).toEqual(["uid-A"]);
    expect(offlineStatus().ready).toBe(0);
    expect(isOfflineReady("uid-A")).toBe(false);

    // The next attempt (a later pin, or the next sign-in) picks it up.
    const working = pinPhotos({ "uid-A": photoA });
    pinOffline(working, ["uid-A"]);
    await settle();
    expect(isOfflineReady("uid-A")).toBe(true);
  });

  // The reason the feature exists: with the network away, the viewer still opens the
  // photo, and opens it at full resolution rather than stopping at the preview.
  it("opens a pinned photo at full resolution with NO network at all", async () => {
    const online = pinPhotos({ "uid-A": photoA });
    pinOffline(online, ["uid-A"]);
    await settle();

    // Everything that would reach the network now throws, so any attempt to use one
    // fails this test rather than quietly succeeding on a machine that has a network.
    const offlineClient = {
      getNode: async () => {
        throw new Error("no network");
      },
      getFileDownloader: async () => {
        throw new Error("no network");
      },
    };

    const status = await getOriginal(offlineClient, "uid-A");

    // Settled on the FIRST call: no `loading`, so the viewer never polls and never
    // shows the preview step for a photo it already holds.
    expect(status.state).toBe("ready");
    if (status.state !== "ready" || status.via !== "memory") {
      throw new Error("expected the in-memory route");
    }
    expect(status.size).toBe(photoA.length);
    expect(status.mime).toBe("image/jpeg");

    // And what it serves is the full-resolution original, byte for byte, not a preview.
    const served = readOriginalBytes(status.token);
    expect(Buffer.from(served!.base64, "base64").equals(photoA)).toBe(true);

    releaseOriginal();
  });

  it("falls back to the network for a photo that is not pinned", async () => {
    const photos = pinPhotos({ "uid-B": photoB });

    // Not pinned, so this must take the ordinary path rather than answering from
    // an empty store.
    const status = await getOriginal(photos, "uid-B");
    for (let i = 0; i < 500 && status.state === "loading"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if ((await getOriginal(photos, "uid-B")).state !== "loading") break;
    }

    expect(photos.downloaded).toEqual(["uid-B"]);
    releaseOriginal();
  });

  // A torn pin list reads back as an empty set, which on its own is the safe answer.
  // What made it costly is that the two halves of "free up" disagreed: Settings sizes
  // itself from the directory and still billed for the gigabytes, while the button
  // walked the list and so freed nothing at all. Only a sign-out got the space back.
  it("frees the originals even when the pin list was torn", async () => {
    const photos = pinPhotos({ "uid-A": photoA, "uid-B": photoB });
    pinOffline(photos, ["uid-A", "uid-B"]);
    await settle();
    expect(offlineStatus().ready).toBe(2);

    // What a write torn by a crash or a power cut leaves behind.
    writeFileSync(join(dir, OFFLINE_LIST_FILE), randomBytes(64));
    resetOfflineState();

    // The pins are gone from the UI, but Settings still reports every byte, because
    // the bytes really are still there.
    expect(offlineStatus().pinned).toEqual([]);
    expect(offlineStatus().bytes).toBe(photoA.length + photoB.length);

    const after = unpinAllOffline();

    expect(after.bytes).toBe(0);
    expect(after.ready).toBe(0);
    expect(readdirSync(join(dir, "originals"))).toHaveLength(0);
  });

  it("writes the pin list without leaving a scratch file behind", async () => {
    const photos = pinPhotos({ "uid-A": photoA });
    pinOffline(photos, ["uid-A"]);
    await settle();

    expect(readdirSync(dir).filter((f) => f.endsWith(".part"))).toHaveLength(0);
    expect(existsSync(join(dir, `${OFFLINE_LIST_FILE}.part`))).toBe(false);
  });

  // The host admits one call at a time, and the in-memory route holds that channel for
  // the whole base64 hand-over. The cap is what keeps that hold short, and it applies
  // to a pinned photo too, although its bytes are already local.
  // What happens ABOVE the in-memory cap is covered in download.test.ts instead: it
  // stages a real file, and VIEW_DIR is one fixed path the whole process shares, so a
  // staging test here would race that file's assertion that the folder is never made.
  it("a pinned photo under the cap answers from memory", async () => {
    const photos = pinPhotos({ "uid-A": photoA });
    pinOffline(photos, ["uid-A"]);
    await settle();

    const status = await getOriginal(photos, "uid-A");

    expect(status.state).toBe("ready");
    if (status.state === "ready") expect(status.via).toBe("memory");
    releaseOriginal();
  });

  // Nothing filters a pin by media type, so pinning a trip video is exactly what the
  // feature invites. Reading one to find out how big it is costs the sealed bytes and
  // the plaintext at once, which is the cost the cap exists to refuse.
  it("refuses a pinned video past the cap from its size, without reading it", async () => {
    const photos = pinPhotos({ "uid-vid": photoA });
    pinOffline(photos, ["uid-vid"]);
    await settle();

    // Grown past the cap on disk. The contents no longer decrypt, so a size taken from
    // the file is the only thing that can still answer: were the bytes read first, this
    // would fall through to the network stub and resolve instead of being refused.
    const blob = join(dir, "originals", readdirSync(join(dir, "originals"))[0]);
    truncateSync(blob, 151 * 1024 * 1024);

    await expect(getVideo(photos, "uid-vid")).rejects.toThrow("VIDEO_TOO_LARGE");
  });

  it("locking forgets the list without touching the stored photos", async () => {
    const photos = pinPhotos({ "uid-A": photoA });
    pinOffline(photos, ["uid-A"]);
    await settle();

    resetOfflineState(); // what the session calls when it locks

    // The blob stays for the same account to come back to; only sign-out removes it.
    expect(existsSync(join(dir, "originals"))).toBe(true);
    expect(readdirSync(join(dir, "originals"))).toHaveLength(1);
  });
});

describe("an album kept offline", () => {
  const photo = () => Buffer.concat([JPEG_MAGIC, randomBytes(2000)]);

  beforeEach(() => {
    resetOfflineState();
    setDataKey(randomBytes(32));
    initStore(mkdtempSync(join(tmpdir(), "pfp-offline-album-")));
  });

  it("keeps its photos in the app, then gives back only what nothing else keeps", async () => {
    const photos = pinPhotos({ a: photo(), b: photo(), c: photo() });
    pinOffline(photos, ["b"]);
    setAlbumOffline(photos, "album", ["a", "b"]);
    await settle();
    expect(offlineAlbums()).toEqual(["album"]);
    expect(isOfflineReady("a") && isOfflineReady("b")).toBe(true);
    setAlbumOffline(photos, "album", null);
    expect(offlineAlbums()).toEqual([]);
    expect(originalGet("a")).toBeNull();
    // Kept one by one too, so it stays.
    expect(isOfflineReady("b")).toBe(true);
  });

  it("takes in a photo added to it, and lets go of one taken out of it", async () => {
    const photos = pinPhotos({ a: photo(), b: photo(), c: photo() });
    setAlbumOffline(photos, "album", ["a", "b"]);
    await settle();
    addToOfflineAlbum(photos, "album", ["c"]);
    await settle();
    expect(isOfflineReady("c")).toBe(true);
    setAlbumOffline(photos, "album", ["b", "c"]);
    expect(originalGet("a")).toBeNull();
    expect(isOfflineReady("b") && isOfflineReady("c")).toBe(true);
    // Another album is not changed by it.
    addToOfflineAlbum(photos, "other", ["a"]);
    expect(offlineAlbums()).toEqual(["album"]);
  });

  it("is remembered across a restart, sealed with the rest", async () => {
    const photos = pinPhotos({ a: photo() });
    setAlbumOffline(photos, "album", ["a"]);
    await settle();
    resetOfflineState();
    expect(offlineAlbums()).toEqual(["album"]);
    expect(isOfflineReady("a")).toBe(true);
  });
});

describe("the library with no network", () => {
  const T1 = Date.UTC(2024, 5, 1, 10, 0, 0);
  const T2 = Date.UTC(2025, 2, 3, 9, 30, 0);

  /** The pin queue's stand-in, with the capture time each photo node carries. */
  function takenPhotos(bytes: Record<string, Buffer>, taken: Record<string, number>, failUids?: Set<string>) {
    const base = pinPhotos(bytes, { failUids });
    return {
      ...base,
      getNode: async (uid: string) => ({
        ...(await base.getNode(uid)),
        photo: { captureTime: taken[uid] ? new Date(taken[uid]) : undefined },
      }),
    };
  }

  beforeEach(() => {
    resetOfflineState();
    setDataKey(randomBytes(32));
    initStore(mkdtempSync(join(tmpdir(), "pfp-offline-lib-")));
  });

  it("lists the kept photos newest first, with the times they were taken, after a restart", async () => {
    const a = Buffer.concat([JPEG_MAGIC, randomBytes(800)]);
    const b = Buffer.concat([JPEG_MAGIC, randomBytes(900)]);
    pinOffline(takenPhotos({ "uid-A": a, "uid-B": b }, { "uid-A": T1, "uid-B": T2 }), ["uid-A", "uid-B"]);
    await settle();

    // The next start reads the sealed list again, with no node lookup.
    resetOfflineState();
    expect(offlineLibrary()).toEqual([
      { uid: "uid-B", captureTime: T2, tags: [] },
      { uid: "uid-A", captureTime: T1, tags: [] },
    ]);
  });

  it("leaves out a photo whose copy never arrived", async () => {
    const a = Buffer.concat([JPEG_MAGIC, randomBytes(800)]);
    pinOffline(
      takenPhotos({ "uid-A": a, "uid-B": a }, { "uid-A": T1, "uid-B": T2 }, new Set(["uid-B"])),
      ["uid-A", "uid-B"],
    );
    await settle();

    expect(offlineLibrary().map((p) => p.uid)).toEqual(["uid-A"]);
  });

  it("takes the times of copies kept before they were recorded from a timeline read online", async () => {
    const a = Buffer.concat([JPEG_MAGIC, randomBytes(800)]);
    // A node with no capture time, as a copy kept by an older version has none recorded.
    pinOffline(takenPhotos({ "uid-A": a }, {}), ["uid-A"]);
    await settle();
    const before = offlineLibrary()[0].captureTime;
    expect(before).not.toBe(T1);

    noteOfflineTimes([
      { uid: "uid-A", captureTime: T1 },
      { uid: "uid-not-kept", captureTime: T2 },
    ]);
    resetOfflineState();

    expect(offlineLibrary()).toEqual([{ uid: "uid-A", captureTime: T1, tags: [] }]);
  });

  it("forgets a time once its photo is no longer kept", async () => {
    const a = Buffer.concat([JPEG_MAGIC, randomBytes(800)]);
    pinOffline(takenPhotos({ "uid-A": a }, { "uid-A": T1 }), ["uid-A"]);
    await settle();

    unpinOffline(["uid-A"]);
    resetOfflineState();

    expect(offlineLibrary()).toEqual([]);
  });
});
