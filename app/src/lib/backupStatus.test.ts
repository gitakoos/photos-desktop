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
import { BACKUP_KINDS, backupBlocked, backupPartLine, backupSendingLine, backupSynced, type BackupKind, type PartStatus } from "./backupStatus";
import { en } from "./locales/en";

const dictionaries = import.meta.glob<Record<string, Record<string, string>>>("./locales/*.ts", { eager: true });

const date = (at: number) => `day ${at}`;
const line = (kind: BackupKind, part: PartStatus) => backupPartLine(kind, part, date);

const SKIPS = [
  ["recognition-off", "backup.skip.recognitionOff"],
  ["index-off", "backup.skip.indexOff"],
  ["names-held", "backup.skip.namesHeld"],
  ["library-unlisted", "backup.skip.libraryUnlisted"],
  ["nothing-to-save", "backup.skip.nothing"],
] as const;

const FAILS = [
  ["network", "backup.failed.network"],
  ["drive-full", "backup.failed.driveFull"],
  ["signed-out", "backup.failed.signedOut"],
  ["copy-invalid", "backup.failed.invalid"],
  ["drive-error", "backup.failed.drive"],
] as const;

describe("what the backup says about a part", () => {
  it("gives a saved part its date and what its copy holds", () => {
    expect(line("faces", { result: "saved", at: 1, counts: { faces: 3, photos: 2 } })).toEqual({
      key: "backup.savedFaces",
      values: { date: "day 1", faces: 3, photos: 2 },
    });
    expect(line("search", { result: "saved", at: 1, counts: { vectors: 7 } })).toEqual({
      key: "backup.savedSearch",
      values: { date: "day 1", vectors: 7 },
    });
    expect(line("labels", { result: "saved", at: 1 })).toEqual({ key: "backup.saved", values: { date: "day 1" } });
    expect(line("hidden", { result: "saved", at: 1 })).toEqual({ key: "backup.saved", values: { date: "day 1" } });
  });

  it("reads a part with nothing new as saved, with counts only when it has them", () => {
    expect(line("faces", { result: "unchanged", at: 2 })).toEqual({ key: "backup.saved", values: { date: "day 2" } });
    expect(line("search", { result: "unchanged", at: 2 })).toEqual({ key: "backup.saved", values: { date: "day 2" } });
    expect(line("faces", { result: "unchanged", at: 2, counts: { faces: 5, photos: 4 } })).toEqual({
      key: "backup.savedFaces",
      values: { date: "day 2", faces: 5, photos: 4 },
    });
  });

  it.each(SKIPS)("names the skip %s", (reason, key) => {
    expect(line("search", { result: "skipped", at: 1, reason })).toEqual({ key, values: {} });
  });

  it.each(FAILS)("names the failure %s", (reason, key) => {
    expect(line("faces", { result: "failed", at: 1, reason })).toEqual({ key, values: {} });
  });

  it("gives a copy held back the numbers on both sides", () => {
    const report = { photosBefore: 100, photosAfter: 90, itemsBefore: 200, itemsAfter: 150 };
    expect(line("faces", { result: "blocked", at: 1, report })).toEqual({ key: "backup.blocked", values: report });
  });
});

describe("the line for a copy on its way", () => {
  it("gives the bytes as sizes", () => {
    expect(backupSendingLine({ kind: "faces", sent: 512, total: 1536 })).toEqual({
      key: "backup.sending",
      values: { sent: "512 B", total: "1.5 KB" },
    });
  });
});

describe("whether the last round saved anything", () => {
  it("is false when every part was skipped", () => {
    expect(backupSynced({ faces: { result: "skipped", at: 1, reason: "recognition-off" } })).toBe(false);
  });

  it("is true with one part saved or already up to date", () => {
    const skipped: PartStatus = { result: "skipped", at: 1, reason: "index-off" };
    expect(backupSynced({ search: skipped, faces: { result: "saved", at: 1 } })).toBe(true);
    expect(backupSynced({ search: skipped, labels: { result: "unchanged", at: 1 } })).toBe(true);
  });

  it("is false for a copy held back or failed", () => {
    const report = { photosBefore: 2, photosAfter: 1, itemsBefore: 2, itemsAfter: 1 };
    expect(backupSynced({ faces: { result: "blocked", at: 1, report } })).toBe(false);
    expect(backupSynced({ labels: { result: "failed", at: 1, reason: "network" } })).toBe(false);
  });

  it("is false before any round", () => {
    expect(backupSynced({})).toBe(false);
  });
});

describe("whether a copy is held back", () => {
  const report = { photosBefore: 2, photosAfter: 1, itemsBefore: 2, itemsAfter: 1 };

  it("is true with any part blocked, whatever the others did", () => {
    expect(backupBlocked({ faces: { result: "blocked", at: 1, report } })).toBe(true);
    expect(
      backupBlocked({
        faces: { result: "saved", at: 1 },
        search: { result: "blocked", at: 1, report },
        labels: { result: "failed", at: 1, reason: "network" },
      }),
    ).toBe(true);
  });

  it("is false with none blocked, and before any round", () => {
    expect(
      backupBlocked({
        faces: { result: "saved", at: 1 },
        search: { result: "skipped", at: 1, reason: "index-off" },
        labels: { result: "failed", at: 1, reason: "network" },
        hidden: { result: "unchanged", at: 1 },
      }),
    ).toBe(false);
    expect(backupBlocked({})).toBe(false);
  });
});

describe("the backup texts", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const keys = Object.keys(en).filter((key) => key.startsWith("backup."));

  it("cover every line a part can show, in English", () => {
    const shown = [
      ...SKIPS.map(([, key]) => key),
      ...FAILS.map(([, key]) => key),
      ...["saved", "savedFaces", "savedSearch", "blocked", "saveAnyway", "sending", "nothingSaved"].map((name) => `backup.${name}`),
      ...BACKUP_KINDS.map((kind) => `backup.part.${kind}`),
    ];
    expect([...keys].sort()).toEqual([...shown].sort());
  });

  it("are in every language, with the same blanks to fill", () => {
    expect(Object.keys(dictionaries)).toHaveLength(11);
    for (const [file, module] of Object.entries(dictionaries)) {
      const dictionary = Object.values(module)[0];
      for (const key of keys) {
        expect(dictionary[key], `${key} in ${file}`).toBeTruthy();
        expect(placeholders(dictionary[key]), `${key} in ${file}`).toEqual(placeholders(en[key]));
      }
    }
  });
});
