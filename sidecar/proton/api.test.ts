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

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { isApiUrl, makeSdkHttpClient, userAgentFor } from "./api.ts";

describe("isApiUrl", () => {
  it("takes the API origin, any path on it", () => {
    expect(isApiUrl("https://drive-api.proton.me/drive/v2/volumes")).toBe(true);
    expect(isApiUrl("https://drive-api.proton.me")).toBe(true);
  });

  it("refuses a host that only starts with the API's name", () => {
    expect(isApiUrl("https://drive-api.proton.me.example.com/x")).toBe(false);
    expect(isApiUrl("https://drive-api.proton.me@example.com/x")).toBe(false);
    expect(isApiUrl("https://drive-api.proton.me:8443/x")).toBe(false);
    expect(isApiUrl("http://drive-api.proton.me/x")).toBe(false);
    expect(isApiUrl("not a url")).toBe(false);
  });
});

describe("userAgentFor", () => {
  it("keeps the Windows string byte for byte", () => {
    expect(userAgentFor("win32")).toBe("AkoosProtonPhotos/2.3.10 (Windows 11; Desktop)");
  });

  it("names the system the app runs on everywhere else", () => {
    expect(userAgentFor("linux")).toBe("AkoosProtonPhotos/2.3.10 (Linux; Desktop)");
    expect(userAgentFor("darwin")).toBe("AkoosProtonPhotos/2.3.10 (macOS; Desktop)");
  });
});

// A local server standing in for the connection that never answers: the laptop that
// resumed from sleep, the captive portal that swallowed the request. Nothing here
// leaves the loopback interface.
//
//   /ok          answers at once
//   /stall       accepts the connection and never sends anything, not even headers
//   /stall-body  sends headers and one chunk, then goes silent forever
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Code: 1000 }));
      return;
    }
    if (req.url === "/stall-body") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write("partial");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // The stalled sockets are still open, and close() alone would wait on them.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const client = () => makeSdkHttpClient({ uid: "test-uid", accessToken: "test-token" });

/** The error a promise settled with, failing the test if it resolved instead. */
async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the request to be rejected, but it settled");
}

// The SDK declares the timeout as this client's job and its retry logic keys on an
// error NAMED `TimeoutError` (internal/apiService/apiService.ts). Nothing raised one
// before, so a stalled request never settled at all: the handler never returned, no
// response line was written, and the host, which admits one call at a time, waited on
// it forever. That is the whole app frozen, not one failed request.
describe("SDK http client: request timeout", () => {
  it("aborts a stalled request instead of hanging on it", async () => {
    const started = Date.now();

    const err = await rejection(
      client().fetchJson({
        url: `${base}/stall`,
        method: "GET",
        headers: new Headers(),
        timeoutMs: 150,
      }),
    );

    // The name is the whole point: it is what the SDK matches to decide to retry, so
    // an abort raised under any other name leaves those retries dead code.
    expect(err.name).toBe("TimeoutError");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("bounds fetchBlob too, which is the path file content takes", async () => {
    const err = await rejection(
      client().fetchBlob({
        url: `${base}/stall`,
        method: "GET",
        headers: new Headers(),
        timeoutMs: 150,
      }),
    );

    expect(err.name).toBe("TimeoutError");
  });

  // Headers arriving is not the same as the request being safe: a connection that
  // delivers them and then stalls mid-body holds the channel exactly as long. This is
  // what a timeout cancelled once the response object exists would fail to catch.
  it("cuts a connection that delivers headers and then stalls mid-body", async () => {
    const res = await client().fetchBlob({
      url: `${base}/stall-body`,
      method: "GET",
      headers: new Headers(),
      timeoutMs: 250,
    });
    expect(res.status).toBe(200);

    const err = await rejection(res.arrayBuffer());

    expect(err.name).toBe("TimeoutError");
  });

  // The caller's signal must survive the composition. The SDK treats `AbortError` as
  // final and `TimeoutError` as worth retrying, so collapsing the two would have it
  // retry work the user just cancelled.
  it("reports a caller's own cancel as AbortError, not as a timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const err = await rejection(
      client().fetchJson({
        url: `${base}/stall`,
        method: "GET",
        headers: new Headers(),
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
    );

    expect(err.name).toBe("AbortError");
  });

  it("leaves a request that answers in time alone", async () => {
    const res = await client().fetchJson({
      url: `${base}/ok`,
      method: "GET",
      headers: new Headers(),
      timeoutMs: 5000,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ Code: 1000 });
  });

  it("treats a non-positive timeout as no deadline rather than an instant abort", async () => {
    const res = await client().fetchJson({
      url: `${base}/ok`,
      method: "GET",
      headers: new Headers(),
      timeoutMs: 0,
    });

    expect(res.status).toBe(200);
  });
});
