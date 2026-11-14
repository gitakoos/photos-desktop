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

/**
 * The requests the host has sent and that have not answered yet, each with the signal that
 * says the host has let go of it.
 *
 * Until now a cancel stopped at the host: a call let go of while it queued there was never
 * sent, but one already sent ran to its end here, its download, decrypt or read finished
 * for nobody. The host now writes `{"cancel": <request id>}` for a call it lets go of
 * after sending it, and the handler running it sees `ctx.signal` abort, which it can pass
 * on to the SDK, whose calls all take one.
 */

/** What a handler is given besides its params. */
export type CallContext = {
  /** Aborts when the host lets go of the call. */
  signal: AbortSignal;
};

const live = new Map<number, AbortController>();

/** Starts following a request: its context, with a signal that a cancel line aborts. */
export function beginRequest(id: number | null): CallContext {
  const controller = new AbortController();
  if (typeof id === "number") live.set(id, controller);
  return { signal: controller.signal };
}

/** The request has answered: a cancel naming it from now on is a stray, and dropped. */
export function endRequest(id: number | null): void {
  if (typeof id === "number") live.delete(id);
}

/**
 * Takes a line from the host if it is a cancel, `{"cancel": <request id>}`, aborting that
 * request's signal if it is still running. True when the line was a cancel (handled or a
 * stray), so the request loop does not treat it as a request.
 */
export function takeCancelLine(line: unknown): boolean {
  if (!line || typeof line !== "object") return false;
  const msg = line as Record<string, unknown>;
  if (typeof msg.cancel !== "number" || "method" in msg) return false;
  live.get(msg.cancel)?.abort();
  return true;
}

/** How many requests are being followed (for tests). */
export function liveRequests(): number {
  return live.size;
}
