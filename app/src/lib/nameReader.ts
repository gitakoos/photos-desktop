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
 * Reads photo names a batch at a time, each photo asked for once: photos added while a reading
 * is under way join it rather than start it over. One asked and not answered counts as read.
 */
export class NameReader {
  private waiting: string[] = [];
  private asked = new Set<string>();
  private unanswered = new Set<string>();
  private draining = false;
  private stopped = false;

  constructor(
    private readonly names: Map<string, string>,
    private readonly fetch: (uids: string[]) => Promise<{ uid: string; name: string }[] | null>,
    private readonly onBatch: () => void,
    private readonly batch = 400,
  ) {}

  add(uids: string[]): void {
    for (const uid of uids) {
      if (this.names.has(uid) || this.asked.has(uid)) continue;
      this.asked.add(uid);
      this.waiting.push(uid);
    }
    if (!this.draining && this.waiting.length > 0) void this.drain();
  }

  isRead(uid: string): boolean {
    return this.names.has(uid) || this.unanswered.has(uid);
  }

  stop(): void {
    this.stopped = true;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.stopped && this.waiting.length > 0) {
        const uids = this.waiting.splice(0, this.batch);
        const rows = await this.fetch(uids).catch(() => null);
        if (rows) for (const r of rows) this.names.set(r.uid, r.name);
        for (const uid of uids) if (!this.names.has(uid)) this.unanswered.add(uid);
        if (!this.stopped) this.onBatch();
      }
    } finally {
      this.draining = false;
    }
  }
}
