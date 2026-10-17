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

import { describe, it, expect, afterEach } from "vitest";
import { request } from "node:http";

import { startThumbServer, stopThumbServer } from "./thumbServer.ts";

const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const UID = "dm9sdW1l~bGluaw==";
const source = async (uid: string) => (uid === UID ? PHOTO : null);

/** A raw GET, so the method and the Host header can be anything a caller might send. */
function get(url: string, options: { method?: string; host?: string } = {}) {
  const target = new URL(url);
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: options.method ?? "GET",
          headers: options.host ? { Host: options.host } : {},
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

  it("stops answering at lock", async () => {
    const base = await startThumbServer(source);
    await stopThumbServer();

    await expect(get(base + encodeURIComponent(UID))).rejects.toThrow();
  });
});
