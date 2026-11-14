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

import { useEffect, useMemo, useRef, useState } from "react";
import { Confirm } from "./Confirm";
import { FaceCover, type LibraryEntry } from "./Library";
import { CallMergeIcon, CallSplitIcon, CloseIcon, FaceIcon, PencilIcon, SearchIcon } from "./icons";
import { useThumbnails } from "../hooks/useThumbnails";
import { useT } from "../lib/i18n";
import "../styles/Confirm.css";
import "../styles/AlbumDialogs.css";
import { personNameKey } from "../lib/personName";
import { backdropClose } from "../lib/backdrop";

/** Name compare for the suggestions, case and accents aside. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();

/**
 * A person's own controls in the top bar: naming them, with the people already named offered
 * as the typing goes (picking one puts the two together), merging them with someone picked from
 * the people, and leaving the group out as not a person at all.
 */
export function PersonActions({
  name,
  names,
  others,
  onRename,
  onMerge,
  onReject,
  onFind,
  findOpen,
  onSplit,
}: {
  /** The person's name, or null while unnamed. */
  name: string | null;
  /** Everyone else already named. */
  names: string[];
  /** Everyone this person could be merged with, named first. */
  others: LibraryEntry[];
  onRename: (name: string) => Promise<void>;
  onMerge: (other: LibraryEntry) => Promise<void>;
  onReject: () => Promise<void>;
  /** Opens or closes the side panel of photos that might be them; named people only. */
  onFind?: () => void;
  findOpen?: boolean;
  /** Opens the split of this person in two, for two people grouped as one. */
  onSplit?: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name ?? "");
  const [picked, setPicked] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [merging, setMerging] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  const suggestions = useMemo(() => {
    const q = fold(text);
    if (!q) return [];
    return names.filter((n) => personNameKey(n) !== personNameKey(name ?? "") && fold(n).includes(q)).slice(0, 6);
  }, [text, names, name]);

  async function save(value: string) {
    const next = value.trim();
    if (busy) return;
    if (next === (name ?? "")) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onRename(next);
      setEditing(false);
    } catch {
      /* stays open for another try */
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="g-strip-search g-personname">
        <PencilIcon size={15} />
        <input
          ref={field}
          className="g-searchfield"
          value={text}
          maxLength={100}
          placeholder={t("faces.namePlaceholder")}
          disabled={busy}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setPicked(-1);
          }}
          onBlur={() => window.setTimeout(() => !busy && setEditing(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            } else if (e.key === "Enter") {
              e.preventDefault();
              void save(picked >= 0 ? suggestions[picked] : text);
            } else if (e.key === "ArrowDown" && suggestions.length) {
              e.preventDefault();
              setPicked((i) => (i + 1) % suggestions.length);
            } else if (e.key === "ArrowUp" && suggestions.length) {
              e.preventDefault();
              setPicked((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
            }
          }}
        />
        {suggestions.length > 0 && (
          <div className="g-strip-suggest" role="listbox">
            {suggestions.map((s, i) => (
              <button
                key={s}
                className={`g-strip-option${i === picked ? " on" : ""}`}
                role="option"
                aria-selected={i === picked}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void save(s)}
              >
                <span className="g-strip-optico">
                  <FaceIcon size={16} />
                </span>
                <span className="g-strip-optlabel">{s}</span>
                <span className="g-strip-optkind">{t("faces.sameAs")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="g-tools">
      {onFind && (
        <button className={`g-tool g-tooltext${findOpen ? " on" : ""}`} onClick={onFind} aria-pressed={!!findOpen}>
          <SearchIcon size={15} />
          <span>{t("faces.findMore")}</span>
        </button>
      )}
      <button
        className="g-tool g-tooltext"
        onClick={() => {
          setText(name ?? "");
          setEditing(true);
        }}
      >
        <PencilIcon size={15} />
        <span>{t(name ? "faces.rename" : "faces.name")}</span>
      </button>
      {others.length > 0 && (
        <button className="g-tool g-tooltext" onClick={() => setMerging(true)}>
          <CallMergeIcon size={15} />
          <span>{t("faces.merge")}</span>
        </button>
      )}
      {onSplit && (
        <button className="g-tool g-tooltext" onClick={onSplit}>
          <CallSplitIcon size={15} />
          <span>{t("faces.split")}</span>
        </button>
      )}
      <button className="g-tool g-tooltext" onClick={() => setConfirmReject(true)}>
        <span>{t("faces.notPerson")}</span>
      </button>
      {merging && (
        <PersonPicker
          people={others}
          onCancel={() => setMerging(false)}
          onPick={async (other) => {
            await onMerge(other);
            setMerging(false);
          }}
        />
      )}
      {confirmReject && (
        <Confirm
          title={t("faces.notPersonTitle")}
          message={t("faces.notPersonMessage")}
          confirmLabel={t("faces.notPersonAction")}
          danger
          onCancel={() => setConfirmReject(false)}
          onConfirm={() => {
            setConfirmReject(false);
            void onReject().catch(() => {});
          }}
        />
      )}
    </div>
  );
}

/** The people to merge with, as the album picker lays them out: faces, names and a search. */
export function PersonPicker({
  people,
  onPick,
  onCancel,
}: {
  people: LibraryEntry[];
  onPick: (other: LibraryEntry) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const q = fold(query);
    return q ? people.filter((p) => fold(p.name).includes(q)) : people;
  }, [people, query]);
  const covers = useThumbnails(useMemo(() => people.map((p) => p.cover).filter((u): u is string => !!u), [people]));

  const pick = async (other: LibraryEntry) => {
    if (busy) return;
    setBusy(true);
    try {
      await onPick(other);
    } catch {
      setBusy(false);
    }
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") {
        if (query) setQuery("");
        else onCancel();
      } else if (e.key === "Enter" && query.trim() && shown.length === 1) {
        e.preventDefault();
        void pick(shown[0]);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel, query, shown, busy]);

  return (
    <div
      className="cf-backdrop"
      {...backdropClose(onCancel)}
    >
      <div className="cf-panel ad-picker" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ad-picker-head">
          <div className="ad-picker-titles">
            <h3 className="cf-title">{t("faces.mergeTitle")}</h3>
            <p className="cf-msg">{t("faces.mergeHint")}</p>
          </div>
          <button className="ad-close" onClick={onCancel} title={t("common.cancel")} aria-label={t("common.cancel")}>
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="ad-search">
          <SearchIcon size={16} />
          <input
            autoFocus
            value={query}
            placeholder={t("faces.searchPeople")}
            aria-label={t("faces.searchPeople")}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {query && (
            <button className="ad-search-clear" onClick={() => setQuery("")} aria-label={t("common.cancel")}>
              <CloseIcon size={14} />
            </button>
          )}
        </div>
        <div className="ad-grid">
          {shown.map((p) => (
            <button className="ad-card" key={p.personId} disabled={busy} onClick={() => void pick(p)} title={p.name}>
              <span className="ad-cover">
                {p.cover && covers[p.cover] ? (
                  <span className="lib-facebox">
                    <FaceCover uid={p.cover} thumb={covers[p.cover]!} box={p.box} />
                  </span>
                ) : (
                  <span className="ad-cover-empty">
                    <FaceIcon size={30} />
                  </span>
                )}
              </span>
              <span className="ad-card-name">{p.name}</span>
              <span className="ad-card-count">
                {t(p.uids.length === 1 ? "common.photoCount.one" : "common.photoCount.other", { count: p.uids.length })}
              </span>
            </button>
          ))}
        </div>
        {query.trim() && shown.length === 0 && <div className="ad-hint">{t("faces.searchEmpty")}</div>}
      </div>
    </div>
  );
}
