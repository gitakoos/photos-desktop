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

import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));
const refreshes = vi.hoisted(() => ({ count: 0 }));
vi.mock("./api.ts", async (original) => ({
  ...(await original<typeof import("./api.ts")>()),
  refreshSession: async (uid: string) => {
    refreshes.count++;
    return { uid, accessToken: "access-2", refreshToken: "refresh-2" };
  },
}));

import { ProtonSession } from "./session.ts";
import { SESSION_FILE, initStore, readSealedOrDiscard, setDataKey, writeSealedAtomic } from "./store.ts";

const saved = { uid: "u1", accessToken: "access-1", refreshToken: "refresh-1", username: "a", userKeyPassphrases: {}, method: "browser" };

describe("resuming a saved session", () => {
  it("saves the new refresh token before the account is built", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-resume-test-"));
    initStore(dir);
    setDataKey(randomBytes(32));
    const session = new ProtonSession();
    // The app stops while the keys are being opened: the account is never built.
    (session as any).finishLogin = () => new Promise(() => {});

    void (session as any).resumeSession(saved, "");
    await new Promise((r) => setTimeout(r, 20));

    const written = JSON.parse(readSealedOrDiscard(join(dir, SESSION_FILE))!.toString("utf8"));
    expect(written.refreshToken).toBe("refresh-2");
    expect(written.method).toBe("browser");
  });

  it("runs one resume at a time, and a second ask waits for the first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-resume-test-"));
    initStore(dir);
    setDataKey(randomBytes(32));
    writeSealedAtomic(join(dir, SESSION_FILE), Buffer.from(JSON.stringify(saved)));
    const session = new ProtonSession();
    let finish: (r: unknown) => void = () => {};
    (session as any).finishLogin = () => new Promise((r) => (finish = r));
    refreshes.count = 0;

    const first = (session as any).resumeSaved("");
    const second = (session as any).resumeSaved("");
    await new Promise((r) => setTimeout(r, 20));
    finish({ status: "ok", email: "a@example.com" });

    expect(await first).toEqual({ status: "ok", email: "a@example.com" });
    expect(await second).toEqual({ status: "ok", email: "a@example.com" });
    expect(refreshes.count).toBe(1);
  });
});
