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

import { describe, it, expect, afterEach, vi } from "vitest";
import { request } from "node:http";

import { startThumbServer, stopThumbServer } from "./thumbServer.ts";
import { videoFromBytes, type VideoSource } from "./videoStream.ts";

const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const UID = "dm9sdW1l~bGluaw==";
const source = async (uid: string) => (uid === UID ? PHOTO : null);

/** A raw GET, so the method and the Host header can be anything a caller might send. */
function get(url: string, options: { method?: string; host?: string; range?: string } = {}) {
  const target = new URL(url);
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: options.method ?? "GET",
          headers: {
            ...(options.host ? { Host: options.host } : {}),
            ...(options.range ? { Range: options.range } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

afterEach(async () => {
  await stopThumbServer();
});

describe("the loopback thumbnail server", () => {
  it("serves a thumbnail to a request with the token, and tells the webview not to keep it", async () => {
    const base = await startThumbServer(source);

    const res = await get(base + encodeURIComponent(UID));

    expect(base.startsWith("http://127.0.0.1:")).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body.equals(PHOTO)).toBe(true);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a wrong token, and one from before the last start", async () => {
    const old = await startThumbServer(source);
    const base = await startThumbServer(source);
    const wrong = base.replace(/\/t\/[^/]+\//, `/t/${Buffer.alloc(32, 7).toString("base64url")}/`);

    expect((await get(wrong + encodeURIComponent(UID))).status).toBe(403);
    expect((await get(old + encodeURIComponent(UID))).status).toBe(403);
    expect((await get(base + encodeURIComponent(UID))).status).toBe(200);
  });

  it("refuses another Host, which is what a rebound web address would send", async () => {
    const base = await startThumbServer(source);

    const res = await get(base + encodeURIComponent(UID), { host: "evil.example:80" });

    expect(res.status).toBe(403);
    expect(res.body.length).toBe(0);
  });

  it("answers nothing but GET, and nothing that is not a uid", async () => {
    const base = await startThumbServer(source);

    expect((await get(base + encodeURIComponent(UID), { method: "POST" })).status).toBe(405);
    expect((await get(base + "..%2F..%2Fsecret")).status).toBe(404);
    expect((await get(base + encodeURIComponent("unknown~uid"))).status).toBe(404);
  });

  it("tells the source when the webview stops waiting, so a tile scrolled away is not fetched", async () => {
    let seen: AbortSignal | null = null;
    const base = await startThumbServer(
      (_uid, gone) =>
        new Promise((resolve) => {
          seen = gone;
          gone.addEventListener("abort", () => resolve(null));
        }),
    );
    const target = new URL(base + encodeURIComponent(UID));
    const req = request({ hostname: target.hostname, port: target.port, path: target.pathname });
    req.on("error", () => {});
    req.end();
    await vi.waitFor(() => expect(seen).not.toBeNull());

    req.destroy();

    await vi.waitFor(() => expect(seen!.aborted).toBe(true));
  });

  it("serves a cover cut to a face, with the same token and no-store", async () => {
    const CUT = Buffer.from([0xff, 0xd8, 9, 9]);
    const asked: unknown[] = [];
    const base = await startThumbServer(source, async (uid, box) => {
      asked.push([uid, box]);
      return CUT;
    });

    const res = await get(base + encodeURIComponent(UID) + "/f/0.1,0.2,0.3,0.4");

    expect(res.status).toBe(200);
    expect(res.body.equals(CUT)).toBe(true);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(asked).toEqual([[UID, [0.1, 0.2, 0.3, 0.4]]]);
  });

  it("refuses a face cover with a bad box, a wrong token, or no face source", async () => {
    const faces = async () => Buffer.from([1]);
    const base = await startThumbServer(source, faces);
    const wrong = base.replace(/\/t\/[^/]+\//, `/t/${Buffer.alloc(32, 7).toString("base64url")}/`);

    expect((await get(base + encodeURIComponent(UID) + "/f/0.5,0.2,0.3,0.4")).status).toBe(404);
    expect((await get(base + encodeURIComponent(UID) + "/f/x")).status).toBe(404);
    expect((await get(base + encodeURIComponent(UID) + "/g/0.1,0.2,0.3,0.4")).status).toBe(404);
    expect((await get(wrong + encodeURIComponent(UID) + "/f/0.1,0.2,0.3,0.4")).status).toBe(403);

    const plain = await startThumbServer(source);
    expect((await get(plain + encodeURIComponent(UID) + "/f/0.1,0.2,0.3,0.4")).status).toBe(404);
  });

  describe("a video", () => {
    const CLIP = Buffer.from(Array.from({ length: 600_000 }, (_, i) => i % 253));
    const videos = async (uid: string): Promise<VideoSource | null> =>
      uid === UID ? videoFromBytes(CLIP, "video/mp4") : null;

    it("answers a range with 206 and where it sits in the file", async () => {
      const base = await startThumbServer(source, undefined, videos);
      const res = await get(base + encodeURIComponent(UID) + "/v", { range: "bytes=1000-1999" });
      expect(res.status).toBe(206);
      expect(res.headers["content-range"]).toBe(`bytes 1000-1999/${CLIP.length}`);
      expect(res.headers["content-length"]).toBe("1000");
      expect(res.headers["accept-ranges"]).toBe("bytes");
      expect(res.headers["content-type"]).toBe("video/mp4");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.equals(CLIP.subarray(1000, 2000))).toBe(true);
    });

    it("answers the whole video without a range, and says ranges may be asked for", async () => {
      const base = await startThumbServer(source, undefined, videos);
      const res = await get(base + encodeURIComponent(UID) + "/v");
      expect(res.status).toBe(200);
      expect(res.headers["accept-ranges"]).toBe("bytes");
      expect(res.body.equals(CLIP)).toBe(true);
    });

    it("refuses a range past the end with 416 and the size", async () => {
      const base = await startThumbServer(source, undefined, videos);
      const res = await get(base + encodeURIComponent(UID) + "/v", { range: `bytes=${CLIP.length}-` });
      expect(res.status).toBe(416);
      expect(res.headers["content-range"]).toBe(`bytes */${CLIP.length}`);
    });

    it("answers HEAD for a video with its size and nothing else, and refuses HEAD for a thumbnail", async () => {
      const base = await startThumbServer(source, undefined, videos);
      const res = await get(base + encodeURIComponent(UID) + "/v", { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers["content-length"]).toBe(String(CLIP.length));
      expect(res.body.length).toBe(0);
      expect((await get(base + encodeURIComponent(UID), { method: "HEAD" })).status).toBe(405);
    });

    it("needs the token, and answers 404 for an unknown video or without a video source", async () => {
      const base = await startThumbServer(source, undefined, videos);
      const wrong = base.replace(/\/t\/[^/]+\//, `/t/${Buffer.alloc(32, 7).toString("base64url")}/`);
      expect((await get(wrong + encodeURIComponent(UID) + "/v")).status).toBe(403);
      expect((await get(base + encodeURIComponent("other~uid") + "/v")).status).toBe(404);
      const plain = await startThumbServer(source);
      expect((await get(plain + encodeURIComponent(UID) + "/v")).status).toBe(404);
    });

    it("cuts the connection when the video turns out shorter than it said", async () => {
      const short: VideoSource = {
        size: 1000,
        mime: "video/mp4",
        async *read() {
          yield Buffer.alloc(600);
          throw new Error("video shorter than stated");
        },
      };
      const base = await startThumbServer(source, undefined, async () => short);
      await expect(get(base + encodeURIComponent(UID) + "/v")).rejects.toThrow();
    });

    it("stops reading when the player hangs up", async () => {
      let read = 0;
      let stopped: AbortSignal | null = null;
      const endless: VideoSource = {
        size: 1 << 30,
        mime: "video/mp4",
        async *read(_start, _end, gone) {
          stopped = gone;
          while (!gone.aborted) {
            read++;
            yield Buffer.alloc(64 * 1024);
            await new Promise((r) => setTimeout(r, 1));
          }
        },
      };
      const base = await startThumbServer(source, undefined, async () => endless);
      const target = new URL(base + encodeURIComponent(UID) + "/v");
      const req = request({ hostname: target.hostname, port: target.port, path: target.pathname });
      req.on("error", () => {});
      req.on("response", (res) => {
        res.once("data", () => req.destroy());
      });
      req.end();
      await vi.waitFor(() => expect(stopped?.aborted).toBe(true));
      const at = read;
      await new Promise((r) => setTimeout(r, 50));
      expect(read - at).toBeLessThanOrEqual(1);
    });
  });

  it("stops answering at lock", async () => {
    const base = await startThumbServer(source);
    await stopThumbServer();

    await expect(get(base + encodeURIComponent(UID))).rejects.toThrow();
  });
});
