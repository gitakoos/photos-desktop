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

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CheckIcon, ChevronLeftIcon, CloseIcon, LabelIcon, SearchIcon } from "./icons";
import { useLang, useT } from "../lib/i18n";
import { CATEGORIES } from "../lib/tags";
import { matchingLabels } from "../lib/labels";
import type { LabelUsage } from "../lib/labelQuery";
import { shownInSection, toggleLabel, withLabels, type LabelFilter } from "../lib/labelFilter";
import { useLeaving } from "../hooks/useLeaving";
import "../styles/ContextMenu.css";
import "../styles/Library.css";
import "../styles/FilterPanel.css";
import "../styles/Settings.css";
import "../styles/AlbumDialogs.css";
import "../styles/LabelPicker.css";
import "../styles/Confirm.css";

/** Timeline media-type filter, read straight off the item tags (no index needed). */
export type MediaType = "all" | "photo" | "video";

/** Which page of the panel shows: the filters, or every label to pick from. */
export type FilterPage = "filters" | "labels";

/** How long a closing panel, or a row leaving it, stays to fade out. */
export const FILTER_LEAVE_MS = 140;

const MEDIA_TYPES: { value: MediaType; labelKey: string }[] = [
  { value: "all", labelKey: "filter.mediaAll" },
  { value: "photo", labelKey: "filter.mediaPhotos" },
  { value: "video", labelKey: "filter.videos" },
];

/** A label as a chip: its tag, its name and how many photos carry it. */
export function LabelChip({
  label,
  selected,
  active,
  onPick,
  onHover,
}: {
  label: LabelUsage;
  selected?: boolean;
  /** Reached by the arrow keys. */
  active?: boolean;
  onPick: () => void;
  onHover?: () => void;
}) {
  return (
    <button
      className={`g-chip g-labelchip${selected ? " sel" : ""}${active ? " on" : ""}`}
      aria-pressed={selected}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      onClick={onPick}
      title={label.label}
    >
      <LabelIcon size={15} />
      <span className="g-labelchip-name">{label.label}</span>
      <span className="g-labelchip-count">{label.count}</span>
    </button>
  );
}

/** "Show 3 labels", in the plural form the language takes. */
function useShowLabels(): (count: number) => string {
  const t = useT();
  const { lang } = useLang();
  return (count) => {
    const key = `filter.labelsShow.${new Intl.PluralRules(lang).select(count)}`;
    const text = t(key, { count });
    return text === key ? t("filter.labelsShow.other", { count }) : text;
  };
}

/**
 * The timeline content filter, mirroring the Android app's ContentFilterSheet:
 * a Categories section (the photo tags, multi-select, OR across selections), a Type
 * section (All / Photos / Videos, single-select) and, with labels, a Labels section
 * whose More opens a page of every label in the same panel. A rounded popover under
 * the filter button; every toggle applies in real time.
 */
export function FilterPanel({
  categories,
  onToggleCategory,
  mediaType,
  onMediaType,
  labels,
  labelFilter,
  onLabelFilter,
  page,
  onPage,
  omitVideoCategory,
  anchor,
  activeCount,
  onReset,
  onClose,
  closing,
}: {
  categories: Set<string>;
  onToggleCategory: (key: string) => void;
  mediaType: MediaType;
  onMediaType: (m: MediaType) => void;
  /** The labels with photos, most used first; none hides the section. */
  labels: LabelUsage[];
  labelFilter: LabelFilter;
  onLabelFilter: (filter: LabelFilter) => void;
  page: FilterPage;
  onPage: (page: FilterPage) => void;
  /** Leaves out the Videos category, which the type already offers. */
  omitVideoCategory?: boolean;
  /** The trigger's bottom right corner, for a panel opened from the right-hand side. */
  anchor?: { x: number; y: number };
  activeCount: number;
  onReset: () => void;
  onClose: () => void;
  /** Fading out after a close: it no longer takes clicks, keys or the focus. */
  closing?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const shownPage: FilterPage = page === "labels" && labels.length > 0 ? "labels" : "filters";
  // The page slides in only when it changes in the open panel, not when the panel opens on it.
  const firstPage = useRef(shownPage);
  const turned = useRef(false);
  if (shownPage !== firstPage.current) turned.current = true;
  const slide = turned.current ? (shownPage === "labels" ? " fp-page-on" : " fp-page-back") : "";
  const anyAll = useLeaving(labelFilter.keys.length >= 2 ? { all: labelFilter.all } : null, FILTER_LEAVE_MS);

  useEffect(() => {
    if (closing) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target)) return;
      // The trigger toggles itself; let its own click handle the close.
      if (target.closest?.(".g-filterpill, [data-filter-trigger]")) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (pageRef.current === "labels") onPage("filters");
      else onClose();
    }
    // Deferred, so the click that opened the panel does not immediately close it.
    const id = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, onPage, closing]);

  const style: CSSProperties | undefined = anchor
    ? {
        position: "fixed",
        top: anchor.y,
        left: "auto",
        right: Math.max(8, window.innerWidth - anchor.x),
        transformOrigin: "top right",
      }
    : undefined;
  const frame = {
    className: `fp${closing ? " closing" : ""}`,
    ref,
    style,
    role: "dialog",
    inert: closing,
  } as const;

  if (shownPage === "labels") {
    return (
      <div {...frame} aria-label={t("library.labels")}>
        <div className={`fp-page${slide}`} key="labels">
          <LabelPage
            labels={labels}
            picked={labelFilter.keys}
            onBack={() => onPage("filters")}
            onClose={onClose}
            onShow={(keys) => {
              onLabelFilter(withLabels(keys, labelFilter.all));
              onPage("filters");
            }}
          />
        </div>
      </div>
    );
  }

  const shownCategories = omitVideoCategory ? CATEGORIES.filter((c) => c.key !== "video") : CATEGORIES;
  return (
    <div {...frame} aria-label={t("filter.title")}>
      <div className={`fp-page${slide}`} key="filters">
        <div className="fp-head">
          <span className="fp-title">{t("filter.title")}</span>
          {activeCount > 0 && (
            <button className="fp-reset" onClick={onReset}>
              {t("filter.reset")}
            </button>
          )}
          <button className="fp-x" onClick={onClose} title={t("common.close")}>
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="fp-label">{t("filter.categories")}</div>
        <div className="fp-chips">
          {shownCategories.map((c) => (
            <button
              key={c.key}
              className={`g-chip ${categories.has(c.key) ? "sel" : ""}`}
              aria-pressed={categories.has(c.key)}
              onClick={() => onToggleCategory(c.key)}
            >
              {t(`category.${c.key}`)}
            </button>
          ))}
        </div>

        <div className="fp-label">{t("filter.type")}</div>
        <div className="fp-chips" role="group" aria-label={t("filter.type")}>
          {MEDIA_TYPES.map((m) => (
            <button
              key={m.value}
              className={`g-chip ${mediaType === m.value ? "sel" : ""}`}
              aria-pressed={mediaType === m.value}
              onClick={() => onMediaType(m.value)}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>

        {labels.length > 0 && (
          <>
            <div className="fp-label">{t("library.labels")}</div>
            <div className="fp-chips" role="group" aria-label={t("library.labels")}>
              {shownInSection(labels, labelFilter.keys).map((label) => (
                <LabelChip
                  key={label.key}
                  label={label}
                  selected={labelFilter.keys.includes(label.key)}
                  onPick={() => onLabelFilter(toggleLabel(labelFilter, label.key))}
                />
              ))}
              <button className="g-chip" onClick={() => onPage("labels")}>
                {t("filter.labelsMore")}
              </button>
            </div>
            {anyAll.value && (
              <div
                className={`st-seg fp-seg${anyAll.leaving ? " leaving" : ""}`}
                role="radiogroup"
                aria-label={t("library.labels")}
                inert={anyAll.leaving}
              >
                {([false, true] as const).map((all) => (
                  <button
                    key={String(all)}
                    role="radio"
                    aria-checked={anyAll.value?.all === all}
                    className={`st-seg-btn${anyAll.value?.all === all ? " on" : ""}`}
                    onClick={() => onLabelFilter(withLabels(labelFilter.keys, all))}
                  >
                    {t(all ? "filter.labelsAll" : "filter.labelsAny")}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Every label to pick from, found by part of its name, applied by its Show button. */
export function LabelPage({
  labels,
  picked,
  onBack,
  onClose,
  onShow,
}: {
  labels: LabelUsage[];
  picked: string[];
  onBack: () => void;
  onClose: () => void;
  onShow: (keys: string[]) => void;
}) {
  const t = useT();
  const showLabels = useShowLabels();
  const [chosen, setChosen] = useState<string[]>(picked);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => matchingLabels(labels.map((l) => ({ ...l, name: l.label })), query), [labels, query]);
  const toggle = (key: string) => setChosen((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  return (
    <>
      <div className="fp-head">
        <button className="fp-x" onClick={onBack} title={t("common.back")} aria-label={t("common.back")}>
          <ChevronLeftIcon size={16} />
        </button>
        <span className="fp-title">{t("library.labels")}</span>
        <button className="fp-x" onClick={onClose} title={t("common.close")}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="ad-search fp-search">
        <SearchIcon size={16} />
        <input
          autoFocus
          value={query}
          placeholder={t("filter.labelsSearch")}
          aria-label={t("filter.labelsSearch")}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        {query && (
          <button className="ad-search-clear" onClick={() => setQuery("")} aria-label={t("common.close")}>
            <CloseIcon size={14} />
          </button>
        )}
      </div>
      <div className="lp-list fp-labellist" role="list">
        {shown.map((label) => {
          const on = chosen.includes(label.key);
          return (
            <button
              key={label.key}
              className={`lp-row${on ? " on" : ""}`}
              role="listitem"
              aria-pressed={on}
              onClick={() => toggle(label.key)}
            >
              <span className={`lp-mark ${on ? "all" : "none"}`} aria-hidden>
                {on ? <CheckIcon size={12} /> : null}
              </span>
              <LabelIcon size={16} />
              <span className="lp-name">{label.label}</span>
              <span className="lp-count">{label.count}</span>
            </button>
          );
        })}
        {shown.length === 0 && <div className="ad-hint">{t("labels.searchEmpty")}</div>}
      </div>
      <button className="cf-btn primary fp-show" onClick={() => onShow(chosen)}>
        {chosen.length === 0 ? t("filter.labelsShowAll") : showLabels(chosen.length)}
      </button>
    </>
  );
}
