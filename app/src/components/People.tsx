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

// The People pages' own controls, as the Android app has them: the groups still to name
// beside the named people, "Is this <name>?" suggestions, a person's actions (name or rename,
// merge, hide) and the name picker every one of them uses.

import { useEffect, useId, useMemo, useState } from "react";
import { useThumbnails } from "../hooks/useThumbnails";
import { useT } from "../lib/i18n";
import type { MlSuggestion } from "../lib/people";
import { HideIcon, MergeIcon, PencilIcon } from "./icons";
import { EntryGrid, type LibraryEntry } from "./Library";
import "../styles/AlbumDialogs.css";
import "../styles/People.css";

const MAX_NAME = 200;

/**
 * Names a person, renames one, or picks who photos move to. The names already in use are
 * offered as the user types; picking one of them for a person who has another name merges
 * the two, which the dialog says before it is confirmed.
 */
export function PersonNameDialog({
  title,
  confirmLabel,
  initial = "",
  names,
  current,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  confirmLabel: string;
  initial?: string;
  names: string[];
  /** The person being named, when they already have a name: picking another one merges. */
  current?: string | null;
  busy?: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const listId = useId();
  const [draft, setDraft] = useState(initial);
  const name = draft.trim();
  const valid = name.length > 0 && name.length <= MAX_NAME;
  const merges = valid && name !== current && names.includes(name) && current !== undefined;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter" && valid && !busy) onConfirm(name);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, onConfirm, name, valid, busy]);

  return (
    <div
      className="cf-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="cf-panel" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="cf-title">{title}</h3>
        <input
          autoFocus
          className="ad-input"
          value={draft}
          maxLength={MAX_NAME}
          list={listId}
          placeholder={t("people.namePlaceholder")}
          disabled={busy}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <datalist id={listId}>
          {names.filter((n) => n !== current).map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {merges && (
          <p className="pp-hint">
            {current ? t("people.mergeHint", { name, current }) : t("people.joinHint", { name })}
          </p>
        )}
        <div className="cf-actions">
          <button className="cf-btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="cf-btn primary" disabled={!valid || busy} onClick={() => onConfirm(name)}>
            {merges ? t("people.merge") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Is this <name>?": a few of the group's photos, and a yes and a no. */
export function SuggestionCard({
  suggestion,
  uids,
  busy,
  onAnswer,
  onOpen,
}: {
  suggestion: MlSuggestion;
  /** The group's photos as timeline uids. */
  uids: string[];
  busy?: boolean;
  onAnswer: (yes: boolean) => void;
  /** Opens the group's photos in full, to look before answering. */
  onOpen?: () => void;
}) {
  const t = useT();
  const shown = useMemo(() => uids.slice(0, 6), [uids]);
  const thumbs = useThumbnails(shown);
  const see = t(uids.length === 1 ? "people.suggestSee.one" : "people.suggestSee.other", { count: uids.length });
  return (
    <div className="pp-suggest">
      <div className="pp-suggest-thumbs">
        {shown.map((uid) => (
          <button key={uid} className="pp-suggest-thumb" disabled={!onOpen} onClick={onOpen} title={onOpen ? see : undefined}>
            {thumbs[uid] ? <img src={thumbs[uid]!} alt="" draggable={false} /> : null}
          </button>
        ))}
      </div>
      <div className="pp-suggest-text">{t("people.suggestQuestion", { name: suggestion.name })}</div>
      <div className="pp-suggest-actions">
        {onOpen && (
          <button className="cf-btn pp-suggest-see" onClick={onOpen}>
            {see}
          </button>
        )}
        <button className="cf-btn" disabled={busy} onClick={() => onAnswer(false)}>
          {t("people.suggestNo")}
        </button>
        <button className="cf-btn primary" disabled={busy} onClick={() => onAnswer(true)}>
          {t("people.suggestYes")}
        </button>
      </div>
    </div>
  );
}

/** The People page: suggestions to answer, the named people, and the groups to name. */
export function PeopleLibrary({
  named,
  groups,
  suggestions,
  cardSize,
  busy,
  onOpen,
  onAnswer,
  onOpenSuggestion,
}: {
  named: LibraryEntry[];
  groups: LibraryEntry[];
  suggestions: { suggestion: MlSuggestion; uids: string[] }[];
  cardSize: number;
  busy?: boolean;
  onOpen: (entry: LibraryEntry) => void;
  onAnswer: (suggestion: MlSuggestion, yes: boolean) => void;
  onOpenSuggestion: (suggestion: MlSuggestion) => void;
}) {
  const t = useT();
  return (
    <div className="pp-page">
      {suggestions.length > 0 && (
        <section className="pp-section">
          <h2 className="pp-heading">{t("people.suggestions")}</h2>
          <div className="pp-suggest-row">
            {suggestions.slice(0, 4).map((s) => (
              <SuggestionCard key={`${s.suggestion.group}:${s.suggestion.name}`} suggestion={s.suggestion} uids={s.uids} busy={busy} onAnswer={(yes) => onAnswer(s.suggestion, yes)} onOpen={() => onOpenSuggestion(s.suggestion)} />
            ))}
          </div>
        </section>
      )}
      {named.length > 0 && <EntryGrid entries={named} face cardSize={cardSize} onOpen={onOpen} />}
      {groups.length > 0 && (
        <section className="pp-section">
          <h2 className="pp-heading">{t("people.toName")}</h2>
          <p className="lib-note pp-left">{t("people.toNameDesc")}</p>
          <EntryGrid entries={groups} face cardSize={cardSize} onOpen={onOpen} />
        </section>
      )}
    </div>
  );
}

/** A person's own actions, in the page's head. */
export function PersonActions({
  named,
  onName,
  onMerge,
  onHide,
}: {
  named: boolean;
  onName: () => void;
  onMerge: () => void;
  onHide: () => void;
}) {
  const t = useT();
  return (
    <div className="pp-actions">
      <button className="pp-action" onClick={onName} title={t(named ? "people.rename" : "people.addName")}>
        <PencilIcon size={16} />
        <span>{t(named ? "people.rename" : "people.addName")}</span>
      </button>
      <button className="pp-action" onClick={onMerge} title={t("people.mergeWith")}>
        <MergeIcon size={16} />
        <span>{t("people.mergeWith")}</span>
      </button>
      <button className="pp-action" onClick={onHide} title={t("people.hide")}>
        <HideIcon size={16} />
        <span>{t("people.hide")}</span>
      </button>
    </div>
  );
}
