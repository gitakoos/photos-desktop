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

// A date typed into the search, by the Android app's rules: a month and a year in either
// order at the end of the query ("2026 january", "jan 2026"), or either one alone. A month
// is its whole name, its usual short form or the first three letters of its name in the
// app's language, naming that one month alone ("janu" is no month). In the app's other
// languages a whole name or a short form counts from four letters, so a short word of one
// language is not taken for a month of another.

export type DateQuery = {
  year: number | null;
  /** 1..12, or null for the whole year. */
  month: number | null;
  /** The query with the date's words taken off, for the text search. */
  rest: string;
};

const LANGUAGES = ["en", "cs", "de", "es", "fr", "it", "hu", "nl", "pl", "sk", "sl"];
const MIN_MONTH_CHARS = 3;
const MIN_OTHER_LANGUAGE_CHARS = 4;
const FIRST_YEAR = 1900;
const LAST_YEAR = 2100;

export const foldWord = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/\.+$/, "")
    .trim();

type Names = { long: string[]; short: string[] };
const namesCache = new Map<string, Names>();

/** The twelve month names of [lang], whole and short, folded like the query. */
function monthNames(lang: string): Names {
  let names = namesCache.get(lang);
  if (!names) {
    const long = new Intl.DateTimeFormat(lang, { month: "long" });
    const short = new Intl.DateTimeFormat(lang, { month: "short" });
    const months = Array.from({ length: 12 }, (_, m) => new Date(2001, m, 15));
    names = { long: months.map((d) => foldWord(long.format(d))), short: months.map((d) => foldWord(short.format(d))) };
    namesCache.set(lang, names);
  }
  return names;
}

function yearOf(word: string): number | null {
  if (!/^\d{4}$/.test(word)) return null;
  const year = Number(word);
  return year >= FIRST_YEAR && year <= LAST_YEAR ? year : null;
}

/** The month (1..12) a folded word names, or null. */
export function monthOf(word: string, lang: string): number | null {
  if (word.length < MIN_MONTH_CHARS) return null;
  const own = monthNames(lang);
  const hits = own.long
    .map((name, m) => (word === name || word === own.short[m] || word === name.slice(0, MIN_MONTH_CHARS) ? m : -1))
    .filter((m) => m >= 0);
  if (hits.length === 1) return hits[0] + 1;
  if (hits.length > 1 || word.length < MIN_OTHER_LANGUAGE_CHARS) return null;
  const other = new Set<number>();
  for (const l of LANGUAGES) {
    if (l === lang) continue;
    const names = monthNames(l);
    names.long.forEach((name, m) => {
      if (word === name || word === names.short[m]) other.add(m);
    });
  }
  return other.size === 1 ? [...other][0] + 1 : null;
}

/** The date at the end of [query], read in [lang], or null when it ends in none. */
export function parseDateQuery(query: string, lang: string): DateQuery | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const folded = words.map(foldWord);
  const last = folded[folded.length - 1];
  const before = folded.length > 1 ? folded[folded.length - 2] : null;
  const rest = (taken: number) => words.slice(0, words.length - taken).join(" ");

  const year = yearOf(last);
  if (year !== null) {
    const month = before !== null ? monthOf(before, lang) : null;
    return { year, month, rest: rest(month !== null ? 2 : 1) };
  }
  const month = monthOf(last, lang);
  if (month === null) return null;
  const yearBefore = before !== null ? yearOf(before) : null;
  return { year: yearBefore, month, rest: rest(yearBefore !== null ? 2 : 1) };
}

/** Whether a photo taken at [time] (ms, local) falls in [date]. A month without a year is
 *  that month of every year. */
export function inDate(time: number, date: DateQuery): boolean {
  if (!(time > 0)) return false;
  const d = new Date(time);
  if (date.year !== null && d.getFullYear() !== date.year) return false;
  if (date.month !== null && d.getMonth() + 1 !== date.month) return false;
  return true;
}

/** The date as the pill and the title read it: "2026", "January 2026" or "January". */
export function dateLabel(date: DateQuery, lang: string): string {
  if (date.month === null) return String(date.year ?? "");
  const at = new Date(date.year ?? 2001, date.month - 1, 15);
  if (date.year === null) {
    const name = new Intl.DateTimeFormat(lang, { month: "long" }).format(at);
    return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
  }
  const text = new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" }).format(at);
  return text.charAt(0).toLocaleUpperCase(lang) + text.slice(1);
}
