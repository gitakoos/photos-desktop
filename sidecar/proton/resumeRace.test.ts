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

// Resuming against a stand-in for Proton's /auth/v4/refresh that swaps the refresh token on
// every use and refuses a spent one with 400 / Code 10013, the way the real one does.

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

import { diag } from "./diag.ts";
import { ProtonSession } from "./session.ts";
import { SESSION_LOCK_FILE } from "./sessionLock.ts";
import { SESSION_FILE, initStore, readSealedOrSetAside, setDataKey, writeSealedAtomic } from "./store.ts";

type Fake = {
  uid: string;
  seq: number;
  current: string;
  access: string;
  /** Every refresh token presented, in order. */
  presented: string[];
  refused: number;
  /** The next renewal is made, and then its answer is lost to a dropped connection. */
  dropAfterRotate: boolean;
  /** Runs once when the next refresh arrives, before it is answered. */
  before: (() => void) | null;
};

function rotate(fake: Fake): void {
  fake.seq++;
  fake.current = `refresh-${fake.seq}`;
  fake.access = `access-${fake.seq}`;
}

function stubProton(fake: Fake): void {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/auth/v4/refresh")) {
      const before = fake.before;
      fake.before = null;
      before?.();
      const token = JSON.parse(String(init?.body)).RefreshToken as string;
      fake.presented.push(token);
      if (token !== fake.current) {
        fake.refused++;
        return new Response(JSON.stringify({ Code: 10013, Error: "Invalid refresh token" }), { status: 400 });
      }
      rotate(fake);
      if (fake.dropAfterRotate) {
        fake.dropAfterRotate = false;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return new Response(
        JSON.stringify({ Code: 1000, UID: fake.uid, AccessToken: fake.access, RefreshToken: fake.current }),
        { status: 200 },
      );
    }
    // Any other API call stands only with the newest access token.
    const auth = new Headers(init?.headers).get("Authorization");
    return new Response(JSON.stringify({ Code: 1000 }), { status: auth === `Bearer ${fake.access}` ? 200 : 401 });
  });
}

function setup(): { dir: string; fake: Fake } {
  const dir = mkdtempSync(join(tmpdir(), "pfp-resume-race-"));
  initStore(dir);
  setDataKey(randomBytes(32));
  const fake: Fake = {
    uid: "u1",
    seq: 1,
    current: "refresh-1",
    access: "access-1",
    presented: [],
    refused: 0,
    dropAfterRotate: false,
    before: null,
  };
  stubProton(fake);
  save(dir, fake);
  return { dir, fake };
}

/** What a start that renewed the session leaves on disk. */
function save(dir: string, fake: Fake): void {
  const blob = {
    uid: fake.uid,
    accessToken: fake.access,
    refreshToken: fake.current,
    username: "a",
    userKeyPassphrases: {},
    method: "browser",
  };
  writeSealedAtomic(join(dir, SESSION_FILE), Buffer.from(JSON.stringify(blob)));
}

function saved(dir: string): { refreshToken: string; accessToken: string } {
  return JSON.parse(readSealedOrSetAside(join(dir, SESSION_FILE))!.toString("utf8"));
}

/** A session whose account is taken as built once the tokens are settled. */
function quickSession(): ProtonSession {
  const session = new ProtonSession();
  (session as any).finishLogin = async () => ({ status: "ok", email: "a@example.com" });
  return session;
}

const opened: ProtonSession[] = [];

/** A session that goes through the real end of a sign-in, with the account itself stood in for. */
function fullSession(onBuild: () => void = () => {}): ProtonSession {
  const session = new ProtonSession();
  (session as any).buildAccount = async () => {
    onBuild();
    return { getOwnPrimaryAddress: async () => ({ email: "a@example.com" }) };
  };
  (session as any).attachFaceScan = () => {};
  opened.push(session);
  return session;
}

function apiCall(session: ProtonSession): Promise<Response> {
  return (session as any).sessionClient.fetchJson({
    url: "https://drive-api.proton.me/core/v4/users",
    method: "GET",
    headers: new Headers(),
    timeoutMs: 5_000,
  });
}

const events = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls.filter((c) => c[0] === "session").map((c) => c[1] as string);

afterEach(() => {
  for (const s of opened.splice(0)) clearInterval((s as any).sessionWatch);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resuming against a refresh that swaps the token on every use", () => {
  it("two starts on one store folder at once both end signed in", async () => {
    const { dir, fake } = setup();
    const one = quickSession();
    const two = quickSession();

    const [a, b] = await Promise.all([(one as any).resumeSaved(""), (two as any).resumeSaved("")]);

    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    // One renewal; the other start took up what the first saved instead of spending it again.
    expect(fake.presented).toEqual(["refresh-1"]);
    expect(fake.refused).toBe(0);
    expect(saved(dir).refreshToken).toBe(fake.current);
    expect((one as any).session.refreshToken).toBe(fake.current);
    expect((two as any).session.refreshToken).toBe(fake.current);
    expect(existsSync(join(dir, SESSION_LOCK_FILE))).toBe(false);
  });

  it("reports a renewal whose answer was lost as resume_reused, and writes nothing over the saved token", async () => {
    const { dir, fake } = setup();
    fake.dropAfterRotate = true;
    const log = vi.spyOn(diag, "log");

    const result = await (quickSession() as any).resumeSaved("");

    // The first try spent the token and its answer never came; the second is refused.
    expect(fake.presented).toEqual(["refresh-1", "refresh-1"]);
    expect(events(log)).toContain("resume_reused");
    expect(events(log)).not.toContain("persist");
    expect(result.status).toBe("relogin");
    expect(saved(dir).refreshToken).toBe("refresh-1");
    expect(existsSync(join(dir, SESSION_LOCK_FILE))).toBe(false);
  });

  it("tries once more with a renewal saved meanwhile by a writer that took no lock", async () => {
    const { dir, fake } = setup();
    // An older build renews the saved token and saves the result just before ours arrives.
    fake.before = () => {
      rotate(fake);
      save(dir, fake);
    };
    const log = vi.spyOn(diag, "log");

    const result = await (quickSession() as any).resumeSaved("");

    expect(result.status).toBe("ok");
    expect(fake.presented).toEqual(["refresh-1", "refresh-2"]);
    expect(events(log)).not.toContain("resume_reused");
    expect(saved(dir).refreshToken).toBe(fake.current);
  });

  it("takes up the tokens another process renewed at the next 401, instead of spending its own", async () => {
    const { dir, fake } = setup();
    const session = fullSession();
    expect((await (session as any).resumeSaved("")).status).toBe("ok");
    // Another process on the same folder renews the session and saves it.
    rotate(fake);
    save(dir, fake);
    const spent = fake.presented.length;
    const log = vi.spyOn(diag, "log");

    const res = await apiCall(session);

    expect(res.status).toBe(200);
    expect(events(log)).toContain("token_adopted");
    expect(fake.presented.length).toBe(spent);
    expect(fake.refused).toBe(0);
    expect((session as any).session.refreshToken).toBe(fake.current);
  });

  it("does not write its spent token over one another process saved since", async () => {
    const { dir, fake } = setup();
    const session = fullSession();
    expect((await (session as any).resumeSaved("")).status).toBe("ok");
    rotate(fake);
    save(dir, fake);
    const log = vi.spyOn(diag, "log");

    (session as any).persistSession();

    expect(events(log)).toContain("persist_skipped");
    expect(saved(dir).refreshToken).toBe(fake.current);
  });
});

describe("a renewal that cannot be saved", () => {
  /** Makes every save of the session fail, the way a file an antivirus holds does. */
  const block = (dir: string) => mkdirSync(join(dir, `${SESSION_FILE}.part`));
  const unblock = (dir: string) => rmSync(join(dir, `${SESSION_FILE}.part`), { recursive: true, force: true });

  it("is saved by the save at the end of the sign-in once the failure passes, and the next start resumes", async () => {
    const { dir, fake } = setup();
    block(dir);
    const log = vi.spyOn(diag, "log");
    const session = fullSession(() => unblock(dir));

    expect((await (session as any).resumeSaved("")).status).toBe("ok");
    expect(events(log)).toContain("persist_failed");
    expect(saved(dir).refreshToken).toBe(fake.current);

    expect((await (quickSession() as any).resumeSaved("")).status).toBe("ok");
    expect(fake.refused).toBe(0);
  });

  it("keeps the session signed in, and the next refresh spends the token in memory, not the saved spent one", async () => {
    const { dir, fake } = setup();
    block(dir);
    const log = vi.spyOn(diag, "log");
    const session = fullSession();

    expect((await (session as any).resumeSaved("")).status).toBe("ok");
    expect(events(log).filter((e) => e === "persist_failed").length).toBe(2);
    // On disk only the spent token: a start now would be asked to sign in.
    expect(saved(dir).refreshToken).toBe("refresh-1");

    // The disk works again, and the access token runs out.
    unblock(dir);
    fake.access = "expired";
    const res = await apiCall(session);

    expect(res.status).toBe(200);
    expect(fake.refused).toBe(0);
    expect(saved(dir).refreshToken).toBe(fake.current);
  });

  it("leaves a start that finds only the spent token asking for a sign-in, with the vault kept", async () => {
    const { dir, fake } = setup();
    block(dir);
    const session = fullSession();
    expect((await (session as any).resumeSaved("")).status).toBe("ok");
    unblock(dir);

    const result = await (quickSession() as any).resumeSaved("");

    expect(result.status).toBe("relogin");
    expect(fake.refused).toBe(1);
    expect(existsSync(join(dir, SESSION_FILE))).toBe(true);
    expect(existsSync(join(dir, SESSION_LOCK_FILE))).toBe(false);
  });
});
