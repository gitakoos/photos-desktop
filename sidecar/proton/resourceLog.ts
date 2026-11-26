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

// With Detailed logging on, the sidecar's own CPU and memory in the app's log every few seconds:
//   [HH:MM:SS] [sidecar] [res] sidecar cpu=<percent> rss_mb=<n> heap_mb=<n>
// Numbers only. With it off nothing is measured and nothing is written.

import { logStamp } from "./diag.ts";

/** How often a resource line is written. */
const EVERY_MS = 5_000;

export type ResourceReading = { cpuMicros: number; rssBytes: number; heapBytes: number; atMs: number };

function readOwn(): ResourceReading {
  const cpu = process.cpuUsage();
  const mem = process.memoryUsage();
  return { cpuMicros: cpu.user + cpu.system, rssBytes: mem.rss, heapBytes: mem.heapUsed, atMs: performance.now() };
}

/** The log line for CPU use over a stretch (as a percentage of one core, as top shows it) and the memory held now. */
export function resourceLine(before: ResourceReading, now: ResourceReading): string {
  const wallMicros = (now.atMs - before.atMs) * 1000;
  const cpu = wallMicros > 0 ? Math.max(0, now.cpuMicros - before.cpuMicros) / wallMicros * 100 : 0;
  const mb = (bytes: number) => Math.round(bytes / 1_048_576);
  return `[res] sidecar cpu=${cpu.toFixed(1)} rss_mb=${mb(now.rssBytes)} heap_mb=${mb(now.heapBytes)}`;
}

export class ResourceLog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: ResourceReading | null = null;

  constructor(
    private readonly write: (line: string) => void = (line) => process.stderr.write(`${logStamp()} [sidecar] ${line}\n`),
    private readonly read: () => ResourceReading = readOwn,
  ) {}

  /** Follows the Detailed logging setting. */
  set(on: boolean): void {
    if (!on) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.last = null;
      return;
    }
    if (this.timer) return;
    this.last = this.read();
    this.timer = setInterval(() => this.tick(), EVERY_MS);
    this.timer.unref?.();
  }

  /** One look: a line for the stretch since the last, while on. */
  tick(): void {
    if (!this.timer || !this.last) return;
    const now = this.read();
    this.write(resourceLine(this.last, now));
    this.last = now;
  }
}

export const resourceLog = new ResourceLog();
