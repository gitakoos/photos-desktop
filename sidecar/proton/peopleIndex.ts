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

// The people list as `listPeople` makes it, kept from one read to the next. Each read goes over the
// faces once to see which people they belong to now; a person whose faces, name, cover, hidden state
// and confirmed photos are as at the last read keeps what was worked out for them then: the entry
// shown, the mean direction of the faces, the closest named person and the faces listed as loose.
// Only the people that changed are worked out again, so the list stays quick on a large library.

import {
  FACE_SUGGEST_THRESHOLD,
  MIN_FACES_TO_SHOW_PERSON,
  dot,
  isNameableCluster,
  meanDirection,
  runPausable,
  runPausableSliced,
  type Pausable,
} from "./faceCluster.ts";
import {
  MAX_LOOSE,
  facesByPersonSteps,
  isHiddenName,
  portableFaceId,
  type LooseFace,
  type PeopleLists,
  type PersonView,
  type Suggestion,
} from "./facePeople.ts";
import type { FaceRecord, FaceStore, PeopleState } from "./faceStore.ts";
import { shownName } from "./personName.ts";

/** What a person's faces alone decide, kept while the faces stay the same. */
type FacesOf = {
  faces: FaceRecord[];
  /** The photos the faces are on, in the faces' order. */
  uids: string[];
  /** The clearest face, the first of equals. */
  clearest: FaceRecord | undefined;
  direction: Float32Array | null;
  /** The faces clearest first, equals in their order. */
  byScore: FaceRecord[] | null;
};

/** A person's entry as last shown, with what it was made from. */
type Shown = {
  of: FacesOf;
  name: string | null;
  isOther: boolean;
  picked: string | undefined;
  extra: string[];
  view: PersonView;
};

/** The closest named person to an unnamed group, against the named people of one read. */
type Closest = {
  direction: Float32Array;
  named: Map<string, Float32Array>;
  id: string | null;
  similarity: number;
};

export class PeopleIndex {
  private store: FaceStore | null = null;
  private people: PeopleState | null = null;
  private faces = new Map<string, FacesOf>();
  private shown = new Map<string, Shown>();
  private closest = new Map<string, Closest>();

  /** The people list, worked out again only where it changed since the last read. */
  list(store: FaceStore, uidOfLink?: (link: string) => string | undefined): PeopleLists {
    return runPausable(this.steps(store, uidOfLink));
  }

  /**
   * `list`, giving the rest of the process its turn as it goes. The people changing meanwhile start
   * it over, so the list is one moment's. While they keep changing, the third try is answered as it
   * is: each change moves the version the window watches, so the window reads them again after.
   */
  async listAsync(store: FaceStore, uidOfLink?: (link: string) => string | undefined): Promise<PeopleLists> {
    let list: PeopleLists;
    let tries = 0;
    for (;;) {
      const held = store.people;
      const marks = store.peopleMarks;
      list = await runPausableSliced(this.steps(store, uidOfLink));
      if ((store.people === held && store.peopleMarks === marks) || ++tries === 3) return list;
    }
  }

  private *steps(store: FaceStore, uidOfLink?: (link: string) => string | undefined): Pausable<PeopleLists> {
    const p = store.people;
    if (this.store !== store || this.people !== p) {
      this.store = store;
      this.people = p;
      this.faces.clear();
      this.shown.clear();
      this.closest.clear();
    }
    const byPerson = yield* facesByPersonSteps(store);
    let scannedByLink: Map<string, string> | null = null;
    const resolve = (link: string) => {
      const found = uidOfLink?.(link);
      if (found) return found;
      if (!scannedByLink) scannedByLink = new Map(store.scanned().map((uid) => [portableFaceId(uid), uid]));
      return scannedByLink.get(link);
    };

    const named: PersonView[] = [];
    const unnamed: PersonView[] = [];
    const hidden: PersonView[] = [];
    let leftover = 0;
    const namedDirections = new Map<string, Float32Array>();
    const nameOf = new Map<string, string>();
    const toMatch: [string, FacesOf][] = [];
    const loose: FacesOf[] = [];
    const seen = new Set<string>();
    for (let at = 0; at < p.people.length; at++) {
      yield;
      const person = p.people[at];
      seen.add(person.id);
      const of = this.facesOf(person.id, byPerson.get(person.id) ?? []);
      const isHidden = isHiddenName(p, person.name);

      // What the suggestions and the loose faces take from this person.
      if (!person.isOther && !isHidden && of.faces.length > 0) {
        if (shownName(person.name)) {
          namedDirections.set(person.id, directionOf(of));
          nameOf.set(person.id, person.name!);
        } else if (isNameableCluster(null, false, of.uids.length)) {
          toMatch.push([person.id, of]);
        }
      }
      if (!person.name && (person.isOther || of.uids.length < MIN_FACES_TO_SHOW_PERSON)) loose.push(of);

      let uids = of.uids;
      let extra: string[] = [];
      if (person.name && !person.isOther) {
        const have = new Set(uids);
        for (const link of p.manual[person.name] ?? []) {
          const uid = resolve(link);
          if (uid && !have.has(uid)) {
            have.add(uid);
            extra.push(uid);
          }
        }
        if (extra.length) uids = [...uids, ...extra];
      }
      if (person.isOther) {
        leftover = uids.length;
        continue;
      }
      if (uids.length === 0) continue;
      const view = this.viewOf(person.id, person.name, person.isOther, person.name ? p.covers[person.name] : undefined, of, extra, uids);
      if (isHidden) hidden.push(view);
      else if (view.name) named.push(view);
      else if (isNameableCluster(null, false, uids.length)) unnamed.push(view);
    }
    for (const id of [...this.faces.keys()]) if (!seen.has(id)) this.faces.delete(id);
    for (const id of [...this.shown.keys()]) if (!seen.has(id)) this.shown.delete(id);
    named.sort((a, b) => b.uids.length - a.uids.length || a.name!.localeCompare(b.name!));
    const bySize = (a: PersonView, b: PersonView) => b.uids.length - a.uids.length || (a.id < b.id ? -1 : 1);
    unnamed.sort(bySize);
    hidden.sort(bySize);

    const suggestions = yield* this.suggestionSteps(p, toMatch, namedDirections, nameOf);
    return { named, unnamed, hidden, leftover, suggestions, loose: looseOf(loose) };
  }

  private facesOf(id: string, faces: FaceRecord[]): FacesOf {
    const held = this.faces.get(id);
    if (held && sameFaces(held.faces, faces)) return held;
    const uids = [...new Set(faces.map((f) => f.uid))];
    const clearest = faces.reduce<FaceRecord | undefined>((best, f) => (!best || f.score > best.score ? f : best), undefined);
    const of: FacesOf = { faces, uids, clearest, direction: null, byScore: null };
    this.faces.set(id, of);
    return of;
  }

  private viewOf(
    id: string,
    name: string | null,
    isOther: boolean,
    picked: string | undefined,
    of: FacesOf,
    extra: string[],
    uids: string[],
  ): PersonView {
    const held = this.shown.get(id);
    if (
      held &&
      held.of === of &&
      held.name === name &&
      held.isOther === isOther &&
      held.picked === picked &&
      sameStrings(held.extra, extra)
    ) {
      return held.view;
    }
    const coverFace = (picked ? of.faces.find((f) => f.uid === picked) : undefined) ?? of.clearest;
    const view: PersonView = {
      id,
      name: shownName(name),
      isOther: false,
      uids,
      cover: coverFace ? { uid: coverFace.uid, box: coverFace.box } : null,
    };
    this.shown.set(id, { of, name, isOther, picked, extra, view });
    return view;
  }

  /**
   * The unnamed groups close to a named person, as `listSuggestions` finds them. A group whose faces
   * and the named people it was held against are as before keeps its closest person; when only some
   * named people changed, it is held against those alone.
   */
  private *suggestionSteps(
    p: PeopleState,
    toMatch: [string, FacesOf][],
    named: Map<string, Float32Array>,
    nameOf: Map<string, string>,
  ): Pausable<Suggestion[]> {
    const matching = new Set(toMatch.map(([id]) => id));
    for (const id of [...this.closest.keys()]) if (!matching.has(id)) this.closest.delete(id);
    if (named.size === 0 || toMatch.length === 0) return [];
    const byId = [...named].sort((a, b) => cmp(a[0], b[0]));
    // What changed among the named people since each earlier read, worked out once a read.
    const since = new Map<Map<string, Float32Array>, { gone: Set<string>; changed: [string, Float32Array][] } | null>();
    const changesSince = (before: Map<string, Float32Array>) => {
      if (!since.has(before)) {
        const gone = new Set<string>();
        for (const [id, d] of before) if (named.get(id) !== d) gone.add(id);
        const changed = byId.filter(([id, d]) => before.get(id) !== d);
        since.set(before, gone.size + changed.length > byId.length / 2 ? null : { gone, changed });
      }
      return since.get(before)!;
    };
    const out: Suggestion[] = [];
    for (let at = 0; at < toMatch.length; at++) {
      yield;
      const [id, of] = toMatch[at];
      const direction = directionOf(of);
      let held = this.closest.get(id);
      if (held && held.direction === direction && held.named !== named) {
        const changes = changesSince(held.named);
        if (!changes || (held.id !== null && changes.gone.has(held.id))) {
          held = undefined;
        } else {
          let best = held.similarity;
          let bestId = held.id;
          for (const [namedId, d] of changes.changed) {
            const s = dot(direction, d);
            if (bestId === null || s > best || (s === best && cmp(namedId, bestId) < 0)) {
              best = s;
              bestId = namedId;
            }
          }
          held = { direction, named, id: bestId, similarity: best };
          this.closest.set(id, held);
        }
      }
      if (!held || held.direction !== direction) {
        let bestId: string | null = null;
        let best = -Infinity;
        for (const [namedId, d] of byId) {
          const s = dot(direction, d);
          if (s > best) {
            best = s;
            bestId = namedId;
          }
        }
        held = { direction, named, id: bestId, similarity: best };
        this.closest.set(id, held);
      }
      if (held.id !== null && held.similarity >= FACE_SUGGEST_THRESHOLD) {
        out.push({ named: held.id, unnamed: id, similarity: held.similarity });
      }
    }
    out.sort((a, b) => b.similarity - a.similarity || cmp(a.unnamed, b.unnamed));
    const facesOf = new Map(toMatch);
    return out.filter((s) => {
      const name = nameOf.get(s.named)!;
      return !facesOf.get(s.unnamed)!.faces.some((f) => p.blocked[f.id]?.includes(name));
    });
  }
}

function directionOf(of: FacesOf): Float32Array {
  return (of.direction ??= meanDirection(of.faces.map((f) => f.embedding)));
}

/** The loose faces as `listLoose` lists them: clearest first, equals in the people's and the faces' order. */
function looseOf(people: FacesOf[]): { faces: LooseFace[]; total: number } {
  let total = 0;
  const picked: { face: FaceRecord; person: number; at: number }[] = [];
  people.forEach((of, person) => {
    total += of.faces.length;
    of.byScore ??= [...of.faces].sort((a, b) => b.score - a.score);
    const upTo = Math.min(of.byScore.length, MAX_LOOSE);
    for (let at = 0; at < upTo; at++) picked.push({ face: of.byScore[at], person, at });
  });
  picked.sort((a, b) => b.face.score - a.face.score || a.person - b.person || a.at - b.at);
  return {
    faces: picked.slice(0, MAX_LOOSE).map(({ face: f }) => ({ faceId: f.id, uid: f.uid, box: f.box })),
    total,
  };
}

function sameFaces(a: FaceRecord[], b: FaceRecord[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
