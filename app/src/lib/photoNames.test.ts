/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const asked: string[][] = [];
vi.mock("./rpc", () => ({
  rpc: vi.fn(async (_m: string, p: { uids: string[] }) => {
    asked.push(p.uids);
    return Object.fromEntries(p.uids.filter((u) => u !== "nameless").map((u) => [u, `${u}.jpg`]));
  }),
}));

import { forgetNames, knownName, learnNames, rememberName } from "./photoNames";

describe("the viewer's photo names", () => {
  beforeEach(() => {
    asked.length = 0;
    forgetNames();
  });

  it("learns the names it does not know, once", async () => {
    let told = 0;
    await learnNames(["a", "b", "nameless"], undefined, () => told++);
    expect(knownName("a")).toBe("a.jpg");
    expect(knownName("nameless")).toBeUndefined();
    await learnNames(["a", "b", "c"]);
    expect(asked).toEqual([["a", "b", "nameless"], ["c"]]);
    expect(told).toBe(1);
  });

  it("keeps a name learned elsewhere, and asks nothing for it", async () => {
    rememberName("d", "renamed.jpg");
    await learnNames(["d"]);
    expect(knownName("d")).toBe("renamed.jpg");
    expect(asked).toEqual([]);
  });

  it("forgets everything", async () => {
    await learnNames(["a"]);
    forgetNames();
    expect(knownName("a")).toBeUndefined();
  });
});
