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

// Themes: the photos of the library grouped by what they show (Food, Beach, Pets, ...), from
// the image vectors the search already holds and the text vectors of a fixed prompt table.
// The table, the prompts and the thresholds are the phone's, so both group a photo the same
// way. Nothing is scored twice: the result is kept per photo, and a pass scores only the photos
// it has not seen, so opening the Collection costs a key comparison once the library is done.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { EMBEDDING_DIM, SEARCH_MODEL_ID, encodeText, halfToFloatTable, type SearchCopy } from "./semantic.ts";
import { readSealedOrSetAside, storeDir, THEMES_DIR, writeSealedAtomic } from "./store.ts";

/**
 * Generation of the prompt table below. Raise it whenever a prompt, a category or its id
 * changes: the cached prompt vectors and every cached assignment are then dropped and made
 * again, so a stale assignment never outlives the table that produced it.
 */
export const THEME_TABLE_VERSION = 1;

/** A photo's best theme needs at least this cosine against one of the theme's prompts. */
export const THEME_TOP_MIN_SCORE = 0.2;
/** A second theme needs at least this cosine: two themes on one photo is a stronger claim. */
export const THEME_SECOND_MIN_SCORE = 0.235;
/** A second theme must also sit within this margin of the best one. */
export const THEME_SECOND_MARGIN = 0.015;

/** One theme: a stable id (the stored key, never reused), the slug its name is looked up by,
 *  and the prompts whose vectors stand for it. */
export type ThemeCategory = { id: number; slug: string; prompts: string[] };

export const THEME_TABLE: ThemeCategory[] = [
  { id: 0, slug: "food", prompts: ["a photo of food", "a photo of a meal on a plate", "a photo of a dish at a restaurant"] },
  { id: 1, slug: "pets", prompts: ["a photo of a dog", "a photo of a cat", "a photo of a pet"] },
  { id: 2, slug: "animals", prompts: ["a photo of a wild animal", "a photo of a bird", "a photo of farm animals"] },
  { id: 3, slug: "beach", prompts: ["a photo of a beach", "a photo of the sea", "a photo of people swimming"] },
  { id: 4, slug: "mountains", prompts: ["a photo of mountains", "a photo of hiking in the mountains"] },
  { id: 5, slug: "nature", prompts: ["a photo of a forest", "a photo of a landscape", "a photo of a lake"] },
  { id: 6, slug: "flowers", prompts: ["a photo of flowers", "a photo of a garden"] },
  { id: 7, slug: "city", prompts: ["a photo of a city street", "a photo of buildings", "a photo of a town square"] },
  { id: 8, slug: "night", prompts: ["a photo taken at night", "a photo of city lights at night"] },
  { id: 9, slug: "sunsets", prompts: ["a photo of a sunset", "a photo of a sunrise"] },
  {
    id: 10,
    slug: "sky",
    prompts: ["a photo of clouds in the sky", "a photo of a blue sky with clouds", "a photo of a cloudy sky"],
  },
  { id: 11, slug: "snow", prompts: ["a photo of snow", "a photo of winter"] },
  { id: 12, slug: "portraits", prompts: ["a portrait photo of a person", "a close-up photo of a face"] },
  { id: 13, slug: "group_photos", prompts: ["a group photo of people", "a photo of a crowd"] },
  {
    id: 14,
    slug: "celebrations",
    prompts: ["a photo of a birthday party", "a photo of a wedding", "a photo of a celebration"],
  },
  { id: 15, slug: "sports", prompts: ["a photo of people playing sports", "a photo of a football match"] },
  { id: 16, slug: "cars", prompts: ["a photo of a car", "a photo of vehicles"] },
  {
    id: 17,
    slug: "documents",
    prompts: ["a photo of a document", "a photo of a receipt", "a photo of text on paper"],
  },
  { id: 18, slug: "screenshots", prompts: ["a screenshot of a phone screen", "a screenshot of a website"] },
  { id: 19, slug: "drawings", prompts: ["a cartoon drawing", "an illustration", "a drawing"] },
];

const FLAT_PROMPTS: string[] = THEME_TABLE.flatMap((c) => c.prompts);

/** The 0 to 2 themes one photo carries: `first` with its score, then an optional `second`
 *  (-1 for none). A photo that clears no threshold is NO_THEME; it is still recorded, so it is
 *  not scored again. */
export type ThemeAssignment = { first: number; firstScore: number; second: number; secondScore: number };

export const NO_THEME: ThemeAssignment = { first: -1, firstScore: 0, second: -1, secondScore: 0 };

/**
 * Assigns a photo its themes from its per-theme `scores` (index = position in `ids`, the theme
 * ids). The best theme counts when it reaches the top threshold; one second theme counts when it
 * reaches the second threshold and sits within the margin of the best. Ties go to the lowest
 * index, so the result is deterministic.
 */
export function classifyThemeScores(scores: ArrayLike<number>, ids: ArrayLike<number>): ThemeAssignment {
  let bestIdx = -1;
  for (let i = 0; i < scores.length; i++) if (bestIdx < 0 || scores[i] > scores[bestIdx]) bestIdx = i;
  if (bestIdx < 0 || scores[bestIdx] < THEME_TOP_MIN_SCORE) return NO_THEME;
  const best = scores[bestIdx];
  let secondIdx = -1;
  for (let i = 0; i < scores.length; i++) {
    if (i === bestIdx) continue;
    const s = scores[i];
    if (s < THEME_SECOND_MIN_SCORE || s < best - THEME_SECOND_MARGIN) continue;
    if (secondIdx < 0 || s > scores[secondIdx]) secondIdx = i;
  }
  return secondIdx < 0
    ? { first: ids[bestIdx], firstScore: best, second: -1, secondScore: 0 }
    : { first: ids[bestIdx], firstScore: best, second: ids[secondIdx], secondScore: scores[secondIdx] };
}

/** The embedded prompts, one list of unit vectors per theme, in table order. */
export type PromptVectors = Float32Array[][];

/** A photo's unit `vector` against the prompts: each theme scores as its best prompt cosine. A
 *  vector of the wrong width lands in NO_THEME. */
export function classifyVector(vector: Float32Array, prompts: PromptVectors, ids: ArrayLike<number>): ThemeAssignment {
  const scores = new Float32Array(prompts.length);
  for (let c = 0; c < prompts.length; c++) {
    let best = -1;
    for (const p of prompts[c]) {
      if (p.length !== vector.length) continue;
      let dot = 0;
      for (let d = 0; d < p.length; d++) dot += p[d] * vector[d];
      if (dot > best) best = dot;
    }
    scores[c] = best;
  }
  return classifyThemeScores(scores, ids);
}

/** A stored half-precision vector as a unit float vector, or null for a zero one. */
export function unitFromHalves(halves: Uint16Array): Float32Array | null {
  const table = halfToFloatTable();
  const out = new Float32Array(halves.length);
  let norm = 0;
  for (let i = 0; i < halves.length; i++) {
    const v = table[halves[i]];
    out[i] = v;
    norm += v * v;
  }
  if (!(norm > 0)) return null;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

// ---- The cache on disk ----

const MAGIC = 0x50544d31;
const FORMAT = 1;

/** What a cache file was built from. A file is reused only when this matches the running build. */
export function cacheKey(): string {
  return `${SEARCH_MODEL_ID}|${THEME_TABLE_VERSION}`;
}

function header(key: string, count: number): Buffer {
  const k = Buffer.from(key, "utf8");
  const head = Buffer.alloc(14 + k.length);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(FORMAT, 4);
  head.writeUInt16LE(k.length, 8);
  k.copy(head, 10);
  head.writeUInt32LE(count, 10 + k.length);
  return head;
}

/** The offset after a header made for `key`, with the count it carries, or null when the
 *  buffer is of another layout or generation. */
function readHeader(buf: Buffer, key: string): { at: number; count: number } | null {
  if (buf.length < 14 || buf.readUInt32LE(0) !== MAGIC || buf.readUInt32LE(4) !== FORMAT) return null;
  const len = buf.readUInt16LE(8);
  if (buf.length < 14 + len || buf.toString("utf8", 10, 10 + len) !== key) return null;
  return { at: 14 + len, count: buf.readUInt32LE(10 + len) };
}

export function encodeAssignments(entries: Map<string, ThemeAssignment>, key = cacheKey()): Buffer {
  const parts: Buffer[] = [header(key, entries.size)];
  for (const [photo, a] of entries) {
    const name = Buffer.from(photo, "utf8");
    const row = Buffer.alloc(2 + name.length + 10);
    row.writeUInt16LE(name.length, 0);
    name.copy(row, 2);
    let o = 2 + name.length;
    row.writeInt8(a.first, o++);
    row.writeFloatLE(a.firstScore, o);
    o += 4;
    row.writeInt8(a.second, o++);
    row.writeFloatLE(a.secondScore, o);
    parts.push(row);
  }
  return Buffer.concat(parts);
}

/** The assignments in `buf`, or null when it was made for another model or table generation, or
 *  is cut short or corrupt. */
export function decodeAssignments(buf: Buffer, key = cacheKey()): Map<string, ThemeAssignment> | null {
  const head = readHeader(buf, key);
  if (!head) return null;
  const out = new Map<string, ThemeAssignment>();
  let o = head.at;
  try {
    for (let i = 0; i < head.count; i++) {
      const len = buf.readUInt16LE(o);
      o += 2;
      const photo = buf.toString("utf8", o, o + len);
      o += len;
      const first = buf.readInt8(o++);
      const firstScore = buf.readFloatLE(o);
      o += 4;
      const second = buf.readInt8(o++);
      const secondScore = buf.readFloatLE(o);
      o += 4;
      out.set(photo, { first, firstScore, second, secondScore });
    }
  } catch {
    return null;
  }
  return out;
}

export function encodePrompts(vectors: Float32Array[], key = cacheKey()): Buffer {
  const dim = vectors[0]?.length ?? 0;
  const dimBuf = Buffer.alloc(4);
  dimBuf.writeUInt32LE(dim, 0);
  const body = Buffer.alloc(vectors.length * dim * 4);
  vectors.forEach((v, i) => v.forEach((f, d) => body.writeFloatLE(f, (i * dim + d) * 4)));
  return Buffer.concat([header(key, vectors.length), dimBuf, body]);
}

export function decodePrompts(buf: Buffer, expectedCount: number, key = cacheKey()): Float32Array[] | null {
  const head = readHeader(buf, key);
  if (!head || head.count !== expectedCount || buf.length < head.at + 4) return null;
  const dim = buf.readUInt32LE(head.at);
  if (dim <= 0 || buf.length !== head.at + 4 + expectedCount * dim * 4) return null;
  return Array.from({ length: expectedCount }, (_, i) => {
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = buf.readFloatLE(head.at + 4 + (i * dim + d) * 4);
    return v;
  });
}

// ---- The index ----

/** Photos scored between two yields to the sidecar's other work. */
const SLICE = 300;
/** A first pass over a large library is written to disk every this many photos, so an
 *  interrupted one keeps most of its work. */
const SAVE_EVERY = 20_000;

/** One theme as the window shows it: its id and slug, and the photos (Drive link ids) that
 *  carry it, best score first. */
export type ThemeGroup = { id: number; slug: string; keys: string[] };

export type ThemeSnapshot = { syncing: boolean; themes: ThemeGroup[] };

/** What the index reads and writes beyond its own logic, replaceable in a test. */
export type ThemeDeps = {
  embed: (text: string) => Promise<Float32Array | null>;
  dir: () => string;
  yieldNow: () => Promise<void>;
};

const realDeps: ThemeDeps = {
  embed: encodeText,
  dir: () => join(storeDir(), THEMES_DIR),
  yieldNow: () => new Promise((r) => setImmediate(r)),
};

/**
 * The classification of the library. A pass compares the keys of the search copies against the
 * photos already classified, scores only the new ones, and forgets the removed ones; one runs at
 * a time, in slices that let the sidecar answer in between.
 */
export class ThemeIndex {
  private entries: Map<string, ThemeAssignment> | null = null;
  private entriesDir = "";
  private prompts: PromptVectors | null = null;
  private running = false;
  private wanted: SearchCopy[] | null = null;
  private snapshotCache: { version: number; value: ThemeGroup[] } | null = null;
  private version = 0;
  private readonly ids = THEME_TABLE.map((c) => c.id);

  constructor(private readonly deps: ThemeDeps = realDeps) {}

  /** Forgets everything held in memory, for a sign-out or an account switch. */
  reset(): void {
    this.entries = null;
    this.entriesDir = "";
    this.prompts = null;
    this.wanted = null;
    this.snapshotCache = null;
    this.version++;
  }

  /** Asks for the classification to cover `copies`, and answers what it holds now. Starts a pass
   *  in the background when there is anything new; a pass already running picks the latest ask up. */
  request(copies: SearchCopy[]): ThemeSnapshot {
    this.load();
    if (this.entries) {
      this.wanted = copies;
      if (!this.running && this.needsWork(copies)) {
        this.running = true;
        void this.run().finally(() => {
          this.running = false;
        });
      }
    }
    return this.snapshot();
  }

  /** Resolves when no pass is running. */
  async settled(): Promise<void> {
    while (this.running) await this.deps.yieldNow();
  }

  snapshot(): ThemeSnapshot {
    return { syncing: this.running, themes: this.groups() };
  }

  private load(): void {
    let dir: string;
    try {
      dir = this.deps.dir();
    } catch {
      return;
    }
    if (this.entries && this.entriesDir === dir) return;
    const blob = readSealedOrSetAside(join(dir, "assign.enc"));
    this.entriesDir = dir;
    this.prompts = null;
    this.entries = (blob && decodeAssignments(blob)) || new Map();
    this.snapshotCache = null;
    this.version++;
  }

  private needsWork(copies: SearchCopy[]): boolean {
    const entries = this.entries;
    if (!entries) return false;
    const keys = new Set<string>();
    for (const copy of copies) for (const k of copy.keys) keys.add(k);
    if (keys.size !== entries.size) return true;
    for (const k of keys) if (!entries.has(k)) return true;
    return false;
  }

  private async promptVectors(): Promise<PromptVectors | null> {
    if (this.prompts) return this.prompts;
    const file = join(this.deps.dir(), "prompts.enc");
    let flat: Float32Array[] | null = null;
    const blob = readSealedOrSetAside(file);
    if (blob) flat = decodePrompts(blob, FLAT_PROMPTS.length);
    if (!flat) {
      const made: Float32Array[] = [];
      for (const text of FLAT_PROMPTS) {
        const v = await this.deps.embed(text);
        if (!v) return null;
        made.push(v);
      }
      flat = made;
      try {
        mkdirSync(this.deps.dir(), { recursive: true });
        writeSealedAtomic(file, encodePrompts(flat));
      } catch {
        /* the vectors are made again next time */
      }
    }
    const all = flat;
    let at = 0;
    this.prompts = THEME_TABLE.map((c) => c.prompts.map(() => all[at++]));
    return this.prompts;
  }

  private save(): void {
    if (!this.entries) return;
    try {
      mkdirSync(this.deps.dir(), { recursive: true });
      writeSealedAtomic(join(this.deps.dir(), "assign.enc"), encodeAssignments(this.entries));
    } catch {
      /* kept in memory, written by the next pass */
    }
  }

  private async run(): Promise<void> {
    try {
      while (this.wanted) {
        const copies = this.wanted;
        this.wanted = null;
        await this.pass(copies);
      }
    } catch (e) {
      process.stderr.write(`[themes] a pass failed: ${(e as Error).name}\n`);
    }
  }

  private async pass(copies: SearchCopy[]): Promise<void> {
    const entries = this.entries;
    const dirAtStart = this.entriesDir;
    if (!entries) return;
    // The first copy holding a photo supplies its vector.
    const source = new Map<string, { copy: SearchCopy; at: number }>();
    for (const copy of copies) {
      if (copy.vectors.length !== copy.keys.length * EMBEDDING_DIM) continue;
      copy.keys.forEach((key, at) => {
        if (!source.has(key)) source.set(key, { copy, at });
      });
    }
    let changed = false;
    for (const key of [...entries.keys()]) {
      if (!source.has(key)) {
        entries.delete(key);
        changed = true;
      }
    }
    const pending = [...source.keys()].filter((k) => !entries.has(k));
    if (changed) this.version++;
    const prompts = pending.length > 0 ? await this.promptVectors() : null;
    if (!prompts) {
      if (changed) this.save();
      return;
    }
    let sinceSave = 0;
    for (let i = 0; i < pending.length; i++) {
      if (this.entries !== entries || this.entriesDir !== dirAtStart) return;
      const { copy, at } = source.get(pending[i])!;
      const unit = unitFromHalves(copy.vectors.subarray(at * EMBEDDING_DIM, (at + 1) * EMBEDDING_DIM));
      entries.set(pending[i], unit ? classifyVector(unit, prompts, this.ids) : NO_THEME);
      changed = true;
      if (++sinceSave >= SAVE_EVERY) {
        sinceSave = 0;
        this.save();
      }
      if ((i + 1) % SLICE === 0) {
        this.version++;
        await this.deps.yieldNow();
      }
    }
    this.version++;
    if (changed) this.save();
  }

  private groups(): ThemeGroup[] {
    if (this.snapshotCache?.version === this.version) return this.snapshotCache.value;
    const scored = new Map<number, [string, number][]>();
    const add = (id: number, key: string, score: number) => {
      let list = scored.get(id);
      if (!list) scored.set(id, (list = []));
      list.push([key, score]);
    };
    for (const [key, a] of this.entries ?? []) {
      if (a.first >= 0) add(a.first, key, a.firstScore);
      if (a.second >= 0) add(a.second, key, a.secondScore);
    }
    const value: ThemeGroup[] = [];
    for (const c of THEME_TABLE) {
      const list = scored.get(c.id);
      if (!list) continue;
      list.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
      value.push({ id: c.id, slug: c.slug, keys: list.map((e) => e[0]) });
    }
    this.snapshotCache = { version: this.version, value };
    return value;
  }
}

export const themeIndex = new ThemeIndex();
