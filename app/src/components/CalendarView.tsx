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
import { useThumbnails } from "../hooks/useThumbnails";
import {
  bucketByDay,
  dayKey,
  monthCells,
  monthKeyOf,
  monthTotals,
  monthsWithPhotos,
  stepMonth,
  weekStart,
  yearSpan,
} from "../lib/calendarDays";
import { locale } from "../lib/format";
import { useT } from "../lib/i18n";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "./icons";
import "../styles/Calendar.css";

export type CalendarMonth = { year: number; month: number };

/** A date in the reader's locale, for a day's page title and a cell's label. */
export function dayTitle(year: number, month: number, day: number): string {
  return new Date(year, month, day).toLocaleDateString(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * A month at a time: each day that holds photos shows its newest one and how many there are, today
 * is marked, and a day opens as the timeline narrowed to it. The month steps with the arrows,
 * Page Up and Page Down, and the title opens a picker that jumps to any month that holds photos.
 */
export function CalendarView({
  items,
  month,
  onMonth,
  onOpenDay,
}: {
  /** The photos the timeline shows, newest first, hidden ones left out. */
  items: { uid: string; captureTime: number }[];
  /** The month shown, or null for the newest month that holds photos. */
  month: CalendarMonth | null;
  onMonth: (month: CalendarMonth) => void;
  onOpenDay: (title: string, uids: string[]) => void;
}) {
  const t = useT();
  const days = useMemo(() => bucketByDay(items), [items]);
  const withPhotos = useMemo(() => monthsWithPhotos(days), [days]);
  const years = useMemo(() => yearSpan(days), [days]);
  const now = new Date();
  const today = dayKey(now.getTime());
  const shown = useMemo<CalendarMonth>(() => {
    if (month) return month;
    const newest = items[0] ? new Date(items[0].captureTime) : now;
    return { year: newest.getFullYear(), month: newest.getMonth() };
    // `now` only matters while the list is empty, and the month then is this one either way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, items]);

  const first = useMemo(() => weekStart(locale), []);
  const cells = useMemo(() => monthCells(shown.year, shown.month, first), [shown, first]);
  const totals = monthTotals(days, shown.year, shown.month);
  const covers = useThumbnails(
    useMemo(() => {
      const out: string[] = [];
      for (let d = 1; d <= 31; d++) {
        const b = days.get(`${monthKeyOf(shown.year, shown.month)}-${String(d).padStart(2, "0")}`);
        if (b) out.push(b.cover);
      }
      return out;
    }, [days, shown]),
  );

  const monthName = (m: number, style: "long" | "short") =>
    new Date(2000, m, 1).toLocaleDateString(locale, { month: style });
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        // 2024-01-01 is a Monday; `first` is 1 for Monday.
        new Date(2024, 0, 1 + ((first - 1 + i) % 7)).toLocaleDateString(locale, { weekday: "short" }),
      ),
    [first],
  );

  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpYear, setJumpYear] = useState(shown.year);
  const jumpRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!jumpOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!jumpRef.current?.contains(e.target as Node)) setJumpOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setJumpOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [jumpOpen]);

  const step = (by: number) => onMonth(stepMonth(shown.year, shown.month, by));
  const yearList = useMemo(() => {
    if (!years) return [now.getFullYear()];
    const out: number[] = [];
    for (let y = years[1]; y >= years[0]; y--) out.push(y);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years]);

  if (items.length === 0) {
    return (
      <div className="g-empty">
        <p className="g-empty-title">{t("calendar.empty")}</p>
      </div>
    );
  }

  const atToday = shown.year === now.getFullYear() && shown.month === now.getMonth();
  const photoLabel = (n: number) => t(n === 1 ? "common.photoCount.one" : "common.photoCount.other", { count: n });

  return (
    <div
      className="cal"
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === "PageUp") {
          e.preventDefault();
          step(-1);
        } else if (e.key === "PageDown") {
          e.preventDefault();
          step(1);
        }
      }}
    >
      <div className="cal-bar">
        <button className="cal-nav" onClick={() => step(-1)} title={t("calendar.prev")} aria-label={t("calendar.prev")}>
          <ChevronLeftIcon size={18} />
        </button>
        <div className="cal-titlewrap" ref={jumpRef}>
          <button
            className="cal-title"
            aria-haspopup="dialog"
            aria-expanded={jumpOpen}
            title={t("calendar.jump")}
            onClick={() => {
              setJumpYear(shown.year);
              setJumpOpen((o) => !o);
            }}
          >
            <span>
              {monthName(shown.month, "long")} {shown.year}
            </span>
            <ChevronDownIcon size={16} />
          </button>
          {jumpOpen && (
            <div className="cal-jump" role="dialog" aria-label={t("calendar.jump")}>
              <div className="cal-yrs">
                {yearList.map((y) => (
                  <button key={y} className={`cal-chip${y === jumpYear ? " on" : ""}`} onClick={() => setJumpYear(y)}>
                    {y}
                  </button>
                ))}
              </div>
              <div className="cal-mons">
                {Array.from({ length: 12 }, (_, m) => {
                  const has = withPhotos.has(monthKeyOf(jumpYear, m));
                  return (
                    <button
                      key={m}
                      className={`cal-chip${jumpYear === shown.year && m === shown.month ? " on" : ""}`}
                      disabled={!has}
                      onClick={() => {
                        onMonth({ year: jumpYear, month: m });
                        setJumpOpen(false);
                      }}
                    >
                      {monthName(m, "short")}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <button className="cal-nav" onClick={() => step(1)} title={t("calendar.next")} aria-label={t("calendar.next")}>
          <ChevronRightIcon size={18} />
        </button>
        <button className="cal-today" disabled={atToday} onClick={() => onMonth({ year: now.getFullYear(), month: now.getMonth() })}>
          {t("calendar.today")}
        </button>
        <span className="cal-sum">
          {totals.photos > 0
            ? `${photoLabel(totals.photos)}, ${t(totals.days === 1 ? "calendar.dayCount.one" : "calendar.dayCount.other", { count: totals.days })}`
            : t("calendar.noneThisMonth")}
        </span>
      </div>

      <div className="cal-wd" aria-hidden>
        {weekdays.map((w, i) => (
          <div key={i}>{w}</div>
        ))}
      </div>
      <div className="cal-days">
        {cells.map((d, i) => {
          if (d === null) return <div key={`b${i}`} />;
          const key = `${monthKeyOf(shown.year, shown.month)}-${String(d).padStart(2, "0")}`;
          const bucket = days.get(key);
          const future = key > today;
          const cls = `cal-d${bucket ? " has" : ""}${key === today ? " today" : ""}${future ? " future" : ""}`;
          const inner = (
            <>
              <div className="cal-dn">
                <b>{d}</b>
                {bucket && <em>{bucket.uids.length}</em>}
              </div>
              <div className="cal-th">
                {bucket && covers[bucket.cover] ? <img src={covers[bucket.cover]!} alt="" draggable={false} /> : null}
              </div>
            </>
          );
          if (!bucket) return <div key={key} className={cls}>{inner}</div>;
          const title = dayTitle(shown.year, shown.month, d);
          return (
            <button
              key={key}
              className={cls}
              aria-label={`${title}, ${photoLabel(bucket.uids.length)}`}
              onClick={() => onOpenDay(title, bucket.uids)}
            >
              {inner}
            </button>
          );
        })}
      </div>
    </div>
  );
}
