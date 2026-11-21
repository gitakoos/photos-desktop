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

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

import { ProtonSession } from "./session.ts";
import { StallError } from "./stallGuard.ts";

type Answer = { ok: true; thumbnail: Uint8Array } | { ok: false; error: unknown } | "none";

/** How the fake Drive answers for one photo: its type, its original, and its previews by size. */
type Photo = {
  mediaType: string;
  original?: Buffer | Error;
  previews?: Answer[];
};

const httpError = (status: number) => Object.assign(new Error("refused"), { status });
const netError = (code: string) => Object.assign(new Error("network"), { code });
const preview = (bytes = Buffer.from([1, 2, 3])): Answer => ({ ok: true, thumbnail: bytes });
const failed = (error: unknown): Answer => ({ ok: false, error });

/**
 * An SDK client serving `library`; `thumbnailsThrow` makes every preview read of that size (2 large,
 * 1 small) throw its error after answering the photos before `after`. A preview
 * size not given is answered as the SDK answers a photo without one.
 */
function fakePhotos(library: Record<string, Photo>, thumbnailsThrow?: { type: number; error: unknown; after?: number }) {
  return {
    async *iterateNodes(uids: string[]) {
      for (const uid of uids) yield { uid, mediaType: library[uid].mediaType, name: { ok: true, value: "x" } };
    },
    async getFileDownloader(uid: string) {
      const original = library[uid].original;
      if (!original) throw httpError(404);
      if (original instanceof Error) throw original;
      return {
        getClaimedSizeInBytes: () => original.length,
        downloadToStream: (sink: WritableStream<Uint8Array>) => ({
          completion: async () => {
            const writer = sink.getWriter();
            await writer.write(new Uint8Array(original));
            await writer.close();
          },
        }),
      };
    },
    async *iterateThumbnails(uids: string[], type: number) {
      for (const [i, uid] of uids.entries()) {
        if (thumbnailsThrow?.type === type && i >= (thumbnailsThrow.after ?? 0)) throw thumbnailsThrow.error;
        const answer = library[uid].previews?.[type === 2 ? 0 : 1] ?? failed("This item has no image preview");
        if (answer !== "none") yield { nodeUid: uid, ...answer };
      }
    },
  };
}

async function scan(library: Record<string, Photo>, thumbnailsThrow?: { type: number; error: unknown; after?: number }) {
  const session = new ProtonSession();
  const out: { uid: string; bytes: number | null; miss?: unknown }[] = [];
  for await (const got of (session as any).scanPictures(fakePhotos(library, thumbnailsThrow), Object.keys(library))) {
    out.push({ uid: got.uid, bytes: got.bytes ? got.bytes.length : null, ...(got.miss ? { miss: got.miss } : {}) });
  }
  return out;
}

const jpeg = () => sharp({ create: { width: 4, height: 4, channels: 3, background: "#808080" } }).jpeg().toBuffer();

describe("what the scan gets for each photo", () => {
  it("is the original when it downloads", async () => {
    const original = await jpeg();
    expect(await scan({ "vol~a": { mediaType: "image/jpeg", original } })).toEqual([{ uid: "vol~a", bytes: original.length }]);
  });

  it("is a miss that may pass when the original's download drops", async () => {
    const got = await scan({ "vol~a": { mediaType: "image/jpeg", original: netError("ETIMEDOUT"), previews: [preview()] } });
    expect(got).toEqual([{ uid: "vol~a", bytes: null, miss: { kind: "transient", cause: "timeout" } }]);
  });

  it("is the preview when the original is refused", async () => {
    const got = await scan({ "vol~a": { mediaType: "image/jpeg", original: httpError(422), previews: [preview()] } });
    expect(got).toEqual([{ uid: "vol~a", bytes: 3 }]);
  });

  it("is the original's miss when it is refused and there is no preview", async () => {
    const got = await scan({ "vol~a": { mediaType: "image/jpeg", original: httpError(422) } });
    expect(got).toEqual([{ uid: "vol~a", bytes: null, miss: { kind: "transient", cause: "other:http422" } }]);
  });

  it("is a miss that will not pass when the original is gone and there is no preview", async () => {
    const got = await scan({ "vol~a": { mediaType: "image/jpeg", original: httpError(410) } });
    expect(got).toEqual([{ uid: "vol~a", bytes: null, miss: { kind: "permanent", cause: "notFound" } }]);
  });

  it("is a miss that will not pass when an original does not decode and there is no preview", async () => {
    const got = await scan({ "vol~a": { mediaType: "image/jpeg", original: Buffer.from("not a picture") } });
    expect(got).toEqual([{ uid: "vol~a", bytes: null, miss: { kind: "permanent", cause: "undecodable" } }]);
  });

  it("is a video's small preview when it has no large one", async () => {
    const got = await scan({ "vol~v": { mediaType: "video/mp4", previews: [failed(httpError(404)), preview(Buffer.from([9]))] } });
    expect(got).toEqual([{ uid: "vol~v", bytes: 1 }]);
  });

  it("is a miss that may pass when a video's preview read fails for now", async () => {
    const got = await scan({ "vol~v": { mediaType: "video/mp4", previews: [failed(httpError(503))] } });
    expect(got).toEqual([{ uid: "vol~v", bytes: null, miss: { kind: "transient", cause: "server" } }]);
  });

  it("is a miss that may pass for every photo of a preview read that stalls", async () => {
    const got = await scan(
      { "vol~v": { mediaType: "video/mp4" }, "vol~w": { mediaType: "video/mp4" } },
      { type: 2, error: new StallError("iterateThumbnails", 1000) },
    );
    expect(got).toEqual([
      { uid: "vol~v", bytes: null, miss: { kind: "transient", cause: "timeout" } },
      { uid: "vol~w", bytes: null, miss: { kind: "transient", cause: "timeout" } },
    ]);
  });

  it("is a miss that may pass for a photo still due its small preview when that read stalls", async () => {
    const none = failed("This item has no image preview");
    const got = await scan(
      { "vol~v": { mediaType: "video/mp4", previews: [none] }, "vol~w": { mediaType: "video/mp4", previews: [none] } },
      { type: 1, error: new StallError("iterateThumbnails", 1000), after: 1 },
    );
    expect(got).toEqual([
      { uid: "vol~v", bytes: null, miss: { kind: "transient", cause: "metadata" } },
      { uid: "vol~w", bytes: null, miss: { kind: "transient", cause: "timeout" } },
    ]);
  });

  it("is a miss that may pass for a photo the preview read never answered", async () => {
    const got = await scan({ "vol~v": { mediaType: "video/mp4", previews: ["none"] } });
    expect(got).toEqual([{ uid: "vol~v", bytes: null, miss: { kind: "transient", cause: "metadata:unanswered" } }]);
  });

  it("is a metadata miss, tried again, when neither preview size exists", async () => {
    const none = failed("This item has no image preview");
    const got = await scan({ "vol~v": { mediaType: "video/mp4", previews: [none, none] } });
    expect(got).toEqual([{ uid: "vol~v", bytes: null, miss: { kind: "transient", cause: "metadata" } }]);
  });

  it("is a miss that will not pass when the original is empty and there is no preview", async () => {
    const got = await scan({ "vol~a": { mediaType: "image/jpeg", original: Buffer.alloc(0) } });
    expect(got).toEqual([{ uid: "vol~a", bytes: null, miss: { kind: "permanent", cause: "empty" } }]);
  });

  it("is a miss that may pass when a preview's download drops, which the SDK gives as text", async () => {
    const got = await scan({ "vol~v": { mediaType: "video/mp4", previews: [failed("fetch failed")] } });
    expect(got).toEqual([{ uid: "vol~v", bytes: null, miss: { kind: "transient", cause: "network" } }]);
  });
});
