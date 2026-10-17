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

import { describe, it, expect } from "vitest";

import { isStall, StallError, withStallGuard } from "./stallGuard.ts";

/** An async iterable that yields `values`, pausing `gapMs` before each one. */
function paced<T>(values: T[], gapMs: number[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < values.length; i++) {
        await new Promise((r) => setTimeout(r, gapMs[i] ?? 0));
        yield values[i];
      }
    },
  };
}

async function collect<T>(src: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of src) out.push(v);
  return out;
}

describe("withStallGuard", () => {
  it("passes a healthy iterator straight through", async () => {
    const got = await collect(withStallGuard(paced([1, 2, 3], [0, 0, 0]), 1000, "test"));

    expect(got).toEqual([1, 2, 3]);
  });

  it("throws a StallError when one pull exceeds the idle budget", async () => {
    // Second item never arrives inside the budget.
    const src = withStallGuard(paced([1, 2], [0, 500]), 50, "iterateThumbnails");

    await expect(collect(src)).rejects.toThrow(StallError);
  });

  it("names what stalled, so the log says which call it was", async () => {
    const src = withStallGuard(paced([1], [500]), 20, "iterateThumbnails");

    await expect(collect(src)).rejects.toThrow(/iterateThumbnails produced nothing for 20ms/);
  });

  it("budgets the GAP between items, not the total run", async () => {
    // Four slow-but-steady items: 160ms total, no single gap over 40ms. A total-time
    // budget of 100ms would kill this; a whole-library walk is legitimately long and
    // must not be killed for being big.
    const got = await collect(withStallGuard(paced([1, 2, 3, 4], [40, 40, 40, 40]), 100, "test"));

    expect(got).toEqual([1, 2, 3, 4]);
  });

  it("releases the underlying iterator when it stalls", async () => {
    let released = false;
    const src: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<number>>(() => {}), // never settles
          return: async () => {
            released = true;
            return { done: true as const, value: undefined };
          },
        } as any;
      },
    };

    await expect(collect(withStallGuard(src, 20, "test"))).rejects.toThrow(StallError);
    // Without this the SDK is left mid-iteration holding whatever it had open.
    expect(released).toBe(true);
  });

  it("releases the underlying iterator when the caller stops early", async () => {
    let released = false;
    const src: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: async () => ({ done: false as const, value: i++ }),
          return: async () => {
            released = true;
            return { done: true as const, value: undefined };
          },
        } as any;
      },
    };

    for await (const v of withStallGuard(src, 1000, "test")) {
      if (v >= 2) break;
    }

    expect(released).toBe(true);
  });

  it("lets a real error through rather than reporting it as a stall", async () => {
    const boom = new Error("network exploded");
    const src: AsyncIterable<number> = {
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw boom;
      },
    };

    // The caller absorbs stalls and rethrows everything else, so the two must stay
    // distinguishable.
    await expect(collect(withStallGuard(src, 1000, "test"))).rejects.toThrow("network exploded");
  });

  it("identifies stalls without instanceof", () => {
    expect(isStall(new StallError("test", 1))).toBe(true);
    expect(isStall(new Error("ordinary"))).toBe(false);
    expect(isStall(null)).toBe(false);
    expect(isStall("a string")).toBe(false);
  });
});
