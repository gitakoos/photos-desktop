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

import { useEffect, useMemo, useState } from "react";
import { useT } from "../lib/i18n";
import { rpc } from "../lib/rpc";
import { labelState, matchingLabels, sameLabel } from "../lib/labels";
import type { LocalLabel } from "../hooks/useLocalLabels";
import { CheckIcon, CloseIcon, LabelIcon, PlusIcon, SearchIcon } from "./icons";
import "../styles/AlbumDialogs.css";
import "../styles/LabelPicker.css";

/**
 * The labels of the selected photos, as the phone's label sheet has them: a search over every
 * label that also offers to make the one typed, and each label marked as on all, some or none
 * of the photos. Picking a label puts it on every photo, or takes it off when all had it; each
 * change is kept at once. A photo carries five labels at most.
 */
export function LabelPicker({
  keys,
  labels,
  act,
  onClose,
}: {
  /** The selected photos' Drive link ids. */
  keys: string[];
  labels: LocalLabel[];
  act: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  // Each selected photo's labels, read again after every change.
  const [carried, setCarried] = useState<Record<string, string[]> | null>(null);

  const readCarried = async () => setCarried(await rpc<Record<string, string[]>>("labelsOf", { keys }));
  useEffect(() => {
    void readCarried().catch(() => setCarried({}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join(",")]);

  // A label taken off its last photo leaves the list, but it stays here, at no photos, so the
  // pick can be undone in the same sitting.
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => {
    setSeen((before) => {
      const more = labels.map((l) => l.name).filter((n) => !before.some((b) => sameLabel(b, n)));
      return more.length ? [...before, ...more] : before;
    });
  }, [labels]);
  const listed = useMemo(
    () => [
      ...labels,
      ...seen.filter((n) => !labels.some((l) => sameLabel(l.name, n))).map((name) => ({ name, keys: [] as string[] })),
    ],
    [labels, seen],
  );
  const shown = useMemo(() => matchingLabels(listed, query), [listed, query]);
  const typed = query.trim();
  const offerCreate = !!typed && !listed.some((l) => sameLabel(l.name, typed));

  async function run(method: string, params: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      const result = (await act(method, params)) as { full?: number } | undefined;
      if (method === "labelsAdd") setFull((result?.full ?? 0) > 0);
      await readCarried();
    } catch {
      /* the labels stay as they were */
    } finally {
      setBusy(false);
    }
  }

  const toggle = (name: string) => {
    const state = labelState(name, keys, carried ?? {});
    void run(state === "all" ? "labelsRemove" : "labelsAdd", { keys, labels: [name] });
  };
  // Made by name first, as the phone makes it, so it stays in the list whatever happens to its photos.
  const create = () => {
    if (!typed) return;
    void act("labelCreate", { name: typed })
      .then(() => run("labelsAdd", { keys, labels: [typed] }))
      .then(() => setQuery(""))
      .catch(() => {});
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") {
        if (query) setQuery("");
        else onClose();
      } else if (e.key === "Enter" && typed) {
        e.preventDefault();
        const exact = listed.find((l) => sameLabel(l.name, typed));
        if (exact) {
          toggle(exact.name);
          setQuery("");
        } else create();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div
      className="cf-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="cf-panel ad-picker lp-picker" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ad-picker-head">
          <div className="ad-picker-titles">
            <h3 className="cf-title">{t("library.labels")}</h3>
            <p className="cf-msg">
              {t(keys.length === 1 ? "common.photoCount.one" : "common.photoCount.other", { count: keys.length })}
            </p>
          </div>
          <button className="ad-close" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="ad-search">
          <SearchIcon size={16} />
          <input
            autoFocus
            value={query}
            maxLength={24}
            placeholder={t("labels.searchHint")}
            aria-label={t("labels.searchHint")}
            onChange={(e) => setQuery(e.currentTarget.value.replace(/,/g, ""))}
          />
          {query && (
            <button className="ad-search-clear" onClick={() => setQuery("")} aria-label={t("common.close")}>
              <CloseIcon size={14} />
            </button>
          )}
        </div>

        {full && <div className="lp-note">{t("labels.full")}</div>}

        <div className="lp-list" role="list">
          {offerCreate && (
            <button className="lp-row" disabled={busy} onClick={create}>
              <span className="lp-mark new" aria-hidden>
                <PlusIcon size={14} />
              </span>
              <span className="lp-name">{t("labels.create", { name: typed })}</span>
            </button>
          )}
          {shown.map((label) => {
            const state = carried ? labelState(label.name, keys, carried) : "none";
            return (
              <button
                className={`lp-row${state !== "none" ? " on" : ""}`}
                key={label.name}
                role="listitem"
                aria-pressed={state === "all"}
                disabled={busy || carried === null}
                onClick={() => toggle(label.name)}
              >
                <span className={`lp-mark ${state}`} aria-hidden>
                  {state === "all" ? <CheckIcon size={12} /> : state === "some" ? <span className="lp-dash" /> : null}
                </span>
                <LabelIcon size={16} />
                <span className="lp-name">{label.name}</span>
                <span className="lp-count">{label.keys.length}</span>
              </button>
            );
          })}
          {listed.length === 0 && !offerCreate && <div className="ad-hint">{t("labels.none")}</div>}
          {listed.length > 0 && typed && shown.length === 0 && !offerCreate && (
            <div className="ad-hint">{t("labels.searchEmpty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
