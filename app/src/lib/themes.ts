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

// Themes (Food, Beach, Pets, ...): the sidecar groups the library by what the photos show; this
// side names the groups, finds the one a typed query names, and lays them out as cards.

import type { LibraryEntry } from "../components/Library";
import { cs } from "./locales/cs";
import { de } from "./locales/de";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { hu } from "./locales/hu";
import { it } from "./locales/it";
import { nl } from "./locales/nl";
import { pl } from "./locales/pl";
import { sk } from "./locales/sk";
import { sl } from "./locales/sl";

/** One theme as the sidecar answers it: its photos by Drive link id, best score first. */
export type ThemeGroup = { id: number; slug: string; keys: string[] };

/** What the `themes` call answers. */
export type ThemesReply = { syncing: boolean; themes: ThemeGroup[] };

/** The most themes the Collection shows in its row; the page behind the title shows all. */
export const THEME_ROW_LIMIT = 12;

/** The dictionary key a theme's name is looked up by. */
export const themeNameKey = (slug: string): string => `theme.${slug}`;

/** Lowercased, diacritic-folded form a typed query and a theme name are compared in. */
export function foldThemeText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().trim();
}

const NAME_PREFIX = "theme.";

/** Every theme's name in every shipped language, folded, by slug. */
export const THEME_NAMES: Map<string, Set<string>> = (() => {
  const out = new Map<string, Set<string>>();
  for (const dict of [en, cs, de, es, fr, hu, it, nl, pl, sk, sl] as Record<string, string>[]) {
    for (const [key, value] of Object.entries(dict)) {
      if (!key.startsWith(NAME_PREFIX)) continue;
      const slug = key.slice(NAME_PREFIX.length);
      let names = out.get(slug);
      if (!names) out.set(slug, (names = new Set()));
      names.add(foldThemeText(value));
    }
  }
  return out;
})();

/**
 * The theme a typed `query` names, or null. A query matches a name exactly or as a simple plural
 * of it ("beach", "beaches"; "flower", "flowers"); under three characters it never matches, so a
 * stray letter does not jump to a theme.
 */
export function matchTheme(query: string, names: Map<string, Set<string>> = THEME_NAMES): string | null {
  const q = foldThemeText(query);
  if (q.length < 3) return null;
  for (const [slug, set] of names) {
    for (const n of set) {
      if (q === n || q + "s" === n || q === n + "s" || q === n + "es") return slug;
      if (n.length > 1 && n.endsWith("s") && q === n.slice(0, -1)) return slug;
    }
  }
  return null;
}

/**
 * Whether a whole search term at the end of the text may become its pill by itself. A category
 * (`cat:` key) whose name is also a theme's (Portraits, Screenshots) stays text while the theme is
 * named, or its pill would narrow the theme's photos away; picking it from the suggestions still works.
 */
export function pillsByItself(termKey: string, themeSlug: string | null): boolean {
  return !(themeSlug && termKey.startsWith("cat:"));
}

type Placed = { uid: string; captureTime: number };

/**
 * One card per theme that still has photos in the library, the biggest first. A photo's link id
 * the library does not hold (deleted, hidden, in the vault) drops out, and a theme left with
 * nothing is omitted. The photos are newest first and the cover is the best-scoring one present.
 */
export function themeEntries(
  groups: ThemeGroup[],
  byLinkId: Map<string, Placed>,
  nameOf: (slug: string) => string,
): LibraryEntry[] {
  const out: { id: number; entry: LibraryEntry }[] = [];
  for (const g of groups) {
    const found: Placed[] = [];
    for (const k of g.keys) {
      const it = byLinkId.get(k);
      if (it) found.push(it);
    }
    if (found.length === 0) continue;
    const cover = found[0].uid;
    found.sort((a, b) => b.captureTime - a.captureTime);
    out.push({
      id: g.id,
      entry: { name: nameOf(g.slug), uids: found.map((it) => it.uid), cover, box: null, key: `theme:${g.slug}` },
    });
  }
  return out.sort((a, b) => b.entry.uids.length - a.entry.uids.length || a.id - b.id).map((e) => e.entry);
}

/** The photos of the theme `slug`, best score first, as far as the library holds them. */
export function themePhotos<T extends Placed>(groups: ThemeGroup[], slug: string, byLinkId: Map<string, T>): T[] {
  const group = groups.find((g) => g.slug === slug);
  if (!group) return [];
  const out: T[] = [];
  for (const k of group.keys) {
    const it = byLinkId.get(k);
    if (it) out.push(it);
  }
  return out;
}
