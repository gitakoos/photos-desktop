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

import { useThumbnails } from "../hooks/useThumbnails";
import { dateProblem, type DateProblem } from "../lib/fixDates";
import { useLang, useT } from "../lib/i18n";
import { rpc } from "../lib/rpc";
import "../styles/FixDates.css";

type Item = { uid: string; captureTime: number };
type Row = { uid: string; captureMs: number; name: string; problem: DateProblem };

/** Rows drawn at first, and added with each "show more". */
const PAGE = 120;
const META_BATCH = 400;
const KEPT_KEY = "pfp.fixDates.kept";

// The names read once stay for the session, so coming back to the page lists at once.
const names = new Map<string, string>();

function readKept(): Set<string> {
  try {
    const raw = localStorage.getItem(KEPT_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeKept(kept: Set<string>) {
  try {
    localStorage.setItem(KEPT_KEY, JSON.stringify([...kept]));
  } catch {
    /* kept for this session only */
  }
}

/**
 * The photos whose date cannot be right: no date at all, a date still to come, or a file name
 * that records another day. Each one opens the date editor; a date that is right after all is
 * kept, and the photo leaves the list on this computer.
 */
export function FixDates({
  items,
  onEditDate,
  onView,
}: {
  /** The timeline as the grid has it, hidden photos left out. */
  items: Item[];
  /** Opens the date editor; `byName` when every photo has a name that records its day. */
  onEditDate: (uids: string[], byName: boolean) => void;
  onView: (uids: string[], at: string) => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(lang, { year: "numeric", month: "long", day: "numeric" }), [lang]);
  const dateText = (ms: number) => dateFormat.format(ms);
  const [read, setRead] = useState(() => items.filter((it) => names.has(it.uid)).length);
  const [kept, setKept] = useState<Set<string>>(readKept);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [shownCount, setShownCount] = useState(PAGE);

  // The names come from the sidecar's encrypted cache, so only a first visit decrypts them.
  useEffect(() => {
    const missing = items.filter((it) => !names.has(it.uid)).map((it) => it.uid);
    if (missing.length === 0) {
      setRead(items.length);
      return;
    }
    let live = true;
    void (async () => {
      for (let at = 0; at < missing.length && live; at += META_BATCH) {
        const rows = await rpc<{ uid: string; name: string }[]>("getMetadata", {
          uids: missing.slice(at, at + META_BATCH),
        }).catch(() => []);
        for (const r of rows) names.set(r.uid, r.name);
        if (live) setRead(items.length - missing.length + Math.min(at + META_BATCH, missing.length));
      }
    })();
    return () => {
      live = false;
    };
  }, [items]);

  const rows = useMemo(() => {
    const now = Date.now();
    const out: Row[] = [];
    for (const it of items) {
      if (kept.has(it.uid)) continue;
      const name = names.get(it.uid) ?? null;
      const problem = dateProblem(it.captureTime, name, now);
      if (problem) out.push({ uid: it.uid, captureMs: it.captureTime, name: name ?? "", problem });
    }
    return out;
    // `read` stands for the names that have arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, kept, read]);

  // Picks of photos no longer listed fall away.
  useEffect(() => {
    const listed = new Set(rows.map((r) => r.uid));
    setPicked((prev) => {
      const next = new Set([...prev].filter((u) => listed.has(u)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const visible = useMemo(() => rows.slice(0, shownCount), [rows, shownCount]);
  const visibleUids = useMemo(() => visible.map((r) => r.uid), [visible]);
  const thumbs = useThumbnails(visibleUids);
  const reading = read < items.length;

  const keep = (uids: string[]) => {
    const next = new Set(kept);
    uids.forEach((u) => next.add(u));
    writeKept(next);
    setKept(next);
  };
  const toggle = (uid: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  const kindOf = useMemo(() => new Map(rows.map((r) => [r.uid, r.problem.kind])), [rows]);
  const allByName = (uids: string[]) => uids.every((u) => kindOf.get(u) === "name");
  const reason = (r: Row) =>
    r.problem.kind === "none"
      ? t("fixDates.noDate")
      : r.problem.kind === "future"
        ? t("fixDates.future", { date: dateText(r.captureMs) })
        : t("fixDates.byName", { date: dateText(r.captureMs), name: dateText(r.problem.nameMs) });

  const pickedList = [...picked];

  return (
    <div className="fd-page">
      <div className="fd-head">
        <p className="fd-hint">{t("fixDates.hint")}</p>
        <div className="fd-status" aria-live="polite">
          {reading ? (
            <>
              <span>
                {t("fixDates.reading", {
                  done: read.toLocaleString(lang),
                  total: items.length.toLocaleString(lang),
                })}
              </span>
              <span className="fd-bar">
                <span style={{ width: `${items.length ? Math.round((read / items.length) * 100) : 0}%` }} />
              </span>
            </>
          ) : rows.length > 0 ? (
            <>
              <button
                className="g-chip"
                onClick={() => setPicked(picked.size === rows.length ? new Set() : new Set(rows.map((r) => r.uid)))}
              >
                {t(picked.size === rows.length ? "fixDates.pickNone" : "fixDates.pickAll")}
              </button>
              {picked.size > 0 && (
                <>
                  <button className="g-chip sel" onClick={() => onEditDate(pickedList, allByName(pickedList))}>
                    {t("fixDates.changePicked", { count: picked.size })}
                  </button>
                  <button className="g-chip" onClick={() => keep(pickedList)}>
                    {t("fixDates.keepPicked", { count: picked.size })}
                  </button>
                </>
              )}
            </>
          ) : null}
        </div>
      </div>

      {rows.length === 0 && !reading ? (
        <div className="g-empty">
          <p className="g-empty-title">{t("fixDates.empty")}</p>
        </div>
      ) : (
        <div className="fd-list">
          {visible.map((r) => (
            <div key={r.uid} className={`fd-row${picked.has(r.uid) ? " sel" : ""}`}>
              <input
                type="checkbox"
                className="fd-check"
                checked={picked.has(r.uid)}
                onChange={() => toggle(r.uid)}
                aria-label={r.name}
              />
              <button className="fd-thumb" onClick={() => onView(rows.map((x) => x.uid), r.uid)} title={r.name}>
                {thumbs[r.uid] ? <img src={thumbs[r.uid]!} alt="" draggable={false} /> : <span className="g-skel" />}
              </button>
              <div className="fd-text">
                <span className="fd-name">{r.name || " "}</span>
                <span className="fd-why">{reason(r)}</span>
              </div>
              <button className="g-chip" onClick={() => keep([r.uid])}>
                {t("fixDates.keep")}
              </button>
              <button className="g-chip sel" onClick={() => onEditDate([r.uid], r.problem.kind === "name")}>
                {t(r.problem.kind === "name" ? "fixDates.useName" : "dateEdit.title")}
              </button>
            </div>
          ))}
          {rows.length > shownCount && (
            <button className="g-chip fd-more" onClick={() => setShownCount((n) => n + PAGE)}>
              {t("fixDates.more", { count: rows.length - shownCount })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
