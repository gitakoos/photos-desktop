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

// The Collection's groupings, by the Android app's rules: "On this day" a milestone number
// of years ago, and the photos of each season. Items arrive newest first, as the timeline
// holds them, and each group keeps that order, so its first photo is its newest.

export type Dated = { uid: string; captureTime: number };

/** The anniversaries a memory marks; the years between are skipped so each is a real jump. */
export const MILESTONE_YEARS = [1, 2, 5, 10];

/** The first moment of the local day `yearsAgo` years before `now`. A 29 February with no
 *  match that year falls on the 28th, as a calendar adding years does. */
function dayStart(now: Date, yearsAgo: number): number {
  const d = new Date(now.getFullYear() - yearsAgo, now.getMonth(), 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(now.getDate(), lastDay));
  return d.getTime();
}

/** The photos taken on today's date 1, 2, 5 and 10 years ago, the latest anniversary first;
 *  an anniversary with none is left out. */
export function onThisDay(items: Dated[], now = new Date()): { yearsAgo: number; uids: string[] }[] {
  const out: { yearsAgo: number; uids: string[] }[] = [];
  for (const yearsAgo of MILESTONE_YEARS) {
    const from = dayStart(now, yearsAgo);
    const start = new Date(from);
    const until = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime();
    const uids = items.filter((it) => it.captureTime >= from && it.captureTime < until).map((it) => it.uid);
    if (uids.length > 0) out.push({ yearsAgo, uids });
  }
  return out;
}

export type Season = "spring" | "summer" | "autumn" | "winter";

/** Within one season-year, the later season first: winter closes the year, spring opens it. */
const SEASON_RANK: Record<Season, number> = { spring: 0, summer: 1, autumn: 2, winter: 3 };

/**
 * Every photo by meteorological season. A winter is named by the December it starts in, so
 * January and February belong to the winter of the year before. The latest season first,
 * and a photo with no known time is in none.
 */
export function seasons(items: Dated[]): { season: Season; year: number; uids: string[] }[] {
  const groups = new Map<string, { season: Season; year: number; uids: string[] }>();
  for (const it of items) {
    if (!(it.captureTime > 0)) continue;
    const d = new Date(it.captureTime);
    const month = d.getMonth() + 1;
    const season: Season =
      month === 12 || month <= 2 ? "winter" : month <= 5 ? "spring" : month <= 8 ? "summer" : "autumn";
    const year = month <= 2 ? d.getFullYear() - 1 : d.getFullYear();
    const key = `${year}:${season}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { season, year, uids: [] }));
    group.uids.push(it.uid);
  }
  return [...groups.values()].sort((a, b) => b.year - a.year || SEASON_RANK[b.season] - SEASON_RANK[a.season]);
}
