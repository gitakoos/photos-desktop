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

// Framing for the one rule the JSON-RPC channel runs on: every request gets exactly
// one response line. Kept apart from server.ts so it carries no start-up side effects
// and can be exercised on its own.

/** The id a response is answering. Null for a request too malformed to carry one. */
export type RpcId = number | null;

/** Where a line goes. Injected so the channel can be stood in for. */
export type RpcWriter = (line: string) => void;

/** Names an error by its class alone, the way every log in the sidecar does. */
function errorKind(e: unknown): string {
  return e instanceof Error ? (e.name ?? "Error") : typeof e;
}

/**
 * Write one response line, and answer even when writing the intended one fails.
 *
 * The host admits one call at a time and blocks on the id it sent, so a request that
 * never gets a line back does not fail that one call: it strands the channel and hangs
 * the app with nothing to recover from. A payload that will not serialise therefore
 * still has to produce a line, carrying the same id so the host can retire the request.
 *
 * The fallback names the error's class only. What could not be serialised is a decrypted
 * result, and this text reaches both the log and the UI.
 */
export function respond(write: RpcWriter, id: RpcId, payload: unknown): void {
  try {
    write(JSON.stringify(payload) + "\n");
    return;
  } catch (e) {
    process.stderr.write(`[sidecar] failed op=respond kind=${errorKind(e)}\n`);
    try {
      write(JSON.stringify({ id, ok: false, error: `response failed: ${errorKind(e)}` }) + "\n");
    } catch {
      /* the channel itself is gone; the host's own read ends and it stops waiting */
    }
  }
}
