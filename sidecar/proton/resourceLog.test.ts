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

import { ResourceLog, resourceLine, type ResourceReading } from "./resourceLog.ts";

const MB = 1_048_576;
const at = (atMs: number, cpuMicros: number, rssMb = 100, heapMb = 40): ResourceReading => ({
  atMs,
  cpuMicros,
  rssBytes: rssMb * MB,
  heapBytes: heapMb * MB,
});

describe("a sidecar resource line", () => {
  it("gives CPU as a share of one core over the stretch, and memory in MB", () => {
    expect(resourceLine(at(0, 0), at(5_000, 1_250_000, 180, 62))).toBe("[res] sidecar cpu=25.0 rss_mb=180 heap_mb=62");
  });

  it("can pass one core when several threads work", () => {
    expect(resourceLine(at(0, 0), at(1_000, 1_500_000))).toBe("[res] sidecar cpu=150.0 rss_mb=100 heap_mb=40");
  });

  it("never shows a negative or undefined share", () => {
    expect(resourceLine(at(0, 0), at(0, 10))).toBe("[res] sidecar cpu=0.0 rss_mb=100 heap_mb=40");
  });
});

describe("the resource log", () => {
  let log: ResourceLog | null = null;
  afterEach(() => log?.set(false));

  function made() {
    const lines: string[] = [];
    const readings = [at(0, 0), at(5_000, 500_000), at(10_000, 500_000)];
    log = new ResourceLog((line) => lines.push(line), () => readings.shift()!);
    return { log, lines };
  }

  it("writes nothing while Detailed logging is off", () => {
    const { log, lines } = made();
    log.tick();
    log.tick();
    expect(lines).toEqual([]);
  });

  it("writes a line for each look while it is on, and none once it is off again", () => {
    const { log, lines } = made();
    log.set(true);
    log.tick();
    log.tick();
    log.set(false);
    log.tick();
    expect(lines).toEqual(["[res] sidecar cpu=10.0 rss_mb=100 heap_mb=40", "[res] sidecar cpu=0.0 rss_mb=100 heap_mb=40"]);
  });
});
