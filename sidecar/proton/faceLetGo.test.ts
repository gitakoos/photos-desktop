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
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setSliceMs, SLICE_MS } from "./faceCluster.ts";
import { FaceScanner } from "./faceScan.ts";
import { initStore, setDataKey } from "./store.ts";
import { library } from "./testLibrary.ts";

const filesOf = (dir: string) => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out[join(d, e.name)] = readFileSync(join(d, e.name)).toString("base64");
    }
  };
  walk(dir);
  return out;
};

const turns = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

afterEach(() => setSliceMs(SLICE_MS));

describe("a store let go while faces are taken in and saved", () => {
  it("carries nothing of the copy or the save into the store loaded next", async () => {
    // Every chance for a turn is taken, so the take-in is surely under way at the sign-out.
    setSliceMs(0);
    const lib = library(3, 3_000);
    const first = mkdtempSync(join(tmpdir(), "pfp-letgo-a-"));
    initStore(first);
    setDataKey(randomBytes(32));
    const scanner = new FaceScanner();
    scanner.setEnabled(true, false, false, true, false);
    scanner.store.load();
    for (const [uid, faces] of lib.local) scanner.store.put(uid, faces);
    scanner.changed();

    const underWay = scanner.setPhoneCopies([lib.copy]);
    const queued = scanner.setPhoneCopies([lib.copy]);
    await turns(20);
    expect(scanner.store.people.applied).toEqual({});
    scanner.stop(true);
    const firstFiles = filesOf(first);

    const second = mkdtempSync(join(tmpdir(), "pfp-letgo-b-"));
    initStore(second);
    setDataKey(randomBytes(32));
    scanner.store.load();
    await Promise.all([underWay, queued]);
    await turns(200);

    const held = scanner.store.people;
    expect(scanner.store.allFaces()).toEqual([]);
    expect(held.people).toEqual([]);
    expect(held.namedAt).toEqual({});
    expect(held.applied).toEqual({});
    expect(filesOf(first)).toEqual(firstFiles);
    scanner.changed();
    await turns(50);
    scanner.store.unload();
    scanner.store.load();
    expect(scanner.store.allFaces()).toEqual([]);
    expect(scanner.store.people.people).toEqual([]);
  }, 120_000);
});
