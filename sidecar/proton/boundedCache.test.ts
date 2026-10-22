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
import { MemoryCache } from "@protontech/drive-sdk";
import { BoundedCache } from "./boundedCache.ts";

async function collect<T>(it: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** A small deterministic generator, so a failure replays the same way. */
function random(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

describe("the SDK cache", () => {
  it("answers exactly as the SDK's own cache does", async () => {
    const theirs = new MemoryCache<string>();
    const ours = new BoundedCache<string>(1_000_000);
    const next = random(42);
    const keys = Array.from({ length: 40 }, (_, i) => `node-${i}`);
    const tags = ["volume:v", "parentUid:root", "parentUid:album", "trashed", "roots:v"];
    const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)];

    for (let step = 0; step < 3000; step++) {
      const op = next();
      if (op < 0.5) {
        const chosen = tags.filter(() => next() < 0.4);
        const key = pick(keys);
        const value = `v${step}`;
        await theirs.setEntity(key, value, chosen.length ? chosen : undefined);
        await ours.setEntity(key, value, chosen.length ? chosen : undefined);
      } else if (op < 0.65) {
        const gone = keys.filter(() => next() < 0.1);
        await theirs.removeEntities(gone);
        await ours.removeEntities(gone);
      } else if (op < 0.85) {
        const tag = pick(tags);
        expect(await collect(ours.iterateEntitiesByTag(tag))).toEqual(
          await collect(theirs.iterateEntitiesByTag(tag)),
        );
      } else {
        const asked = keys.filter(() => next() < 0.3);
        expect(await collect(ours.iterateEntities(asked))).toEqual(await collect(theirs.iterateEntities(asked)));
      }
    }
  });

  it("stays fast with a whole large library under the same two tags", async () => {
    const cache = new BoundedCache<string>(1_000_000);
    const started = performance.now();
    for (let i = 0; i < 200_000; i++) {
      await cache.setEntity(`node-${i}`, "x", ["volume:v", "parentUid:root"]);
    }
    expect(performance.now() - started).toBeLessThan(3000);
    expect((await collect(cache.iterateEntitiesByTag("parentUid:root"))).length).toBe(200_000);
  });

  it("starts over when full, so nothing is left half there", async () => {
    const cache = new BoundedCache<string>(3);
    for (const key of ["a", "b", "c"]) await cache.setEntity(key, key, ["parentUid:root"]);
    await cache.setEntity("a", "again", ["parentUid:root"]);
    expect(cache.size).toBe(3);

    await cache.setEntity("d", "d", ["parentUid:root"]);

    expect(cache.size).toBe(1);
    await expect(cache.getEntity("a")).rejects.toThrow();
    const listed = await collect(cache.iterateEntitiesByTag("parentUid:root"));
    expect(listed).toEqual([{ key: "d", ok: true, value: "d" }]);
  });

  it("forgets the tags along with the entries when cleared", async () => {
    const cache = new BoundedCache<string>(10);
    await cache.setEntity("a", "a", ["parentUid:root"]);
    await cache.clear();
    expect(await collect(cache.iterateEntitiesByTag("parentUid:root"))).toEqual([]);
  });
});
