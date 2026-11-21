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
import { coalesced } from "./coalesced";

/** A run that waits until released, so the test decides when each one finishes. */
function gated() {
  const releases: (() => void)[] = [];
  let runs = 0;
  const run = () =>
    new Promise<void>((r) => {
      runs++;
      releases.push(r);
    });
  const release = async () => {
    releases.shift()?.();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { run, release, runs: () => runs };
}

describe("a coalesced run", () => {
  it("runs at once when idle", () => {
    const g = gated();
    coalesced(g.run)();
    expect(g.runs()).toBe(1);
  });

  it("answers any number of triggers during a run with exactly one more run", async () => {
    const g = gated();
    const go = coalesced(g.run);
    go();
    go();
    go();
    go();
    expect(g.runs()).toBe(1);
    await g.release();
    expect(g.runs()).toBe(2);
    await g.release();
    expect(g.runs()).toBe(2);
    go();
    expect(g.runs()).toBe(3);
  });

  it("goes on after a failed run", async () => {
    let n = 0;
    const go = coalesced(async () => {
      n++;
      if (n === 1) throw new Error("offline");
    });
    go();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    go();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(n).toBe(2);
  });
});
