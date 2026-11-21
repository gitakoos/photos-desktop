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
import { PhotoGrid } from "./PhotoGrid";
import { VirtualSections } from "./VirtualSections";
import { CloseIcon } from "./icons";
import { FILTER_LEAVE_MS, LabelPage } from "./FilterPanel";
import { SearchField } from "./TopStrip";
import { useT } from "../lib/i18n";
import { locale } from "../lib/format";
import { useLabelKeywords, useLabelSearch } from "../hooks/useLabelSearch";
import { useLeaving } from "../hooks/useLeaving";
import { NO_LABELS, applyLabels, withLabels, type LabelFilter } from "../lib/labelFilter";
import type { LabelUsage } from "../lib/labelQuery";
import { alternatives, matchesAlternatives } from "../lib/searchQuery";
import "../styles/AlbumAddPhotos.css";

/** A timeline photo offered for adding: the uid, when it was taken (for the month
 *  headers) and its tags (so the grid can badge it like everywhere else). */
type Candidate = { uid: string; captureTime: number; tags?: number[] };

/** What the picker's search reads, from the timeline's own search. */
export type PickerSearch = {
  /** A photo's folded texts: its name and type once indexed, and its people and labels unless `namesOff`. */
  fieldsOf: (uid: string, namesOff: boolean) => (string | undefined)[];
  /** The labels with photos, most used first. */
  labels: LabelUsage[];
  /** Every label's name by its key. */
  labelNames: Map<string, string>;
  /** Each photo's label keys. */
  labelsOfPhoto: Map<string, Set<string>>;
  /** The field is in use, so the photos' names are read in. */
  onActive: (active: boolean) => void;
};

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}`;
}
function monthLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
}

/**
 * Picks timeline photos to add to the open album, the way the web client's "Add photos"
 * does. Purely a chooser: the parent owns the add call, the toast and the reload, so this
 * holds only the selection. The candidate list already excludes what the album holds, so
 * every photo shown is one that can actually be added.
 *
 * The grid is the same one the timeline uses, so thumbnails load lazily per visible cell
 * and the month sections virtualise; a large library opens the picker without loading
 * every thumbnail at once.
 */
export function AlbumAddPhotos({
  albumName,
  title,
  confirmLabel,
  single,
  candidates,
  cellSize,
  busy,
  search,
  onConfirm,
  onClose,
}: {
  albumName: string;
  /** The head's title, when this picks for something other than adding to an album. */
  title?: string;
  /** The confirm button's text, in place of "Add photos". */
  confirmLabel?: string;
  /** Picks one photo: choosing another moves the choice. */
  single?: boolean;
  candidates: Candidate[];
  cellSize: number;
  busy: boolean;
  /** A search over the candidates, with the timeline's words, labels and label keyword. */
  search?: PickerSearch;
  onConfirm: (uids: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (uid: string) =>
    setSelected((prev) => {
      if (single) return prev.has(uid) ? new Set() : new Set([uid]);
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });

  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [labelFilter, setLabelFilter] = useState<LabelFilter>(NO_LABELS);
  // The Labels page the chips' More opens, hung under the search field.
  const [labelsAt, setLabelsAt] = useState<CSSProperties | null>(null);
  const labelsShown = useLeaving(labelsAt, FILTER_LEAVE_MS);
  const searchRef = useRef<HTMLInputElement>(null);
  const keywords = useLabelKeywords();
  const labels = search?.labels ?? [];
  const labelSearch = useLabelSearch({
    query,
    setQuery,
    usage: labels,
    names: search?.labelNames ?? new Map(),
    filter: labelFilter,
    setFilter: setLabelFilter,
    keywords,
    onMore: () => {
      const r = searchRef.current?.parentElement?.getBoundingClientRect();
      if (r) setLabelsAt({ position: "fixed", top: r.bottom + 6, left: "auto", right: window.innerWidth - r.right });
    },
  });
  const typing = labelSearch.typing;
  const text = typing ? typing.rest : query;
  const alts = useMemo(() => alternatives(text), [text]);
  const namesOff = labelFilter.keys.length > 0 || typing !== null;

  const onActive = search?.onActive;
  useEffect(() => {
    onActive?.(focused || query.trim() !== "");
  }, [onActive, focused, query]);
  useEffect(() => () => onActive?.(false), [onActive]);

  // Escape steps back: the Labels page first, then the typed text, then the picker itself.
  // Captured and stopped so it does not also reach anything underneath.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (labelsAt) setLabelsAt(null);
      else if (query) setQuery("");
      else onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, labelsAt, query]);

  const fieldsOf = search?.fieldsOf;
  const labelsOfPhoto = search?.labelsOfPhoto;
  const shown = useMemo(() => {
    let list = labelsOfPhoto ? applyLabels(candidates, labelFilter, labelsOfPhoto) : candidates;
    if (fieldsOf && alts.length > 0) list = list.filter((c) => matchesAlternatives(alts, fieldsOf(c.uid, namesOff)));
    return list;
  }, [candidates, labelFilter, labelsOfPhoto, fieldsOf, alts, namesOff]);

  const sections = useMemo(() => {
    const map = new Map<string, { label: string; items: Candidate[] }>();
    for (const it of shown) {
      const k = monthKey(it.captureTime);
      let s = map.get(k);
      if (!s) {
        s = { label: monthLabel(it.captureTime), items: [] };
        map.set(k, s);
      }
      s.items.push(it);
    }
    return [...map.values()];
  }, [shown]);
  const virtualSections = useMemo(
    () => sections.map((s) => ({ key: s.label, items: s.items })),
    [sections],
  );

  return (
    <div className="ap-veil" onMouseDown={onClose}>
      <div
        className="ap-card"
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="ap-head">
          <span className="ap-title">{title ?? t("albums.addPhotos")}</span>
          {albumName && <span className="ap-sub">{albumName}</span>}
          <span className="ap-spacer" />
          {search && candidates.length > 0 && (
            <SearchField
              ref={searchRef}
              className="ap-search"
              query={query}
              onQuery={setQuery}
              pills={labelSearch.pills}
              onClearAll={() => setQuery("")}
              clearable={query !== ""}
              suggestions={[]}
              labelChips={labelSearch.chips}
              placeholder={t("search.pickerHint")}
              onFocusChange={setFocused}
            />
          )}
          <button className="ap-x" onClick={onClose} title={t("common.close")}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="ap-body">
          {shown.length === 0 ? (
            <div className="ap-empty">{t(candidates.length === 0 ? "photos.noPhotos" : "photos.noMatches")}</div>
          ) : (
            // Only the rows near the view are built: this lists the whole timeline.
            <VirtualSections
              scroller=".ap-body"
              sections={virtualSections}
              cellSize={cellSize}
              header={(s) => (
                <div className="g-monthhdr">
                  <span className="g-monthtitle">{s.key}</span>
                </div>
              )}
              grid={(_, items) => (
                <PhotoGrid
                  items={items}
                  cellSize={cellSize}
                  selected={selected}
                  onToggle={toggle}
                  onOpen={toggle}
                />
              )}
            />
          )}
        </div>

        {labelsShown.value && labels.length > 0 && (
          <div
            className={`fp ap-labels${labelsShown.leaving ? " closing" : ""}`}
            style={labelsShown.value}
            role="dialog"
            aria-label={t("library.labels")}
            inert={labelsShown.leaving}
          >
            <LabelPage
              labels={labels}
              picked={labelFilter.keys}
              onBack={() => setLabelsAt(null)}
              onClose={() => setLabelsAt(null)}
              onShow={(keys) => {
                if (typing && keys.some((k) => !labelFilter.keys.includes(k))) setQuery(typing.rest);
                setLabelFilter(withLabels(keys, labelFilter.all));
                setLabelsAt(null);
              }}
            />
          </div>
        )}

        <div className="ap-foot">
          <button className="ap-cancel" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            className="ap-add"
            onClick={() => onConfirm([...selected])}
            disabled={busy || selected.size === 0}
          >
            {confirmLabel ?? t("albums.addPhotos")}
            {!single && selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
