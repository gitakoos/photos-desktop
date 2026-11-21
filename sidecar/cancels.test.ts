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

import { describe, expect, it, vi } from "vitest";

import { follow, settle, takeCancelLine } from "./cancels.ts";

describe("a cancel line from the host", () => {
  it("aborts the running request it names, and no other", () => {
    const named = follow(7)!;
    const other = follow(8)!;
    expect(takeCancelLine({ cancel: 7 })).toBe(true);
    expect(named.aborted).toBe(true);
    expect(other.aborted).toBe(false);
    settle(7);
    settle(8);
  });

  it("is taken and ignored for a request that is not running", () => {
    const done = follow(9)!;
    settle(9);
    expect(takeCancelLine({ cancel: 9 })).toBe(true);
    expect(takeCancelLine({ cancel: 12345 })).toBe(true);
    expect(done.aborted).toBe(false);
  });

  it("leaves every other line to the request loop", () => {
    expect(takeCancelLine({ id: 3, method: "ping" })).toBe(false);
    expect(takeCancelLine({ id: 3, method: "ping", cancel: 3 })).toBe(false);
    expect(takeCancelLine({ hostReply: 1, ok: true })).toBe(false);
    expect(takeCancelLine(null)).toBe(false);
  });
});

describe("a preview or thumbnails let go of", () => {
  // A fresh import of the session transforms the SDK's sources, which takes seconds on a busy machine.
  it("hands the request's signal on to the download", async () => {
    vi.resetModules();
    vi.doMock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));
    const { ProtonSession } = await import("./proton/session.ts");
    const asked: (AbortSignal | undefined)[] = [];
    const session = new ProtonSession();
    (session as any).photos = {
      async *iterateThumbnails(_uids: string[], _type: number, signal?: AbortSignal) {
        asked.push(signal);
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    };
    const controller = new AbortController();
    await expect(session.getPreview("p", controller.signal)).rejects.toThrow("aborted");
    await expect(session.warmThumbnails(["t"], controller.signal)).rejects.toThrow("aborted");
    expect(asked).toEqual([controller.signal, controller.signal]);
  }, 30_000);
});
