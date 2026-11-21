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

import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { WindowButtons } from "./Titlebar";
import type { Activity } from "./Sidebar";
import { CloseIcon, DownloadIcon, GearIcon, SearchIcon, SpinnerIcon, UploadArrowIcon } from "./icons";
import { useT } from "../lib/i18n";
import type { LabelUsage } from "../lib/labelQuery";
import { LabelChip } from "./FilterPanel";
import { stillMotion, useLeaving } from "../hooks/useLeaving";
import logo from "../assets/applogo.png";

/** Something narrowing the photos, shown in the search: a date, a type, a category, a person
 *  or a label. */
export type SearchPill = { key: string; label: string; icon?: ReactNode; onRemove: () => void };

/** A name the typing has started: a person, a label, a category or a type, offered as a pill. */
export type SearchSuggestion = { key: string; label: string; kind: string; icon?: ReactNode; onPick: () => void };

/** The labels the typed label keyword offers under the field, and a way to all of them. */
export type LabelChips = { labels: LabelUsage[]; onPick: (key: string) => void; onMore: () => void };

/** How long a pill taken out, or the label chips going away, stay to fold and fade. */
const LEAVE_MS = 140;

/** Pills just taken out, each kept for a moment where it stood so it can fold away. */
function useGonePills(pills: SearchPill[]): { pill: SearchPill; at: number }[] {
  const before = useRef(pills);
  const timers = useRef<number[]>([]);
  const [gone, setGone] = useState<{ pill: SearchPill; at: number }[]>([]);
  useLayoutEffect(() => {
    const now = new Set(pills.map((p) => p.key));
    const left = before.current.flatMap((pill, at) => (now.has(pill.key) ? [] : [{ pill, at }]));
    before.current = pills;
    if (left.length === 0 || stillMotion()) return;
    const keys = new Set(left.map((l) => l.pill.key));
    setGone((g) => [...g.filter((x) => !keys.has(x.pill.key)), ...left]);
    timers.current.push(window.setTimeout(() => setGone((g) => g.filter((x) => !keys.has(x.pill.key))), LEAVE_MS));
  }, [pills]);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);
  const now = new Set(pills.map((p) => p.key));
  return gone.filter((x) => !now.has(x.pill.key));
}

/** A pill taken out: it narrows to nothing as it fades, so the text after it closes up smoothly. */
function GonePill({ pill }: { pill: SearchPill }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el?.animate) return;
    el.animate(
      [
        { width: `${el.offsetWidth}px` },
        { width: "0px", paddingLeft: "0px", paddingRight: "0px", marginRight: "-10px", opacity: 0, transform: "scale(0.9)" },
      ],
      { duration: LEAVE_MS, easing: "ease-in", fill: "forwards" },
    );
  }, []);
  return (
    <span ref={ref} className="g-strip-pillout" aria-hidden>
      {pill.icon}
      <span>{pill.label}</span>
      <CloseIcon size={11} />
    </span>
  );
}

/**
 * The window's top strip in the sidebar layout, part of the frame around the page: the
 * brand, one search over the whole library in the middle, and on the right the upload
 * (which also reads out what is moving), the settings and the window's own buttons.
 * Its empty stretches drag the window.
 */
export const TopStrip = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQuery: (q: string) => void;
    /** What narrows the photos besides the text, before it in the field. */
    pills: SearchPill[];
    /** Empties the field: the text and every pill. */
    onClearAll: () => void;
    /** What the text typed so far could become, offered under the field. */
    suggestions: SearchSuggestion[];
    labelChips?: LabelChips | null;
    /** Whether the clear button has something to empty. */
    clearable?: boolean;
    activity: Activity | null;
    /** A file is being dragged over the window, so the upload reads as a drop target. */
    dragging: boolean;
    onUpload: () => void;
    onSettings: () => void;
  }
>(function TopStrip(
  { query, onQuery, pills, onClearAll, suggestions, labelChips, clearable, activity, dragging, onUpload, onSettings },
  searchRef,
) {
  const t = useT();
  // The name shows whole or not at all: a narrow strip would otherwise cut it to its
  // first letter. The brand's width comes from the strip, never from what it holds, so
  // hiding the name cannot change the width this measures.
  const brandRef = useRef<HTMLSpanElement>(null);
  const nameWidth = useRef(0);
  const [nameFits, setNameFits] = useState(true);
  useLayoutEffect(() => {
    const brand = brandRef.current;
    if (!brand) return;
    const check = () => {
      const width = brand.querySelector<HTMLElement>(".g-strip-name")?.getBoundingClientRect().width ?? 0;
      if (width > 0) nameWidth.current = width;
      const logo = brand.querySelector<HTMLElement>(".g-strip-logo")?.getBoundingClientRect().width ?? 0;
      const gap = parseFloat(getComputedStyle(brand).columnGap) || 0;
      setNameFits(brand.clientWidth >= logo + gap + nameWidth.current);
    };
    const observer = new ResizeObserver(check);
    observer.observe(brand);
    check();
    return () => observer.disconnect();
  }, []);
  const busy = activity !== null;
  const spinning = activity?.kind === "index" || activity?.kind === "sync";
  const label = dragging
    ? t("photos.dropTitle")
    : activity?.kind === "upload" || activity?.kind === "download"
      ? activity.label
      : activity?.kind === "index"
        ? t("sidebar.indexing")
        : activity?.kind === "sync"
          ? (activity.label ?? t("avatar.syncing"))
          : t("upload.title");
  const why = activity?.kind === "sync" ? activity.why : undefined;
  const Glyph = !dragging && activity?.kind === "download" ? DownloadIcon : spinning ? SpinnerIcon : UploadArrowIcon;

  return (
    <header className="g-strip" data-tauri-drag-region>
      <span className="g-strip-brand" ref={brandRef} data-tauri-drag-region>
        <img className="g-strip-logo" src={logo} alt="" draggable={false} />
        {nameFits && (
          <span className="g-strip-name" data-tauri-drag-region>
            Photos for Proton
          </span>
        )}
      </span>

      <SearchField
        ref={searchRef}
        query={query}
        onQuery={onQuery}
        pills={pills}
        onClearAll={onClearAll}
        suggestions={suggestions}
        labelChips={labelChips}
        clearable={clearable}
      />

      <div className="g-strip-end" data-tauri-drag-region>
        <button
          className={`g-strip-upload${busy ? " busy" : ""}${spinning ? " spin" : ""}${dragging ? " drop" : ""}`}
          onClick={onUpload}
          title={dragging ? t("photos.dropTitle") : busy ? (why ? `${label}\n${why}` : label) : t("photos.uploadTitle")}
        >
          <span className="g-strip-upico">
            <Glyph size={16} />
          </span>
          <span className="g-strip-uplabel">{label}</span>
          {busy && !dragging && <span className="g-strip-progress" aria-hidden />}
        </button>
        <button className="g-strip-icon" onClick={onSettings} title={t("settings.title")} aria-label={t("settings.title")}>
          <GearIcon size={17} />
        </button>
        <WindowButtons />
      </div>
    </header>
  );
});

/**
 * The one search over the library: what narrows the photos as pills before the typed text,
 * the names the typing could become offered under it, and a way to empty all of it.
 */
export const SearchField = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQuery: (q: string) => void;
    pills: SearchPill[];
    onClearAll: () => void;
    suggestions: SearchSuggestion[];
    /** While the label keyword is typed: the labels it offers, in place of the suggestions. */
    labelChips?: LabelChips | null;
    /** Whether the clear button has something to empty; by default the text or any pill. */
    clearable?: boolean;
    className?: string;
    placeholder?: string;
    onFocusChange?: (focused: boolean) => void;
  }
>(function SearchField(
  { query, onQuery, pills, onClearAll, suggestions, labelChips, clearable, className, placeholder, onFocusChange },
  searchRef,
) {
  const t = useT();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  // The label chips and their More stand where the suggestions would, reached the same way.
  const choices: { key: string; onPick: () => void }[] = labelChips
    ? [
        ...labelChips.labels.map((l) => ({ key: l.key, onPick: () => labelChips.onPick(l.key) })),
        { key: "more", onPick: labelChips.onMore },
      ]
    : suggestions;
  const offered = focused && choices.length > 0;
  const picked = Math.min(active, choices.length - 1);
  // The chips fade out where they stood when they go, unless the suggestions take their place.
  const chipsGoing = useLeaving(offered && labelChips ? labelChips : null, LEAVE_MS);
  const gonePills = useGonePills(pills);
  const shownPills: ReactNode[] = pills.map((pill) => (
    <button
      key={pill.key}
      className="g-strip-pill"
      onMouseDown={(e) => e.preventDefault()}
      onClick={pill.onRemove}
      title={t("filter.removeOne")}
    >
      {pill.icon}
      <span>{pill.label}</span>
      <CloseIcon size={11} />
    </button>
  ));
  for (const g of [...gonePills].sort((a, b) => a.at - b.at)) {
    shownPills.splice(Math.min(g.at, shownPills.length), 0, <GonePill key={`gone:${g.pill.key}`} pill={g.pill} />);
  }
  return (
  <div className={`g-strip-search${className ? ` ${className}` : ""}`}>
    <SearchIcon size={16} />
    {shownPills}
    <input
      ref={searchRef}
      className="g-searchfield"
      placeholder={pills.length > 0 ? "" : (placeholder ?? t("search.global"))}
      value={query}
      onChange={(e) => {
        setActive(0);
        onQuery(e.currentTarget.value);
      }}
      onFocus={() => {
        setFocused(true);
        onFocusChange?.(true);
      }}
      onBlur={() => {
        setFocused(false);
        onFocusChange?.(false);
      }}
      onKeyDown={(e) => {
        if (offered && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          setActive((a) => (a + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
        } else if (offered && e.key === "Enter") {
          e.preventDefault();
          setActive(0);
          choices[picked]?.onPick();
        } else if (e.key === "Escape") {
          onQuery("");
          e.currentTarget.blur();
        } else if (e.key === "Backspace" && query === "" && pills.length > 0) {
          // An empty field gives up its last pill, as a word would be deleted.
          pills[pills.length - 1].onRemove();
        }
      }}
    />
    {offered && labelChips && (
      <div className="g-strip-suggest g-strip-labels" role="listbox" aria-label={t("library.labels")}>
        {labelChips.labels.map((label, i) => (
          <LabelChip
            key={label.key}
            label={label}
            active={i === picked}
            onHover={() => setActive(i)}
            onPick={() => {
              setActive(0);
              labelChips.onPick(label.key);
            }}
          />
        ))}
        <button
          className={`g-chip${picked === labelChips.labels.length ? " on" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(labelChips.labels.length)}
          onClick={labelChips.onMore}
        >
          {t("filter.labelsMore")}
        </button>
      </div>
    )}
    {!offered && chipsGoing.leaving && chipsGoing.value && (
      <div className="g-strip-suggest g-strip-labels leaving" aria-hidden inert>
        {chipsGoing.value.labels.map((label) => (
          <LabelChip key={label.key} label={label} onPick={() => {}} />
        ))}
        <button className="g-chip">{t("filter.labelsMore")}</button>
      </div>
    )}
    {offered && !labelChips && (
      <div className="g-strip-suggest" role="listbox">
        {suggestions.map((s, i) => (
          <button
            key={s.key}
            role="option"
            aria-selected={i === picked}
            className={`g-strip-option${i === picked ? " on" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={s.onPick}
          >
            <span className="g-strip-optico">{s.icon}</span>
            <span className="g-strip-optlabel">{s.label}</span>
            <span className="g-strip-optkind">{s.kind}</span>
          </button>
        ))}
      </div>
    )}
    {(clearable ?? (!!query || pills.length > 0)) && (
      <button
        className="g-searchx"
        title={t("photos.closeSearch")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClearAll}
      >
        <CloseIcon size={14} />
      </button>
    )}
  </div>
  );
});
