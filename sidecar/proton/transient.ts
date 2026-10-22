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

// Telling a failure that may pass (the network dropped, the server is busy) from one
// that will not (a refused token, a file the server rejects), and trying the first kind
// again after a pause.

/** Node's own codes for a connection that dropped, timed out or never formed. */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Whether trying the same thing again a little later could succeed. */
export function isTransient(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as {
    name?: string;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    stalled?: unknown;
    cause?: { code?: unknown };
    message?: unknown;
  };
  if (err.stalled === true) return true;
  switch (err.name) {
    case "ConnectionError":
    case "RateLimitedError":
    case "TimeoutError":
    case "StallError":
      return true;
  }
  const status = Number(err.statusCode ?? err.status ?? 0);
  if (status === 408 || status === 429 || status >= 500) return true;
  const code = String(err.code ?? err.cause?.code ?? "");
  if (NETWORK_CODES.has(code)) return true;
  return typeof err.message === "string" && /fetch failed|socket hang up|network error/i.test(err.message);
}

/**
 * Runs `work`, and again after each of `delays` (in ms) while it fails transiently.
 * A failure that will not pass, or a cancel, is thrown at once.
 */
export async function withRetry<T>(work: () => Promise<T>, delays: number[], signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (e) {
      if (signal?.aborted || attempt >= delays.length || !isTransient(e)) throw e;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delays[attempt]);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (signal?.aborted) throw e;
    }
  }
}
