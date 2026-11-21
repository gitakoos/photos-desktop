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
  hidePerson,
  personCandidates,
  mergePeople,
  notThisPerson,
  rejectPerson,
  removePhotosFromPerson,
  renamePerson,
  setPersonCover,
  showPerson,
} from "./facePeople.ts";
import { diag } from "./diag.ts";
import { faceScanner } from "./faceScan.ts";
import { isScanSpeed } from "./scanPipeline.ts";
import type { PeopleToken } from "./peopleFeed.ts";
import { isReady } from "./store.ts";

const str = (v: unknown, max = 500) => String(v ?? "").slice(0, max);
const token = (v: any): PeopleToken | null =>
  v && typeof v.epoch === "string" && typeof v.seq === "number" ? { epoch: v.epoch, seq: v.seq } : null;
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
  // The whole list on a first read, after a restart or when the reader fell too far behind; else what changed since `since`.
  facePeople: async (p) => {
    const started = performance.now();
    try {
      const people = await faceScanner.peopleIndex.listAsync(store(), (link) => faceScanner.uidOfLink(link));
      const feed = faceScanner.peopleFeed;
      feed.update(people);
      return feed.answer(token(p?.since));
    } finally {
      diag.record("faces", "list_people", performance.now() - started);
    }
  },
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
  facePersonHide: (p) => change(() => hidePerson(store(), str(p?.id))),
  facePersonShow: (p) => change(() => showPerson(store(), str(p?.id))),
  facePersonCover: (p) => change(() => setPersonCover(store(), str(p?.id), str(p?.uid))),
};
