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

export type BackupKind = "faces" | "labels" | "search" | "hidden" | "settings" | "albumOrder";

export type BackupPart = {
  kind: BackupKind;
  /** Whether this part has something its copy on Drive does not; with `all`, whether it has anything to save. */
  dirty: (all: boolean) => boolean;
  /** Writes this part's copy to Drive; false when the copy there already held it. `all` writes it anyway. */
  save: (all: boolean) => Promise<boolean | void>;
  /**
   * Whether this part holds a change that is not on Drive, also one a round may not write yet (a
   * read that failed); `dirty(false)` when not given.
   */
  unsaved?: () => boolean;
};

/** What a sign-out's save found: whether a round is still under way, and the kinds not on Drive. */
export type SignOutSave = { done: boolean; unsaved: BackupKind[] };

/** What a round's read found on Drive beyond what it took in. */
export type BackupRead = {
  /** Copies that were there but would not open or read, this computer's own among them. */
  unreadable: number;
  /** The kinds whose copy of this computer's would not open: they keep that copy and wait for the next round. */
  held: BackupKind[];
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

/**
 * The order a round writes the parts in: the small lists the user edits by hand first, then the
 * face and search copies, which are large and slow to write. A wait that runs out mid-round (a quit,
 * a sign-out) then has the hand-made lists on Drive already.
 */
export const SAVE_ORDER: readonly BackupKind[] = ["labels", "hidden", "settings", "albumOrder", "faces", "search"];

/** A change waits this long, so a run of edits goes out as one save. */
export const SAVE_AFTER_MS = 3 * 60_000;
/** A round runs this often anyway, for what the other devices saved. */
export const ROUND_EVERY_MS = 30 * 60_000;
/** After a failed round, the next one comes this soon rather than at the half hour. */
export const RETRY_AFTER_MS = 2 * 60_000;
/** While the app runs, Drive's folder listings are asked this often whether another device saved something. */
export const LOOK_EVERY_MS = 2 * 60_000;
/** A look asked for by the window coming back waits this long after the last look or round. */
export const LOOK_GAP_MS = 60_000;

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
  /** The last round started: the one running, or the one queued after it. Set only by `startRound`. */
  private running: Promise<void> | null = null;
  /** Something changed while a round ran, after it had read what it saves. */
  private again = false;
  private soon: unknown = null;
  private every: unknown = null;
  /** The next look at the listings. */
  private poll: unknown = null;
  private looking: Promise<boolean> | null = null;
  /** When the last look or round started. */
  private lastLook = Number.NEGATIVE_INFINITY;
  /**
   * A round is still reading the other devices' copies and has not looked at what it saves yet: a
   * change now (one its own read took in, or the user's) goes out with that round's saves.
   */
  private reading = false;
  /** The window is in the tray: the quick look waits until it is back; the rounds and saves go on. */
  private hidden = false;
  /** Looks in a row that could not reach Drive: each waits twice as long as the one before. */
  private lookFailures = 0;
  private status: BackupStatus = { on: false, running: false, lastAt: null, failed: false, saved: {} };
  /** Told what is not on Drive after each change and each round, and nothing once turned off. */
  private unsavedListener: ((kinds: BackupKind[]) => void) | null = null;

  constructor(
    /** Reads every other device's copy from Drive and takes in what is new. */
    private readonly read: () => Promise<BackupRead | void>,
    private readonly parts: () => BackupPart[],
    private readonly timers: Timers = realTimers,
    /**
     * Whether another device's copy on Drive changed since this computer last read it, from the
     * folder listings alone. Without it, only the rounds look.
     */
    private readonly anythingNew: (() => Promise<boolean>) | null = null,
  ) {}

  /** Who is told what is not on Drive yet: after a change, after a round, and on turning it off. */
  setUnsavedListener(listener: ((kinds: BackupKind[]) => void) | null): void {
    this.unsavedListener = listener;
  }

  private tellUnsaved(): void {
    if (!this.unsavedListener) return;
    try {
      this.unsavedListener(this.unsaved());
    } catch {
      // Only a record of what waits; the backup goes on without it.
    }
  }

  getStatus(): BackupStatus {
    return { ...this.status, saved: { ...this.status.saved } };
  }

  /**
   * Turns the shared backup on or off. On, a round runs now and then every half hour, and every
   * couple of minutes the folder listings are asked whether another device saved something.
   */
  setOn(on: boolean): BackupStatus {
    if (on === this.on) return this.getStatus();
    this.on = on;
    this.status.on = on;
    this.stopTimers();
    // Turned off, nothing here is meant for Drive any more.
    if (!on) this.tellUnsaved();
    // The round's end sets the first look.
    if (on) void this.syncNow();
    return this.getStatus();
  }

  /**
   * The window came back: Drive is asked whether another device saved something, unless a look or
   * a round started within the last minute. Resolves whether a round ran for what it found.
   */
  check(): Promise<boolean> {
    if (!this.on || this.timers.now() - this.lastLook < LOOK_GAP_MS) return Promise.resolve(false);
    return this.look();
  }

  /**
   * The window went to the tray, or came back. The quick look at the listings is for while the app
   * is open: it pauses in the tray (the half-hour round and the saves of changes go on) and comes
   * back as the window does, with a look at once unless one ran within the last minute.
   */
  setShown(shown: boolean): void {
    if (shown === !this.hidden) return;
    this.hidden = !shown;
    if (!shown) {
      this.clearPoll();
      return;
    }
    void this.check().finally(() => {
      if (this.poll === null && !this.running && !this.looking) this.armLook();
    });
  }

  /**
   * The user refreshed the library. A change still waiting for its save goes out now, and that
   * round reads every other device's copy before it writes, so it is the check as well. With
   * nothing waiting, Drive's folder listings are asked whether another device saved something,
   * without the minute's gap a returning window keeps, and a round runs only when one did.
   * Resolves whether a round ran.
   */
  async refresh(): Promise<boolean> {
    if (!this.on) return false;
    const waiting = this.soon !== null || this.again;
    const round = await (waiting ? this.flush() : this.look());
    diag.log("backup", "refresh", { waiting, round });
    return round;
  }

  /**
   * For a quit or a close to the tray: a change still waiting for its save is saved now, and a
   * round under way is waited for. Resolves true once that is done; false at once with nothing to wait for.
   * The host asks again every second until it is done, and every ask answers with the same round:
   * the last one queued, which is the one carrying the waiting change. A change made since the last
   * ask queues one more round behind it, and from then on that is the answer.
   */
  flush(): Promise<boolean> {
    if (!this.on) return Promise.resolve(false);
    const waiting = this.soon !== null || this.again;
    if (waiting) {
      this.clearSoon();
      this.again = false;
      void this.startRound(false, this.running !== null);
    }
    const last = this.running;
    return last ? last.then(() => true, () => true) : Promise.resolve(false);
  }

  /**
   * `flush`, waited for at most `ms`: false when the wait ran out first. The save goes on, and one
   * cut short by the app ending leaves the copy on Drive as it was and the change waiting here.
   */
  flushWithin(ms: number): Promise<boolean> {
    const flushing = this.flush();
    if (ms <= 0) {
      void flushing.catch(() => undefined);
      return Promise.resolve(false);
    }
    let timer: unknown = null;
    const out = new Promise<boolean>((resolve) => {
      timer = this.timers.set(() => resolve(false), ms);
    });
    return Promise.race([flushing.then(() => true, () => false), out]).finally(() => this.timers.clear(timer));
  }

  /**
   * The kinds holding a change that is not on Drive, which a sign-out would delete. The search
   * index is left out: this computer makes it again.
   */
  unsaved(): BackupKind[] {
    if (!this.on) return [];
    const out: BackupKind[] = [];
    for (const part of this.parts()) {
      if (part.kind === "search") continue;
      try {
        if (part.unsaved ? part.unsaved() : part.dirty(false)) out.push(part.kind);
      } catch {
        /* a store that cannot be read holds nothing this can save */
      }
    }
    return out;
  }

  /**
   * For a sign-out, which deletes what is not on Drive. With `start`, a change waiting, or one an
   * earlier round could not save, goes out now in a round of its own; then the round under way is
   * waited for at most `ms`. `done` once no round runs, with the kinds still not on Drive.
   */
  async saveForSignOut(ms: number, start: boolean): Promise<SignOutSave> {
    if (!this.on) return { done: true, unsaved: [] };
    if (start) {
      const waiting = this.soon !== null || this.again || (this.running === null && this.unsaved().length > 0);
      if (waiting) {
        this.clearSoon();
        this.again = false;
        void this.startRound(false, this.running !== null);
      }
    }
    const last = this.running;
    if (last && ms > 0) {
      let timer: unknown = null;
      await Promise.race([
        last.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = this.timers.set(resolve, ms);
        }),
      ]).finally(() => this.timers.clear(timer));
    }
    const done = this.running === null;
    return { done, unsaved: done ? this.unsaved() : [] };
  }

  /** Something here changed: a round runs a few minutes after the last change. */
  changed(): void {
    if (this.on) this.tellUnsaved();
    if (!this.on || this.reading) return;
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
    return this.startRound(false);
  }

  /**
   * "Back up now": one round whether the automatic backup is on or not, after the one running, if
   * any. It reads the other devices' copies first, then writes every copy of this computer's, also
   * one that did not change since it was last saved.
   */
  backUpNow(): Promise<void> {
    return this.startRound(true);
  }

  /**
   * Every round starts here: at once when none runs, otherwise queued after the last one started,
   * so no two rounds ever run side by side whatever asked for them. `followUp` is a round queued
   * behind another only to carry a change made while that one ran.
   */
  private startRound(all: boolean, followUp = false): Promise<void> {
    const before = this.running;
    const run = before ? before.catch(() => undefined).then(() => this.round(all, followUp)) : this.round(all, followUp);
    const next: Promise<void> = run.finally(() => {
      // A round queued behind this one carries on from here.
      if (this.running !== next) return;
      this.running = null;
      this.status.running = false;
      if (this.again && this.on) {
        this.again = false;
        void this.startRound(false, true);
      }
    });
    this.running = next;
    this.status.running = true;
    return next;
  }

  /** Stops the timers, for a sign-out; a round already running finishes on its own. */
  stop(): void {
    this.on = false;
    this.status = { on: false, running: false, lastAt: null, failed: false, saved: {} };
    this.stopTimers();
  }

  private clearSoon(): void {
    if (this.soon) this.timers.clear(this.soon);
    this.soon = null;
  }

  private stopTimers(): void {
    if (this.soon) this.timers.clear(this.soon);
    if (this.every) this.timers.clear(this.every);
    if (this.poll) this.timers.clear(this.poll);
    this.soon = null;
    this.every = null;
    this.poll = null;
    this.lookFailures = 0;
  }

  /**
   * The next look at the listings, a couple of minutes from now (longer after looks that could not
   * reach Drive), while the backup is on. Set again at the end of every look and every round, so
   * the timed look always comes that long after the last one, whatever started it.
   */
  private armLook(): void {
    this.clearPoll();
    if (!this.anythingNew || !this.on || this.hidden) return;
    this.poll = this.timers.set(
      () => {
        this.poll = null;
        void this.look().finally(() => {
          // A look that did not run (after a failed round) sets the next one here; a round sets its own.
          if (this.poll === null && !this.running && !this.looking) this.armLook();
        });
      },
      Math.min(LOOK_EVERY_MS * 2 ** this.lookFailures, ROUND_EVERY_MS),
    );
  }

  private clearPoll(): void {
    if (this.poll) this.timers.clear(this.poll);
    this.poll = null;
  }

  /**
   * Asks the listings whether another device saved something since this computer last read it, and
   * runs a round when one did. Nothing is asked while a round runs (it reads anyway) or after a
   * failed one (its retry comes on its own timer). Resolves whether a round ran.
   */
  private look(): Promise<boolean> {
    const anythingNew = this.anythingNew;
    if (!anythingNew || !this.on || this.running || this.status.failed) return Promise.resolve(false);
    if (this.looking) return this.looking;
    this.lastLook = this.timers.now();
    this.clearPoll();
    this.looking = (async () => {
      let news: boolean;
      try {
        news = await anythingNew();
        this.lookFailures = 0;
      } catch (e) {
        // Offline, or Drive did not answer: the next look waits longer.
        this.lookFailures = Math.min(this.lookFailures + 1, 4);
        diag.log("backup", "look_failed", { error: (e as Error)?.name ?? "error", failures: this.lookFailures });
        return false;
      }
      if (!news || !this.on) return false;
      await this.syncNow();
      return true;
    })().finally(() => {
      this.looking = null;
      this.armLook();
    });
    return this.looking;
  }

  private async round(all = false, followUp = false): Promise<void> {
    // The round before this one read the other devices' copies a moment ago, and its own saves
    // carried the change it was queued for: nothing is left to read or write.
    if (followUp && !all && !this.status.failed && !this.parts().some((part) => part.dirty(false))) {
      this.clearSoon();
      this.again = false;
      diag.log("backup", "round_not_needed");
      return;
    }
    this.status.running = true;
    if (this.every) this.timers.clear(this.every);
    // Every change made until now goes out with this round: its own save is not needed any more.
    this.clearSoon();
    this.again = false;
    // No look while a round reads anyway; its end sets the next one.
    this.clearPoll();
    const started = this.timers.now();
    this.lastLook = started;
    let failed = false;
    let written = 0;
    let unreadable = 0;
    let held = 0;
    this.reading = true;
    try {
      const read = await diag.time("backup", "read", () => this.read()).finally(() => {
        this.reading = false;
      });
      // A copy that would not open leaves the round failed, so it is read again soon.
      unreadable = read?.unreadable ?? 0;
      if (unreadable > 0) {
        failed = true;
        process.stderr.write(`[backup] copies on Drive that could not be read: ${unreadable}\n`);
      }
      const parts = [...this.parts()].sort((a, b) => SAVE_ORDER.indexOf(a.kind) - SAVE_ORDER.indexOf(b.kind));
      for (const part of parts) {
        if (!this.on && !all) break;
        // Nothing is written over this computer's own copy while it could not be read.
        if (read?.held.includes(part.kind)) {
          failed = true;
          held++;
          process.stderr.write(`[backup] the ${part.kind} copy was not saved: this computer's copy on Drive could not be read\n`);
          continue;
        }
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
    diag.log("backup", "round", { s: Math.round((this.status.lastAt - started) / 1000), parts_saved: written, unreadable, parts_held: held, failed });
    if (this.on) {
      this.tellUnsaved();
      if (this.every) this.timers.clear(this.every);
      this.every = this.timers.set(
        () => {
          this.every = null;
          void this.syncNow();
        },
        failed ? RETRY_AFTER_MS : ROUND_EVERY_MS,
      );
      this.armLook();
    }
  }
}
