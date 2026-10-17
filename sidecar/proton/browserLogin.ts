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

// Sign-in through Proton's own page in the browser, by session fork: the app asks
// Proton for a one-time code, opens account.proton.me with it, and waits while the
// user signs in there, password, second factor and captcha included. Proton then
// hands this app a session of its own, and the key password sealed under a key that
// only ever travelled in the link's fragment, which a browser never sends to a
// server. The account password never reaches this app.
//
// The link and the payload follow Proton's Drive SDK (`incubating/account`,
// MIT, Copyright (c) 2025-2026 Proton AG), which is how Proton's own CLI signs in.

import { createDecipheriv, randomBytes } from "node:crypto";

/** The page the user signs in on, and the only one `signInUrl` points at. */
export const SIGN_IN_PAGE = "https://account.proton.me/desktop/login";

/** The client a third-party Drive app forks its session for. */
export const FORK_CLIENT_ID = "external-drive";

const FORK_AAD = Buffer.from("fork", "utf8");
const NONCE_LEN = 12;
const TAG_LEN = 16;

export const FORK_FIRST_POLL_MS = 5000;
export const FORK_POLL_MS = 5000;
export const FORK_GIVE_UP_MS = 10 * 60 * 1000;

/** The sign-in link for a fork's user code, and the key its answer is sealed with. */
export function signInUrl(userCode: string): { url: string; key: Buffer } {
  const key = randomBytes(32);
  const payload = `0:${userCode}:${key.toString("base64")}:${FORK_CLIENT_ID}`;
  return { url: `${SIGN_IN_PAGE}?app=drive&pv=3#payload=${encodeURIComponent(payload)}`, key };
}

/** The key password inside a fork's answer. Throws when it was not sealed with `key`. */
export function openForkPayload(key: Buffer, payload: string): string {
  const blob = Buffer.from(payload, "base64");
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error("The sign-in answer is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, NONCE_LEN));
  decipher.setAAD(FORK_AAD);
  decipher.setAuthTag(blob.subarray(blob.length - TAG_LEN));
  const plain = Buffer.concat([
    decipher.update(blob.subarray(NONCE_LEN, blob.length - TAG_LEN)),
    decipher.final(),
  ]).toString("utf8");
  const keyPassword = (JSON.parse(plain) as { keyPassword?: unknown }).keyPassword;
  if (typeof keyPassword !== "string" || !keyPassword) {
    throw new Error("The sign-in answer holds no key password");
  }
  return keyPassword;
}

export type ForkedSession = {
  uid: string;
  accessToken: string;
  refreshToken: string;
  keyPassword: string;
};

export type ForkApi = {
  init(): Promise<{ selector: string; userCode: string }>;
  /** The finished fork, or null while the user has not signed in yet. */
  status(selector: string): Promise<{ payload: string; uid: string; accessToken: string; refreshToken: string } | null>;
  /** Spends a fork that will not be finished, so its code stops working. */
  discard(selector: string): Promise<void>;
};

export type BrowserSignInState =
  | { state: "waiting"; url: string }
  | { state: "done"; session: ForkedSession }
  | { state: "cancelled" }
  | { state: "failed"; error: string };

/**
 * One sign-in through the browser, from the code to the session. `start` returns the
 * link to open; the wait runs on its own, since the user may take minutes, and its
 * outcome is read with `state`. A fork the user never finishes is discarded on
 * cancel and on giving up.
 */
export class BrowserSignIn {
  private current: BrowserSignInState = { state: "cancelled" };
  private selector = "";
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly api: ForkApi,
    private readonly timing = { first: FORK_FIRST_POLL_MS, every: FORK_POLL_MS, giveUp: FORK_GIVE_UP_MS },
  ) {}

  async start(): Promise<string> {
    const { selector, userCode } = await this.api.init();
    const { url, key } = signInUrl(userCode);
    this.selector = selector;
    this.current = { state: "waiting", url };
    void this.wait(key);
    return url;
  }

  state(): BrowserSignInState {
    return this.current;
  }

  cancel(): void {
    if (this.current.state !== "waiting") return;
    this.finish({ state: "cancelled" });
  }

  private finish(next: BrowserSignInState): void {
    const unfinished = next.state !== "done" && this.current.state === "waiting";
    this.current = next;
    this.stopped = true;
    this.wake?.();
    if (unfinished && this.selector) void this.api.discard(this.selector).catch(() => {});
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  private async wait(key: Buffer): Promise<void> {
    const began = Date.now();
    await this.sleep(this.timing.first);
    while (!this.stopped) {
      if (Date.now() - began > this.timing.giveUp) {
        this.finish({ state: "failed", error: "timeout" });
        return;
      }
      try {
        const answer = await this.api.status(this.selector);
        if (this.stopped) return;
        if (answer) {
          const keyPassword = openForkPayload(key, answer.payload);
          this.finish({
            state: "done",
            session: {
              uid: answer.uid,
              accessToken: answer.accessToken,
              refreshToken: answer.refreshToken,
              keyPassword,
            },
          });
          return;
        }
      } catch (e) {
        if (!this.stopped) this.finish({ state: "failed", error: (e as Error).message });
        return;
      }
      await this.sleep(this.timing.every);
    }
  }
}
