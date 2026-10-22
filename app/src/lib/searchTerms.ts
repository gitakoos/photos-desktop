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

// Words typed into the search that name something the photos can be narrowed by: a category
// ("screenshots"), a type ("videos"), a person or a label. As on Android, a whole name at the
// end of the text becomes a pill once the typing pauses, and the start of one is offered.

import { foldWord } from "./dateQuery";

export type SearchTerm = {
  /** What picking it does, named: "cat:screen", "type:video", "people:Anna". */
  key: string;
  /** How the pill reads. */
  label: string;
  /** The folded spellings that name it whole. */
  forms: string[];
};

/** Folds a phrase as the search does, word by word: case and accents aside. */
export const foldPhrase = (text: string): string =>
  text
    .split(/\s+/)
    .map(foldWord)
    .filter(Boolean)
    .join(" ");

/**
 * The spellings a label is typed as: the whole label, and its singular where the language
 * makes a plural with an ending that comes off cleanly ("videos" -> "video", Hungarian
 * "videók" -> "videó", "képernyőképek" -> "képernyőkép").
 */
export function wordForms(label: string, lang: string): string[] {
  const whole = foldPhrase(label);
  const forms = new Set([whole]);
  if (lang === "hu") {
    // Before folding, while the vowels still say which they are: a short linking vowel
    // after a consonant goes with the -k ("képek", "sorozatok"), a stem's own long vowel
    // stays ("videók", "portrék").
    const lower = label.trim().toLocaleLowerCase("hu");
    const linked = /^(.{2,}[^aáeéiíoóöőuúüűy\s])[aeoö]k$/u.exec(lower);
    const plain = /^(.{3,})k$/u.exec(lower);
    const stem = linked?.[1] ?? plain?.[1];
    if (stem) forms.add(foldPhrase(stem));
  } else if (/^.{3,}s$/.test(whole)) {
    forms.add(whole.slice(0, -1));
  }
  return [...forms];
}

/** The longest run of words at the end of `text` that names a term whole, and the text
 *  before it, or null. At most four words, enough for a full name. */
export function termAtEnd(text: string, terms: SearchTerm[]): { term: SearchTerm; rest: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    const tail = foldPhrase(words.slice(-n).join(" "));
    const term = terms.find((t) => t.forms.includes(tail));
    if (term) return { term, rest: words.slice(0, -n).join(" ") };
  }
  return null;
}

/**
 * Terms the end of `text` is the start of, the closest first: the last word, or the last
 * words, typed so far of a name. A name needs two letters, anything else three.
 */
export function termsStartedAtEnd(
  text: string,
  terms: SearchTerm[],
  max = 6,
): { term: SearchTerm; rest: string }[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out: { term: SearchTerm; rest: string }[] = [];
  const taken = new Set<string>();
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    const tail = foldPhrase(words.slice(-n).join(" "));
    for (const term of terms) {
      if (taken.has(term.key)) continue;
      const min = term.key.startsWith("people:") || term.key.startsWith("labels:") ? 2 : 3;
      if (tail.length < min) continue;
      if (term.forms.some((f) => f.startsWith(tail) || f.split(" ").some((w) => w.startsWith(tail) && n === 1))) {
        taken.add(term.key);
        out.push({ term, rest: words.slice(0, -n).join(" ") });
      }
    }
  }
  return out.slice(0, max);
}
