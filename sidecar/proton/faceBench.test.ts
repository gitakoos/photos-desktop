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

// How the sidecar answers while a large library's faces are taken in from the phone and grouped.
// A made-up library goes through what a scan does with a phone's copy (its scans adopted, its
// faces paired, the new ones placed, the likely groups merged, the leftovers looked at again, the
// whole library grouped, everything written), while a probe on another thread sends cheap calls
// and thumbnail requests to this one and the event loop's delay is measured. The answers must
// stay quick, and the people must come out as a run that never gives a turn.
//
// The everyday run uses a small library and checks the people only. PFP_FACE_BENCH=50000,150000
// runs those sizes instead, with the waits held to MAX_LAG_MS; run it on its own:
// `PFP_FACE_BENCH=50000,150000 npx vitest run proton/faceBench.test.ts`.

import { describe, expect, it } from "vitest";

import { setSliceMs, SLICE_MS } from "./faceCluster.ts";
import { listPeople } from "./facePeople.ts";
import type { FaceStore } from "./faceStore.ts";
import { PeopleFeed, applyPeopleAnswer, tokenOf, type HeldPeople } from "./peopleFeed.ts";
import { PeopleIndex } from "./peopleIndex.ts";
import { library, outcome, probed, storeBefore, takeInAndGroup } from "./testLibrary.ts";

/** The longest the event loop, a cheap call or a thumbnail may wait while the faces are worked on. */
const MAX_LAG_MS = 100;

const sizes = (process.env.PFP_FACE_BENCH ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

describe("a large library taken in from the phone and grouped", () => {
  for (const size of sizes.length ? sizes : [3_000]) {
    it(
      `keeps the sidecar answering at ${size} faces, with the people of a run that never gives a turn`,
      async () => {
        const lib = library(7, size);
        const faceCount = lib.copy.faces.length;

        // The run with the probe goes first, so the reference's leftovers are not swept up during it.
        let store: FaceStore | null = await storeBefore(lib);
        const started = performance.now();
        // The window's read of the people, as the sidecar answers it: what changed, put in JSON to
        // be sent. The window reads the JSON in its own process, so the answer is applied as it is.
        const feed = new PeopleFeed("bench");
        const index = new PeopleIndex();
        let held: HeldPeople | null = null;
        let sentChars = 0;
        const read = async () => {
          feed.update(await index.listAsync(store!, (link) => lib.uidByLink.get(link)));
          const answer = feed.answer(tokenOf(held));
          sentChars = Math.max(sentChars, JSON.stringify(answer).length);
          held = applyPeopleAnswer(held, answer);
        };
        const run = await probed(() => takeInAndGroup(store!, lib), read);
        run.out.total = Math.round(performance.now() - started);
        await read();
        const people = listPeople(store);
        expect(held!.list).toEqual(JSON.parse(JSON.stringify(people)));
        const measured = outcome(store);
        store = null;

        setSliceMs(Infinity);
        let reference: string;
        let referenceSteps: Record<string, number>;
        try {
          const straight = await storeBefore(lib);
          const at = performance.now();
          referenceSteps = await takeInAndGroup(straight, lib);
          referenceSteps.total = Math.round(performance.now() - at);
          reference = outcome(straight);
        } finally {
          setSliceMs(SLICE_MS);
        }
        const report = {
          faces: faceCount,
          photos: lib.copy.scanned.length,
          named: people.named.length,
          unnamed: people.unnamed.length,
          leftover: people.leftover,
          reference: referenceSteps,
          steps: run.out,
          lag: run.lag,
          blocks: run.blocks,
          duringReads: run.duringReads,
          sentChars,
          gc: run.gc,
          rpc: run.rpc,
          thumb: run.thumb,
          reads: run.reads,
        };
        process.stdout.write(`[face bench] ${JSON.stringify(report)}\n`);

        expect(measured).toBe(reference);
        expect(people.named.length).toBeGreaterThan(0);
        expect(run.rpc.count).toBeGreaterThan(10);
        expect(run.thumb.count).toBeGreaterThan(3);
        // Timed only when run on its own: beside the other test files the machine is shared.
        if (sizes.length) {
          expect(run.lag.max).toBeLessThan(MAX_LAG_MS);
          expect(run.rpc.max).toBeLessThan(MAX_LAG_MS);
          expect(run.thumb.max).toBeLessThan(MAX_LAG_MS);
        }
      },
      60 * 60_000,
    );
  }
});
