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

import { afterEach, describe, expect, it } from "vitest";

import { hostCall, setHostWriter, takeHostLine } from "./hostCall.ts";

afterEach(() => setHostWriter(null));

describe("a call made of the host", () => {
  it("goes out as a line without an id and ends with the host's answer, its progress heard on the way", async () => {
    const lines: any[] = [];
    setHostWriter((line) => lines.push(JSON.parse(line)));
    const heard: number[] = [];
    const answer = hostCall("videoProbe", { path: "a.mp4" }, (v) => heard.push(v));
    expect(lines).toEqual([{ call: "videoProbe", callId: expect.any(Number), params: { path: "a.mp4" } }]);
    expect(lines[0].id).toBeUndefined();
    const callId = lines[0].callId;
    expect(takeHostLine({ hostProgress: callId, value: 0.5 })).toBe(true);
    expect(takeHostLine({ hostReply: callId, ok: true, result: { width: 4 } })).toBe(true);
    await expect(answer).resolves.toEqual({ width: 4 });
    expect(heard).toEqual([0.5]);
  });

  it("rejects with the host's error, and a request is not taken for an answer", async () => {
    const lines: any[] = [];
    setHostWriter((line) => lines.push(JSON.parse(line)));
    const answer = hostCall("videoTranscode", {});
    takeHostLine({ hostReply: lines[0].callId, ok: false, error: "no encoder" });
    await expect(answer).rejects.toThrow("no encoder");
    expect(takeHostLine({ id: 3, method: "whoami" })).toBe(false);
  });

  it("tells the host to stop when given up on", async () => {
    const lines: any[] = [];
    setHostWriter((line) => lines.push(JSON.parse(line)));
    const stop = new AbortController();
    const answer = hostCall("videoTranscode", {}, undefined, stop.signal);
    stop.abort();
    await expect(answer).rejects.toThrow("cancelled");
    expect(lines[1]).toEqual({ call: "cancel", callId: lines[0].callId });
  });

  it("fails at once with no app to ask", async () => {
    await expect(hostCall("videoEncoders", {})).rejects.toThrow();
  });
});
