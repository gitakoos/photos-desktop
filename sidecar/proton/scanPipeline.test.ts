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
  PowerWatch,
  SPEED_LEVELS,
  batchStream,
  defaultSpeed,
  effectiveSpeed,
  isScanSpeed,
  newStageTimes,
  runInOrder,
  stageFields,
  timed,
} from "./scanPipeline.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function* listOf<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

class Halt extends Error {}

describe("photos worked on side by side", () => {
  it("one at a time, each is committed before the next is started", async () => {
    const events: string[] = [];
    await runInOrder(
      listOf([1, 2, 3]),
      () => 1,
      async (n) => {
        events.push(`work ${n}`);
        await sleep(1);
        return n;
      },
      (n) => {
        events.push(`commit ${n}`);
      },
      () => true,
      () => new Halt(),
    );
    expect(events).toEqual(["work 1", "commit 1", "work 2", "commit 2", "work 3", "commit 3"]);
  });

  it("several at once, are committed in the order they came, whatever order they finish in", async () => {
    let running = 0;
    let most = 0;
    const committed: number[] = [];
    const delays = [30, 5, 20, 1, 12, 3, 25, 2];
    await runInOrder(
      listOf(delays.map((_, i) => i)),
      () => 3,
      async (n) => {
        running++;
        most = Math.max(most, running);
        await sleep(delays[n]);
        running--;
        return n * 10;
      },
      (n, out) => {
        expect(out).toBe(n * 10);
        committed.push(n);
      },
      () => true,
      () => new Halt(),
    );
    expect(committed).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(most).toBe(3);
  });

  it("follow a width that changes while they run", async () => {
    let width = 1;
    let running = 0;
    const seen: number[] = [];
    await runInOrder(
      listOf([0, 1, 2, 3, 4, 5, 6, 7]),
      () => width,
      async (n) => {
        running++;
        seen.push(running);
        if (n === 2) width = 4;
        await sleep(2);
        running--;
        return n;
      },
      () => {},
      () => true,
      () => new Halt(),
    );
    expect(seen.slice(0, 2)).toEqual([1, 1]);
    expect(Math.max(...seen)).toBeGreaterThan(1);
  });

  it("stop taking new ones once told to, let the ones under way finish, and commit no more", async () => {
    let live = true;
    const started: number[] = [];
    const finished: number[] = [];
    const committed: number[] = [];
    const run = runInOrder(
      listOf([0, 1, 2, 3, 4, 5]),
      () => 2,
      async (n) => {
        started.push(n);
        await sleep(n === 1 ? 20 : 2);
        finished.push(n);
        return n;
      },
      (n) => {
        committed.push(n);
        if (n === 0) live = false;
      },
      () => live,
      () => new Halt(),
    );
    await expect(run).rejects.toBeInstanceOf(Halt);
    expect(committed).toEqual([0]);
    expect(started).toEqual([0, 1]);
    // The photo under way when the stop came had finished before the stop was thrown.
    expect(finished.sort()).toEqual([0, 1]);
  });

  it("throw a photo's error in turn, after the work under way has finished", async () => {
    const committed: number[] = [];
    const finished: number[] = [];
    const run = runInOrder(
      listOf([0, 1, 2, 3]),
      () => 3,
      async (n) => {
        await sleep(n === 2 ? 15 : 1);
        finished.push(n);
        if (n === 1) throw new Error("bad picture");
        return n;
      },
      (n) => {
        committed.push(n);
      },
      () => true,
      () => new Halt(),
    );
    await expect(run).rejects.toThrow("bad picture");
    expect(committed).toEqual([0]);
    expect(finished).toContain(2);
  });

  it("let markers pass in order without taking up the width", async () => {
    const events: string[] = [];
    await runInOrder(
      listOf(["a", "b", "|", "c", "|"]),
      () => 2,
      async (x) => {
        await sleep(x === "a" ? 10 : 1);
        return x;
      },
      (x) => {
        events.push(x);
      },
      () => true,
      () => new Halt(),
      (x) => x !== "|",
    );
    expect(events).toEqual(["a", "b", "|", "c", "|"]);
  });
});

describe("the batches as one stream", () => {
  const source = (opened: number[]) => (uids: string[]) => {
    opened.push(Number(uids[0].slice(1)));
    return listOf(uids.map((uid) => ({ uid })));
  };

  it("keep each batch's order, with a marker after each", async () => {
    const opened: number[] = [];
    const out: string[] = [];
    for await (const x of batchStream([["u0", "u1"], ["u2"], ["u3", "u4"]], source(opened), () => false)) {
      out.push(x.kind === "end" ? `end${x.batch}` : x.picture.uid);
    }
    expect(out).toEqual(["u0", "u1", "end0", "u2", "end1", "u3", "u4", "end2"]);
  });

  it("ask for the next batch as the current one starts, only when prefetching", async () => {
    for (const prefetch of [true, false]) {
      const opened: number[] = [];
      const it = batchStream([["u0", "u1"], ["u2"]], source(opened), () => prefetch)[Symbol.asyncIterator]();
      await it.next();
      expect(opened).toEqual(prefetch ? [0, 2] : [0]);
      await it.return?.(undefined);
    }
  });

  it("let a prefetched batch go when the stream ends early", async () => {
    let closed = false;
    const open = (uids: string[]) =>
      (async function* () {
        try {
          for (const uid of uids) yield { uid };
        } finally {
          if (uids[0] === "u2") closed = true;
        }
      })();
    for await (const x of batchStream([["u0", "u1"], ["u2"]], open, () => true)) {
      if (x.kind === "picture") break;
    }
    await sleep(5);
    expect(closed).toBe(true);
  });
});

describe("the scan's speed", () => {
  it("starts from what the machine has, Balanced when the card is not known", () => {
    expect(defaultSpeed({ cores: 20, memoryGiB: 32, gpu: true })).toBe("fast");
    expect(defaultSpeed({ cores: 20, memoryGiB: 32, gpu: null })).toBe("balanced");
    expect(defaultSpeed({ cores: 20, memoryGiB: 32, gpu: false })).toBe("balanced");
    expect(defaultSpeed({ cores: 4, memoryGiB: 8, gpu: true })).toBe("balanced");
    expect(defaultSpeed({ cores: 2, memoryGiB: 16, gpu: true })).toBe("gentle");
    expect(defaultSpeed({ cores: 8, memoryGiB: 4, gpu: true })).toBe("gentle");
  });

  it("is Gentle on the battery, with Battery Saver or on a metered connection", () => {
    expect(effectiveSpeed("fast", { saving: false, metered: false })).toBe("fast");
    expect(effectiveSpeed("fast", { saving: true, metered: false })).toBe("gentle");
    expect(effectiveSpeed("balanced", { saving: false, metered: true })).toBe("gentle");
  });

  it("reads one photo at a time when Gentle, more when faster", () => {
    expect(SPEED_LEVELS.gentle).toMatchObject({ photos: 1, downloads: 2 });
    expect(SPEED_LEVELS.gentle.pauseMs).toBeGreaterThan(0);
    expect(SPEED_LEVELS.balanced).toMatchObject({ photos: 2, downloads: 4, pauseMs: 0 });
    expect(SPEED_LEVELS.fast.photos).toBeGreaterThanOrEqual(3);
    expect(SPEED_LEVELS.fast.downloads).toBe(8);
  });

  it("takes only the three names", () => {
    expect(isScanSpeed("fast")).toBe(true);
    expect(isScanSpeed("auto")).toBe(false);
    expect(isScanSpeed(null)).toBe(false);
  });
});

describe("the power state the scan follows", () => {
  it("is asked again once stale, and an answer that does not come counts as mains", async () => {
    let now = 0;
    const answers: (() => unknown)[] = [
      () => ({ saving: true, metered: false }),
      () => {
        throw new Error("gone");
      },
      () => ({ saving: false, metered: true }),
    ];
    let asked = 0;
    const watch = new PowerWatch(
      async () => {
        asked++;
        return answers.shift()?.();
      },
      () => now,
    );
    expect(watch.current()).toEqual({ saving: false, metered: false });
    await watch.refresh();
    expect(watch.current()).toEqual({ saving: true, metered: false });
    expect(asked).toBe(1);
    now += 31_000;
    await watch.refresh();
    // The failed answer keeps the last good one.
    expect(watch.current()).toEqual({ saving: true, metered: false });
    now += 31_000;
    await watch.refresh();
    expect(watch.current()).toEqual({ saving: false, metered: true });
    expect(asked).toBe(3);
  });
});

describe("the stage times", () => {
  it("add up what each step took, and come out as whole milliseconds", async () => {
    const t = newStageTimes();
    await timed(t, "decode", () => sleep(5));
    await timed(t, "decode", () => sleep(5));
    t.photos = 2;
    const fields = stageFields(t);
    expect(fields.decode).toBeGreaterThanOrEqual(8);
    expect(Number.isInteger(fields.decode)).toBe(true);
    expect(fields.photos).toBe(2);
  });
});
