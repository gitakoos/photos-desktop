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

import { readLabelCopy, writeLabelCopy, type LabelCopy } from "./driveData.ts";
import {
  addLabels,
  cleanLabel,
  createLabel,
  deleteLabel,
  emptyLabels,
  labelList,
  labelsForDrive,
  removeLabels,
  renameLabel,
  setLabels,
  takeInLabels,
} from "./labelStore.ts";

const PC = "11111111-1111-4111-8111-111111111111";
const PHONE = "22222222-2222-4222-8222-222222222222";

const phoneCopy = (createdAt: number, over: Partial<LabelCopy> = {}): LabelCopy => ({
  deviceId: PHONE,
  deviceLabel: "Pixel",
  createdAt,
  photos: [],
  names: [],
  deleted: [],
  ...over,
});

const labelsOf = (state: ReturnType<typeof emptyLabels>, key: string) => state.photos[key]?.l ?? [];

describe("a label", () => {
  it("is cleaned as the phone cleans it", () => {
    expect(cleanLabel("  Summer   holiday ")).toBe("Summer holiday");
    expect(cleanLabel("a,b")).toBeNull();
    expect(cleanLabel("   ")).toBeNull();
    expect(cleanLabel("x".repeat(30))).toBe("x".repeat(24));
  });
});

describe("editing labels here", () => {
  it("adds after what a photo has, once each, up to five, and says which photos were full", () => {
    const s = emptyLabels();
    setLabels(s, "k0", ["a", "b", "c", "d"], 1);
    const result = addLabels(s, ["k0", "k1"], ["B", "e", "f"], 2);
    expect(labelsOf(s, "k0")).toEqual(["a", "b", "c", "d", "e"]);
    expect(labelsOf(s, "k1")).toEqual(["B", "e", "f"]);
    expect(result).toEqual({ changed: 2, full: 1 });
  });

  it("takes labels off, case and accents aside", () => {
    const s = emptyLabels();
    setLabels(s, "k0", ["Nyár", "Strand"], 1);
    expect(removeLabels(s, ["k0", "k9"], ["nyar"], 2)).toBe(1);
    expect(labelsOf(s, "k0")).toEqual(["Strand"]);
  });

  it("keeps a label made by name in the list, also once its last photo lets go of it", () => {
    const s = emptyLabels();
    expect(createLabel(s, " Later ", 1)).toBe("Later");
    expect(labelList(s)).toEqual([{ name: "Later", keys: [] }]);
    addLabels(s, ["k0"], ["later"], 2);
    expect(labelList(s)).toEqual([{ name: "later", keys: ["k0"] }]);
    expect(labelsForDrive(s, PC, "Desk", 3).names).toEqual([]);
    removeLabels(s, ["k0"], ["Later"], 4);
    expect(labelList(s)).toEqual([{ name: "Later", keys: [] }]);
    expect(labelsForDrive(s, PC, "Desk", 5).names).toEqual([{ name: "Later", changedAt: 1 }]);
  });

  it("renames on every photo, keeping a photo that had both names to one", () => {
    const s = emptyLabels();
    setLabels(s, "k0", ["Old", "New"], 1);
    setLabels(s, "k1", ["Old"], 1);
    expect(renameLabel(s, "Old", "New", 5)).toBe("New");
    expect(labelsOf(s, "k0")).toEqual(["New"]);
    expect(labelsOf(s, "k1")).toEqual(["New"]);
    expect(s.deleted.old).toEqual({ n: "Old", t: 4 });
  });

  it("deletes from every photo and remembers when", () => {
    const s = emptyLabels();
    setLabels(s, "k0", ["Beach", "Sun"], 1);
    expect(deleteLabel(s, "beach", 4)).toBe(true);
    expect(labelsOf(s, "k0")).toEqual(["Sun"]);
    expect(s.deleted.beach.t).toBe(4);
    expect(deleteLabel(s, "nothing", 5)).toBe(false);
  });
});

describe("another device's copy", () => {
  it("brings a photo's labels when they changed there later, and keeps a later edit made here", () => {
    const s = emptyLabels();
    setLabels(s, "k0", ["Here"], 10);
    setLabels(s, "k1", ["Here"], 30);
    takeInLabels(
      s,
      phoneCopy(40, {
        photos: [
          { key: "k0", labels: ["There"], changedAt: 20 },
          { key: "k1", labels: ["There"], changedAt: 20 },
          { key: "k2", labels: ["New"], changedAt: 20 },
        ],
      }),
      PC,
    );
    expect(labelsOf(s, "k0")).toEqual(["There"]);
    expect(labelsOf(s, "k1")).toEqual(["Here"]);
    expect(labelsOf(s, "k2")).toEqual(["New"]);
  });

  it("from an app that saves no change times only fills the photos with no labels here", () => {
    const s = emptyLabels();
    setLabels(s, "k0", ["Here"], 10);
    takeInLabels(
      s,
      phoneCopy(99, {
        photos: [
          { key: "k0", labels: [], changedAt: 0 },
          { key: "k1", labels: ["Old phone"], changedAt: 0 },
        ],
      }),
      PC,
    );
    expect(labelsOf(s, "k0")).toEqual(["Here"]);
    expect(labelsOf(s, "k1")).toEqual(["Old phone"]);
  });

  it("takes a deleted label off the photos labelled before it, and not one labelled after", () => {
    const s = emptyLabels();
    setLabels(s, "k0", ["Beach"], 10);
    setLabels(s, "k1", ["Beach"], 50);
    createLabel(s, "Beachy", 1);
    takeInLabels(s, phoneCopy(60, { deleted: [{ name: "beach", at: 40 }] }), PC);
    expect(labelsOf(s, "k0")).toEqual([]);
    expect(labelsOf(s, "k1")).toEqual(["Beach"]);
  });

  it("does not bring back a label deleted here after it was saved there", () => {
    const s = emptyLabels();
    setLabels(s, "k0", ["Beach"], 10);
    deleteLabel(s, "Beach", 30);
    takeInLabels(
      s,
      phoneCopy(60, { photos: [{ key: "k0", labels: ["Beach", "Sun"], changedAt: 20 }], names: [{ name: "Beach", changedAt: 20 }] }),
      PC,
    );
    expect(labelsOf(s, "k0")).toEqual([]);
    expect(s.names).toEqual({});
  });

  it("renames a photo whose copy carries the deletion and the new list at the same time", () => {
    const s = emptyLabels();
    setLabels(s, "k0", ["Old"], 10);
    takeInLabels(
      s,
      phoneCopy(60, { deleted: [{ name: "Old", at: 50 }], photos: [{ key: "k0", labels: ["New"], changedAt: 50 }] }),
      PC,
    );
    expect(labelsOf(s, "k0")).toEqual(["New"]);
  });

  it("is taken in once, and this install's own copy never", () => {
    const s = emptyLabels();
    const copy = phoneCopy(60, { photos: [{ key: "k0", labels: ["A"], changedAt: 20 }] });
    expect(takeInLabels(s, copy, PC)).toBe(true);
    setLabels(s, "k0", [], 5);
    expect(takeInLabels(s, copy, PC)).toBe(false);
    expect(takeInLabels(s, { ...copy, deviceId: PC, createdAt: 70 }, PC)).toBe(false);
  });
});

describe("two devices through Drive", () => {
  it("end with the same labels whichever saved last", () => {
    const pc = emptyLabels();
    const phone = emptyLabels();
    setLabels(pc, "k0", ["Family"], 10);
    setLabels(pc, "k2", ["Old"], 5);
    setLabels(phone, "k2", ["Old"], 5);
    setLabels(phone, "k1", ["Trip"], 12);
    deleteLabel(phone, "Old", 13);
    const toPhone = readLabelCopy(writeLabelCopy(labelsForDrive(pc, PC, "Desk", 20)));
    const toPc = readLabelCopy(writeLabelCopy(labelsForDrive(phone, PHONE, "Pixel", 21)));
    takeInLabels(phone, toPhone, PHONE);
    takeInLabels(pc, toPc, PC);
    const view = (s: typeof pc) => Object.fromEntries(Object.entries(s.photos).map(([k, p]) => [k, p.l]));
    expect(view(pc)).toEqual({ k0: ["Family"], k1: ["Trip"], k2: [] });
    expect(view(phone)).toEqual(view(pc));
  });

  it("carry a rename across, and the old name does not come back when the copy goes back", () => {
    const pc = emptyLabels();
    const phone = emptyLabels();
    setLabels(phone, "k0", ["Old"], 5);
    setLabels(phone, "k1", ["Old", "Sun"], 5);
    takeInLabels(pc, readLabelCopy(writeLabelCopy(labelsForDrive(phone, PHONE, "Pixel", 6))), PC);
    renameLabel(phone, "Old", "New", 10);
    takeInLabels(pc, readLabelCopy(writeLabelCopy(labelsForDrive(phone, PHONE, "Pixel", 11))), PC);
    takeInLabels(phone, readLabelCopy(writeLabelCopy(labelsForDrive(pc, PC, "Desk", 12))), PHONE);
    const view = (s: typeof pc) => Object.fromEntries(Object.entries(s.photos).map(([k, p]) => [k, p.l]));
    expect(view(pc)).toEqual({ k0: ["New"], k1: ["New", "Sun"] });
    expect(view(phone)).toEqual(view(pc));
    expect(labelList(pc).map((l) => l.name).sort()).toEqual(["New", "Sun"]);
  });
});
