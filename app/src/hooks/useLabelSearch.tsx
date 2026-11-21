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

import { useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import { LabelIcon } from "../components/icons";
import type { LabelChips, SearchPill } from "../components/TopStrip";
import { useLang, useT } from "../lib/i18n";
import { labelKeywords, namedLabel, offeredLabels, parseLabelTyping, type LabelTyping, type LabelUsage } from "../lib/labelQuery";
import { withLabels, type LabelFilter } from "../lib/labelFilter";

/** How long a typed "labels:<name>" settles before it becomes its pill, as the other pills. */
const LABEL_PILL_MS = 700;
/** How many labels the chips under the field offer before More. */
const OFFERED_CHIPS = 12;

/** The label keyword's spellings in the app's language and in English. */
export function useLabelKeywords(): string[] {
  const t = useT();
  const { lang } = useLang();
  return useMemo(() => labelKeywords([t("search.labelKeyword"), "labels|label"]), [t, lang]);
}

/**
 * The label keyword typed into a search field: the chips it offers, a settled "labels:<name>"
 * picked by itself, and the picked labels as pills. Picking a label takes the keyword out of
 * the text; removing a pill unpicks its label.
 */
export function useLabelSearch({
  query,
  setQuery,
  usage,
  names,
  filter,
  setFilter,
  keywords,
  onMore,
}: {
  query: string;
  setQuery: (q: string) => void;
  /** The labels with photos, most used first. */
  usage: LabelUsage[];
  /** Every label's name by its key, for the pills of labels with no photo in sight. */
  names: Map<string, string>;
  filter: LabelFilter;
  setFilter: Dispatch<SetStateAction<LabelFilter>>;
  keywords: string[];
  onMore: () => void;
}): { typing: LabelTyping | null; chips: LabelChips | null; pills: SearchPill[]; pick: (key: string) => void } {
  // With no label to offer, the keyword is only a word.
  const offering = usage.length > 0;
  const typing = useMemo(() => (offering ? parseLabelTyping(query, keywords) : null), [offering, query, keywords]);

  const pick = (key: string) => {
    setFilter((f) => (f.keys.includes(key) ? f : withLabels([...f.keys, key], f.all)));
    if (typing) setQuery(typing.rest);
  };

  useEffect(() => {
    if (!typing) return;
    const found = namedLabel(typing, usage);
    if (!found) return;
    const id = window.setTimeout(() => pick(found.key), LABEL_PILL_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing, usage]);

  const chips: LabelChips | null =
    typing
      ? { labels: offeredLabels(typing, usage, filter.keys).slice(0, OFFERED_CHIPS), onPick: pick, onMore }
      : null;

  const pills: SearchPill[] = filter.keys.map((key) => ({
    key: `label:${key}`,
    label: names.get(key) ?? usage.find((u) => u.key === key)?.label ?? key,
    icon: <LabelIcon size={15} />,
    onRemove: () => setFilter((f) => withLabels(f.keys.filter((k) => k !== key), f.all)),
  }));

  return { typing, chips, pills, pick };
}
