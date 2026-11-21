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

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  dismissSuggestion,
  hidePerson,
  listPeople,
  mergePeople,
  nameFaces,
  notThisPerson,
  placeNew,
  regroupAll,
  rejectFaces,
  rejectPerson,
  removePhotosFromPerson,
  renamePerson,
  setPersonCover,
  showPerson,
} from "./facePeople.ts";
import { FaceStore, type FaceRecord } from "./faceStore.ts";
import {
  PeopleFeed,
  applyPeopleAnswer,
  tokenOf,
  type HeldPeople,
  type PeopleAnswer,
  type PeopleList,
} from "./peopleFeed.ts";
import { PeopleIndex } from "./peopleIndex.ts";
import { initStore, setDataKey } from "./store.ts";
import { direction, faceOf, seeded } from "./testFaces.ts";

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-feed-")));
  setDataKey(randomBytes(32));
});

/** The answer as it reaches the window: through JSON. */
const sent = (answer: PeopleAnswer): PeopleAnswer => JSON.parse(JSON.stringify(answer));

/** The list as a full read sees it, through JSON too. */
const full = (store: FaceStore): PeopleList => JSON.parse(JSON.stringify(listPeople(store)));

/** The window reading the people: what it holds is replaced by the answer, read in full again when it does not follow on. */
function read(feed: PeopleFeed, index: PeopleIndex, store: FaceStore, held: HeldPeople | null): HeldPeople {
  feed.update(index.list(store));
  const next = applyPeopleAnswer(held, sent(feed.answer(tokenOf(held))));
  return next ?? applyPeopleAnswer(null, sent(feed.answer(null)))!;
}

const list = (people: PeopleList) => ({ ...people });

describe("the people read as changes", () => {
  it("come out as a full read over a long random run of scans, names, merges, regroups and drops, the kept list too", async () => {
    const rand = seeded(91);
    const pick = <T,>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(rand() * xs.length)] : undefined);
    const store = new FaceStore();
    store.load();
    const identities = Array.from({ length: 14 }, () => direction(rand));
    let photo = 0;
    const scan = (count: number) => {
      for (let i = 0; i < count; i++) {
        const uid = `vol~q${photo++}`;
        const faces: FaceRecord[] = [];
        const n = 1 + Math.floor(rand() * 2);
        for (let k = 0; k < n; k++) {
          const base = rand() < 0.15 ? direction(rand) : identities[Math.floor(rand() * identities.length)];
          faces.push({
            id: `${uid}#${k}`,
            uid,
            box: [0.1 + 0.4 * k, 0.1, 0.4 + 0.4 * k, 0.5],
            points: [],
            score: 0.7 + rand() * 0.3,
            blur: 100,
            sideways: 0,
            embedding: faceOf(base, rand, 0.5),
          });
        }
        store.put(uid, faces);
      }
    };
    let feed = new PeopleFeed("run-1");
    let index = new PeopleIndex();
    let held: HeldPeople | null = null;
    const seen = { suggestions: 0, loose: 0, hidden: 0, leftover: 0 };
    let reads = 0;
    let fullAnswers = 0;
    let deltas = 0;
    const people = () => listPeople(store);
    const somePerson = () => pick([...people().named, ...people().unnamed, ...people().hidden]);
    const ops: (() => Promise<void> | void)[] = [
      async () => {
        scan(1 + Math.floor(rand() * 12));
        await placeNew(store);
      },
      () => {
        const x = somePerson();
        if (x) renamePerson(store, x.id, rand() < 0.2 ? "" : `Name ${Math.floor(rand() * 8)}`);
      },
      () => {
        const a = somePerson();
        const b = somePerson();
        if (a && b && a.id !== b.id && !(a.name && b.name && a.name !== b.name)) mergePeople(store, a.id, b.id);
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
        const x = somePerson();
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
        if (f) nameFaces(store, [f.id], `Name ${Math.floor(rand() * 8)}`);
      },
      () => {
        const f = pick(store.allFaces());
        if (f && store.people.assign[f.id]) notThisPerson(store, f.id);
      },
      () => {
        const f = pick(store.allFaces());
        if (f) rejectFaces(store, [f.id]);
      },
      async () => {
        store.people.grouped = false;
        await regroupAll(store);
      },
      () => {
        const s = pick(listPeople(store).suggestions);
        if (s) dismissSuggestion(store, s.unnamed, s.named);
      },
      () => {
        // Photos gone from the library, a few at a time.
        const keep = new Set(store.scanned().filter(() => rand() > 0.05));
        store.keepOnly(keep);
      },
    ];
    scan(30);
    await placeNew(store);
    for (let step = 0; step < 600; step++) {
      try {
        await pick(ops)!();
      } catch {
        // A person gone meanwhile, or a name not allowed: the run goes on.
      }
      // The kept list against one worked out from nothing, after every step.
      const whole = listPeople(store);
      expect(JSON.stringify(index.list(store))).toBe(JSON.stringify(whole));
      if (whole.suggestions.length) seen.suggestions++;
      if (whole.loose.total) seen.loose++;
      if (whole.hidden.length) seen.hidden++;
      if (whole.leftover) seen.leftover++;
      const roll = rand();
      if (roll < 0.05) {
        // The sidecar started over.
        feed = new PeopleFeed(`run-${step}`);
        index = new PeopleIndex();
      } else if (roll < 0.1) {
        // An answer lost on the way: the window stays where it was.
        feed.update(index.list(store));
        feed.answer(tokenOf(held));
        continue;
      } else if (roll < 0.35) {
        // Several changes before the next read.
        continue;
      }
      const before = held;
      held = read(feed, index, store, held);
      reads++;
      if (before && held.epoch === before.epoch) deltas++;
      else fullAnswers++;
      expect(list(held.list)).toEqual(full(store));
    }
    expect(reads).toBeGreaterThan(300);
    expect(deltas).toBeGreaterThan(200);
    expect(fullAnswers).toBeGreaterThan(5);
    expect(seen.suggestions).toBeGreaterThan(15);
    expect(seen.loose).toBeGreaterThan(50);
    expect(seen.hidden).toBeGreaterThan(50);
    expect(seen.leftover).toBeGreaterThan(50);
    expect(people().named.length + people().unnamed.length).toBeGreaterThan(3);
  });

  it("sends only the people that changed, and keeps the rest as they were", async () => {
    const rand = seeded(5);
    const store = new FaceStore();
    store.load();
    for (let p = 0; p < 4; p++) {
      const base = direction(rand);
      for (let i = 0; i < 5; i++) {
        const uid = `vol~p${p}-${i}`;
        store.put(uid, [{ id: `${uid}#0`, uid, box: [0.1, 0.1, 0.4, 0.5], points: [], score: 0.9, blur: 100, sideways: 0, embedding: faceOf(base, rand, 0.4) }]);
      }
    }
    await placeNew(store);
    const feed = new PeopleFeed("one");
    const index = new PeopleIndex();
    let held = read(feed, index, store, null);
    const first = held.list.unnamed;
    expect(first.length).toBe(4);

    const same = read(feed, index, store, held);
    expect(same).toBe(held);

    renamePerson(store, first[0].id, "Anna");
    feed.update(listPeople(store));
    const answer = feed.answer(tokenOf(held));
    expect(answer.full).toBe(false);
    if (answer.full) return;
    expect(answer.changed.map((x) => x.id)).toEqual([first[0].id]);
    expect(answer.removed).toEqual([]);
    held = applyPeopleAnswer(held, answer)!;
    expect(held.list.named.map((x) => x.name)).toEqual(["Anna"]);
    // The people that did not change are the same objects as before.
    expect(held.list.unnamed).toEqual(first.slice(1));
    held.list.unnamed.forEach((x, i) => expect(x).toBe(first[i + 1]));
    expect(held.list).toEqual(full(store));
  });

  it("answers in full a reader of another run, one too far behind, and none at all", () => {
    const feed = new PeopleFeed("now");
    const empty: PeopleList = { named: [], unnamed: [], hidden: [], leftover: 0, suggestions: [], loose: { faces: [], total: 0 } };
    const person = (id: string) => ({ id, name: null, isOther: false, uids: [`u-${id}`], cover: null });
    feed.update({ ...empty, unnamed: [person("a")] });
    expect(feed.answer(null).full).toBe(true);
    expect(feed.answer({ epoch: "before", seq: 1 }).full).toBe(true);
    expect(feed.answer({ epoch: "now", seq: 99 }).full).toBe(true);
    expect(feed.answer({ epoch: "now", seq: 1 }).full).toBe(false);
    // Thousands of people gone, one after another: an early reader cannot be told them all.
    for (let i = 0; i < 4_500; i++) feed.update({ ...empty, unnamed: [person(`x${i}`)] });
    expect(feed.answer({ epoch: "now", seq: 1 }).full).toBe(true);
    const late = feed.answer({ epoch: "now", seq: 4_400 });
    expect(late.full).toBe(false);
    // An answer that does not follow on from what is held is not applied.
    const held = applyPeopleAnswer(null, feed.answer(null))!;
    expect(applyPeopleAnswer({ ...held, seq: held.seq - 3 }, feed.answer({ epoch: "now", seq: held.seq - 2 }))).toBeNull();
    expect(applyPeopleAnswer(null, late)).toBeNull();
  });
});
