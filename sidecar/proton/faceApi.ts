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

// What the window asks of face recognition on this computer.

import {
  addFacesToPerson,
  declineCandidates,
  facesOnPhoto,
  nameFaces,
  rejectFaces,
  dismissSuggestion,
  listPeople,
  personCandidates,
  mergePeople,
  notThisPerson,
  rejectPerson,
  removePhotosFromPerson,
  renamePerson,
  setPersonCover,
} from "./facePeople.ts";
import { faceScanner } from "./faceScan.ts";
import { isScanSpeed } from "./scanPipeline.ts";
import { isReady } from "./store.ts";

const str = (v: unknown, max = 500) => String(v ?? "").slice(0, max);
const ids = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10_000) : [];

function store() {
  const s = faceScanner.store;
  if (!s.isLoaded()) {
    if (!isReady()) throw new Error("Locked");
    s.load();
  }
  return s;
}

/** Runs a change to the people, then saves it and tells the window. */
function change<T>(edit: () => T): T {
  const out = edit();
  faceScanner.changed();
  return out;
}

export const faceHandlers: Record<string, (p: any) => unknown> = {
  faceScanStatus: () => faceScanner.getStatus(),
  faceScanSetEnabled: (p) => {
    // A speed that is not one of the three is this machine's own.
    faceScanner.setSpeed(isScanSpeed(p?.speed) ? p.speed : null);
    return faceScanner.setEnabled(
      p?.on === true,
      p?.autoMerge === true,
      p?.findMore === true,
      p?.sync === true,
      p?.index === true,
    );
  },
  faceScanSetPaused: (p) => faceScanner.setPaused(p?.paused === true),
  faceScanRescan: () => faceScanner.rescan(),
  faceScanClear: () => faceScanner.clearAll(),
  faceWipeSeen: () => {
    faceScanner.wipeSeen();
    return faceScanner.getStatus();
  },
  faceSearchClear: () => faceScanner.clearSearch(),
  facePeople: () => listPeople(store(), (link) => faceScanner.uidOfLink(link)),
  facePersonRename: (p) => change(() => ({ id: renamePerson(store(), str(p?.id), str(p?.name, 100)) })),
  facePersonMerge: (p) => change(() => mergePeople(store(), str(p?.from), str(p?.into))),
  faceNameFaces: (p) => change(() => ({ id: nameFaces(store(), ids(p?.faceIds), str(p?.name, 100)) })),
  faceRejectFaces: (p) => change(() => ({ count: rejectFaces(store(), ids(p?.faceIds)) })),
  faceNotThisPerson: (p) => change(() => ({ ok: notThisPerson(store(), str(p?.faceId)) })),
  facesOnPhoto: (p) => (faceScanner.store.isLoaded() || isReady() ? facesOnPhoto(store(), str(p?.uid)) : []),
  facePersonCandidates: (p) => personCandidates(store(), str(p?.id)),
  facePersonAddFaces: (p) => change(() => ({ count: addFacesToPerson(store(), str(p?.id), ids(p?.faceIds)) })),
  facePersonDecline: (p) => change(() => declineCandidates(store(), str(p?.id), ids(p?.faceIds))),
  faceSweepStart: (p) => faceScanner.startSweep(str(p?.id)),
  faceSweepStop: () => faceScanner.stopSweep(),
  faceSweepStatus: () => faceScanner.getSweep(),
  faceSuggestionDismiss: (p) => change(() => dismissSuggestion(store(), str(p?.unnamed), str(p?.named))),
  facePersonReject: (p) => change(() => ({ count: rejectPerson(store(), str(p?.id)) })),
  facePersonRemovePhotos: (p) =>
    change(() => ({
      count: removePhotosFromPerson(
        store(),
        str(p?.id),
        Array.isArray(p?.uids) ? p.uids.filter((u: unknown) => typeof u === "string").slice(0, 10_000) : [],
      ),
    })),
  facePersonCover: (p) => change(() => setPersonCover(store(), str(p?.id), str(p?.uid))),
};
