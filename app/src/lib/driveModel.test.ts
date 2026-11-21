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
import { driveReadKinds, migrateSettings, peopleOnOffer, searchFromCopiesOnly, searchOnOffer } from "./driveModel";

const off = { sharedBackup: false, localFaces: false, localSearch: false, driveLabels: true };

describe("what is read from Drive", () => {
  it("reads other devices' people and search copies whenever the backup is on", () => {
    expect(driveReadKinds({ ...off, sharedBackup: true })).toEqual({ faces: true, labels: true, search: true, faceData: true });
  });
  it("reads nothing of the faces or the search with the backup off", () => {
    expect(driveReadKinds(off)).toEqual({ faces: false, labels: true, search: false, faceData: false });
  });
  it("leaves the people to the scan's own merge when it runs here", () => {
    const kinds = driveReadKinds({ ...off, sharedBackup: true, localFaces: true });
    expect(kinds.faces).toBe(false);
    expect(kinds.faceData).toBe(true);
  });
});

describe("the people and the search on offer", () => {
  it("shows people from Drive with the scan off only when the backup is on and some came", () => {
    expect(peopleOnOffer({ ...off, sharedBackup: true }, 3)).toBe(true);
    expect(peopleOnOffer({ ...off, sharedBackup: true }, 0)).toBe(false);
    expect(peopleOnOffer({ ...off, sharedBackup: false }, 3)).toBe(false);
    expect(peopleOnOffer({ ...off, localFaces: true }, 0)).toBe(true);
  });
  it("searches by content on the copies with indexing off", () => {
    expect(searchOnOffer({ ...off, sharedBackup: true }, 10)).toBe(true);
    expect(searchOnOffer({ ...off, sharedBackup: true }, 0)).toBe(false);
    expect(searchOnOffer({ ...off, sharedBackup: false }, 10)).toBe(false);
    expect(searchOnOffer({ ...off, localSearch: true }, 0)).toBe(true);
  });
  it("needs the text model fetched only when the copies are all there is", () => {
    expect(searchFromCopiesOnly({ ...off, sharedBackup: true }, 10)).toBe(true);
    expect(searchFromCopiesOnly({ ...off, sharedBackup: true, localSearch: true }, 10)).toBe(false);
    expect(searchFromCopiesOnly({ ...off, sharedBackup: true }, 0)).toBe(false);
  });
});

describe("settings from older versions", () => {
  it("turns the faces' share into the backup", () => {
    expect(migrateSettings({ faceSync: true })).toEqual({ sharedBackup: true });
  });
  it("keeps the scan and the index on for whoever had them on", () => {
    expect(migrateSettings({ driveFaces: true, semanticSearch: true })).toEqual({ localFaces: true, localSearch: true });
  });
  it("leaves the scan and the index off for whoever did not use them", () => {
    expect(migrateSettings({ localFaces: false, sharedBackup: true, driveFaces: false, semanticSearch: false })).toEqual({
      localFaces: false,
      localSearch: false,
      sharedBackup: true,
    });
  });
  it("keeps the index off under a search that was off", () => {
    expect(migrateSettings({ semanticSearch: false, localSearch: true })).toEqual({ localSearch: false });
  });
  it("leaves a current file as it is", () => {
    expect(migrateSettings({ localSearch: true, localFaces: true })).toEqual({ localSearch: true, localFaces: true });
  });
});
