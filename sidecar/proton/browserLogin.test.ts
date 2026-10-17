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
import { createCipheriv, randomBytes } from "node:crypto";
import {
  BrowserSignIn,
  FORK_CLIENT_ID,
  SIGN_IN_PAGE,
  openForkPayload,
  signInUrl,
  type ForkApi,
} from "./browserLogin.ts";

/** What Proton's page sends back: the key password, sealed under the link's key. */
function seal(key: Buffer, body: object, aad = "fork"): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const text = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, text, cipher.getAuthTag()]).toString("base64");
}

const quick = { first: 1, every: 1, giveUp: 2000 };
const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
};

/** A fork that finishes on the `after`-th status call, recording what was asked. */
function fakeFork(after: number, answer?: (url: string) => string) {
  const calls = { status: 0, discarded: [] as string[] };
  let url = "";
  const api: ForkApi = {
    async init() {
      return { selector: "sel-1", userCode: "CODE42" };
    },
    async status() {
      calls.status++;
      if (calls.status < after) return null;
      return { payload: answer!(url), uid: "uid-1", accessToken: "at-1", refreshToken: "rt-1" };
    },
    async discard(selector) {
      calls.discarded.push(selector);
    },
  };
  return { api, calls, setUrl: (u: string) => (url = u) };
}

const keyOf = (url: string) => {
  const payload = decodeURIComponent(url.split("#payload=")[1]);
  return Buffer.from(payload.split(":")[2], "base64");
};

describe("the browser sign-in link", () => {
  it("points at Proton's page and carries the key only after the #", () => {
    const { url, key } = signInUrl("CODE42");
    expect(url.startsWith(`${SIGN_IN_PAGE}?app=drive&pv=3#payload=`)).toBe(true);
    const [beforeHash, afterHash] = url.split("#");
    expect(beforeHash).not.toContain(key.toString("base64"));
    expect(decodeURIComponent(afterHash.slice("payload=".length))).toBe(
      `0:CODE42:${key.toString("base64")}:${FORK_CLIENT_ID}`,
    );
  });

  it("uses a new key every time", () => {
    expect(signInUrl("A").key.equals(signInUrl("A").key)).toBe(false);
  });
});

describe("Proton's answer", () => {
  it("opens to the key password with the link's key", () => {
    const { key } = signInUrl("C");
    expect(openForkPayload(key, seal(key, { type: "default", keyPassword: "kp-secret" }))).toBe("kp-secret");
  });

  it("does not open with another key, another tag or a changed byte", () => {
    const { key } = signInUrl("C");
    const sealed = seal(key, { keyPassword: "kp" });
    expect(() => openForkPayload(signInUrl("C").key, sealed)).toThrow();
    expect(() => openForkPayload(key, seal(key, { keyPassword: "kp" }, "other"))).toThrow();
    const bytes = Buffer.from(sealed, "base64");
    bytes[14] ^= 1;
    expect(() => openForkPayload(key, bytes.toString("base64"))).toThrow();
    expect(() => openForkPayload(key, "AAAA")).toThrow();
  });

  it("is refused when it holds no key password", () => {
    const { key } = signInUrl("C");
    expect(() => openForkPayload(key, seal(key, { type: "default" }))).toThrow();
  });
});

describe("waiting for the sign-in", () => {
  it("keeps asking while Proton says not yet, then hands over the session", async () => {
    const fork = fakeFork(3, (url) => seal(keyOf(url), { keyPassword: "kp-1" }));
    const signIn = new BrowserSignIn(fork.api, quick);
    fork.setUrl(await signIn.start());
    expect(signIn.state().state).toBe("waiting");

    await until(() => signIn.state().state !== "waiting");

    expect(fork.calls.status).toBe(3);
    expect(signIn.state()).toEqual({
      state: "done",
      session: { uid: "uid-1", accessToken: "at-1", refreshToken: "rt-1", keyPassword: "kp-1" },
    });
    expect(fork.calls.discarded).toEqual([]);
  });

  it("stops and spends the code when cancelled", async () => {
    const fork = fakeFork(Infinity);
    const signIn = new BrowserSignIn(fork.api, { first: 1, every: 50, giveUp: 60_000 });
    await signIn.start();
    await until(() => fork.calls.status > 0);
    signIn.cancel();
    const asked = fork.calls.status;
    await new Promise((r) => setTimeout(r, 120));

    expect(signIn.state().state).toBe("cancelled");
    expect(fork.calls.status).toBe(asked);
    expect(fork.calls.discarded).toEqual(["sel-1"]);
  });

  it("gives up after its time, and spends the code", async () => {
    const fork = fakeFork(Infinity);
    const signIn = new BrowserSignIn(fork.api, { first: 1, every: 5, giveUp: 40 });
    await signIn.start();

    await until(() => signIn.state().state !== "waiting");

    expect(signIn.state()).toEqual({ state: "failed", error: "timeout" });
    expect(fork.calls.discarded).toEqual(["sel-1"]);
  });

  it("fails on an answer sealed with another key, and never opens it", async () => {
    const fork = fakeFork(1, () => seal(randomBytes(32), { keyPassword: "kp" }));
    const signIn = new BrowserSignIn(fork.api, quick);
    await signIn.start();

    await until(() => signIn.state().state !== "waiting");

    expect(signIn.state().state).toBe("failed");
  });
});
