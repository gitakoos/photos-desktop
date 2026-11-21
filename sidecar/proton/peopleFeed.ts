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

// The people list as the window reads it: the whole list once, then only what changed since the
// read before. The sidecar keeps the list it last handed out and notes, per person, when it
// changed; the window keeps what it was given and applies each answer on top. Both halves live
// here, with nothing of Node's, so the window takes the same code.

export type FeedBox = [number, number, number, number];

/** A person as the window shows them. */
export type FeedPerson = {
  id: string;
  name: string | null;
  isOther: boolean;
  /** The photos the person is in. */
  uids: string[];
  cover: { uid: string; box: FeedBox } | null;
};

/** The whole people list, as `listPeople` makes it. */
export type PeopleList = {
  named: FeedPerson[];
  unnamed: FeedPerson[];
  hidden: FeedPerson[];
  leftover: number;
  suggestions: { unnamed: string; named: string; similarity: number }[];
  loose: { faces: { faceId: string; uid: string; box: FeedBox }[]; total: number };
};

/** Which list a person was handed out in, and its order there. */
export type PeopleOrder = { named: string[]; unnamed: string[]; hidden: string[] };

/** What the list holds besides its people. */
type Rest = Pick<PeopleList, "leftover" | "suggestions" | "loose">;

/** Where a reader stands: the run of the sidecar that answered, and the change it was last given. */
export type PeopleToken = { epoch: string; seq: number };

/**
 * An answer to the window: the whole list, or what changed since `base` (the people changed or
 * added, in full; those gone, by id; the order and the rest only when they changed).
 */
export type PeopleAnswer =
  | { full: true; epoch: string; seq: number; people: PeopleList }
  | {
      full: false;
      epoch: string;
      seq: number;
      base: number;
      changed: FeedPerson[];
      removed: string[];
      order?: PeopleOrder;
      rest?: Rest;
    };

/** People gone longer ago than this many are forgotten; a reader from before them is answered in full. */
const MAX_REMOVED = 4_000;

function sameUids(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function samePerson(a: FeedPerson, b: FeedPerson): boolean {
  if (a === b) return true;
  if (a.name !== b.name || a.isOther !== b.isOther || !sameUids(a.uids, b.uids)) return false;
  if (!a.cover || !b.cover) return a.cover === b.cover;
  return a.cover.uid === b.cover.uid && a.cover.box.every((v, i) => v === b.cover!.box[i]);
}

function sameIds(a: string[], b: string[]): boolean {
  return sameUids(a, b);
}

const orderOf = (list: PeopleList): PeopleOrder => ({
  named: list.named.map((x) => x.id),
  unnamed: list.unnamed.map((x) => x.id),
  hidden: list.hidden.map((x) => x.id),
});

const restOf = (list: PeopleList): Rest => ({ leftover: list.leftover, suggestions: list.suggestions, loose: list.loose });

/** The sidecar's half: the list last handed out, and when each part of it changed. */
export class PeopleFeed {
  private seq = 0;
  /** A reader whose change is older than this is answered in full. */
  private floor = 0;
  private people = new Map<string, FeedPerson>();
  private changedAt = new Map<string, number>();
  private removedAt = new Map<string, number>();
  private order: PeopleOrder = { named: [], unnamed: [], hidden: [] };
  private orderAt = 0;
  private rest: Rest = { leftover: 0, suggestions: [], loose: { faces: [], total: 0 } };
  private restText = JSON.stringify(this.rest);
  private restAt = 0;

  constructor(readonly epoch: string) {}

  /** Takes in the list as it is now; anything different from the one held is a new change. */
  update(list: PeopleList): void {
    const next = this.seq + 1;
    let changed = false;
    const seen = new Set<string>();
    for (const person of [...list.named, ...list.unnamed, ...list.hidden]) {
      seen.add(person.id);
      const held = this.people.get(person.id);
      if (held && samePerson(held, person)) continue;
      this.people.set(person.id, person);
      this.changedAt.set(person.id, next);
      this.removedAt.delete(person.id);
      changed = true;
    }
    for (const id of [...this.people.keys()]) {
      if (seen.has(id)) continue;
      this.people.delete(id);
      this.changedAt.delete(id);
      this.removedAt.set(id, next);
      changed = true;
    }
    const order = orderOf(list);
    if (!sameIds(order.named, this.order.named) || !sameIds(order.unnamed, this.order.unnamed) || !sameIds(order.hidden, this.order.hidden)) {
      this.order = order;
      this.orderAt = next;
      changed = true;
    }
    const rest = restOf(list);
    const restText = JSON.stringify(rest);
    if (restText !== this.restText) {
      this.rest = rest;
      this.restText = restText;
      this.restAt = next;
      changed = true;
    }
    if (!changed) return;
    this.seq = next;
    if (this.removedAt.size > MAX_REMOVED) this.forgetOldRemovals();
  }

  /** The answer for a reader at `since`: what changed after it, or the whole list when that cannot be told. */
  answer(since?: PeopleToken | null): PeopleAnswer {
    const { epoch, seq } = this;
    if (!since || since.epoch !== epoch || !Number.isInteger(since.seq) || since.seq < this.floor || since.seq > seq) {
      return { full: true, epoch, seq, people: this.list() };
    }
    const base = since.seq;
    const changed: FeedPerson[] = [];
    for (const [id, at] of this.changedAt) if (at > base) changed.push(this.people.get(id)!);
    const removed: string[] = [];
    for (const [id, at] of this.removedAt) if (at > base) removed.push(id);
    const out: PeopleAnswer = { full: false, epoch, seq, base, changed, removed };
    if (this.orderAt > base) out.order = this.order;
    if (this.restAt > base) out.rest = this.rest;
    return out;
  }

  private list(): PeopleList {
    const pick = (ids: string[]) => ids.map((id) => this.people.get(id)!);
    return { named: pick(this.order.named), unnamed: pick(this.order.unnamed), hidden: pick(this.order.hidden), ...this.rest };
  }

  private forgetOldRemovals(): void {
    const times = [...this.removedAt.values()].sort((a, b) => a - b);
    const cutoff = times[times.length - MAX_REMOVED / 2];
    for (const [id, at] of this.removedAt) if (at < cutoff) this.removedAt.delete(id);
    this.floor = cutoff - 1;
  }
}

/** The window's half: the list it was given, and where it stands. */
export type HeldPeople = {
  epoch: string;
  seq: number;
  people: Map<string, FeedPerson>;
  order: PeopleOrder;
  rest: Rest;
  list: PeopleList;
};

/** Where `held` stands, to send with the next read; none for a first read. */
export function tokenOf(held: HeldPeople | null): PeopleToken | null {
  return held ? { epoch: held.epoch, seq: held.seq } : null;
}

/**
 * The list after `answer`, on top of what was held. The same object when nothing changed, and the
 * same person objects for the people that did not, so the views reading them do not draw again.
 * Null when the answer does not follow on from what is held: the list is then read in full.
 */
export function applyPeopleAnswer(held: HeldPeople | null, answer: PeopleAnswer): HeldPeople | null {
  if (answer.full) {
    const list = answer.people;
    const people = new Map<string, FeedPerson>();
    for (const person of [...list.named, ...list.unnamed, ...list.hidden]) people.set(person.id, person);
    return { epoch: answer.epoch, seq: answer.seq, people, order: orderOf(list), rest: restOf(list), list };
  }
  if (!held || held.epoch !== answer.epoch || held.seq !== answer.base) return null;
  if (answer.changed.length === 0 && answer.removed.length === 0 && !answer.order && !answer.rest) {
    return answer.seq === held.seq ? held : { ...held, seq: answer.seq };
  }
  const people = new Map(held.people);
  for (const id of answer.removed) people.delete(id);
  for (const person of answer.changed) people.set(person.id, person);
  const order = answer.order ?? held.order;
  const rest = answer.rest ?? held.rest;
  const pick = (ids: string[]) => ids.map((id) => people.get(id));
  const named = pick(order.named);
  const unnamed = pick(order.unnamed);
  const hidden = pick(order.hidden);
  if ([named, unnamed, hidden].some((xs) => xs.includes(undefined))) return null;
  const list: PeopleList = {
    named: named as FeedPerson[],
    unnamed: unnamed as FeedPerson[],
    hidden: hidden as FeedPerson[],
    ...rest,
  };
  return { epoch: answer.epoch, seq: answer.seq, people, order, rest, list };
}
