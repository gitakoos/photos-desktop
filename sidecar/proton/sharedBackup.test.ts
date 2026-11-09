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

import { failReason, RETRY_AFTER_MS, ROUND_EVERY_MS, SAVE_AFTER_MS, SavedCopies, SharedBackup, type BackupPart, type SaveResult } from "./sharedBackup.ts";

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

  it("know which parts were ever written", () => {
    let kept: Record<string, string> = {};
    const saved = new SavedCopies(() => kept, (v) => (kept = v));
    expect(saved.has("labels")).toBe(false);
    saved.record("labels", Buffer.from("labels v1"));
    expect(saved.has("labels")).toBe(true);
    expect(saved.has("faces")).toBe(false);
  });
});

/** A backup of the faces alone, with `part` in place of what that part does by default. */
function facesBackup(part: Partial<BackupPart>) {
  return new SharedBackup(async () => {}, () => [{ kind: "faces", dirty: () => true, save: async () => {}, ...part }], fakeTimers());
}

/** How the backup stands after one round of `part`. */
async function afterRound(part: Partial<BackupPart>) {
  const backup = facesBackup(part);
  backup.setOn(true);
  await backup.syncNow();
  return backup.getStatus();
}

describe("what a round says about each part", () => {
  it("does not call a round that wrote nothing synced", async () => {
    const status = await afterRound({ dirty: () => false, skipReason: () => "recognition-off" });
    expect(status.parts.faces).toEqual({ result: "skipped", reason: "recognition-off", at: 0 });
    expect(status.saved.faces).toBeUndefined();
  });

  it("counts a part with nothing new as unchanged", async () => {
    const status = await afterRound({ dirty: () => false });
    expect(status.parts.faces?.result).toBe("unchanged");
    expect(status.saved.faces).toBeUndefined();
  });

  it("counts a save that found the copy already there as unchanged", async () => {
    for (const result of [false, { wrote: false, counts: { faces: 3 } }]) {
      const status = await afterRound({ save: async () => result });
      expect(status.parts.faces?.result).toBe("unchanged");
      expect(status.saved.faces).toBeUndefined();
    }
  });

  it("says how much a saved part holds", async () => {
    const counts = { faces: 3, photos: 2 };
    const status = await afterRound({ save: async () => ({ wrote: true, counts }) });
    expect(status.parts.faces).toEqual({ result: "saved", at: 0, counts });
    expect(status.saved.faces).toBe(0);
  });

  it("keeps what the copy holds through quiet rounds", async () => {
    const counts = { faces: 3, photos: 2 };
    let dirty = true;
    const backup = facesBackup({ dirty: () => dirty, save: async () => ({ wrote: true, counts }) });
    backup.setOn(true);
    await backup.syncNow();
    dirty = false;
    await backup.syncNow();
    expect(backup.getStatus().parts.faces).toEqual({ result: "unchanged", at: 0, counts });
    await backup.syncNow();
    expect(backup.getStatus().parts.faces).toEqual({ result: "unchanged", at: 0, counts });
  });

  it("keeps what the copy holds when a save finds it already there", async () => {
    const counts = { faces: 3, photos: 2 };
    let answer: SaveResult = { wrote: true, counts };
    const backup = facesBackup({ save: async () => answer });
    backup.setOn(true);
    await backup.syncNow();
    answer = false;
    await backup.syncNow();
    expect(backup.getStatus().parts.faces).toEqual({ result: "unchanged", at: 0, counts });
  });

  it("does not carry counts across a round that did not save the part", async () => {
    const counts = { faces: 3, photos: 2 };
    let answer: SaveResult = { wrote: true, counts };
    let dirty = true;
    const backup = facesBackup({ dirty: () => dirty, save: async () => answer });
    backup.setOn(true);
    await backup.syncNow();
    answer = { skipped: "names-held" };
    await backup.syncNow();
    dirty = false;
    await backup.syncNow();
    expect(backup.getStatus().parts.faces).toEqual({ result: "unchanged", at: 0 });
  });

  it("sends a part again when its copy is gone", async () => {
    const calls: unknown[][] = [];
    const status = await afterRound({
      dirty: () => false,
      gone: async () => true,
      save: async (...args) => {
        calls.push(args);
        return { wrote: true };
      },
    });
    expect(calls).toEqual([[true, false]]);
    expect(status.parts.faces?.result).toBe("saved");
    expect(status.saved.faces).toBe(0);
  });

  it("leaves a part alone when its copy is there", async () => {
    let saves = 0;
    const status = await afterRound({ dirty: () => false, gone: async () => false, save: async () => void saves++ });
    expect(saves).toBe(0);
    expect(status.parts.faces?.result).toBe("unchanged");
  });

  it("does not save when the check fails", async () => {
    let saves = 0;
    const status = await afterRound({
      dirty: () => false,
      gone: async () => {
        throw new Error("offline");
      },
      save: async () => void saves++,
    });
    expect(saves).toBe(0);
    expect(status.parts.faces?.result).toBe("unchanged");
    expect(status.failed).toBe(false);
  });

  it("does not check a part that has something to save", async () => {
    let checks = 0;
    await afterRound({
      gone: async () => {
        checks++;
        return true;
      },
    });
    expect(checks).toBe(0);
  });

  it("does not check a part skipped for a reason", async () => {
    let checks = 0;
    const status = await afterRound({
      dirty: () => false,
      skipReason: () => "recognition-off",
      gone: async () => {
        checks++;
        return true;
      },
    });
    expect(checks).toBe(0);
    expect(status.parts.faces?.result).toBe("skipped");
  });

  it("does not send a copy that is gone once the backup was turned off during the check", async () => {
    let saves = 0;
    const backup = facesBackup({
      dirty: () => false,
      gone: async () => {
        backup.setOn(false);
        return true;
      },
      save: async () => void saves++,
    });
    backup.setOn(true);
    await backup.syncNow();
    expect(saves).toBe(0);
  });

  it("reports a blocked part without calling the round failed", async () => {
    const report = { photosBefore: 100, photosAfter: 50, itemsBefore: 300, itemsAfter: 120 };
    const status = await afterRound({ save: async () => ({ blocked: report }) });
    expect(status.parts.faces).toEqual({ result: "blocked", report, at: 0 });
    expect(status.failed).toBe(false);
    expect(status.saved.faces).toBeUndefined();
  });

  it("reports a part skipped while saving", async () => {
    const status = await afterRound({ save: async () => ({ skipped: "library-unlisted" }) });
    expect(status.parts.faces).toEqual({ result: "skipped", reason: "library-unlisted", at: 0 });
    expect(status.failed).toBe(false);
    expect(status.saved.faces).toBeUndefined();
  });

  it("names why a part failed", async () => {
    const full = Object.assign(new Error("x"), { name: "ServerError", code: 200002 });
    const status = await afterRound({
      save: async () => {
        throw full;
      },
    });
    expect(status.parts.faces).toEqual({ result: "failed", reason: "drive-full", at: 0 });
    expect(status.failed).toBe(true);
  });

  it("passes force only on a forced backup", async () => {
    const calls: boolean[][] = [];
    const backup = facesBackup({
      save: async (all, force) => {
        calls.push([all, force]);
      },
    });
    await backup.backUpNow(true);
    await backup.backUpNow();
    backup.setOn(true);
    await backup.syncNow();
    expect(calls).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
  });

  it("leaves nothing running after a failed upload", async () => {
    let during: unknown;
    const backup = facesBackup({
      save: async () => {
        backup.reportProgress("faces", 5, 10);
        during = backup.getStatus().progress;
        throw new Error("x");
      },
    });
    backup.setOn(true);
    await backup.syncNow();
    expect(during).toEqual({ kind: "faces", sent: 5, total: 10 });
    expect(backup.getStatus().progress).toBeNull();
    expect(backup.getStatus().running).toBe(false);
    // An upload's last word, landing after the round is over, starts nothing up again.
    backup.reportProgress("faces", 6, 10);
    expect(backup.getStatus().progress).toBeNull();
  });

  it("clears a failed part's progress before the next part runs", async () => {
    let during: unknown;
    const backup = new SharedBackup(
      async () => {},
      () => [
        {
          kind: "faces",
          dirty: () => true,
          save: async () => {
            backup.reportProgress("faces", 5, 10);
            throw new Error("x");
          },
        },
        {
          kind: "labels",
          dirty: () => true,
          save: async () => {
            during = backup.getStatus().progress;
          },
        },
      ],
      fakeTimers(),
    );
    backup.setOn(true);
    await backup.syncNow();
    expect(during).toBeNull();
  });

  it("names why every part failed when the round could not read", async () => {
    const offline = Object.assign(new Error("x"), { name: "ConnectionError" });
    const parts = (["faces", "labels"] as const).map((kind): BackupPart => ({ kind, dirty: () => true, save: async () => {} }));
    const backup = new SharedBackup(
      async () => {
        throw offline;
      },
      () => parts,
      fakeTimers(),
    );
    backup.setOn(true);
    await backup.syncNow();
    const status = backup.getStatus();
    expect(status.parts.faces).toEqual({ result: "failed", reason: "network", at: 0 });
    expect(status.parts.labels).toEqual({ result: "failed", reason: "network", at: 0 });
    expect(status.failed).toBe(true);
  });
});

describe("failReason", () => {
  const named = (name: string) => Object.assign(new Error("x"), { name });

  it("tells a dropped connection", () => {
    expect(failReason(named("ConnectionError"))).toBe("network");
  });

  it.each([200001, 200002, 200100, 200101])("tells a full Drive by its code %i", (code) => {
    expect(failReason(Object.assign(named("ServerError"), { code }))).toBe("drive-full");
  });

  it("tells a session that is over", () => {
    expect(failReason(new Error("Not signed in"))).toBe("signed-out");
  });

  it.each(["status", "statusCode"])("tells a session the server turned away by its %s", (field) => {
    expect(failReason(Object.assign(new Error("x"), { [field]: 401 }))).toBe("signed-out");
  });

  it("tells a session the server turned away in the shape the SDK throws it", () => {
    expect(failReason(Object.assign(named("APICodeError"), { code: 401 }))).toBe("signed-out");
  });

  it("tells a copy that did not check out", () => {
    expect(failReason(named("CopyInvalid"))).toBe("copy-invalid");
  });

  it("takes anything else for Drive's own error", () => {
    expect(failReason(new Error("x"))).toBe("drive-error");
    expect(failReason(undefined)).toBe("drive-error");
  });
});
