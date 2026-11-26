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

import { NameReader } from "./nameReader";

/** A fetch that answers when told to, recording what it was asked. */
function gated() {
  const asked: string[][] = [];
  const pending: (() => void)[] = [];
  const fetch = (uids: string[]) => {
    asked.push(uids);
    return new Promise<{ uid: string; name: string }[] | null>((resolve) => {
      pending.push(() => resolve(uids.map((uid) => ({ uid, name: `${uid}.jpg` }))));
    });
  };
  const answer = async () => {
    pending.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { asked, fetch, answer };
}

describe("reading the names of the Fix dates page", () => {
  it("reads in batches, in the order given", async () => {
    const names = new Map<string, string>();
    const { asked, fetch, answer } = gated();
    const reader = new NameReader(names, fetch, () => {}, 2);

    reader.add(["a", "b", "c"]);
    await answer();
    await answer();

    expect(asked).toEqual([["a", "b"], ["c"]]);
    expect(names.get("c")).toBe("c.jpg");
  });

  it("takes photos added while it reads into the same reading, asking for none twice", async () => {
    const names = new Map<string, string>();
    const { asked, fetch, answer } = gated();
    const reader = new NameReader(names, fetch, () => {}, 2);

    reader.add(["a", "b"]);
    reader.add(["a", "b", "c", "d"]);
    await answer();
    await answer();

    expect(asked).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("asks for nothing whose name is already known", () => {
    const names = new Map([["a", "a.jpg"]]);
    const { asked, fetch } = gated();
    const reader = new NameReader(names, fetch, () => {}, 2);

    reader.add(["a"]);

    expect(asked).toEqual([]);
    expect(reader.isRead("a")).toBe(true);
  });

  it("counts a photo asked for and not answered as read, so the page does not wait on it", async () => {
    const reader = new NameReader(new Map(), async () => null, () => {}, 2);

    reader.add(["a"]);
    await new Promise((r) => setTimeout(r, 0));

    expect(reader.isRead("a")).toBe(true);
  });

  it("says when each batch is in", async () => {
    let batches = 0;
    const { fetch, answer } = gated();
    const reader = new NameReader(new Map(), fetch, () => batches++, 1);

    reader.add(["a", "b"]);
    await answer();
    await answer();

    expect(batches).toBe(2);
  });

  it("reads no further batch once stopped", async () => {
    const { asked, fetch, answer } = gated();
    const reader = new NameReader(new Map(), fetch, () => {}, 1);

    reader.add(["a", "b"]);
    reader.stop();
    await answer();

    expect(asked).toEqual([["a"]]);
  });
});
