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

import { Diagnostics, SLOW_MS, STALL_MS, formatLine, safeValue } from "./diag.ts";

function setup() {
  let now = new Date(2026, 9, 24, 15, 0, 0).getTime();
  const written: string[] = [];
  const d = new Diagnostics((line) => written.push(line), () => now);
  return { d, written, advance: (ms: number) => (now += ms) };
}

describe("a diagnostics line", () => {
  it("carries numbers, states and error types", () => {
    const at = new Date(2026, 9, 24, 15, 4, 5, 6).getTime();
    expect(formatLine(at, "upload", "done", { files: 3, ms: 1234.5, ok: true, phase: "downloading", error: "TypeError" })).toBe(
      "15:04:05.006 upload done files=3 ms=1235 ok=yes phase=downloading error=TypeError",
    );
  });

  it("never carries a name, an address or a path", () => {
    expect(safeValue("IMG 2023 beach.jpg")).toBe("[x]");
    expect(safeValue("someone@proton.me")).toBe("[x]");
    expect(safeValue("C:\\Users\\Anna\\Pictures")).toBe("[x]");
    expect(safeValue("Személyes")).toBe("[x]");
    expect(formatLine(0, "app", "Anna's photo", { "a name": 1 })).toMatch(/ app \[x\] \[x\]=1$/);
  });
});

describe("the diagnostics", () => {
  it("keeps the latest lines of each part", () => {
    const { d } = setup();
    for (let i = 0; i < 250; i++) d.log("faces", "pass", { i });
    const report = d.report([]);
    expect(report).toContain("faces pass i=249");
    expect(report).not.toContain("faces pass i=49\n");
  });

  it("times calls, and writes down the slow and failed ones", async () => {
    const { d, written, advance } = setup();
    await d.time("drive", "read", async () => advance(SLOW_MS + 10));
    await expect(
      d.time("drive", "read", async () => {
        throw new TypeError("boom");
      }),
    ).rejects.toThrow();
    d.record("drive", "read", 5);
    expect(written.some((l) => l.includes("drive slow_read ms=3010"))).toBe(true);
    expect(written.some((l) => l.includes("drive failed_read ms=0 error=TypeError"))).toBe(true);
    expect(written.filter((l) => l.includes("read")).length).toBe(2);
    expect(d.report([])).toContain("drive:read 3 1 1 1005 3010");
  });

  it("writes every timed step down with detailed logging on, but only counts the window's calls", () => {
    const { d, written } = setup();
    d.setDetailed(true);
    d.record("upload", "file", 12);
    expect(written.at(-1)).toContain("upload file ms=12");
    d.record("rpc", "getPreview", 20);
    expect(written.at(-1)).toContain("upload file ms=12");
    expect(d.report([])).toContain("rpc:getPreview 1 0 0 20 20");
  });

  it("keeps a line another module wrote, without writing it again", () => {
    const { d, written } = setup();
    d.capture("faces", "saved the copy to Drive: 168 faces, 505 photos\n");
    expect(written).toEqual([]);
    expect(d.report([])).toContain("faces saved the copy to Drive: 168 faces, 505 photos");
  });

  it("reports a working job that stops moving, once, and when it moves again", () => {
    const { d, written, advance } = setup();
    let progress = 0;
    let active = true;
    d.watch("scan", { active: () => active, progress: () => progress });
    d.checkStalls();
    progress = 5;
    advance(10_000);
    d.checkStalls();
    advance(STALL_MS);
    d.checkStalls();
    advance(60_000);
    d.checkStalls();
    expect(written.filter((l) => l.includes("not_moving")).length).toBe(1);
    expect(d.stalled()).toEqual(["scan"]);
    progress = 6;
    d.checkStalls();
    expect(written.at(-1)).toContain("stall moving_again job=scan");
    active = false;
    advance(STALL_MS * 2);
    d.checkStalls();
    expect(d.stalled()).toEqual([]);
  });
});
