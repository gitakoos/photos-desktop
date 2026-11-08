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

// The shared backup on Proton Drive: this computer and the phone each keep their own copy of the
// faces, the labels and the search index there, and each takes in what the others saved. A round
// always reads first: every other device's copy newer than the one taken in last is put together
// with what is here, and only then is this computer's own copy written back, so it carries both.

import { createHash } from "node:crypto";

import { diag } from "./diag.ts";

export type BackupKind = "faces" | "labels" | "search" | "hidden";

export type BackupPart = {
  kind: BackupKind;
  /** Whether this part has something its copy on Drive does not; with `all`, whether it has anything to save. */
  dirty: (all: boolean) => boolean;
  /** Writes this part's copy to Drive; false when the copy there already held it. `all` writes it anyway. */
  save: (all: boolean) => Promise<boolean | void>;
};

export type BackupStatus = {
  on: boolean;
  running: boolean;
  /** When the last round finished, and whether it failed. */
  lastAt: number | null;
  failed: boolean;
  /** When each part's copy was last written from here. */
  saved: Partial<Record<BackupKind, number>>;
};

/**
 * What each part's copy on Drive held when this computer last wrote it, as a fingerprint of its
 * content, so a copy with nothing new is not written again: not after a restart, and not on a
 * round that found nothing to change. Kept in the store, so it survives a restart.
 */
export class SavedCopies {
  constructor(
    private readonly read: () => Record<string, string>,
    private readonly write: (saved: Record<string, string>) => void,
  ) {}

  private static fingerprint(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /** Whether `content` is what the part's copy on Drive already holds. */
  unchanged(kind: BackupKind, content: Buffer): boolean {
    return this.read()[kind] === SavedCopies.fingerprint(content);
  }

  /** Remembers `content` as what the part's copy on Drive holds now. */
  record(kind: BackupKind, content: Buffer): void {
    this.write({ ...this.read(), [kind]: SavedCopies.fingerprint(content) });
  }
}

/** A change waits this long, so a run of edits goes out as one save. */
export const SAVE_AFTER_MS = 3 * 60_000;
/** A round runs this often anyway, for what the other devices saved. */
export const ROUND_EVERY_MS = 30 * 60_000;
/** After a failed round, the next one comes this soon rather than at the half hour. */
export const RETRY_AFTER_MS = 2 * 60_000;

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
  now: () => number;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class SharedBackup {
  private on = false;
  private running: Promise<void> | null = null;
  /** Something changed while a round ran, after it had read what it saves. */
  private again = false;
  private soon: unknown = null;
  private every: unknown = null;
  private status: BackupStatus = { on: false, running: false, lastAt: null, failed: false, saved: {} };

  constructor(
    /** Reads every other device's copy from Drive and takes in what is new. */
    private readonly read: () => Promise<void>,
    private readonly parts: () => BackupPart[],
    private readonly timers: Timers = realTimers,
  ) {}

  getStatus(): BackupStatus {
    return { ...this.status, saved: { ...this.status.saved } };
  }

  /** Turns the shared backup on or off. On, a round runs now and then every half hour. */
  setOn(on: boolean): BackupStatus {
    if (on === this.on) return this.getStatus();
    this.on = on;
    this.status.on = on;
    this.stopTimers();
    if (on) void this.syncNow();
    return this.getStatus();
  }

  /** Something here changed: a round runs a few minutes after the last change. */
  changed(): void {
    if (!this.on) return;
    if (this.running) this.again = true;
    if (this.soon) this.timers.clear(this.soon);
    this.soon = this.timers.set(() => {
      this.soon = null;
      void this.syncNow();
    }, SAVE_AFTER_MS);
  }

  /** Runs a round now; while one runs, that one is the answer. Resolves when it is done. */
  syncNow(): Promise<void> {
    if (!this.on) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.round().finally(() => {
      this.running = null;
      this.status.running = false;
      if (this.again && this.on) {
        this.again = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  /**
   * "Back up now": one round whether the automatic backup is on or not, after the one running, if
   * any. It reads the other devices' copies first, then writes every copy of this computer's, also
   * one that did not change since it was last saved.
   */
  async backUpNow(): Promise<void> {
    if (this.running) await this.running.catch(() => undefined);
    this.running = this.round(true).finally(() => {
      this.running = null;
      this.status.running = false;
    });
    return this.running;
  }

  /** Stops the timers, for a sign-out; a round already running finishes on its own. */
  stop(): void {
    this.on = false;
    this.status = { on: false, running: false, lastAt: null, failed: false, saved: {} };
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.soon) this.timers.clear(this.soon);
    if (this.every) this.timers.clear(this.every);
    this.soon = null;
    this.every = null;
  }

  private async round(all = false): Promise<void> {
    this.status.running = true;
    if (this.every) this.timers.clear(this.every);
    const started = this.timers.now();
    let failed = false;
    let written = 0;
    try {
      await diag.time("backup", "read", () => this.read());
      for (const part of this.parts()) {
        if (!this.on && !all) break;
        if (!part.dirty(all)) continue;
        try {
          const wrote = await diag.time("backup", `save_${part.kind}`, () => part.save(all));
          if (wrote !== false) {
            written++;
            this.status.saved[part.kind] = this.timers.now();
          }
        } catch (e) {
          failed = true;
          process.stderr.write(`[backup] the ${part.kind} copy was not saved: ${(e as Error)?.name ?? "error"}\n`);
        }
      }
    } catch (e) {
      // Nothing is written over a copy that could not be read first.
      failed = true;
      process.stderr.write(`[backup] the copies on Drive could not be read: ${(e as Error)?.name ?? "error"}\n`);
    }
    this.status.failed = failed;
    this.status.lastAt = this.timers.now();
    diag.log("backup", "round", { s: Math.round((this.status.lastAt - started) / 1000), parts_saved: written, failed });
    if (this.on) {
      if (this.every) this.timers.clear(this.every);
      this.every = this.timers.set(
        () => {
          this.every = null;
          void this.syncNow();
        },
        failed ? RETRY_AFTER_MS : ROUND_EVERY_MS,
      );
    }
  }
}
