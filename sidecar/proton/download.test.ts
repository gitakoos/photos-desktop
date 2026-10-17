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

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OriginalSealer,
  setDataKey,
  initStore,
  metaGet,
  metaPut,
  storeDir,
} from "./store.ts";
import { isOfflineReady, pinOffline, resetOfflineState } from "./offline.ts";
import {
  VIEW_DIR,
  clearViewDir,
  getOriginal,
  getSaveStatus,
  isViewableOriginal,
  readOriginalBytes,
  releaseOriginal,
  resetDownloadState,
  resolveDurationsBatch,
  resolveMountMetaBatch,
  safeFileName,
  startSaveOriginals,
  withMediaExtension,
  type OriginalStatus,
} from "./download.ts";
import { nodeDurationMs } from "./nodes.ts";

describe("safeFileName", () => {
  // The security property: whatever a (possibly hostile) cloud name is, the result can
  // never carry a path separator, so join(dir, result) can never escape dir.
  it("neutralizes path traversal from a hostile shared-photo name", () => {
    for (const evil of ["..\\..\\..\\evil.jpg", "../../../evil.jpg", "sub\\dir\\p.jpg", "a/b/c.png"]) {
      const out = safeFileName(evil);
      expect(out).not.toMatch(/[\\/]/);
      expect(out).not.toBe("..");
    }
  });

  it("replaces the Windows-illegal characters and control chars", () => {
    expect(safeFileName('a:b*c?d"e<f>g|h.jpg')).toBe("a_b_c_d_e_f_g_h.jpg");
    expect(safeFileName("tab\tname.jpg")).toBe("tab_name.jpg");
  });

  it("strips leading/trailing dots and whitespace, falling back when nothing is left", () => {
    expect(safeFileName("  spaced.jpg  ")).toBe("spaced.jpg");
    expect(safeFileName("..")).toBe("photo");
    expect(safeFileName("   ")).toBe("photo");
    expect(safeFileName("...")).toBe("photo");
  });

  it("leaves an ordinary name untouched", () => {
    expect(safeFileName("IMG_1234.jpg")).toBe("IMG_1234.jpg");
    expect(safeFileName("Anna's birthday (2).heic")).toBe("Anna's birthday (2).heic");
  });

  it("never names a Windows device", () => {
    expect(safeFileName("NUL.jpg")).toBe("_NUL.jpg");
    expect(safeFileName("com1")).toBe("_com1");
    expect(safeFileName("CONCERT.jpg")).toBe("CONCERT.jpg");
    expect(safeFileName("COM10.jpg")).toBe("COM10.jpg");
  });
});

describe("withMediaExtension", () => {
  it("keeps a name that already says it is a photo or a video", () => {
    expect(withMediaExtension("IMG_1.JPG", "image/jpeg")).toBe("IMG_1.JPG");
    expect(withMediaExtension("clip.mov", "video/quicktime")).toBe("clip.mov");
    expect(withMediaExtension("raw.CR3", null)).toBe("raw.CR3");
  });

  it("gives a name that could run something an extension that cannot", () => {
    expect(withMediaExtension("holiday.exe", "image/jpeg")).toBe("holiday.exe.jpg");
    expect(withMediaExtension("invoice.pdf.lnk", "video/mp4")).toBe("invoice.pdf.lnk.mp4");
    expect(withMediaExtension("start.desktop", null)).toBe("start.desktop.jpg");
    expect(withMediaExtension("run.bat", "video/x-something")).toBe("run.bat.mp4");
  });

  it("names a photo that came with no extension by its type", () => {
    expect(withMediaExtension("IMG_0001", "image/heic")).toBe("IMG_0001.heic");
    expect(withMediaExtension(".hidden", "image/png")).toBe(".hidden.png");
  });
});

// A node shaped like the SDK's iterateNodes result: name is a Result, the claimed size
// lives on the active revision. This is the same shape getNode yields, because getNode is
// a one-element iterateNodes internally — so the size resolved here is the same value from
// the same revision the reconcile guard treats as the cloud size.
function fakeNode(uid: string, name: string, mediaType: string | null, claimedSize: number) {
  return {
    uid,
    name: { ok: true, value: name },
    mediaType,
    activeRevision: { ok: true, value: { claimedSize } },
  };
}

// An iterateNodes that records the uid batches it was handed, so a cache hit can be proven
// to avoid the per-node decrypt and a whole page can be proven to fetch in a single call.
function countingPhotos(node: (uid: string) => unknown) {
  const batches: string[][] = [];
  return {
    batches,
    iterateNodes: async function* (uids: string[]) {
      batches.push([...uids]);
      for (const uid of uids) yield node(uid);
    },
  };
}

describe("resolveMountMetaBatch cache-first", () => {
  beforeEach(() => {
    // A fresh key + empty store dir per test isolates each case.
    setDataKey(randomBytes(32));
    initStore(mkdtempSync(join(tmpdir(), "pfp-mount-test-")));
  });

  it("resolves cached entries with a positive size WITHOUT any lookup", async () => {
    metaPut("uid-A", { name: "beach.jpg", mediaType: "image/jpeg", size: 12345 });
    metaPut("uid-B", { name: "hill.jpg", mediaType: "image/jpeg", size: 67890 });
    const photos = countingPhotos(() => {
      throw new Error("iterateNodes must not be called on a full cache hit");
    });

    const r = await resolveMountMetaBatch(photos, ["uid-A", "uid-B"]);

    expect(photos.batches).toEqual([]); // zero decrypts on a warm run
    expect(r.get("uid-A")).toEqual({ name: "beach.jpg", size: 12345, mediaType: "image/jpeg" });
    expect(r.get("uid-B")).toEqual({ name: "hill.jpg", size: 67890, mediaType: "image/jpeg" });
  });

  it("fetches a page's misses in ONE batch and writes the claimedSize back", async () => {
    const photos = countingPhotos((uid) =>
      fakeNode(uid, `${uid}.mp4`, "video/mp4", uid === "uid-B" ? 98765 : 4444),
    );

    const r = await resolveMountMetaBatch(photos, ["uid-B", "uid-C"]);

    // Both misses went out in a single call, not one round-trip per uid.
    expect(photos.batches).toEqual([["uid-B", "uid-C"]]);
    expect(r.get("uid-B")).toEqual({ name: "uid-B.mp4", size: 98765, mediaType: "video/mp4" });
    expect(r.get("uid-C")).toEqual({ name: "uid-C.mp4", size: 4444, mediaType: "video/mp4" });
    // Written back with the real claimedSize AND media type, so a later mount pass and the
    // search index both reuse it. These nodes carry no Media block, so the length is
    // recorded as a zero: asked once, never asked again.
    expect(metaGet("uid-B")).toEqual({
      name: "uid-B.mp4",
      mediaType: "video/mp4",
      size: 98765,
      durationMs: 0,
    });

    // A second resolve is now a pure cache hit: no further lookup.
    const again = await resolveMountMetaBatch(photos, ["uid-B", "uid-C"]);
    expect(photos.batches).toEqual([["uid-B", "uid-C"]]); // unchanged
    expect(again.get("uid-B")).toEqual({ name: "uid-B.mp4", size: 98765, mediaType: "video/mp4" });
  });

  it("mixes cache hits and misses, fetching only the misses", async () => {
    metaPut("uid-A", { name: "beach.jpg", mediaType: "image/jpeg", size: 12345 });
    const photos = countingPhotos((uid) => fakeNode(uid, "new.heic", "image/heic", 555));

    const r = await resolveMountMetaBatch(photos, ["uid-A", "uid-NEW"]);

    expect(photos.batches).toEqual([["uid-NEW"]]); // only the miss was fetched
    expect(r.get("uid-A")).toEqual({ name: "beach.jpg", size: 12345, mediaType: "image/jpeg" });
    expect(r.get("uid-NEW")).toEqual({ name: "new.heic", size: 555, mediaType: "image/heic" });
  });

  it("does NOT trust a search-index entry (name only, no size); re-fetches for the size", async () => {
    // getMetadata may cache { name, mediaType } with no size. The mount must still fetch to
    // obtain the exact claimedSize the reconcile size-match guard depends on, then upgrade
    // the entry so it never fetches for it again.
    metaPut("uid-C", { name: "photo.heic", mediaType: "image/heic" });
    const photos = countingPhotos((uid) => fakeNode(uid, "photo.heic", "image/heic", 555));

    const r = await resolveMountMetaBatch(photos, ["uid-C"]);

    expect(photos.batches).toEqual([["uid-C"]]); // size was missing, so it fetched
    expect(r.get("uid-C")).toEqual({ name: "photo.heic", size: 555, mediaType: "image/heic" });
    expect(metaGet("uid-C")?.size).toBe(555); // upgraded with the real cloud size
  });

  it("omits a node with no positive-size revision and never caches a zero", async () => {
    const photos = countingPhotos((uid) => fakeNode(uid, "empty.bin", null, 0));

    const r = await resolveMountMetaBatch(photos, ["uid-D"]);

    expect(r.has("uid-D")).toBe(false);
    expect(metaGet("uid-D")).toBeNull(); // a zero size is never cached
  });

  it("omits a uid the lookup reports as missing (vanished server-side)", async () => {
    const photos = {
      iterateNodes: async function* (uids: string[]) {
        for (const uid of uids) yield { missingUid: uid };
      },
    };

    const r = await resolveMountMetaBatch(photos, ["uid-GONE"]);

    expect(r.has("uid-GONE")).toBe(false);
    expect(metaGet("uid-GONE")).toBeNull();
  });

  it("keeps the sizes it resolved before a mid-batch error", async () => {
    // A lookup that throws partway must not lose the nodes it already yielded.
    const photos = {
      iterateNodes: async function* (_uids: string[]) {
        yield fakeNode("uid-OK", "kept.jpg", "image/jpeg", 321);
        throw new Error("network blip");
      },
    };

    const r = await resolveMountMetaBatch(photos, ["uid-OK", "uid-LOST"]);

    expect(r.get("uid-OK")).toEqual({ name: "kept.jpg", size: 321, mediaType: "image/jpeg" });
    expect(r.has("uid-LOST")).toBe(false);
    expect(metaGet("uid-OK")?.size).toBe(321); // the resolved one was still persisted
  });
});

// A node carrying the decrypted extended attributes the SDK exposes as
// `claimedAdditionalMetadata`: the whole attribute blob minus its Common block, so the
// Media sub-object sits at the top. `duration` is what Drive stores there — SECONDS.
function videoNode(uid: string, duration: unknown, key = "Duration", block = "Media") {
  return {
    uid,
    name: { ok: true, value: `${uid}.mp4` },
    mediaType: "video/mp4",
    activeRevision: {
      ok: true,
      value: {
        claimedSize: 5000,
        claimedAdditionalMetadata: { [block]: { Width: 1920, Height: 1080, [key]: duration } },
      },
    },
  };
}

describe("nodeDurationMs reads Drive's SECONDS", () => {
  // The one mistake this conversion exists to prevent, in both directions: a 7.5 taken
  // for milliseconds is seven and a half thousandths of a second and the pill reads
  // 0:00, while a length already in milliseconds fed back through would read 2:04:10.
  it("scales fractional seconds to milliseconds", () => {
    expect(nodeDurationMs(videoNode("v", 7.5))).toBe(7500);
  });

  it("does NOT treat the value as milliseconds", () => {
    // 7.5 as milliseconds would round to 8, or truncate to 0 seconds on the way out.
    expect(nodeDurationMs(videoNode("v", 7.5))).not.toBe(8);
    expect(nodeDurationMs(videoNode("v", 7.5))).toBeGreaterThan(1000);
  });

  it("keeps a real two-hour video two hours, not two thousand", () => {
    // 7425 s = 2 h 03 m 45 s. Read as milliseconds it would collapse to 7.4 seconds;
    // multiplied a second time it would claim 85 days.
    expect(nodeDurationMs(videoNode("v", 7425))).toBe(7_425_000);
  });

  it("accepts a whole-number and a string-encoded length", () => {
    expect(nodeDurationMs(videoNode("v", 12))).toBe(12_000);
    expect(nodeDurationMs(videoNode("v", "12.25"))).toBe(12_250);
  });

  it("reads the lower-cased and the flattened spellings other clients write", () => {
    expect(nodeDurationMs(videoNode("v", 3, "duration", "media"))).toBe(3000);
    expect(
      nodeDurationMs({
        uid: "v",
        activeRevision: { ok: true, value: { claimedAdditionalMetadata: { Duration: 3 } } },
      }),
    ).toBe(3000);
  });

  it("returns null for an image, a zero, a negative and a malformed value", () => {
    expect(nodeDurationMs(fakeNode("i", "beach.jpg", "image/jpeg", 100))).toBeNull();
    expect(nodeDurationMs(videoNode("v", 0))).toBeNull();
    expect(nodeDurationMs(videoNode("v", -5))).toBeNull();
    expect(nodeDurationMs(videoNode("v", "not a number"))).toBeNull();
    expect(nodeDurationMs(videoNode("v", null))).toBeNull();
    expect(nodeDurationMs({ uid: "v" })).toBeNull();
  });
});

describe("resolveDurationsBatch cache-first", () => {
  beforeEach(() => {
    setDataKey(randomBytes(32));
    initStore(mkdtempSync(join(tmpdir(), "pfp-dur-test-")));
  });

  it("fetches a screenful of videos in ONE batch and caches each length", async () => {
    const photos = countingPhotos((uid) => videoNode(uid, uid === "uid-A" ? 7.5 : 90));

    const r = await resolveDurationsBatch(photos, ["uid-A", "uid-B"]);

    expect(photos.batches).toEqual([["uid-A", "uid-B"]]); // one call, not one per tile
    expect(r.get("uid-A")).toBe(7500);
    expect(r.get("uid-B")).toBe(90_000);
    expect(metaGet("uid-A")?.durationMs).toBe(7500);
  });

  it("answers a warm cache with NO lookup at all", async () => {
    metaPut("uid-A", { name: "clip.mp4", mediaType: "video/mp4", durationMs: 7500 });
    const photos = countingPhotos((uid) => videoNode(uid, 1));

    const r = await resolveDurationsBatch(photos, ["uid-A"]);

    expect(photos.batches).toEqual([]);
    expect(r.get("uid-A")).toBe(7500);
  });

  it("reuses what the mount already decrypted, so no node is decrypted twice", async () => {
    // The mount pass and this resolver share one cache entry: whichever runs first pays
    // for the decrypt and the other finds the answer on disk.
    const photos = countingPhotos((uid) => videoNode(uid, 42));
    await resolveMountMetaBatch(photos, ["uid-A"]);
    expect(photos.batches).toEqual([["uid-A"]]);

    const r = await resolveDurationsBatch(photos, ["uid-A"]);

    expect(photos.batches).toEqual([["uid-A"]]); // unchanged: no second decrypt
    expect(r.get("uid-A")).toBe(42_000);
  });

  it("remembers that a node has no length, and never asks about it again", async () => {
    const photos = countingPhotos((uid) => fakeNode(uid, "beach.jpg", "image/jpeg", 100));

    const first = await resolveDurationsBatch(photos, ["uid-IMG"]);
    expect(first.has("uid-IMG")).toBe(false);
    expect(metaGet("uid-IMG")?.durationMs).toBe(0); // resolved, and there is nothing there

    await resolveDurationsBatch(photos, ["uid-IMG"]);
    expect(photos.batches).toEqual([["uid-IMG"]]); // still just the one lookup
  });

  it("never writes a zero size over the cloud size the mount reads", async () => {
    const photos = countingPhotos((uid) => ({
      uid,
      name: { ok: true, value: "clip.mp4" },
      mediaType: "video/mp4",
      activeRevision: { ok: true, value: { claimedAdditionalMetadata: { Media: { Duration: 4 } } } },
    }));

    await resolveDurationsBatch(photos, ["uid-A"]);

    expect(metaGet("uid-A")?.durationMs).toBe(4000);
    expect(metaGet("uid-A")?.size).toBeUndefined();
  });

  it("keeps what it resolved before a mid-batch error", async () => {
    const photos = {
      iterateNodes: async function* (_uids: string[]) {
        yield videoNode("uid-OK", 30);
        throw new Error("network blip");
      },
    };

    const r = await resolveDurationsBatch(photos, ["uid-OK", "uid-LOST"]);

    expect(r.get("uid-OK")).toBe(30_000);
    expect(r.has("uid-LOST")).toBe(false);
    expect(metaGet("uid-LOST")).toBeNull(); // uncached, so it is asked for again later
  });

  it("omits a uid the lookup reports as missing", async () => {
    const photos = {
      iterateNodes: async function* (uids: string[]) {
        for (const uid of uids) yield { missingUid: uid };
      },
    };

    const r = await resolveDurationsBatch(photos, ["uid-GONE"]);

    expect(r.has("uid-GONE")).toBe(false);
    expect(metaGet("uid-GONE")).toBeNull();
  });
});

// A photos stand-in for the save-to-folder path: each getFileDownloader streams a few
// bytes into the WritableStream the engine hands it, unless the uid is one we fail.
function savePhotos(failUids: Set<string>) {
  return {
    getNode: async (uid: string) => ({
      name: { ok: true, value: `${uid}.jpg` },
      photo: { captureTime: "2024-01-02T03:04:05Z" },
    }),
    getFileDownloader: async (uid: string) => ({
      downloadToStream: (stream: WritableStream<Uint8Array>) => ({
        completion: async () => {
          if (failUids.has(uid)) throw new Error("download failed");
          const writer = stream.getWriter();
          await writer.write(new Uint8Array([1, 2, 3, 4]));
          await writer.close();
        },
      }),
    }),
  };
}

/** Wait for the background save loop to finish, without leaning on wall-clock timing. */
async function waitForSave(): Promise<void> {
  for (let i = 0; i < 2000 && getSaveStatus().running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("startSaveOriginals background save", () => {
  beforeEach(() => resetDownloadState());

  it("marks the run running with the full total, then climbs done→total and stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-save-"));

    startSaveOriginals(savePhotos(new Set()), ["a", "b", "c"], dir);
    // Synchronously running with the total known and nothing done yet, so the UI's
    // first poll already shows a determinate 0/N rather than a blank spinner.
    expect(getSaveStatus()).toEqual({ running: true, total: 3, done: 0, failed: 0 });

    await waitForSave();

    expect(getSaveStatus()).toEqual({ running: false, total: 3, done: 3, failed: 0 });
    expect(readdirSync(dir).sort()).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("counts a per-file failure without sinking the batch, and leaves no partial file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-save-"));

    startSaveOriginals(savePhotos(new Set(["b"])), ["a", "b", "c"], dir);
    await waitForSave();

    expect(getSaveStatus()).toEqual({ running: false, total: 3, done: 2, failed: 1 });
    // The good files are on disk; the failed one cleaned up after itself.
    expect(readdirSync(dir).sort()).toEqual(["a.jpg", "c.jpg"]);
  });

  it("resetDownloadState clears a finished run so it never leaks into the next", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-save-"));

    startSaveOriginals(savePhotos(new Set()), ["a"], dir);
    await waitForSave();
    expect(getSaveStatus().done).toBe(1);

    resetDownloadState();
    expect(getSaveStatus()).toEqual({ running: false, total: 0, done: 0, failed: 0 });
  });
});

// ---- Full-resolution originals for the viewer ----

describe("isViewableOriginal", () => {
  it("accepts the formats the webview can draw", () => {
    expect(isViewableOriginal("image/jpeg", "beach.jpg")).toBe(true);
    expect(isViewableOriginal("image/png", "chart.png")).toBe(true);
    expect(isViewableOriginal("image/webp", "shot.webp")).toBe(true);
    expect(isViewableOriginal("image/avif", "shot.avif")).toBe(true);
    expect(isViewableOriginal("image/gif", "loop.gif")).toBe(true);
    expect(isViewableOriginal("image/bmp", "old.bmp")).toBe(true);
  });

  it("refuses the formats it cannot, so their preview is kept instead", () => {
    // Downloading these would spend the bandwidth and still leave a broken image.
    expect(isViewableOriginal("image/heic", "IMG_1.heic")).toBe(false);
    expect(isViewableOriginal("image/heif", "IMG_2.heif")).toBe(false);
    expect(isViewableOriginal("image/x-canon-cr2", "raw.cr2")).toBe(false);
    expect(isViewableOriginal("image/x-nikon-nef", "raw.nef")).toBe(false);
    expect(isViewableOriginal("image/x-adobe-dng", "raw.dng")).toBe(false);
    expect(isViewableOriginal("image/tiff", "scan.tif")).toBe(false);
    // Left off deliberately: the one image type that carries markup.
    expect(isViewableOriginal("image/svg+xml", "logo.svg")).toBe(false);
    // Videos have their own path entirely.
    expect(isViewableOriginal("video/mp4", "clip.mp4")).toBe(false);
  });

  it("falls back to the extension when the media type is missing or generic", () => {
    // A photo stored without a media type still upgrades ...
    expect(isViewableOriginal(null, "beach.jpg")).toBe(true);
    expect(isViewableOriginal(undefined, "beach.PNG")).toBe(true);
    expect(isViewableOriginal("", "beach.jpeg")).toBe(true);
    // ... and so does one whose media type says nothing useful.
    expect(isViewableOriginal("application/octet-stream", "beach.jpg")).toBe(true);
    // But neither signal recognising it is still a no.
    expect(isViewableOriginal(null, "mystery")).toBe(false);
    expect(isViewableOriginal(null, "IMG_1.heic")).toBe(false);
    expect(isViewableOriginal("application/octet-stream", "raw.cr2")).toBe(false);
  });

  it("reads a media type carrying parameters, and ignores case", () => {
    expect(isViewableOriginal("image/jpeg; charset=binary", "x")).toBe(true);
    expect(isViewableOriginal("IMAGE/JPEG", "x")).toBe(true);
  });
});

/**
 * A photos stand-in for the viewer's original fetch. Records every uid it was asked to
 * download, so a format that must never be fetched can be proven never to have been.
 *
 * `claimed` is what the downloader reports its size to be, which is what picks the
 * route. The default of 0 is "unknown", the case that must take the staged file.
 */
function viewPhotos(
  nodes: Record<string, { name: string; mediaType: string | null }>,
  bytes = 64,
  claimed = 0,
) {
  const downloaded: string[] = [];
  return {
    downloaded,
    getNode: async (uid: string) => {
      const n = nodes[uid];
      if (!n) throw new Error("no such node");
      return { uid, name: { ok: true, value: n.name }, mediaType: n.mediaType };
    },
    getFileDownloader: async (uid: string) => {
      downloaded.push(uid);
      return {
        getClaimedSizeInBytes: () => claimed,
        downloadToStream: (stream: WritableStream<Uint8Array>) => ({
          completion: async () => {
            const writer = stream.getWriter();
            // In pieces, the way a real transfer arrives, so a route that switches
            // partway is exercised at the boundary rather than in one write.
            const CHUNK = 4 * 1024 * 1024;
            for (let at = 0; at < bytes; at += CHUNK) {
              await writer.write(new Uint8Array(Math.min(CHUNK, bytes - at)).fill(7));
            }
            await writer.close();
          },
        }),
      };
    },
  };
}

/** Narrow a settled status to the staged-file route, failing the test if it is not. */
function stagedFile(status: OriginalStatus): { path: string; size: number } {
  if (status.state !== "ready" || status.via !== "file") {
    throw new Error(`expected the staged-file route, got state=${status.state}`);
  }
  return status;
}

/** Poll the way the viewer does, until the transfer settles. */
async function settleOriginal(photos: any, uid: string): Promise<OriginalStatus> {
  let status = await getOriginal(photos, uid);
  for (let i = 0; i < 2000 && status.state === "loading"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    status = await getOriginal(photos, uid);
  }
  return status;
}

describe("getOriginal / releaseOriginal", () => {
  beforeEach(() => {
    releaseOriginal();
    clearViewDir();
  });

  it("streams the original into the staging folder and reports its size", async () => {
    const photos = viewPhotos({ "uid-A": { name: "beach.jpg", mediaType: "image/jpeg" } }, 128);

    const status = await settleOriginal(photos, "uid-A");

    const ready = stagedFile(status);
    expect(ready.size).toBe(128);
    // Staged in the one folder the asset protocol is scoped to, and nowhere else.
    expect(ready.path.startsWith(VIEW_DIR)).toBe(true);
    // The bytes on disk are the photo's own, whole.
    expect(readFileSync(ready.path).length).toBe(128);
    // The staged name carries the real extension, never the photo's own name.
    expect(ready.path.endsWith(".jpg")).toBe(true);
    expect(ready.path).not.toContain("beach");
  });

  it("answers unsupported WITHOUT downloading anything", async () => {
    const photos = viewPhotos({ "uid-H": { name: "IMG_1.heic", mediaType: "image/heic" } });

    const status = await settleOriginal(photos, "uid-H");

    expect(status.state).toBe("unsupported");
    // The whole point: a library of these costs nothing beyond the node lookup. Not one
    // byte is fetched, and the staging folder is not so much as created.
    expect(photos.downloaded).toEqual([]);
    expect(existsSync(VIEW_DIR)).toBe(false);
  });

  it("DELETES the staged file when the viewer moves off the photo", async () => {
    const photos = viewPhotos({ "uid-A": { name: "beach.jpg", mediaType: "image/jpeg" } });

    const status = await settleOriginal(photos, "uid-A");
    const ready = stagedFile(status);
    expect(existsSync(ready.path)).toBe(true);

    releaseOriginal("uid-A");

    // A decrypted photo does not outlive the view of it.
    expect(existsSync(ready.path)).toBe(false);
    expect(readdirSync(VIEW_DIR).length).toBe(0);
  });

  it("keeps exactly one original: the next photo's fetch removes the last one's file", async () => {
    const photos = viewPhotos({
      "uid-A": { name: "a.jpg", mediaType: "image/jpeg" },
      "uid-B": { name: "b.jpg", mediaType: "image/jpeg" },
    });

    const first = stagedFile(await settleOriginal(photos, "uid-A"));
    const second = stagedFile(await settleOriginal(photos, "uid-B"));

    expect(existsSync(first.path)).toBe(false); // displaced and deleted
    expect(existsSync(second.path)).toBe(true);
    expect(readdirSync(VIEW_DIR)).toHaveLength(1); // never a pile
  });

  it("a release naming another photo leaves the current one alone", async () => {
    const photos = viewPhotos({ "uid-B": { name: "b.jpg", mediaType: "image/jpeg" } });

    const ready = stagedFile(await settleOriginal(photos, "uid-B"));

    // A late release for the photo just stepped away from must not take this one.
    releaseOriginal("uid-A");
    expect(existsSync(ready.path)).toBe(true);

    releaseOriginal("uid-B");
    expect(existsSync(ready.path)).toBe(false);
  });

  it("re-asking for the same photo reuses the transfer instead of downloading twice", async () => {
    const photos = viewPhotos({ "uid-A": { name: "a.jpg", mediaType: "image/jpeg" } });

    await settleOriginal(photos, "uid-A");
    await getOriginal(photos, "uid-A");
    await getOriginal(photos, "uid-A");

    // The viewer polls this one method, so it must be idempotent per photo.
    expect(photos.downloaded).toEqual(["uid-A"]);
  });

  it("reports an error and stages nothing when the transfer fails", async () => {
    const photos = {
      getNode: async () => ({ name: { ok: true, value: "a.jpg" }, mediaType: "image/jpeg" }),
      getFileDownloader: async () => ({
        downloadToStream: () => ({
          completion: async () => {
            throw new Error("network blip");
          },
        }),
      }),
    };

    const status = await settleOriginal(photos, "uid-A");

    expect(status.state).toBe("error");
    // A failed transfer leaves no partial plaintext behind.
    expect(readdirSync(VIEW_DIR).length).toBe(0);
  });

  it("keeps an ordinary photo in memory: nothing decrypted reaches the disk", async () => {
    // 128 bytes, and the downloader says so, so this takes the in-memory route.
    const photos = viewPhotos({ "uid-A": { name: "beach.jpg", mediaType: "image/jpeg" } }, 128, 128);

    const status = await settleOriginal(photos, "uid-A");

    expect(status.state).toBe("ready");
    if (status.state !== "ready" || status.via !== "memory") {
      throw new Error("expected the in-memory route");
    }
    expect(status.size).toBe(128);
    expect(status.mime).toBe("image/jpeg");
    // The whole point of this route: the staging folder is not even created.
    expect(existsSync(VIEW_DIR)).toBe(false);

    // The token redeems the photo's own bytes, whole.
    const served = readOriginalBytes(status.token);
    expect(served?.mime).toBe("image/jpeg");
    expect(Buffer.from(served!.base64, "base64").length).toBe(128);
  });

  it("refuses a token that is not the one in view", async () => {
    const photos = viewPhotos(
      { "uid-A": { name: "a.jpg", mediaType: "image/jpeg" }, "uid-B": { name: "b.jpg", mediaType: "image/jpeg" } },
      128,
      128,
    );
    const first = await settleOriginal(photos, "uid-A");
    if (first.state !== "ready" || first.via !== "memory") throw new Error("expected memory");

    // A URL the webview kept from the previous photo must resolve to nothing rather
    // than to whatever is staged now.
    await settleOriginal(photos, "uid-B");
    expect(readOriginalBytes(first.token)).toBeNull();
    expect(readOriginalBytes("not-a-token")).toBeNull();

    // And a release leaves nothing to redeem at all.
    const second = await getOriginal(photos, "uid-B");
    if (second.state !== "ready" || second.via !== "memory") throw new Error("expected memory");
    releaseOriginal("uid-B");
    expect(readOriginalBytes(second.token)).toBeNull();
  });

  it("stages a file for a photo too large to hand over the channel", async () => {
    // Claims 32 MiB, past the in-memory ceiling, so it takes the staged file.
    const photos = viewPhotos(
      { "uid-A": { name: "huge.jpg", mediaType: "image/jpeg" } },
      256,
      32 * 1024 * 1024,
    );

    const ready = stagedFile(await settleOriginal(photos, "uid-A"));

    expect(ready.path.startsWith(VIEW_DIR)).toBe(true);
    expect(readFileSync(ready.path).length).toBe(256);
  });

  it("spills to a file when the claimed size was wrong", async () => {
    // Claims to be small, then delivers 20 MiB. Rather than fail the upgrade, the
    // transfer carries what it buffered to disk and finishes there.
    const big = 20 * 1024 * 1024;
    const photos = viewPhotos({ "uid-A": { name: "a.jpg", mediaType: "image/jpeg" } }, big, 1000);

    const ready = stagedFile(await settleOriginal(photos, "uid-A"));

    expect(ready.size).toBe(big);
    expect(readFileSync(ready.path).length).toBe(big);
  });

  it("locking the account empties the staging folder", async () => {
    const photos = viewPhotos({ "uid-A": { name: "a.jpg", mediaType: "image/jpeg" } });

    const status = await settleOriginal(photos, "uid-A");
    const ready = stagedFile(status);
    expect(existsSync(ready.path)).toBe(true);

    resetDownloadState(); // what the session calls when it locks

    expect(existsSync(ready.path)).toBe(false);
    expect(existsSync(VIEW_DIR)).toBe(false);
  });
});

// "Available offline" exists so a pinned photo opens with the network away entirely,
// which is the state the user pinned it for. Past the in-memory cap it cannot be handed
// over the channel, so it is staged as a file rather than fetched again: the host's cap
// holds and the photo still opens from the disk alone.
//
// These live here rather than beside the other pin tests because they stage real files,
// and VIEW_DIR is one fixed path shared by the whole process. Tests inside a file run in
// order, so staging cannot race the assertion that the folder is never created; across
// files it would.
describe("a pinned original past the in-memory cap", () => {
  // Bigger than MAX_INMEMORY_ORIGINAL, with a random head so the decrypt is checked
  // against real content rather than a repeating fill.
  const big = Buffer.concat([randomBytes(4096), Buffer.alloc(17 * 1024 * 1024, 0x7a)]);

  // Every call that would reach the network throws, so a photo served any other way
  // than from disk fails these tests instead of quietly passing on a machine online.
  const noNetwork = {
    getNode: async () => {
      throw new Error("no network");
    },
    getFileDownloader: async () => {
      throw new Error("no network");
    },
  };

  // Each case decrypts the whole original to disk, so these move real megabytes. The
  // pin is therefore sealed once for the group rather than per case, and each is given
  // room well past vitest's default: the work itself settles in tens of milliseconds,
  // but a Windows temp disk flushing this much behind several parallel workers can stall
  // a close for seconds, and that is the machine, not the code.
  const IO_HEAVY_MS = 30_000;
  let blobPath: string;

  beforeAll(async () => {
    resetOfflineState();
    setDataKey(randomBytes(32));
    initStore(mkdtempSync(join(tmpdir(), "pfp-offline-view-test-")));

    // What a settled pin leaves behind: the sealed original, its metadata, and the uid
    // on the list. Sealed directly, so the pin queue finds nothing left to fetch and
    // never reaches for a client at all.
    const sealer = new OriginalSealer("uid-big");
    for (let at = 0; at < big.length; at += 1 << 20) {
      await sealer.write(big.subarray(at, at + (1 << 20)));
    }
    await sealer.finish();
    metaPut("uid-big", { name: "panorama.png", mediaType: "image/png" });
    pinOffline(noNetwork, ["uid-big"]);
    const blobs = join(storeDir(), "originals");
    blobPath = join(blobs, readdirSync(blobs)[0]);
  }, IO_HEAVY_MS);

  beforeEach(() => {
    releaseOriginal();
    clearViewDir();
    expect(isOfflineReady("uid-big")).toBe(true);
  });

  it(
    "opens it from disk by the staged-file route, with NO network at all",
    async () => {
      const status = await settleOriginal(noNetwork, "uid-big");

      const ready = stagedFile(status);
      // Full resolution, byte for byte, and staged in the one folder the asset protocol
      // is scoped to.
      expect(ready.size).toBe(big.length);
      expect(ready.path.startsWith(VIEW_DIR)).toBe(true);
      expect(readFileSync(ready.path).equals(big)).toBe(true);
    },
    IO_HEAVY_MS,
  );

  it(
    "deletes the staged file when the viewer moves off, like any other",
    async () => {
      const ready = stagedFile(await settleOriginal(noNetwork, "uid-big"));
      expect(existsSync(ready.path)).toBe(true);

      releaseOriginal();

      expect(existsSync(ready.path)).toBe(false);
    },
    IO_HEAVY_MS,
  );

  it(
    "is swept when the account locks",
    async () => {
      const ready = stagedFile(await settleOriginal(noNetwork, "uid-big"));

      resetDownloadState(); // what the session calls when it locks

      expect(existsSync(ready.path)).toBe(false);
      expect(existsSync(VIEW_DIR)).toBe(false);
    },
    IO_HEAVY_MS,
  );

  // Declared last on purpose: it corrupts the original the group shares.
  it(
    "leaves nothing staged when the stored blob turns out to be unreadable",
    async () => {
      // Corrupted in place, so it still measures over the cap and still takes the staged
      // route. GCM only authenticates at the very end, so by the time this is caught the
      // decrypt has already written megabytes of plaintext. None of it may survive.
      const blob = readFileSync(blobPath);
      blob[blob.length >> 1] ^= 0xff;
      writeFileSync(blobPath, blob);

      const status = await settleOriginal(noNetwork, "uid-big");

      expect(status.state).toBe("error");
      expect(readdirSync(VIEW_DIR)).toHaveLength(0);
    },
    IO_HEAVY_MS,
  );
});
