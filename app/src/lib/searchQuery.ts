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

// The words of a search, by the Android app's rules: a comma separates alternatives, a space
// separates words that must all match, and a quoted span is one term matched exactly as typed.

import { parseDateQuery, type DateQuery } from "./dateQuery";

const MARKS = "\"“”„«»";

/** Joins the fields of a photo's text: no typed term holds it, so a phrase never spans two fields. */
export const FIELD = "\u0000";

export const isMark = (c: string): boolean => MARKS.includes(c);

export const hasQuote = (q: string): boolean => [...q].some(isMark);

/**
 * The search results' title: the query in the language's quote marks, or as typed when it holds
 * quote marks of its own, so they show once and never inside another pair.
 */
export const resultsTitle = (query: string, quoted: (query: string) => string): string =>
  hasQuote(query) ? query : quoted(query);

/** `q` with the quote marks removed. */
export const stripped = (q: string): string => [...q].filter((c) => !isMark(c)).join("");

/** Lower-case and without accents, so "jose" finds "José". */
export const foldText = (text: string): string =>
  text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ı/g, "i");

/**
 * The query's alternatives, each the folded terms that must all match: commas outside quotes
 * separate alternatives, spaces outside quotes separate words, and a quoted span is one term.
 */
export function alternatives(q: string): string[][] {
  const out: string[][] = [];
  let terms: string[] = [];
  let buf = "";
  let quoted = false;
  const flush = () => {
    const term = quoted ? buf.trim() : buf;
    if (term.trim()) terms.push(foldText(term));
    buf = "";
  };
  for (const c of q.trim()) {
    if (isMark(c)) {
      flush();
      quoted = !quoted;
    } else if (quoted) buf += c;
    else if (c === ",") {
      flush();
      if (terms.length > 0) out.push(terms);
      terms = [];
    } else if (/\s/.test(c)) flush();
    else buf += c;
  }
  flush();
  if (terms.length > 0) out.push(terms);
  return out;
}

/** Whether every term of one of `alts` is found, each within one of the folded `fields`. */
export function matchesAlternatives(alts: string[][], fields: readonly (string | undefined)[]): boolean {
  return alts.some((terms) => terms.every((term) => fields.some((f) => f !== undefined && f.includes(term))));
}

/** A photo's file name and media type folded into one field-joined text, as the search matches it. */
export const metaText = (name: string, mediaType: string | null | undefined): string =>
  `${foldText(name)}${FIELD}${foldText(mediaType ?? "")}`;

/**
 * The part of `q` a date or category pill may read: all of it without quotes, the words after the
 * last closing mark (less a word glued to that mark), and nothing while a quote is still open.
 */
export function pillText(q: string): string {
  let last = -1;
  let marks = 0;
  for (let i = 0; i < q.length; i++) {
    if (isMark(q[i])) {
      last = i;
      marks++;
    }
  }
  if (last < 0) return q;
  if (marks % 2 !== 0) return "";
  const tail = q.slice(last + 1);
  return tail === "" || /^\s/.test(tail) ? tail : tail.replace(/^\S*/, "");
}

/** `q` without its last `count` words, read from the end so a quoted span before them stays as typed. */
export function dropTrailingWords(q: string, count: number): string {
  let end = q.trimEnd().length;
  for (let n = 0; n < count; n++) {
    while (end > 0 && !/\s/.test(q[end - 1])) end--;
    while (end > 0 && /\s/.test(q[end - 1])) end--;
  }
  return q.slice(0, end);
}

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * What is left of `q` once a pill takes the end of its readable part `readable`: the pill's own
 * `readableRest` when `q` has no quote, else `q` less as many words as the pill took, so the
 * quoted text stays as typed.
 */
export function restAfterPill(q: string, readable: string, readableRest: string): string {
  if (!hasQuote(q)) return readableRest;
  return dropTrailingWords(q, wordCount(readable) - wordCount(readableRest));
}

/** The date at the end of `q` outside quotes, its `rest` the query without the date's words. */
export function dateAtEnd(q: string, lang: string): DateQuery | null {
  const readable = pillText(q);
  const date = parseDateQuery(readable, lang);
  return date ? { ...date, rest: restAfterPill(q, readable, date.rest) } : null;
}
