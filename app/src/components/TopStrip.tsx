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

import { forwardRef, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { WindowButtons } from "./Titlebar";
import type { Activity } from "./Sidebar";
import { CloseIcon, DownloadIcon, GearIcon, SearchIcon, SpinnerIcon, UploadArrowIcon } from "./icons";
import { useT } from "../lib/i18n";
import logo from "../assets/applogo.png";

/** Something narrowing the photos, shown in the search: a date, a type, a category, a person
 *  or a label. */
export type SearchPill = { key: string; label: string; icon?: ReactNode; onRemove: () => void };

/** A name the typing has started: a person, a label, a category or a type, offered as a pill. */
export type SearchSuggestion = { key: string; label: string; kind: string; icon?: ReactNode; onPick: () => void };

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
    activity: Activity | null;
    /** A file is being dragged over the window, so the upload reads as a drop target. */
    dragging: boolean;
    onUpload: () => void;
    onSettings: () => void;
  }
>(function TopStrip(
  { query, onQuery, pills, onClearAll, suggestions, activity, dragging, onUpload, onSettings },
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
    className?: string;
    onFocusChange?: (focused: boolean) => void;
  }
>(function SearchField({ query, onQuery, pills, onClearAll, suggestions, className, onFocusChange }, searchRef) {
  const t = useT();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const offered = focused && suggestions.length > 0;
  const picked = Math.min(active, suggestions.length - 1);
  return (
  <div className={`g-strip-search${className ? ` ${className}` : ""}`}>
    <SearchIcon size={16} />
    {pills.map((pill) => (
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
    ))}
    <input
      ref={searchRef}
      className="g-searchfield"
      placeholder={pills.length > 0 ? "" : t("search.global")}
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
          setActive((a) => (a + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        } else if (offered && e.key === "Enter") {
          e.preventDefault();
          suggestions[picked]?.onPick();
        } else if (e.key === "Escape") {
          onQuery("");
          e.currentTarget.blur();
        } else if (e.key === "Backspace" && query === "" && pills.length > 0) {
          // An empty field gives up its last pill, as a word would be deleted.
          pills[pills.length - 1].onRemove();
        }
      }}
    />
    {offered && (
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
    {(query || pills.length > 0) && (
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
