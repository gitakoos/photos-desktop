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

import {
  LOOK_EVERY_MS,
  LOOK_GAP_MS,
  RETRY_AFTER_MS,
  ROUND_EVERY_MS,
  SAVE_AFTER_MS,
  SavedCopies,
  SharedBackup,
  type BackupPart,
  type BackupRead,
} from "./sharedBackup.ts";

/** Timers run by hand: `advance` fires what has come due. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn: () => void, ms: number) => {
      const id = next++;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (id: unknown) => void due.delete(id as number),
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        due.delete(id);
        t.fn();
      }
    },
    pending: () => due.size,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(withLook = false) {
  const log: string[] = [];
  const dirty = { faces: false, labels: true, search: false };
  // Runs once inside the next part's save: a change made after the round has read.
  let duringSave: (() => void) | null = null;
  const parts = (): BackupPart[] =>
    (["faces", "labels", "search"] as const).map((kind) => ({
      kind,
      dirty: (all) => all || dirty[kind],
      save: async (all) => {
        log.push(`save ${kind}${all ? " (all)" : ""}`);
        dirty[kind] = false;
        const hook = duringSave;
        duringSave = null;
        hook?.();
      },
    }));
  const timers = fakeTimers();
  let readFails = false;
  let found: BackupRead | undefined;
  // The listings: the revision another device saved, against the one this computer read last.
  const drive = { revision: 1, seen: 1, offline: false };
  const backup = new SharedBackup(
    async () => {
      log.push("read");
      if (readFails) throw new Error("offline");
      drive.seen = drive.revision;
      return found;
    },
    parts,
    timers,
    withLook
      ? async () => {
          log.push("look");
          if (drive.offline) throw new Error("offline");
          return drive.revision !== drive.seen;
        }
      : null,
  );
  return {
    backup,
    log,
    dirty,
    timers,
    drive,
    failRead: (v: boolean) => (readFails = v),
    readFinds: (v: BackupRead | undefined) => (found = v),
    duringSave: (fn: () => void) => (duringSave = fn),
  };
}

describe("the shared backup", () => {
  it("counts as saved only a part whose copy was written", async () => {
    const timers = fakeTimers();
    const backup = new SharedBackup(async () => {}, () => [{ kind: "faces", dirty: () => true, save: async () => false }], timers);
    backup.setOn(true);
    await backup.syncNow();
    expect(backup.getStatus().saved.faces).toBeUndefined();
  });

  it("reads every other copy first, then writes only the parts that changed", async () => {
    const { backup, log } = setup();
    backup.setOn(true);
    await backup.syncNow();
    expect(log).toEqual(["read", "save labels"]);
    expect(backup.getStatus().saved.labels).toBe(0);
  });

  it("writes nothing over a copy it could not read first", async () => {
    const { backup, log, failRead } = setup();
    failRead(true);
    backup.setOn(true);
    await settle();
    expect(log).toEqual(["read"]);
    expect(backup.getStatus().failed).toBe(true);
  });

  it("keeps this computer's copy of a kind that would not open, saves the rest, and tries again soon", async () => {
    const { backup, log, dirty, readFinds, timers } = setup();
    dirty.faces = true;
    readFinds({ unreadable: 1, held: ["faces"] });
    backup.setOn(true);
    await settle();
    expect(log).toEqual(["read", "save labels"]);
    expect(backup.getStatus().failed).toBe(true);
    expect(backup.getStatus().saved.faces).toBeUndefined();
    // "Back up now" does not write over it either.
    log.length = 0;
    await backup.backUpNow();
    expect(log).toEqual(["read", "save labels (all)", "save search (all)"]);
    // The copy opens on the next round, a couple of minutes on, and is written then.
    readFinds({ unreadable: 0, held: [] });
    log.length = 0;
    timers.advance(RETRY_AFTER_MS);
    await settle();
    expect(log).toEqual(["read", "save faces"]);
    expect(backup.getStatus().failed).toBe(false);
  });

  it("still saves this computer's copies when another device's would not open, and says the round failed", async () => {
    const { backup, log, readFinds, timers } = setup();
    readFinds({ unreadable: 1, held: [] });
    backup.setOn(true);
    await settle();
    expect(log).toEqual(["read", "save labels"]);
    expect(backup.getStatus().saved.labels).toBe(0);
    expect(backup.getStatus().failed).toBe(true);
    log.length = 0;
    timers.advance(RETRY_AFTER_MS);
    await settle();
    expect(log).toEqual(["read"]);
  });

  it("after a failed round, tries again in a couple of minutes, and the next round recovers", async () => {
    const { backup, log, failRead, timers } = setup();
    failRead(true);
    backup.setOn(true);
    await settle();
    expect(backup.getStatus().failed).toBe(true);
    failRead(false);
    log.length = 0;
    timers.advance(RETRY_AFTER_MS);
    await settle();
    expect(log).toEqual(["read", "save labels"]);
    expect(backup.getStatus().failed).toBe(false);
  });

  it("backs up now with the automatic backup off: reads first, then writes every part", async () => {
    const { backup, log, timers } = setup();
    await backup.backUpNow();
    expect(log).toEqual(["read", "save labels (all)", "save faces (all)", "save search (all)"]);
    // Off, it leaves no round behind.
    expect(timers.pending()).toBe(0);
    expect(backup.getStatus().on).toBe(false);
  });

  it("saves a few minutes after the last of several changes, once", async () => {
    const { backup, log, dirty, timers } = setup();
    backup.setOn(true);
    await settle();
    log.length = 0;
    dirty.faces = true;
    backup.changed();
    timers.advance(SAVE_AFTER_MS - 1000);
    backup.changed();
    timers.advance(SAVE_AFTER_MS - 1000);
    expect(log).toEqual([]);
    timers.advance(1000);
    await settle();
    expect(log).toEqual(["read", "save faces"]);
  });

  it("runs another round after the one running when something changed after it read", async () => {
    const { backup, log, dirty, duringSave } = setup();
    backup.setOn(true);
    const first = backup.syncNow();
    expect(backup.syncNow()).toBe(first);
    // The labels part was already looked at when this change comes.
    duringSave(() => {
      dirty.labels = true;
      backup.changed();
    });
    await first;
    await settle();
    await settle();
    expect(log.filter((l) => l === "read").length).toBe(2);
  });

  it("looks again every half hour, and stops when turned off", async () => {
    const { backup, log, timers } = setup();
    backup.setOn(true);
    await settle();
    log.length = 0;
    timers.advance(ROUND_EVERY_MS);
    await settle();
    expect(log).toEqual(["read"]);
    backup.setOn(false);
    expect(timers.pending()).toBe(0);
    backup.changed();
    expect(timers.pending()).toBe(0);
  });
});

describe("the quick look at the other devices' copies", () => {
  it("asks the listings every couple of minutes and runs a round only when another device saved something", async () => {
    const { backup, log, drive, timers } = setup(true);
    backup.setOn(true);
    await settle();
    log.length = 0;
    timers.advance(LOOK_EVERY_MS);
    await settle();
    expect(log).toEqual(["look"]);
    drive.revision = 2;
    log.length = 0;
    timers.advance(LOOK_EVERY_MS);
    await settle();
    await settle();
    expect(log).toEqual(["look", "read"]);
    // Taken in: the next look finds nothing new.
    log.length = 0;
    timers.advance(LOOK_EVERY_MS);
    await settle();
    expect(log).toEqual(["look"]);
  });

  it("keeps the half-hour round as a fallback", async () => {
    const { backup, log, timers } = setup(true);
    backup.setOn(true);
    await settle();
    log.length = 0;
    for (let i = 0; i < ROUND_EVERY_MS / LOOK_EVERY_MS; i++) {
      timers.advance(LOOK_EVERY_MS);
      await settle();
    }
    expect(log.filter((l) => l === "read").length).toBe(1);
  });

  it("looks when the window comes back, at most once a minute", async () => {
    const { backup, log, drive, timers } = setup(true);
    backup.setOn(true);
    await settle();
    // The round on turning on counts as the last look.
    log.length = 0;
    expect(await backup.check()).toBe(false);
    expect(log).toEqual([]);
    timers.advance(LOOK_GAP_MS);
    drive.revision = 2;
    expect(await backup.check()).toBe(true);
    expect(log).toEqual(["look", "read"]);
    log.length = 0;
    timers.advance(LOOK_GAP_MS - 1000);
    expect(await backup.check()).toBe(false);
    expect(log).toEqual([]);
    timers.advance(1000);
    expect(await backup.check()).toBe(false);
    expect(log).toEqual(["look"]);
  });

  it("does not look while off or signed out", async () => {
    const { backup, log, drive, timers } = setup(true);
    drive.revision = 2;
    expect(await backup.check()).toBe(false);
    timers.advance(LOOK_EVERY_MS * 3);
    await settle();
    expect(log).toEqual([]);
    backup.setOn(true);
    await settle();
    backup.stop();
    log.length = 0;
    drive.revision = 3;
    timers.advance(LOOK_EVERY_MS * 3);
    await settle();
    timers.advance(LOOK_GAP_MS);
    expect(await backup.check()).toBe(false);
    expect(log).toEqual([]);
    expect(timers.pending()).toBe(0);
    backup.setOn(true);
    await settle();
    backup.setOn(false);
    expect(timers.pending()).toBe(0);
  });

  it("waits longer after each look that could not reach Drive, and goes back to every couple of minutes", async () => {
    const { backup, log, drive, timers } = setup(true);
    backup.setOn(true);
    await settle();
    drive.offline = true;
    log.length = 0;
    timers.advance(LOOK_EVERY_MS);
    await settle();
    expect(log).toEqual(["look"]);
    // The next look comes after twice the wait, then four times.
    log.length = 0;
    timers.advance(LOOK_EVERY_MS);
    await settle();
    expect(log).toEqual([]);
    timers.advance(LOOK_EVERY_MS);
    await settle();
    expect(log).toEqual(["look"]);
    log.length = 0;
    drive.offline = false;
    timers.advance(LOOK_EVERY_MS * 3);
    await settle();
    expect(log).toEqual([]);
    timers.advance(LOOK_EVERY_MS);
    await settle();
    expect(log).toEqual(["look"]);
    log.length = 0;
    timers.advance(LOOK_EVERY_MS);
    await settle();
    expect(log).toEqual(["look"]);
  });

  it("leaves a failed round to its own retry", async () => {
    const { backup, log, drive, failRead, timers } = setup(true);
    failRead(true);
    backup.setOn(true);
    await settle();
    expect(backup.getStatus().failed).toBe(true);
    drive.revision = 2;
    log.length = 0;
    timers.advance(LOOK_GAP_MS);
    expect(await backup.check()).toBe(false);
    expect(log).toEqual([]);
    // The retry comes at its time, and is the only read.
    timers.advance(RETRY_AFTER_MS - LOOK_GAP_MS);
    await settle();
    await settle();
    expect(log).toEqual(["read"]);
    failRead(false);
    log.length = 0;
    timers.advance(RETRY_AFTER_MS);
    await settle();
    await settle();
    expect(log.filter((l) => l === "read").length).toBe(1);
    expect(backup.getStatus().failed).toBe(false);
  });
});

describe("a refresh of the library", () => {
  it("saves a waiting change at once, and that round is the read of the other copies", async () => {
    const { backup, log, dirty, drive, timers } = setup(true);
    backup.setOn(true);
    await settle();
    log.length = 0;
    dirty.faces = true;
    drive.revision = 2;
    backup.changed();
    expect(await backup.refresh()).toBe(true);
    expect(log).toEqual(["read", "save faces"]);
    // The waiting save is gone, and the round counts as the last look.
    log.length = 0;
    timers.advance(SAVE_AFTER_MS);
    await settle();
    expect(log.filter((l) => l === "save faces")).toEqual([]);
    expect(await backup.check()).toBe(false);
  });

  it("with nothing waiting, looks without the minute's gap and runs a round only for a newer copy", async () => {
    const { backup, log, drive } = setup(true);
    backup.setOn(true);
    await settle();
    log.length = 0;
    expect(await backup.refresh()).toBe(false);
    expect(log).toEqual(["look"]);
    log.length = 0;
    drive.revision = 2;
    expect(await backup.refresh()).toBe(true);
    expect(log).toEqual(["look", "read"]);
  });

  it("restarts the same gap a look does, and keeps the half-hour round after its round", async () => {
    const { backup, log, drive, timers } = setup(true);
    backup.setOn(true);
    await settle();
    timers.advance(LOOK_GAP_MS);
    drive.revision = 2;
    expect(await backup.refresh()).toBe(true);
    log.length = 0;
    timers.advance(LOOK_GAP_MS - 1000);
    expect(await backup.check()).toBe(false);
    expect(log).toEqual([]);
    timers.advance(ROUND_EVERY_MS - (LOOK_GAP_MS - 1000) - 1);
    await settle();
    expect(log.filter((l) => l === "read").length).toBe(0);
    timers.advance(1);
    await settle();
    expect(log.filter((l) => l === "read").length).toBe(1);
  });

  it("does nothing with the backup off or signed out", async () => {
    const { backup, log, dirty, drive, timers } = setup(true);
    drive.revision = 2;
    dirty.faces = true;
    backup.changed();
    expect(await backup.refresh()).toBe(false);
    backup.setOn(true);
    await settle();
    backup.stop();
    log.length = 0;
    drive.revision = 3;
    expect(await backup.refresh()).toBe(false);
    expect(log).toEqual([]);
    expect(timers.pending()).toBe(0);
  });

  it("asks once while a look is under way, and leaves an offline look to its backoff", async () => {
    const { backup, log, drive } = setup(true);
    backup.setOn(true);
    await settle();
    log.length = 0;
    drive.offline = true;
    const [a, b] = await Promise.all([backup.refresh(), backup.refresh()]);
    expect([a, b]).toEqual([false, false]);
    expect(log).toEqual(["look"]);
    expect(backup.getStatus().failed).toBe(false);
  });
});

describe("the save on quit", () => {
  it("saves a waiting change at once instead of minutes later", async () => {
    const { backup, log, dirty, timers } = setup();
    backup.setOn(true);
    await settle();
    log.length = 0;
    dirty.faces = true;
    backup.changed();
    expect(await backup.flushWithin(12_000)).toBe(true);
    expect(log).toEqual(["read", "save faces"]);
    // Nothing is left to go out when the old timer would have come.
    log.length = 0;
    timers.advance(SAVE_AFTER_MS);
    await settle();
    expect(log).toEqual([]);
  });

  it("answers at once with nothing waiting", async () => {
    const { backup, log } = setup();
    backup.setOn(true);
    await settle();
    log.length = 0;
    expect(await backup.flush()).toBe(false);
    expect(await backup.flushWithin(12_000)).toBe(true);
    expect(log).toEqual([]);
  });

  it("saves nothing with the backup off", async () => {
    const { backup, log, dirty } = setup();
    dirty.faces = true;
    backup.changed();
    expect(await backup.flush()).toBe(false);
    expect(log).toEqual([]);
  });

  it("saves a change made during a running round after it, once", async () => {
    const { backup, log, dirty, duringSave } = setup();
    backup.setOn(true);
    const first = backup.syncNow();
    let flushing: Promise<boolean> = Promise.resolve(false);
    // The labels part was already looked at when this change comes.
    duringSave(() => {
      dirty.labels = true;
      backup.changed();
      flushing = backup.flush();
    });
    await first;
    expect(await flushing).toBe(true);
    await settle();
    // One more round reads again after the running one, and no third follows.
    expect(log).toEqual(["read", "save labels", "read", "save labels"]);
  });

  it("needs no second round when the running one's later saves carried the change", async () => {
    const { backup, log, dirty, duringSave } = setup();
    backup.setOn(true);
    const first = backup.syncNow();
    let flushing: Promise<boolean> = Promise.resolve(false);
    // The search part comes after the one saving now, so this round still saves it.
    duringSave(() => {
      dirty.search = true;
      backup.changed();
      flushing = backup.flush();
    });
    await first;
    expect(await flushing).toBe(true);
    await settle();
    expect(log).toEqual(["read", "save labels", "save search"]);
  });

  it("gives up waiting when the time is up, and the change still goes out", async () => {
    const timers = fakeTimers();
    let release: () => void = () => {};
    const saved: string[] = [];
    let dirty = false;
    const backup = new SharedBackup(
      async () => {},
      () => [
        {
          kind: "labels",
          dirty: () => dirty,
          save: () =>
            new Promise<void>((resolve) => {
              release = () => {
                saved.push("labels");
                dirty = false;
                resolve();
              };
            }),
        },
      ],
      timers,
    );
    backup.setOn(true);
    await settle();
    dirty = true;
    backup.changed();
    const waited = backup.flushWithin(12_000);
    await settle();
    timers.advance(12_000);
    expect(await waited).toBe(false);
    expect(saved).toEqual([]);
    // The wait is over, the save is not: it lands, and a quit cut short here leaves the change waiting.
    release();
    await settle();
    expect(saved).toEqual(["labels"]);
  });

  it("writes the hand-made lists before the face and search copies, so a wait cut short loses the least", async () => {
    // The shape a sign-out met: a slow read, a slow face copy, and the labels, hidden list and
    // settings changed with it. The parts come in the order the session lists them, faces first.
    const timers = fakeTimers();
    const saved: string[] = [];
    const dirty = new Set<string>();
    const slow = (ms: number) => new Promise<void>((resolve) => timers.set(resolve, ms));
    const kinds = ["faces", "search", "labels", "hidden", "settings", "albumOrder"] as const;
    const cost: Record<string, number> = { faces: 5_000, search: 5_000, labels: 1_000, hidden: 1_000, settings: 1_000, albumOrder: 1_000 };
    const backup = new SharedBackup(
      () => slow(6_000),
      () =>
        kinds.map((kind) => ({
          kind,
          dirty: () => dirty.has(kind),
          save: async () => {
            await slow(cost[kind]);
            saved.push(kind);
            dirty.delete(kind);
          },
        })),
      timers,
    );
    backup.setOn(true);
    for (let i = 0; i < 4; i++) await settle();
    timers.advance(6_000);
    for (let i = 0; i < 4; i++) await settle();
    for (const kind of ["faces", "labels", "hidden", "settings"]) dirty.add(kind);
    backup.changed();
    const waited = backup.flushWithin(12_000);
    for (let s = 0; s < 12; s++) {
      for (let i = 0; i < 6; i++) await settle();
      timers.advance(1_000);
    }
    expect(await waited).toBe(false);
    expect(saved).toEqual(["labels", "hidden", "settings"]);
    for (let s = 0; s < 6; s++) {
      for (let i = 0; i < 6; i++) await settle();
      timers.advance(1_000);
    }
    for (let i = 0; i < 6; i++) await settle();
    expect(saved).toEqual(["labels", "hidden", "settings", "faces"]);
  });

  it("starts the save without waiting when asked for no wait", async () => {
    const { backup, log, dirty } = setup();
    backup.setOn(true);
    await settle();
    log.length = 0;
    dirty.faces = true;
    backup.changed();
    expect(await backup.flushWithin(0)).toBe(false);
    await settle();
    await settle();
    expect(log).toEqual(["read", "save faces"]);
  });
});

describe("the save before a sign-out", () => {
  /** Parts whose saves fail while `offline`, as a Drive that cannot be reached. */
  function signOutSetup() {
    const timers = fakeTimers();
    const dirty = new Set<string>();
    const net = { offline: false };
    const saved: string[] = [];
    const backup = new SharedBackup(
      async () => {
        if (net.offline) throw new Error("offline");
      },
      () =>
        (["faces", "search", "labels", "hidden", "settings"] as const).map((kind) => ({
          kind,
          dirty: () => dirty.has(kind),
          save: async () => {
            if (net.offline) throw new Error("offline");
            saved.push(kind);
            dirty.delete(kind);
          },
        })),
      timers,
    );
    return { backup, timers, dirty, net, saved };
  }

  it("saves the waiting change at once and answers done with nothing left", async () => {
    const { backup, dirty, saved } = signOutSetup();
    backup.setOn(true);
    await settle();
    dirty.add("labels");
    dirty.add("hidden");
    backup.changed();
    let r = await backup.saveForSignOut(1000, true);
    for (let i = 0; i < 5 && !r.done; i++) r = await backup.saveForSignOut(1000, false);
    expect(r).toEqual({ done: true, unsaved: [] });
    expect(saved).toEqual(["labels", "hidden"]);
  });

  it("names what could not reach Drive, and saves it on a try again", async () => {
    const { backup, dirty, net, saved } = signOutSetup();
    backup.setOn(true);
    await settle();
    net.offline = true;
    dirty.add("labels");
    dirty.add("settings");
    dirty.add("search");
    backup.changed();
    let r = await backup.saveForSignOut(1000, true);
    for (let i = 0; i < 5 && !r.done; i++) r = await backup.saveForSignOut(1000, false);
    // The search index is made again here, so it is never named as lost.
    expect(r).toEqual({ done: true, unsaved: ["labels", "settings"] });
    expect(backup.unsaved()).toEqual(["labels", "settings"]);
    // Asked without `start`, a failed round is not run again on its own.
    expect(await backup.saveForSignOut(1000, false)).toEqual({ done: true, unsaved: ["labels", "settings"] });
    net.offline = false;
    r = await backup.saveForSignOut(1000, true);
    for (let i = 0; i < 5 && !r.done; i++) r = await backup.saveForSignOut(1000, false);
    expect(r).toEqual({ done: true, unsaved: [] });
    expect(saved).toEqual(["labels", "settings", "search"]);
  });

  it("answers not done while the round runs past the wait", async () => {
    const timers = fakeTimers();
    let release: () => void = () => {};
    let dirty = false;
    const backup = new SharedBackup(
      async () => {},
      () => [
        {
          kind: "labels",
          dirty: () => dirty,
          save: () =>
            new Promise<void>((resolve) => {
              release = () => {
                dirty = false;
                resolve();
              };
            }),
        },
      ],
      timers,
    );
    backup.setOn(true);
    await settle();
    dirty = true;
    backup.changed();
    const first = backup.saveForSignOut(1000, true);
    await settle();
    timers.advance(1000);
    expect(await first).toEqual({ done: false, unsaved: [] });
    release();
    await settle();
    await settle();
    expect(await backup.saveForSignOut(1000, false)).toEqual({ done: true, unsaved: [] });
  });

  it("has nothing to save with the backup off", async () => {
    const { backup, dirty } = signOutSetup();
    dirty.add("labels");
    expect(await backup.saveForSignOut(1000, true)).toEqual({ done: true, unsaved: [] });
    expect(backup.unsaved()).toEqual([]);
  });

  it("takes a part's own word for a change a round may not write yet", () => {
    const backup = new SharedBackup(async () => {}, () => [{ kind: "settings", dirty: () => false, save: async () => {}, unsaved: () => true }], fakeTimers());
    backup.setOn(true);
    expect(backup.unsaved()).toEqual(["settings"]);
  });

  it("tells what waits after a change and after each round, and nothing once turned off", async () => {
    const { backup, dirty, net } = signOutSetup();
    const told: string[][] = [];
    backup.setUnsavedListener((kinds) => told.push(kinds));
    backup.setOn(true);
    await settle();
    told.length = 0;
    dirty.add("labels");
    backup.changed();
    expect(told).toEqual([["labels"]]);
    net.offline = true;
    let r = await backup.saveForSignOut(1000, true);
    for (let i = 0; i < 5 && !r.done; i++) r = await backup.saveForSignOut(1000, false);
    expect(told.at(-1)).toEqual(["labels"]);
    net.offline = false;
    r = await backup.saveForSignOut(1000, true);
    for (let i = 0; i < 5 && !r.done; i++) r = await backup.saveForSignOut(1000, false);
    expect(told.at(-1)).toEqual([]);
    dirty.add("hidden");
    backup.changed();
    expect(told.at(-1)).toEqual(["hidden"]);
    backup.setOn(false);
    expect(told.at(-1)).toEqual([]);
  });
});

describe("the copies already on Drive", () => {
  it("are not written again while they hold the same, also after a restart", () => {
    let kept: Record<string, string> = {};
    const saved = () => new SavedCopies(() => kept, (v) => (kept = v));
    const copy = Buffer.from("labels v1");
    expect(saved().unchanged("labels", copy)).toBe(false);
    saved().record("labels", copy);
    expect(saved().unchanged("labels", Buffer.from("labels v1"))).toBe(true);
    expect(saved().unchanged("faces", copy)).toBe(false);
    expect(saved().unchanged("labels", Buffer.from("labels v2"))).toBe(false);
  });
});

/** A backup whose reads wait until released, one release per read, and that counts rounds running at once. */
function gated() {
  const log: string[] = [];
  const timers = fakeTimers();
  const waiting: (() => void)[] = [];
  let reading = 0;
  let most = 0;
  let dirty = false;
  const backup = new SharedBackup(
    async () => {
      reading++;
      most = Math.max(most, reading);
      log.push("read");
      await new Promise<void>((r) => waiting.push(r));
      reading--;
    },
    () => [
      {
        kind: "faces",
        dirty: (all) => all || dirty,
        save: async (all) => {
          log.push(all ? "save (all)" : "save");
          dirty = false;
          await new Promise<void>((r) => waiting.push(r));
        },
      },
    ],
    timers,
  );
  return {
    backup,
    log,
    timers,
    change: () => {
      dirty = true;
      backup.changed();
    },
    /** Lets the oldest waiting read or save finish, then lets the round run on. */
    release: async () => {
      waiting.shift()?.();
      await settle();
      await settle();
    },
    most: () => most,
  };
}

describe("rounds one at a time", () => {
  it("never runs a save on quit and Back up now side by side", async () => {
    const { backup, change, release, most } = gated();
    backup.setOn(true);
    await release();
    // A Back up now saving when a change comes, then a save on quit and another Back up now.
    void backup.backUpNow();
    await release();
    change();
    const flushing = backup.flush();
    const backingUp = backup.backUpNow();
    for (let i = 0; i < 8; i++) await release();
    await Promise.all([flushing, backingUp]);
    expect(most()).toBe(1);
  });

  it("answers a quit's repeated asks only once the round carrying the waiting change is done", async () => {
    const { backup, log, timers, change, release } = gated();
    backup.setOn(true);
    await release();
    // A Back up now is saving when the change comes, so that round does not carry it.
    void backup.backUpNow();
    await release();
    change();
    // The host asks once a second; the first ask runs out while the Back up now still saves.
    const first = backup.flushWithin(1000);
    timers.advance(1000);
    expect(await first).toBe(false);
    const second = backup.flushWithin(1000);
    let savedWhenDone: boolean | null = null;
    void second.then((done) => {
      if (done) savedWhenDone = log.includes("save");
    });
    // The Back up now ends; the round with the change reads.
    await release();
    expect(savedWhenDone).toBeNull();
    await release();
    expect(savedWhenDone).toBeNull();
    await release();
    expect(await second).toBe(true);
    expect(savedWhenDone).toBe(true);
  });

  it("takes a waiting change along on any round, with no extra round when its timer would have come", async () => {
    const { backup, log, dirty, drive, timers } = setup(true);
    backup.setOn(true);
    await settle();
    dirty.faces = true;
    backup.changed();
    log.length = 0;
    await backup.backUpNow();
    expect(log).toContain("save faces (all)");
    // A change, then a look that finds another device's copy: its round carries the change.
    dirty.search = true;
    backup.changed();
    drive.revision = 2;
    timers.advance(LOOK_GAP_MS);
    expect(await backup.check()).toBe(true);
    expect(log).toContain("save search");
    log.length = 0;
    timers.advance(SAVE_AFTER_MS);
    await settle();
    expect(log.filter((l) => l === "read")).toEqual([]);
  });

  it("looks again a couple of minutes after the last look or round, whatever started it", async () => {
    const { backup, log, timers } = setup(true);
    backup.setOn(true);
    await settle();
    log.length = 0;
    // A refresh looks a minute and a half in: the next timed look waits two minutes from there.
    timers.advance(90_000);
    expect(await backup.refresh()).toBe(false);
    expect(log).toEqual(["look"]);
    log.length = 0;
    timers.advance(LOOK_EVERY_MS - 1000);
    await settle();
    expect(log).toEqual([]);
    timers.advance(1000);
    await settle();
    expect(log).toEqual(["look"]);
    // A round counts the same: Back up now pushes the next look back too.
    log.length = 0;
    timers.advance(60_000);
    await backup.backUpNow();
    log.length = 0;
    timers.advance(LOOK_EVERY_MS - 1000);
    await settle();
    expect(log).toEqual([]);
    timers.advance(1000);
    await settle();
    expect(log).toEqual(["look"]);
  });

  it("pauses the quick look while the window is in the tray, keeps the rounds, and looks again when it is back", async () => {
    const { backup, log, dirty, timers } = setup(true);
    backup.setOn(true);
    await settle();
    log.length = 0;
    backup.setShown(false);
    for (let i = 0; i < 10; i++) {
      timers.advance(LOOK_EVERY_MS);
      await settle();
    }
    expect(log).toEqual([]);
    // A change still goes out, and the half-hour round still comes.
    dirty.faces = true;
    backup.changed();
    timers.advance(SAVE_AFTER_MS);
    await settle();
    expect(log).toEqual(["read", "save faces"]);
    log.length = 0;
    timers.advance(ROUND_EVERY_MS);
    await settle();
    expect(log).toEqual(["read"]);
    // Back on screen: a look at once, then every couple of minutes again.
    log.length = 0;
    timers.advance(LOOK_GAP_MS);
    backup.setShown(true);
    await settle();
    expect(log).toEqual(["look"]);
    log.length = 0;
    timers.advance(LOOK_EVERY_MS);
    await settle();
    expect(log).toEqual(["look"]);
  });

  it("needs no second round for what its own read took in, so a quit is not kept waiting", async () => {
    const timers = fakeTimers();
    const log: string[] = [];
    let takeIn = false;
    let dirty = false;
    let backup!: SharedBackup;
    backup = new SharedBackup(
      async () => {
        log.push("read");
        // Another device's copy changed something here: taking it in is a change of this computer's.
        if (takeIn) {
          takeIn = false;
          dirty = true;
          backup.changed();
        }
      },
      () => [{ kind: "labels", dirty: () => dirty, save: async () => { log.push("save"); dirty = false; } }],
      timers,
    );
    backup.setOn(true);
    await settle();
    log.length = 0;
    takeIn = true;
    await backup.syncNow();
    await settle();
    expect(log).toEqual(["read", "save"]);
    expect(await backup.flushWithin(1000)).toBe(true);
    timers.advance(SAVE_AFTER_MS);
    await settle();
    expect(log).toEqual(["read", "save"]);
  });
});

