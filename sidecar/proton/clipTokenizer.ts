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

// The byte-level BPE tokenizer the CLIP text encoder expects: a port of open_clip's
// SimpleTokenizer, the same one the Android app runs, so a query here lands in the space the
// phone's image embeddings were made in. A divergence of a single id puts a query elsewhere
// and the search returns noise, so the tests pin the ids to open_clip's own output.

/** Token count the CLIP text encoder reads. */
export const CONTEXT_LENGTH = 77;
const END_OF_WORD = "</w>";
const START_TOKEN = "<|startoftext|>";
const END_TOKEN = "<|endoftext|>";

/** One past the last vocabulary line that is a merge: 49152 - 256 - 2 + 1. */
const MERGES_END_EXCLUSIVE = 49152 - 256 - 2 + 1;

/** open_clip's split: the special tokens whole, English contractions, letter runs, single
 *  digits, and runs of anything that is neither space, letter nor number. */
const TOKEN_PATTERN =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const MAX_ENTITY_LENGTH = 32;

/** open_clip's bytes_to_unicode: each byte value to a printable character, and the 256
 *  characters in byte-token order. */
function bytesToUnicode(): { encoder: string[]; values: string[] } {
  const bytes: number[] = [];
  for (let c = 0x21; c <= 0x7e; c++) bytes.push(c);
  for (let c = 0xa1; c <= 0xac; c++) bytes.push(c);
  for (let c = 0xae; c <= 0xff; c++) bytes.push(c);
  const printable = new Set(bytes);
  const codes = [...bytes];
  let next = 0;
  for (let b = 0; b <= 0xff; b++) {
    if (!printable.has(b)) {
      bytes.push(b);
      codes.push(0x100 + next);
      next++;
    }
  }
  const values = codes.map((c) => String.fromCodePoint(c));
  const encoder = new Array<string>(256);
  bytes.forEach((b, i) => (encoder[b] = values[i]));
  return { encoder, values };
}

function decodeEntity(body: string): string | null {
  if (!body) return null;
  if (body[0] === "#") {
    const hex = body.length > 1 && (body[1] === "x" || body[1] === "X");
    const digits = hex ? body.slice(2) : body.slice(1);
    if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return null;
    const code = parseInt(digits, hex ? 16 : 10);
    if (!(code >= 0 && code <= 0x10ffff)) return null;
    return String.fromCodePoint(code);
  }
  return NAMED_ENTITIES[body] ?? null;
}

/** The entities the reference decodes: the XML ones and numeric character references. */
function htmlUnescape(text: string): string {
  if (!text.includes("&")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "&") {
      out += ch;
      i++;
      continue;
    }
    const semicolon = text.indexOf(";", i + 1);
    const decoded =
      semicolon >= i + 2 && semicolon <= i + MAX_ENTITY_LENGTH ? decodeEntity(text.slice(i + 1, semicolon)) : null;
    if (decoded !== null) {
      out += decoded;
      i = semicolon + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export class ClipTokenizer {
  private readonly byteEncoder: string[];
  private readonly encoder = new Map<string, number>();
  private readonly ranks = new Map<string, number>();
  private readonly cache = new Map<string, string>([
    [START_TOKEN, START_TOKEN],
    [END_TOKEN, END_TOKEN],
  ]);
  private readonly startOfText: number;
  private readonly endOfText: number;

  /** From the decompressed open_clip vocabulary: a version line, then the ranked merges. */
  constructor(vocabulary: string) {
    const { encoder: byteEncoder, values } = bytesToUnicode();
    this.byteEncoder = byteEncoder;
    const lines = vocabulary.split("\n");
    if (lines.length < MERGES_END_EXCLUSIVE) throw new Error("invalid clip vocabulary");
    const merges: [string, string][] = [];
    for (let i = 1; i < MERGES_END_EXCLUSIVE; i++) {
      const parts = lines[i].split(/\s+/).filter(Boolean);
      if (parts.length >= 2) merges.push([parts[0], parts[1]]);
    }
    const vocab = [...values, ...values.map((v) => v + END_OF_WORD), ...merges.map(([a, b]) => a + b), START_TOKEN, END_TOKEN];
    vocab.forEach((token, id) => this.encoder.set(token, id));
    merges.forEach(([a, b], rank) => this.ranks.set(`${a} ${b}`, rank));
    this.startOfText = this.encoder.get(START_TOKEN)!;
    this.endOfText = this.encoder.get(END_TOKEN)!;
  }

  /** The [CONTEXT_LENGTH] ids for `text`: start, the text's ids (cut to fit), end, zeros. */
  encode(text: string): Int32Array {
    const ids = new Int32Array(CONTEXT_LENGTH);
    const body = this.bpeEncode(text);
    const kept = Math.min(body.length, CONTEXT_LENGTH - 2);
    ids[0] = this.startOfText;
    for (let i = 0; i < kept; i++) ids[i + 1] = body[i];
    ids[kept + 1] = this.endOfText;
    return ids;
  }

  private bpeEncode(text: string): number[] {
    const clean = htmlUnescape(htmlUnescape(text)).trim().replace(/\s+/g, " ").trim().toLowerCase();
    const out: number[] = [];
    for (const match of clean.matchAll(TOKEN_PATTERN)) {
      let encoded = "";
      for (const byte of Buffer.from(match[0], "utf8")) encoded += this.byteEncoder[byte];
      for (const piece of this.bpe(encoded).split(" ")) {
        const id = this.encoder.get(piece);
        if (id === undefined) throw new Error("a token missing from the vocabulary");
        out.push(id);
      }
    }
    return out;
  }

  /** The space-joined merge of one byte-encoded token, by the merges' ranks. */
  private bpe(token: string): string {
    const cached = this.cache.get(token);
    if (cached !== undefined) return cached;
    let word = [...token];
    if (word.length === 0) return "";
    word[word.length - 1] += END_OF_WORD;
    if (word.length < 2) return token + END_OF_WORD;
    for (;;) {
      let best: [string, string] | null = null;
      let bestRank = Infinity;
      for (let i = 0; i + 1 < word.length; i++) {
        const rank = this.ranks.get(`${word[i]} ${word[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = [word[i], word[i + 1]];
        }
      }
      if (!best) break;
      const [first, second] = best;
      const merged: string[] = [];
      for (let i = 0; i < word.length; ) {
        if (word[i] === first && i + 1 < word.length && word[i + 1] === second) {
          merged.push(first + second);
          i += 2;
        } else {
          merged.push(word[i]);
          i++;
        }
      }
      word = merged;
      if (word.length === 1) break;
    }
    const result = word.join(" ");
    this.cache.set(token, result);
    return result;
  }
}
