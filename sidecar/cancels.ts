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

// Calls the window let go of after the host had already sent them on. The host writes one
// `{"cancel": id}` line naming such a request, and the signal its handler was given is
// aborted; a handler that hands the signal on to its network work stops that work.

/** What a request stopped this way answers, the same words the host's own drop uses. */
export const CANCELLED = "rpc cancelled";

const running = new Map<number, AbortController>();

/** The signal for request `id` while it runs, followed until `settle`. */
export function follow(id: unknown): AbortSignal | undefined {
  if (typeof id !== "number") return undefined;
  const controller = new AbortController();
  running.set(id, controller);
  return controller.signal;
}

/** Request `id` has answered: a cancel for it now finds nothing. */
export function settle(id: unknown): void {
  if (typeof id === "number") running.delete(id);
}

/**
 * A cancel line from the host: aborts the request it names, if that is still running.
 * Answers whether the line was one; the request loop treats every other line as a request.
 */
export function takeCancelLine(line: any): boolean {
  if (typeof line?.cancel !== "number" || "method" in line) return false;
  running.get(line.cancel)?.abort();
  return true;
}
