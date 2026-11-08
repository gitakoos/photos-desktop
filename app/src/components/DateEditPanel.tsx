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
import { CloseIcon } from "./icons";
import { rpc } from "../lib/rpc";
import { useLang, useT } from "../lib/i18n";
import { newCaptureTime, type DateEditInfo, type DateEditMode, type DateEditStatus, type Shift } from "../lib/dateEdit";
import "../styles/Library.css";
import "../styles/Settings.css";
import "../styles/DateEdit.css";

const pad = (n: number) => String(n).padStart(2, "0");
const dateField = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const timeField = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Changes the capture date of the chosen photos, as the phone's editor does: one date for all,
 * the same shift for each, or the date each file name records. A side panel beside the grid, with
 * every photo's old and new date before anything is changed, and the run's progress after.
 */
export function DateEditPanel({
  uids,
  status,
  onStarted,
  onClose,
  top = 0,
  initialMode = "set",
  embedded = false,
}: {
  uids: string[];
  status: DateEditStatus | null;
  onStarted: () => void;
  onClose: () => void;
  top?: number;
  /** Inside the viewer's docked side, which places it, rather than beside the grid. */
  embedded?: boolean;
  /** The way the panel opens: Fix dates opens it on the names' dates for photos named with one. */
  initialMode?: DateEditMode;
}) {
  const t = useT();
  const { lang } = useLang();
  const [info, setInfo] = useState<DateEditInfo[] | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<DateEditMode>(initialMode);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [shift, setShift] = useState<Shift>({ days: 0, hours: 0, minutes: 0 });
  const [started, setStarted] = useState(false);
  // One photo gets a date and a time; several get the day, each keeping its own time.
  const single = uids.length === 1;

  useEffect(() => {
    let live = true;
    void rpc<DateEditInfo[]>("dateEditInfo", { uids })
      .then((list) => {
        if (!live) return;
        setInfo(list);
        const first = list.find((i) => i.captureMs > 0);
        if (first) {
          setDate(dateField(first.captureMs));
          setTime(timeField(first.captureMs));
        }
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [uids.join(",")]);

  const fmt = useMemo(
    () => new Intl.DateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    [lang],
  );

  const rows = useMemo(
    () => (info ?? []).map((item) => ({ item, next: newCaptureTime(item, mode, { date, time: single ? time : "", shift }) })),
    [info, mode, date, time, shift, single],
  );
  const changes = rows.filter((r) => r.next.kind === "change");

  async function start() {
    if (changes.length === 0) return;
    setError("");
    try {
      await rpc("startDateEdit", {
        items: changes.map((r) => ({ uid: r.item.uid, captureMs: r.next.kind === "change" ? r.next.captureMs : 0 })),
      });
      setStarted(true);
      onStarted();
    } catch (e) {
      setError(String(e));
    }
  }

  const running = !!status?.running;
  const showRun = started || running;

  const shiftField = (key: keyof Shift, label: string) => (
    <label className="de-shift">
      <span>{label}</span>
      <input
        className="de-input"
        type="number"
        inputMode="numeric"
        value={shift[key]}
        onChange={(e) => setShift((s) => ({ ...s, [key]: Math.trunc(Number(e.currentTarget.value) || 0) }))}
      />
    </label>
  );

  return (
    <aside
      className={embedded ? "de-panel de-embedded" : "lib-findpanel de-panel"}
      style={embedded ? undefined : { top }}
      aria-label={t("dateEdit.title")}
    >
      <div className="lib-findhead">
        <h2 className="lib-findtitle">{t("dateEdit.title")}</h2>
        <button className="lib-findclose" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
          <CloseIcon size={18} />
        </button>
      </div>

      {showRun && status ? (
        <div className="lib-findsweep">
          <p className="lib-findnote">
            {running
              ? t("dateEdit.running", { done: status.done, total: status.total })
              : t("dateEdit.done", { changed: status.changed, failed: status.failed })}
          </p>
          <div className="lib-findbar">
            <div className="de-barfill" style={{ width: `${status.total > 0 ? (100 * status.done) / status.total : 0}%` }} />
          </div>
          {running && (
            <button className="lib-suggestbtn" onClick={() => void rpc("stopDateEdit").catch(() => {})}>
              {t("dateEdit.stop")}
            </button>
          )}
          {status.errors.length > 0 && (
            <ul className="de-errors">
              {status.errors.slice(-20).map((e) => (
                <li key={e.uid}>{e.error}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="lib-findsweep">
          <div className="st-seg" role="group" aria-label={t("dateEdit.title")}>
            {(["set", "shift", "name"] as DateEditMode[]).map((m) => (
              <button key={m} className={`st-seg-btn${mode === m ? " on" : ""}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {t(m === "set" ? "dateEdit.modeSet" : m === "shift" ? "dateEdit.modeShift" : "dateEdit.modeName")}
              </button>
            ))}
          </div>
          {mode === "set" && (
            <div className="de-fields">
              <label className="de-shift">
                <span>{t("dateEdit.date")}</span>
                <input className="de-input" type="date" value={date} onChange={(e) => setDate(e.currentTarget.value)} />
              </label>
              {single && (
                <label className="de-shift">
                  <span>{t("dateEdit.time")}</span>
                  <input className="de-input" type="time" value={time} onChange={(e) => setTime(e.currentTarget.value)} />
                </label>
              )}
            </div>
          )}
          {mode === "set" && !single && <p className="lib-findnote">{t("dateEdit.keepTimes")}</p>}
          {mode === "shift" && (
            <>
              <div className="de-fields">
                {shiftField("days", t("dateEdit.days"))}
                {shiftField("hours", t("dateEdit.hours"))}
                {shiftField("minutes", t("dateEdit.minutes"))}
              </div>
              <p className="lib-findnote">{t("dateEdit.shiftHint")}</p>
            </>
          )}
          <p className="lib-findnote">{t("dateEdit.note")}</p>
          <button className="de-start" disabled={!info || changes.length === 0} onClick={() => void start()}>
            {changes.length > 0 ? t("dateEdit.start", { count: changes.length }) : t("dateEdit.title")}
          </button>
        </div>
      )}

      <div className="lib-findlist">
        {error && <p className="lib-findnote de-error">{error}</p>}
        {!info && !error && <p className="lib-findnote">{t("dateEdit.reading")}</p>}
        {info && (
          <ul className="de-rows">
            {rows.map(({ item, next }) => (
              <li key={item.uid} className="de-row">
                <span className="de-name" title={item.name}>
                  {item.name || "?"}
                </span>
                <span className="de-dates">
                  <span className={next.kind === "change" ? "de-old" : undefined}>
                    {item.captureMs > 0 ? fmt.format(item.captureMs) : ""}
                  </span>
                  {next.kind === "change" ? (
                    <span className="de-new">{fmt.format(next.captureMs)}</span>
                  ) : (
                    <span className="de-skip">{t(`dateEdit.${next.kind}`)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
