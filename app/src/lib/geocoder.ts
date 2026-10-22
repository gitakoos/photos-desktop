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

// The town a photo was taken in, worked out on this computer from the same GeoNames list of
// towns over 15,000 people the Android app ships: the nearest one to the photo's place. No
// coordinate leaves the device.

export type City = { name: string; lat: number; lon: number; country: string };
export type CityIndex = { cities: City[]; cells: Map<string, number[]> };

/** One degree of latitude and longitude a cell. */
const cellOf = (lat: number, lon: number) => `${Math.floor(lat)}:${Math.floor(lon)}`;

/** The list as the app ships it: one town a line, name, latitude, longitude, country code. */
export function parseCities(text: string): CityIndex {
  const cities: City[] = [];
  const cells = new Map<string, number[]>();
  for (const line of text.split("\n")) {
    const [name, lat, lon, country] = line.split("\t");
    const la = Number(lat);
    const lo = Number(lon);
    if (!name || !country || !Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const at = cities.push({ name, lat: la, lon: lo, country: country.trim() }) - 1;
    const key = cellOf(la, lo);
    const cell = cells.get(key);
    if (cell) cell.push(at);
    else cells.set(key, [at]);
  }
  return { cities, cells };
}

/** The nearest town to a place, looking out ring by ring from its cell; null when none is
 *  within a few degrees, out at sea. Distance as the Android app measures it: a degree of
 *  longitude shrinks toward the poles. */
export function nearestCity(index: CityIndex, lat: number, lon: number): City | null {
  const scale = Math.cos((lat * Math.PI) / 180);
  const cy = Math.floor(lat);
  const cx = Math.floor(lon);
  let best: City | null = null;
  let bestD = Infinity;
  for (let ring = 0; ring <= 3; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        for (const i of index.cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const c = index.cities[i];
          const d = (c.lat - lat) ** 2 + ((c.lon - lon) * scale) ** 2;
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
    }
    // Anything in a further ring is at least `ring` degrees off; stop once the best is closer.
    if (best && Math.sqrt(bestD) <= ring * Math.min(1, scale)) break;
  }
  return best;
}

export type Place<T> = { key: string; city: City; items: T[] };

/** Groups items by the town they were taken in, the town with the most first. */
export function groupByCity<T>(
  index: CityIndex,
  items: T[],
  at: (item: T) => { lat: number; lon: number },
): Place<T>[] {
  const places = new Map<string, Place<T>>();
  for (const item of items) {
    const { lat, lon } = at(item);
    const city = nearestCity(index, lat, lon);
    if (!city) continue;
    const key = `${city.name}|${city.country}`;
    let place = places.get(key);
    if (!place) places.set(key, (place = { key, city, items: [] }));
    place.items.push(item);
  }
  return [...places.values()].sort((a, b) => b.items.length - a.items.length || a.city.name.localeCompare(b.city.name));
}

let shipped: Promise<CityIndex> | null = null;

/** The shipped list, read once. */
export function loadCities(url: string): Promise<CityIndex> {
  if (!shipped) {
    shipped = fetch(url)
      .then((r) => r.text())
      .then(parseCities);
    shipped.catch(() => {
      shipped = null;
    });
  }
  return shipped;
}
