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

// What the shared backup on Proton Drive and the two switches under it decide: what is read from
// Drive, which people and which search are on offer, and how settings saved by older versions map.

export type DriveSwitches = {
  sharedBackup: boolean;
  localFaces: boolean;
  localSearch: boolean;
  driveLabels: boolean;
};

/** What each backup round and each read of the copies on Drive takes in. */
export function driveReadKinds(s: DriveSwitches) {
  return {
    // The people other devices saved, whenever the backup is on and this PC does not scan itself;
    // with the scan on they are put together with the faces found here.
    faces: s.sharedBackup && !s.localFaces,
    labels: s.driveLabels,
    // The search copies other devices saved, read with indexing on or off.
    search: s.sharedBackup,
    faceData: s.localFaces || s.sharedBackup,
  };
}

/** The people tile and page: the scan here, or what other devices saved when there is some. */
export function peopleOnOffer(s: DriveSwitches, drivePeople: number): boolean {
  return s.localFaces || (s.sharedBackup && drivePeople > 0);
}

/** The search by what a photo shows works on the index made here or on the copies from Drive. */
export function searchOnOffer(s: DriveSwitches, copyPhotos: number): boolean {
  return s.localSearch || (s.sharedBackup && copyPhotos > 0);
}

/** The search runs on other devices' copies alone: indexing here is off and copies hold vectors. */
export function searchFromCopiesOnly(s: DriveSwitches, copyPhotos: number): boolean {
  return !s.localSearch && s.sharedBackup && copyPhotos > 0;
}

/**
 * Settings saved before the two switches meant "scan here" and "index here": the face share
 * became the shared backup, and whoever had the faces or the search on in any form keeps the
 * scan or the index on. The two old fields are dropped.
 */
export function migrateSettings(saved: Record<string, unknown>): Record<string, unknown> {
  const next = { ...saved };
  if (next.sharedBackup === undefined && typeof next.faceSync === "boolean") next.sharedBackup = next.faceSync;
  delete next.faceSync;
  if (next.driveFaces === true) next.localFaces = true;
  // The index ran only with the search on; a leftover index flag under a search that was off stays off.
  if (typeof next.semanticSearch === "boolean") next.localSearch = next.semanticSearch;
  delete next.driveFaces;
  delete next.semanticSearch;
  return next;
}
