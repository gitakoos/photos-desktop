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

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

import { isTransient, withRetry } from "./transient.ts";
import { ProtonSession } from "./session.ts";

const named = (name: string, extra: object = {}) => Object.assign(new Error(name), { name, ...extra });

describe("what counts as a failure that may pass", () => {
  it("takes a dropped connection, a timeout, a busy server and a stalled walk", () => {
    expect(isTransient(named("ConnectionError"))).toBe(true);
    expect(isTransient(named("RateLimitedError"))).toBe(true);
    expect(isTransient(named("TimeoutError"))).toBe(true);
    expect(isTransient(named("ServerError", { statusCode: 503 }))).toBe(true);
    expect(isTransient(Object.assign(new Error("stalled"), { stalled: true }))).toBe(true);
    expect(isTransient(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe(true);
    expect(isTransient(Object.assign(new Error("token refresh failed"), { status: 502 }))).toBe(true);
  });

  it("leaves a refusal, a bad request and a broken file alone", () => {
    expect(isTransient(Object.assign(new Error("Invalid refresh token"), { status: 401 }))).toBe(false);
    expect(isTransient(named("ServerError", { statusCode: 422 }))).toBe(false);
    expect(isTransient(named("ValidationError"))).toBe(false);
    expect(isTransient(named("IntegrityError"))).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});

describe("trying again", () => {
  it("tries again after each pause while the failure may pass, then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      if (++calls < 3) throw named("ConnectionError");
      return "done";
    }, [1, 1]);
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("gives up once the pauses run out", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw named("ConnectionError");
      }, [1, 1]),
    ).rejects.toThrow("ConnectionError");
    expect(calls).toBe(3);
  });

  it("does not try a failure that will not pass again", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw named("ValidationError");
      }, [1, 1]),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("stops at a cancel", async () => {
    const stop = new AbortController();
    let calls = 0;
    const work = withRetry(async () => {
      calls++;
      throw named("ConnectionError");
    }, [10_000], stop.signal);
    stop.abort();
    await expect(work).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("resuming a saved session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const blob = { uid: "u", accessToken: "a", refreshToken: "r", username: "x", userKeyPassphrases: {} };

  it("waits for the network instead of asking for a new sign-in", async () => {
    vi.useFakeTimers();
    let asked = 0;
    vi.stubGlobal("fetch", async () => {
      asked++;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    const resumed = (new ProtonSession() as any).resumeSession(blob, "pw");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await resumed).toEqual({ status: "offline" });
    expect(asked).toBe(3);
  });

  it("gives up on a token Proton refuses", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ Code: 10013, Error: "Invalid refresh token" }), { status: 422 }),
    );

    const resumed = await (new ProtonSession() as any).resumeSession(blob, "pw");

    expect(resumed.status).toBe("error");
  });
});
