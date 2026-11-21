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


import { afterEach, describe, expect, it } from "vitest";

import { setSliceMs, SLICE_MS } from "./faceCluster.ts";
import {
  dismissSuggestion,
  hidePerson,
  listPeople,
  mergePeople,
  nameFaces,
  notThisPerson,
  placeNew,
  rejectFaces,
  rejectPerson,
  removePhotosFromPerson,
  renamePerson,
  setPersonCover,
  showPerson,
} from "./facePeople.ts";
import type { FaceStore } from "./faceStore.ts";
import { PeopleIndex } from "./peopleIndex.ts";
import { direction, seeded } from "./testFaces.ts";
import { library, storeBefore, takeInAndGroup } from "./testLibrary.ts";

afterEach(() => setSliceMs(SLICE_MS));

const same = (index: PeopleIndex, store: FaceStore) =>
  expect(JSON.stringify(index.list(store))).toBe(JSON.stringify(listPeople(store)));

describe("the people list kept between reads", () => {
  it("equals one worked out from nothing after every step of a random run on a library with many people", async () => {
    const lib = library(11, 3_000);
    const store = await storeBefore(lib);
    await takeInAndGroup(store, lib);
    const rand = seeded(17);
    const pick = <T,>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(rand() * xs.length)] : undefined);
    const people = () => listPeople(store);
    let photo = 0;
    const ops: (() => Promise<void> | void)[] = [
      async () => {
        // New photos, mostly of people already here, some of strangers.
        for (let i = 0; i < 1 + Math.floor(rand() * 6); i++) {
          const like = pick(store.allFaces());
          if (!like) return;
          const uid = `vol~new${photo++}`;
          // Scores in quarters, so the loose faces have equals to keep in order.
          const score = Math.round(rand() * 4) / 4;
          const embedding = rand() < 0.4 ? direction(rand) : like.embedding;
          store.put(uid, [{ ...like, id: `${uid}#0`, uid, score, embedding }]);
        }
        await placeNew(store);
      },
      () => {
        const x = pick([...people().named, ...people().unnamed]);
        if (x) renamePerson(store, x.id, rand() < 0.2 ? "" : `Name ${Math.floor(rand() * 40)}`);
      },
      () => {
        const l = people();
        const a = pick(l.unnamed);
        const b = pick(rand() < 0.5 ? l.named : l.unnamed);
        if (a && b && a.id !== b.id) mergePeople(store, a.id, b.id);
      },
      () => {
        const x = pick(people().unnamed);
        if (x) rejectPerson(store, x.id);
      },
      () => {
        const x = pick(people().named);
        if (x) hidePerson(store, x.id);
      },
      () => {
        const x = pick(people().hidden);
        if (x) showPerson(store, x.id);
      },
      () => {
        const x = pick([...people().named, ...people().unnamed]);
        const uid = x && pick(x.uids);
        if (x && uid) removePhotosFromPerson(store, x.id, [uid]);
      },
      () => {
        const x = pick(people().named);
        const uid = x && pick(x.uids);
        if (x && uid) setPersonCover(store, x.id, uid);
      },
      () => {
        const f = pick(store.allFaces());
        if (f) nameFaces(store, [f.id], `Name ${Math.floor(rand() * 40)}`);
      },
      () => {
        const f = pick(store.allFaces());
        if (f && store.people.assign[f.id]) notThisPerson(store, f.id);
      },
      () => {
        const f = pick(store.allFaces());
        if (f) rejectFaces(store, [f.id]);
      },
      () => {
        const s = pick(people().suggestions);
        if (s) dismissSuggestion(store, s.unnamed, s.named);
      },
      () => {
        const keep = new Set(store.scanned().filter(() => rand() > 0.01));
        store.keepOnly(keep);
      },
    ];
    const index = new PeopleIndex();
    same(index, store);
    let suggested = 0;
    for (let step = 0; step < 200; step++) {
      try {
        await pick(ops)!();
      } catch {
        // A person gone meanwhile, or a name not allowed: the run goes on.
      }
      same(index, store);
      if (people().suggestions.length > 0) suggested++;
    }
    expect(suggested).toBeGreaterThan(20);
    expect(people().named.length).toBeGreaterThan(20);
  }, 300_000);

  it("reads one moment's list while the people change between its turns", async () => {
    const lib = library(5, 2_000);
    const store = await storeBefore(lib);
    await takeInAndGroup(store, lib);
    const index = new PeopleIndex();
    index.list(store);
    setSliceMs(0);
    const target = listPeople(store).unnamed[0];
    // The first turn the read gives goes to a rename.
    let renamed = false;
    setImmediate(() => {
      renamePerson(store, target.id, "Zed");
      renamed = true;
    });
    const reading = index.listAsync(store);
    expect(renamed).toBe(false);
    const read = await reading;
    expect(renamed).toBe(true);
    expect(JSON.stringify(read)).toBe(JSON.stringify(listPeople(store)));
    expect(read.named.some((x) => x.name === "Zed")).toBe(true);
  }, 300_000);
});
