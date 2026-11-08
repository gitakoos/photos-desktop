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

import { RETRY_AFTER_MS, ROUND_EVERY_MS, SAVE_AFTER_MS, SavedCopies, SharedBackup, type BackupPart } from "./sharedBackup.ts";

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

function setup() {
  const log: string[] = [];
  const dirty = { faces: false, labels: true, search: false };
  const parts = (): BackupPart[] =>
    (["faces", "labels", "search"] as const).map((kind) => ({
      kind,
      dirty: (all) => all || dirty[kind],
      save: async (all) => {
        log.push(`save ${kind}${all ? " (all)" : ""}`);
        dirty[kind] = false;
      },
    }));
  const timers = fakeTimers();
  let readFails = false;
  const backup = new SharedBackup(
    async () => {
      log.push("read");
      if (readFails) throw new Error("offline");
    },
    parts,
    timers,
  );
  return { backup, log, dirty, timers, failRead: (v: boolean) => (readFails = v) };
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
    expect(log).toEqual(["read", "save faces (all)", "save labels (all)", "save search (all)"]);
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

  it("runs another round after the one running when something changed during it", async () => {
    const { backup, log } = setup();
    backup.setOn(true);
    const first = backup.syncNow();
    expect(backup.syncNow()).toBe(first);
    backup.changed();
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
