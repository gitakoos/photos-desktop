/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect } from "vitest";
import { unwarmedBatches, warmWholeBatch } from "./warmBatches";

describe("the thumbnail warmer's batches", () => {
  it("goes through the library in order, a batch at a time", () => {
    expect([...unwarmedBatches(["a", "b", "c", "d", "e"], new Set(), 2)]).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("carries on past what an earlier pass warmed", () => {
    expect([...unwarmedBatches(["a", "b", "c", "d", "e"], new Set(["a", "b", "d"]), 2)]).toEqual([["c", "e"]]);
  });

  it("leaves out a uid warmed while the pass is under way", () => {
    const warmed = new Set<string>();
    const batches = unwarmedBatches(["a", "b", "c", "d"], warmed, 2);
    expect(batches.next().value).toEqual(["a", "b"]);
    warmed.add("c");
    expect(batches.next().value).toEqual(["d"]);
    expect(batches.next().done).toBe(true);
  });

  it("gives nothing once everything is warm", () => {
    expect([...unwarmedBatches(["a"], new Set(["a"]), 4)]).toEqual([]);
  });
});

describe("warming one batch", () => {
  /** A sidecar that fetches `perCall` more of the batch each time it is asked. */
  function sidecar(perCall: number, ceiling = Infinity) {
    let have = 0;
    let asks = 0;
    const warm = async (uids: readonly string[]) => {
      asks++;
      have = Math.min(uids.length, ceiling, have + perCall);
      return { ready: have };
    };
    return { warm, asks: () => asks };
  }

  it("asks again until the whole batch is ready", async () => {
    const s = sidecar(2);
    expect(await warmWholeBatch(["a", "b", "c", "d"], s.warm)).toBe(true);
    expect(s.asks()).toBe(2);
  });

  it("is not whole when a photo never gets a thumbnail, and stops asking", async () => {
    const s = sidecar(2, 3);
    expect(await warmWholeBatch(["a", "b", "c", "d"], s.warm)).toBe(false);
    expect(s.asks()).toBe(3);
  });

  it("asks at most a few times", async () => {
    const s = sidecar(1);
    expect(await warmWholeBatch(["a", "b", "c", "d", "e", "f"], s.warm, 4)).toBe(false);
    expect(s.asks()).toBe(4);
  });

  it("passes a rejected ask on, so a batch let go of is not counted", async () => {
    await expect(warmWholeBatch(["a"], () => Promise.reject(new Error("abandoned")))).rejects.toThrow("abandoned");
  });
});
