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
import { createHash } from "node:crypto";

import {
  cancelDateFixJob,
  dateFixJobResults,
  dateFixJobStatus,
  fixDatesFromName,
  startDateFixJob,
  type DateFixItem,
} from "./dateFix.ts";
import { claimedCaptureString, sameCaptureDay } from "./dateFixCore.ts";

// A node shaped like the SDK's getNode result: the name a Result, the claimed size,
// modification time and photo attributes on the active revision, the tags and album
// membership under `photo`.
function photoNode(uid: string, name: string, extra: Record<string, any> = {}) {
  return {
    uid,
    name: { ok: true, value: name },
    mediaType: "image/jpeg",
    activeRevision: {
      ok: true,
      value: {
        claimedSize: 1000,
        claimedModificationTime: new Date("2024-03-04T05:06:07Z"),
        claimedAdditionalMetadata: { Location: { Latitude: 47.5, Longitude: 19.05 } },
      },
    },
    photo: { tags: [0], albums: [], ...extra.photo }, // 0 is the Favorites tag
    ...extra,
  };
}

type Upload = { name: string; metadata: any; sha1: string; bytes: Buffer };

/** The picture data of the fake JPEG, which no date edit may touch. */
const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0x11, 0x22, 0xff, 0xd9]);

/** A minimal JPEG naming its photo in a comment, so every download is a real JPEG to edit. */
function fakeJpeg(uid: string): Buffer {
  const text = Buffer.from(`bytes-of-${uid}`, "latin1");
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0, 0]);
  head.writeUInt16BE(text.length + 2, 4);
  return Buffer.concat([head, text, SCAN]);
}

/**
 * A stand-in Drive client recording everything the fix does, so the assertions can hold
 * the strategy itself: the copy's name and bytes, the carried tags and attributes, the
 * album re-adds, and above all what happened to the original.
 */
function fakeDrive(nodes: Record<string, any>, options: {
  newUidOf?: (uid: string) => string;
  failUploadFor?: string[];
  failAlbumAdds?: string[];
  refuseTrashFor?: string[];
  liveBytes?: (uid: string) => Buffer;
  downloadDelayMs?: number;
  /** Milliseconds added to every uploaded copy's capture time on the live node, so a
   *  misfiled server response can be simulated. */
  copyCaptureOffsetMs?: number;
  /** Source uids whose corrected copy never materializes as a node the fix can read back. */
  unreadableCopies?: string[];
  /** Album re-adds update only the batch answer: the live node's membership is left
   *  without the album, simulating a copy that never actually joined it. */
  dropAlbumOnNode?: boolean;
} = {}) {
  const uploads: (Upload & { newUid: string })[] = [];
  const albumAdds: { albumUid: string; uids: string[] }[] = [];
  const trashCalls: string[][] = [];
  const bytesOf = (uid: string) => options.liveBytes?.(uid) ?? fakeJpeg(uid);
  const uidByName = new Map(Object.entries(nodes).map(([uid, node]) => [node.name?.value, uid]));
  // Corrected copies live here once upload completion answers: the fix reads each copy
  // back through getNode before trusting it, and reads memberships off the same node.
  const liveNodes = new Map<string, any>();
  let activeDownloads = 0;
  let maxActiveDownloads = 0;
  const photos = {
    uploads,
    albumAdds,
    trashCalls,
    liveNodes,
    originalNodes: nodes,
    nodes: { access: { notifyNodeChanged: async (_uid: string) => {} } },
    get maxActiveDownloads() {
      return maxActiveDownloads;
    },
    async getNode(uid: string) {
      const node = nodes[uid] ?? liveNodes.get(uid);
      if (!node) throw new Error("node not found");
      return node;
    },
    async getFileDownloader(uid: string) {
      const bytes = bytesOf(uid);
      return {
        downloadToStream(stream: any) {
          // The SDK delivers the bytes by the time completion resolves.
          return {
            async completion() {
              activeDownloads++;
              maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
              try {
                if (options.downloadDelayMs) {
                  await new Promise((resolve) => setTimeout(resolve, options.downloadDelayMs));
                }
                const writer = stream.getWriter();
                await writer.write(bytes);
                await writer.close();
              } finally {
                activeDownloads--;
              }
            },
          };
        },
      };
    },
    async *iterateThumbnails(_uids: string[], _type: number) {
      // no stored thumbnails in the fake: the copy uploads without, which is the fallback
    },
    async getFileUploader(name: string, metadata: any) {
      const sourceUid = uidByName.get(name) ?? "unknown";
      return {
        async uploadFromStream(stream: any, _thumbnails: unknown[]) {
          const reader = stream.getReader() as any;
          const chunks: Uint8Array[] = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const bytes = Buffer.concat(chunks);
          return {
            async completion() {
              if (options.failUploadFor?.includes(sourceUid)) throw new Error("network blip");
              const newUid = options.newUidOf?.(sourceUid) ?? `${sourceUid}-NEW`;
              uploads.push({ name, metadata, sha1: metadata.expectedSha1, bytes, newUid });
              // The copy materializes as a node the fix can read back — the same shape
              // the verification reads the date and album memberships off. An offset
              // option simulates a server that filed the copy under its old date, and a
              // missing entry one that returns a link for a copy it never really stored.
              if (!options.unreadableCopies?.includes(sourceUid)) {
                const stamped = metadata.captureTime instanceof Date
                  ? metadata.captureTime.getTime()
                  : Number(metadata.captureTime) || 0;
                liveNodes.set(newUid, {
                  uid: newUid,
                  name: { ok: true, value: name },
                  mediaType: "image/jpeg",
                  activeRevision: {
                    ok: true,
                    value: { claimedSize: bytes.byteLength, claimedModificationTime: metadata.modificationTime },
                  },
                  photo: {
                    tags: metadata.tags ?? [],
                    albums: [],
                    captureTime: new Date(stamped + (options.copyCaptureOffsetMs ?? 0)),
                  },
                });
              }
              return { nodeUid: newUid, nodeRevisionUid: `${newUid}-rev` };
            },
          };
        },
      };
    },
    addPhotosToAlbum: async function* (albumUid: string, uids: string[]) {
      albumAdds.push({ albumUid, uids });
      if (options.failAlbumAdds?.includes(albumUid)) {
        for (const uid of uids) yield { uid, ok: false, error: "album refused" };
        return;
      }
      for (const uid of uids) {
        // The membership lands on the live node unless the drift option holds it back,
        // so the fix's read-back confirmation sees the copy actually standing in it.
        if (!options.dropAlbumOnNode) liveNodes.get(uid)?.photo.albums.push({ nodeUid: albumUid });
        yield { uid, ok: true };
      }
    },
    trashNodes: async function* (uids: string[]) {
      trashCalls.push(uids);
      for (const uid of uids) {
        if (options.refuseTrashFor?.includes(uid)) yield { uid, ok: false, error: "trash refused" };
        else yield { uid, ok: true };
      }
    },
  };
  return photos;
}

// The instant "IMG_20230115_123456.jpg" records, as the frontend's filename reader resolves it.
const NAME_DATE = new Date(2023, 0, 15, 12, 34, 56).getTime();
const item: DateFixItem = { uid: "v~uid-x", captureTime: NAME_DATE };
const THREE_DAYS = 3 * 24 * 60 * 60_000;

describe("fixDatesFromName — guards and job control", () => {
  it("leaves a live photo alone, since its halves are dated together", async () => {
    const photos = fakeDrive(
      {
        "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg", {
          photo: { tags: [], albums: [], relatedPhotoNodeUids: ["v~uid-video"] },
        }),
      },
      {},
    );

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/live photo/);
    // Nothing is uploaded for either half: a pair split across two dates is worse than
    // a pair on the old one.
    expect(photos.uploads.length).toBe(0);
    expect(photos.trashCalls).toEqual([]);
  });

  it("attempts every photo whatever happens to the one before it", async () => {
    const photos = fakeDrive(
      {
        "v~uid-1": photoNode("v~uid-1", "IMG_20230115_123456.jpg"),
        "v~uid-2": photoNode("v~uid-2", "IMG_20230116_123456.jpg"),
        "v~uid-3": photoNode("v~uid-3", "IMG_20230117_123456.jpg"),
      },
      {},
    );

    const results = await fixDatesFromName(photos, [
      { uid: "v~uid-1", captureTime: NAME_DATE },
      { uid: "v~uid-2", captureTime: 0 }, // no readable date in the name
      { uid: "v~uid-3", captureTime: NAME_DATE },
    ]);

    expect(results).toEqual([
      { uid: "v~uid-1", ok: true },
      { uid: "v~uid-2", ok: false, error: "no readable date in the name" },
      { uid: "v~uid-3", ok: true },
    ]);
    // A photo that failed in no way holds back the ones after it.
    expect(photos.uploads.map((u) => u.name)).toEqual(["IMG_20230115_123456.jpg", "IMG_20230117_123456.jpg"]);
    expect(photos.trashCalls).toEqual([["v~uid-1", "v~uid-3"]]);
  });

  it("stops claiming new photos on cancellation and marks the rest as skipped", async () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => {
        const uid = `v~cancel-${i}`;
        return [uid, photoNode(uid, `v~cancel-${i}.jpg`)];
      }),
    );
    const photos = fakeDrive(nodes, { downloadDelayMs: 20 });
    let cancel = false;
    const results = await fixDatesFromName(
      photos,
      Object.keys(nodes).map((uid) => ({ uid, captureTime: NAME_DATE })),
      {
        concurrency: 2,
        shouldCancel: () => cancel,
        onProgress: (status) => {
          if (status.active === 2) cancel = true;
        },
      },
    );

    expect(results.filter((result) => result.ok).length).toBeGreaterThan(0);
    expect(results.filter((result) => result.cancelled)).toHaveLength(6 - results.filter((r) => r.ok).length);
    // Only the photos that were fixed lost their originals to the trash.
    expect(photos.trashCalls.flat()).toHaveLength(results.filter((r) => r.ok).length);
  });

  it("runs as a background job, exposes progress and drains only already-started writes on cancel", async () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => {
        const uid = `v~job-${i}`;
        return [uid, photoNode(uid, `v~job-${i}.jpg`)];
      }),
    );
    const photos = fakeDrive(nodes, { downloadDelayMs: 20 });
    const items = Object.keys(nodes).map((uid) => ({ uid, captureTime: NAME_DATE }));

    expect(startDateFixJob(photos, items)).toEqual({ started: true });
    expect(startDateFixJob(photos, items)).toEqual({ started: false });
    expect(dateFixJobStatus().running).toBe(true);
    // Cancel once a photo is in flight: the window's nodes are read in one batch first,
    // so in the very tick the job starts nothing has begun yet.
    while (dateFixJobStatus().active === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    cancelDateFixJob();
    while (dateFixJobStatus().running) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const status = dateFixJobStatus();
    const results = dateFixJobResults();
    expect(status.cancelled).toBe(true);
    expect(status.skipped).toBeGreaterThan(0);
    expect(results.filter((result) => result.ok).length).toBeGreaterThan(0);
    expect(results.filter((result) => result.cancelled)).toHaveLength(status.skipped);
    // Every upload carries the filename date.
    for (const upload of photos.uploads) {
      expect(upload.metadata.captureTime.getTime()).toBe(NAME_DATE);
    }
  });

  it("reads the node before anything is sent, so a vanished photo fails alone", async () => {
    const photos = fakeDrive({}, {}); // nothing on Drive under this uid

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/node not found/);
    expect(photos.uploads.length).toBe(0);
    expect(photos.trashCalls).toEqual([]);
  });
});

describe("fixDatesFromName — only what differs, in sealed windows", () => {
  it("writes nothing for a photo whose Drive date already matches the filename", async () => {
    const photos = fakeDrive(
      {
        "v~same": photoNode("v~same", "IMG_20230115_123456.jpg", {
          photo: { tags: [], albums: [], captureTime: new Date(NAME_DATE + 300) },
        }),
        // A date-only name matches any time on the same calendar day.
        "v~day": photoNode("v~day", "IMG-20230115-WA0001.jpg", {
          photo: { tags: [], albums: [], captureTime: new Date(2023, 0, 15, 18, 5, 0) },
        }),
      },
      {},
    );

    const results = await fixDatesFromName(photos, [
      { uid: "v~same", captureTime: NAME_DATE, withTime: true },
      { uid: "v~day", captureTime: new Date(2023, 0, 15, 12, 0, 0).getTime(), withTime: false },
    ]);

    expect(results).toEqual([
      { uid: "v~same", ok: true, unchanged: true },
      { uid: "v~day", ok: true, unchanged: true },
    ]);
    expect(photos.uploads).toHaveLength(0);
  });

  it("does not re-upload a copy-path photo Drive already dates correctly", async () => {
    const photos = fakeDrive(
      {
        "v~same": photoNode("v~same", "IMG_20230115_123456.jpg", {
          photo: { tags: [], albums: [], captureTime: new Date(NAME_DATE) },
        }),
      },
      {},
    );

    const [r] = await fixDatesFromName(photos, [{ uid: "v~same", captureTime: NAME_DATE }]);

    expect(r).toEqual({ uid: "v~same", ok: true, unchanged: true });
    expect(photos.uploads).toHaveLength(0);
    expect(photos.trashCalls).toEqual([]);
  });

  it("seals each window, trash and all, before the next window starts", async () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => {
        const uid = `v~win-${i}`;
        return [uid, photoNode(uid, `IMG_2023011${i % 10}_123456-${i}.jpg`)];
      }),
    );
    const photos = fakeDrive(nodes);
    const trashedWhenWindowStarted: number[] = [];
    const leads: number[] = [];

    const results = await fixDatesFromName(
      photos,
      Object.keys(nodes).map((uid) => ({ uid, captureTime: NAME_DATE, expectedSize: 1000 })),
      {
        onProgress: (status) => {
          if (status.stage === "uploading" && status.batchDone === 0 && status.active === 0) {
            trashedWhenWindowStarted[status.batch - 1] ??= photos.trashCalls.length;
          }
          // `done` only ever counts sealed outcomes.
          leads.push(status.done - (status.uploaded + status.failed + status.unchanged));
        },
      },
    );

    expect(results.every((r) => r.ok)).toBe(true);
    // Two windows (8 + 2), each sealed with its own trash before the next began.
    expect(photos.trashCalls.map((call) => call.length)).toEqual([8, 2]);
    expect(trashedWhenWindowStarted).toEqual([0, 1]);
    expect(new Set(leads)).toEqual(new Set([0]));
  });

  it("reads Drive's date as the named day in either UTC or this machine's zone", () => {
    const named = new Date(2024, 10, 17, 4, 17, 56).getTime();
    // The camera's wall clock stored as UTC, the way Proton long saved it.
    expect(sameCaptureDay(named, Date.UTC(2024, 10, 17, 4, 17, 56))).toBe(true);
    // The real instant, later the same day here.
    expect(sameCaptureDay(named, new Date(2024, 10, 17, 22, 0, 0).getTime())).toBe(true);
    expect(sameCaptureDay(named, Date.UTC(2024, 10, 20, 4, 17, 56))).toBe(false);
    expect(sameCaptureDay(named, 0)).toBe(false);
  });

  it("claims the new date the way a camera does, wall clock with its offset", () => {
    const claim = claimedCaptureString(new Date(2024, 10, 17, 4, 17, 56).getTime());
    expect(claim).toMatch(/^2024-11-17T04:17:56\.000[+-]\d{2}:\d{2}$/);
  });

  it("stops the job when Drive takes the date for no photo, leaving no duplicate behind", async () => {
    // Every copy reads back under another day: Drive is not taking the date. The job must
    // not grind on through the selection, uploading every photo to learn it again.
    const nodes = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => {
        const uid = `v~stuck-${i}`;
        return [uid, photoNode(uid, `IMG_20230115_1234${String(i).padStart(2, "0")}.jpg`)];
      }),
    );
    const photos = fakeDrive(nodes, { copyCaptureOffsetMs: THREE_DAYS });
    const seen: boolean[] = [];

    const results = await fixDatesFromName(
      photos,
      Object.keys(nodes).map((uid) => ({ uid, captureTime: NAME_DATE, expectedSize: 1000 })),
      { onProgress: (status) => seen.push(status.halted) },
    );

    expect(seen.at(-1)).toBe(true);
    // One window was tried; the rest never started.
    expect(results.filter((r) => r.cancelled).length).toBe(12);
    expect(results.filter((r) => !r.ok && !r.cancelled).length).toBe(8);
    expect(photos.uploads).toHaveLength(8);
    // Every copy that never took the date went to the trash; no original did.
    const trashed = photos.trashCalls.flat();
    expect(trashed.every((uid) => uid.endsWith("-NEW"))).toBe(true);
    expect(trashed).toHaveLength(photos.uploads.length);
  });

});

describe("fixDatesFromName — the re-upload with the date in the file", () => {
  it("replaces the photo with a corrected copy carrying the filename date", async () => {
    const photos = fakeDrive(
      { "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg") },
      {},
    );

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r).toEqual({ uid: "v~uid-x", ok: true });
    // The same name: a correction, not a copy.
    expect(photos.uploads[0].name).toBe("IMG_20230115_123456.jpg");
    // The date the name recorded is what the copy carries.
    expect(photos.uploads[0].metadata.captureTime.getTime()).toBe(NAME_DATE);
    // The bytes are the original's with the date written into their metadata: the
    // picture itself is the same to the byte, and the hash is of what was sent.
    const sent = photos.uploads[0].bytes;
    expect(sent.equals(fakeJpeg("v~uid-x"))).toBe(false);
    expect(sent.subarray(sent.length - SCAN.length)).toEqual(SCAN);
    expect(sent.toString("latin1")).toContain("bytes-of-v~uid-x");
    expect(sent.toString("latin1")).toContain("2023:01:15 12:34:56");
    expect(photos.uploads[0].metadata.expectedSize).toBe(sent.length);
    expect(photos.uploads[0].sha1).toBe(createHash("sha1").update(sent).digest("hex"));
    // The original's own tags (a favourite) and photo attributes (its place) ride along.
    expect(photos.uploads[0].metadata.tags).toEqual([0]);
    // ...with the camera's claimed capture time replaced, since Proton's web shows that
    // claim before the clear-text capture time.
    expect(photos.uploads[0].metadata.additionalMetadata).toEqual({
      Location: { Latitude: 47.5, Longitude: 19.05 },
      Camera: { CaptureTime: claimedCaptureString(NAME_DATE) },
    });
    expect(photos.uploads[0].metadata.modificationTime.getTime()).toBe(
      new Date("2024-03-04T05:06:07Z").getTime(),
    );
    // The original was moved to the trash only after the copy stood in for it.
    expect(photos.trashCalls).toEqual([["v~uid-x"]]);
  });

  it("re-adds the copy to every album the original belonged to", async () => {
    const photos = fakeDrive(
      {
        "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg", {
          photo: { tags: [], albums: [{ nodeUid: "album-a" }, { nodeUid: "album-b" }] },
        }),
      },
      {},
    );

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r.ok).toBe(true);
    expect(photos.albumAdds.map((a) => a.albumUid)).toEqual(["album-a", "album-b"]);
    expect(photos.trashCalls).toEqual([["v~uid-x"]]);
  });

  it("keeps the original when any album re-add fails, so no album loses the photo", async () => {
    const photos = fakeDrive(
      {
        "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg", {
          photo: { tags: [], albums: [{ nodeUid: "album-a" }, { nodeUid: "album-b" }] },
        }),
      },
      { failAlbumAdds: ["album-b"] },
    );

    const [r] = await fixDatesFromName(photos, [item]);

    // The fence: a missed re-add leaves the original untouched, however well the upload went.
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/re-add failed for 1 of 2 album\(s\); original kept/);
    expect(photos.trashCalls).toEqual([]);
  });

  it("keeps the original when the copy stubbornly shows another capture time", async () => {
    // The copy never carries the date, and the read-back exists precisely to catch that
    // long before the original is trashed.
    const photos = fakeDrive(
      { "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg") },
      { copyCaptureOffsetMs: THREE_DAYS },
    );

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/kept an old capture time/);
    expect(photos.albumAdds).toEqual([]);
    // The original stays; the copy that never took the date goes, so no duplicate is left.
    expect(photos.trashCalls).toEqual([["v~uid-x-NEW"]]);
  });

  it("confirms a copy on the named day whatever its time of day", async () => {
    // The fix answers for the day only: a copy filed some hours off (a zone, a clock) is
    // on the day the name records, so it is confirmed rather than failed.
    const photos = fakeDrive(
      { "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg") },
      { copyCaptureOffsetMs: 3 * 60 * 60_000 },
    );

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r).toEqual({ uid: "v~uid-x", ok: true });
    expect(photos.trashCalls).toEqual([["v~uid-x"]]);
  });

  it("keeps the original when the copy cannot be read back at all", async () => {
    // The upload answered with a link, but no node stands behind it: the fence holds.
    const photos = fakeDrive(
      { "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg") },
      { unreadableCopies: ["v~uid-x"] },
    );

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be read back|could not be confirmed/);
    expect(photos.uploads).toHaveLength(1);
    // Only the unconfirmed copy is trashed; the original is never touched.
    expect(photos.trashCalls).toEqual([["v~uid-x-NEW"]]);
  });

  it("keeps the original when the copy's album membership is not confirmed on the node", async () => {
    // The batch call reports the photo joined, but the live node says otherwise: the
    // drift the trash fence refuses to forgive.
    const photos = fakeDrive(
      {
        "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg", {
          photo: { tags: [], albums: [{ nodeUid: "album-a" }] },
        }),
      },
      { dropAlbumOnNode: true },
    );

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/re-add failed for 1 of 1 album\(s\); original kept/);
    expect(photos.trashCalls).toEqual([]);
  });

  it("keeps a photo whose file type cannot carry a date, uploading nothing", async () => {
    const photos = fakeDrive(
      { "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.webp") },
      { liveBytes: () => Buffer.from("RIFF\0\0\0\0WEBPVP8 the picture", "latin1") },
    );

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r).toMatchObject({ ok: false, error: "this file type cannot carry a new date" });
    expect(photos.uploads).toHaveLength(0);
    expect(photos.trashCalls).toEqual([]);
  });

  it("refuses to replace either half of a live photo alone", async () => {
    const photos = fakeDrive(
      {
        "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg", {
          photo: { tags: [], albums: [], relatedPhotoNodeUids: ["v~uid-video"] },
        }),
      },
      {},
    );

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/live photo/);
    expect(photos.uploads.length).toBe(0);
    expect(photos.trashCalls).toEqual([]);
  });

  it("keeps the original when the upload answers with the photo itself", async () => {
    const photos = fakeDrive(
      { "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg") },
      { newUidOf: (uid) => uid }, // the SDK found the same node already there
    );

    const [r] = await fixDatesFromName(photos, [item]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/upload returned the original photo; original kept/);
    expect(photos.trashCalls).toEqual([]);
  });

  it("never trashes another selected original returned as a duplicate upload", async () => {
    const photos = fakeDrive(
      {
        "v~uid-x": photoNode("v~uid-x", "first.jpg"),
        "v~uid-y": photoNode("v~uid-y", "second.jpg"),
      },
      { newUidOf: (uid) => (uid === "v~uid-x" ? "v~uid-y" : `${uid}-NEW`) },
    );

    const results = await fixDatesFromName(photos, [
      { uid: "v~uid-x", captureTime: NAME_DATE },
      { uid: "v~uid-y", captureTime: NAME_DATE },
    ]);

    expect(results[0]).toMatchObject({ ok: false, error: "upload reused a selected original; originals kept" });
    expect(results[1].ok).toBe(true);
    expect(photos.trashCalls).toEqual([["v~uid-y"]]);
  });

  it("still reports the fix done when the trash of the original is refused", async () => {
    const photos = fakeDrive(
      { "v~uid-x": photoNode("v~uid-x", "IMG_20230115_123456.jpg") },
      { refuseTrashFor: ["v~uid-x"] },
    );

    const [r] = await fixDatesFromName(photos, [item]);

    // Best-effort like the editor's paths: the date is on Drive, a refused trash leaves a
    // recoverable duplicate rather than a lost photo.
    expect(r).toEqual({ uid: "v~uid-x", ok: true });
  });

  it("uses bounded parallel workers and batches album/trash mutations", async () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => {
        const uid = `v~uid-${i}`;
        return [
          uid,
          photoNode(uid, `photo-${i}.jpg`, {
            photo: { tags: [], albums: [{ nodeUid: "album-shared" }] },
          }),
        ];
      }),
    );
    const photos = fakeDrive(nodes, { downloadDelayMs: 20 });
    const results = await fixDatesFromName(
      photos,
      Object.keys(nodes).map((uid) => ({ uid, captureTime: NAME_DATE, expectedSize: 1024 * 1024 })),
      { concurrency: 3, memoryBudgetBytes: 64 * 1024 * 1024 },
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(photos.maxActiveDownloads).toBe(3);
    expect(photos.albumAdds).toHaveLength(1);
    expect(photos.albumAdds[0].uids).toHaveLength(6);
    expect(photos.trashCalls).toHaveLength(1);
    expect(photos.trashCalls[0]).toHaveLength(6);
  });

  it("finishes album and trash work in small sealed windows to cap temporary cloud storage", async () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => {
        const uid = `v~window-${i}`;
        return [
          uid,
          photoNode(uid, `v~window-${i}.jpg`, {
            photo: { tags: [], albums: [{ nodeUid: "album-shared" }] },
          }),
        ];
      }),
    );
    const photos = fakeDrive(nodes, {});
    const results = await fixDatesFromName(
      photos,
      Object.keys(nodes).map((uid) => ({ uid, captureTime: NAME_DATE, expectedSize: 1024 * 1024 })),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    // One window's uploads, memberships and trash complete before the next opens: the
    // 30 photos travel in tight, verified trips, not one wide expedition.
    expect(photos.albumAdds.map((call) => call.uids.length)).toEqual([8, 8, 8, 6]);
    expect(photos.trashCalls.map((call) => call.length)).toEqual([8, 8, 8, 6]);
  });

  it("serializes large files when their estimated memory exceeds the shared budget", async () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => {
        const uid = `v~large-${i}`;
        return [uid, photoNode(uid, `v~large-${i}.jpg`)];
      }),
    );
    const photos = fakeDrive(nodes, { downloadDelayMs: 20 });
    const results = await fixDatesFromName(
      photos,
      Object.keys(nodes).map((uid) => ({ uid, captureTime: NAME_DATE, expectedSize: 160 * 1024 * 1024 })),
      { concurrency: 3, memoryBudgetBytes: 256 * 1024 * 1024 },
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(photos.maxActiveDownloads).toBe(1);
  });

  it("stops claiming new photos on cancellation but finishes active replacements safely", async () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => {
        const uid = `v~cancel-${i}`;
        return [uid, photoNode(uid, `v~cancel-${i}.jpg`)];
      }),
    );
    const photos = fakeDrive(nodes, { downloadDelayMs: 20 });
    let cancel = false;
    const results = await fixDatesFromName(
      photos,
      Object.keys(nodes).map((uid) => ({ uid, captureTime: NAME_DATE, expectedSize: 1024 * 1024 })),
      {
        concurrency: 2,
        shouldCancel: () => cancel,
        onProgress: (status) => {
          if (status.active === 2) cancel = true;
        },
      },
    );

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => result.cancelled)).toHaveLength(4);
    expect(photos.trashCalls).toHaveLength(1);
    expect(photos.trashCalls[0]).toHaveLength(2);
  });

});
