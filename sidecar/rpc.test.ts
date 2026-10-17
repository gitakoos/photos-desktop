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

import { describe, it, expect } from "vitest";

import { respond } from "./rpc.ts";

/** A stand-in channel that records the lines written to it. */
function channel() {
  const lines: string[] = [];
  return { lines, write: (line: string) => void lines.push(line) };
}

// The host admits one call at a time and blocks on the id it sent. A request that gets
// no line back therefore does not fail one call: it strands the channel and hangs the
// app. Every path through here has to end in exactly one line.
describe("rpc response framing", () => {
  it("writes one newline-terminated line for an ordinary result", () => {
    const { lines, write } = channel();

    respond(write, 7, { id: 7, ok: true, result: { pinned: [] } });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0])).toEqual({ id: 7, ok: true, result: { pinned: [] } });
  });

  // A throw inside the write must still produce a line, not only a log entry from the
  // unhandled-rejection handler.
  it("still answers when the payload cannot be serialised", () => {
    const { lines, write } = channel();
    const circular: Record<string, unknown> = { id: 12, ok: true };
    circular.result = circular;

    respond(write, 12, circular);

    expect(lines).toHaveLength(1);
    const answer = JSON.parse(lines[0]);
    // Same id, so the host retires the request it is waiting on rather than blocking.
    expect(answer.id).toBe(12);
    expect(answer.ok).toBe(false);
    expect(typeof answer.error).toBe("string");
  });

  it("carries the id even when the payload that failed never held one", () => {
    const { lines, write } = channel();

    respond(write, 31, { id: 31, ok: true, result: 9n }); // a BigInt will not serialise

    expect(JSON.parse(lines[0])).toMatchObject({ id: 31, ok: false });
  });

  // The failure text reaches both the log and the UI, and what could not be serialised
  // is a decrypted result. Only the error's class may be said out loud.
  it("names the error's class and nothing from the payload", () => {
    const { lines, write } = channel();
    const secret = "beach-holiday-2019.jpg";
    const payload: Record<string, unknown> = { id: 5, ok: true, name: secret };
    payload.self = payload;

    respond(write, 5, payload);

    expect(lines[0]).not.toContain(secret);
    expect(JSON.parse(lines[0]).error).toBe("response failed: TypeError");
  });

  it("gives up quietly when the channel itself is gone", () => {
    const write = () => {
      throw new Error("EPIPE");
    };

    // Nothing can reach the host any more, so this must not throw on the way out and
    // take the read loop down with it.
    expect(() => respond(write, 3, { id: 3, ok: true, result: null })).not.toThrow();
  });

  it("answers a request too malformed to carry an id", () => {
    const { lines, write } = channel();

    respond(write, null, { id: null, ok: false, error: "invalid JSON request" });

    expect(JSON.parse(lines[0])).toEqual({ id: null, ok: false, error: "invalid JSON request" });
  });
});
