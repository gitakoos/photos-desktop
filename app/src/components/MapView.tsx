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
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useThumbnails } from "../hooks/useThumbnails";
import { cachedThumbnail } from "../lib/thumbStore";
import { useLang, useT } from "../lib/i18n";
import { groupByCity, loadCities, type Place } from "../lib/geocoder";
import citiesUrl from "../assets/geo/cities15000.tsv?url";
import { foldWord } from "../lib/dateQuery";
import { smoothZoom } from "../lib/smoothZoom";
import { ChevronRightIcon, CloseIcon, SearchIcon } from "./icons";
import "../styles/Map.css";

/** One photo on the map, with the time it was taken for picking the newest of a place. */
export type MapPoint = { uid: string; lat: number; lon: number; captureTime: number };

type Pin = { key: string; lat: number; lon: number; uids: string[]; cover: string };

/** How long after a zoom's last step the pins are grouped again for the new zoom. */
const REGROUP_AFTER_MS = 180;

/** How close, in screen pixels at the current zoom, two photos are to share a pin. */
const PIN_CELL_PX = 76;
/** The one world: the map stops at its edges and never repeats beside itself. */
const WORLD = L.latLngBounds([-85, -180], [85, 180]);
/** The closest the map frames the photos when it opens, so a single place is not a street. */
const FIT_MAX_ZOOM = 13;

/** The widest zoom at which one world still fills the map's width, so no edge shows past it. */
function fillZoom(map: L.Map): number {
  const width = map.getSize().x || 256;
  return Math.max(1, Math.ceil(Math.log2(width / 256)));
}

/**
 * Photos near one another on screen, grouped into one pin each: a grid over the map's own
 * pixel space at this zoom, so pins never overlap and split apart as the map zooms in. A
 * pin sits on the average of its photos and wears the newest one.
 */
function pinsAt(map: L.Map, points: MapPoint[]): Pin[] {
  const zoom = map.getZoom();
  const cells = new Map<string, MapPoint[]>();
  for (const p of points) {
    const at = map.project([p.lat, p.lon], zoom);
    const key = `${Math.floor(at.x / PIN_CELL_PX)}:${Math.floor(at.y / PIN_CELL_PX)}`;
    const cell = cells.get(key);
    if (cell) cell.push(p);
    else cells.set(key, [p]);
  }
  return [...cells.entries()].map(([key, cell]) => {
    let lat = 0;
    let lon = 0;
    let newest = cell[0];
    for (const p of cell) {
      lat += p.lat;
      lon += p.lon;
      if (p.captureTime > newest.captureTime) newest = p;
    }
    return { key, lat: lat / cell.length, lon: lon / cell.length, uids: cell.map((p) => p.uid), cover: newest.uid };
  });
}

function pinHtml(src: string | null | undefined, count: number): string {
  const img = src ? `<img src="${src}" alt="" draggable="false" />` : "";
  const badge = count > 1 ? `<span class="map-pincount">${count > 999 ? "999+" : count}</span>` : "";
  return `<div class="map-pin"><div class="map-pinbody">${img}</div>${badge}</div>`;
}

type Props = {
  points: MapPoint[];
  /** Places still being read from Drive, for the line at the top; null otherwise. */
  progress: { done: number; total: number } | null;
  /** Every place known has been looked up, so an empty map means there are none. */
  settled?: boolean;
  onOpen: (uids: string[]) => void;
  /** The page's name, floated over the map when the map takes the whole page. */
  title?: string;
  /** Opens one town's photos, named after it. */
  onOpenPlace?: (name: string, uids: string[]) => void;
};

/** Towns listed at most, the ones with the most photos first; the search reaches them all. */
const PLACE_LIST_LIMIT = 200;

/** Every photo that carries a place, on OpenStreetMap, one pin per neighbourhood. */
export function MapView({ points, progress, settled = true, onOpen, title, onOpenPlace }: Props) {
  const t = useT();
  const { lang } = useLang();
  // The towns the photos were taken in, from the shipped list, and the list's search.
  const [places, setPlaces] = useState<Place<MapPoint>[]>([]);
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    let live = true;
    if (points.length === 0) {
      setPlaces([]);
      return;
    }
    void loadCities(citiesUrl).then(
      (index) => {
        if (!live) return;
        setPlaces(
          groupByCity(index, points, (p) => p).map((place) => ({
            ...place,
            items: [...place.items].sort((a, b) => b.captureTime - a.captureTime),
          })),
        );
      },
      () => live && setPlaces([]),
    );
    return () => {
      live = false;
    };
  }, [points]);
  const countryName = useMemo(() => {
    const names = new Intl.DisplayNames([lang], { type: "region" });
    return (code: string) => {
      try {
        return names.of(code) ?? code;
      } catch {
        return code;
      }
    };
  }, [lang]);
  const shownPlaces = useMemo(() => {
    const q = foldWord(query);
    const matching = q
      ? places.filter((p) => foldWord(p.city.name).includes(q) || foldWord(countryName(p.city.country)).includes(q))
      : places;
    return matching.slice(0, PLACE_LIST_LIMIT);
  }, [places, query, countryName]);
  const placeCovers = useThumbnails(
    useMemo(() => (listOpen ? shownPlaces.map((p) => p.items[0].uid) : []), [listOpen, shownPlaces]),
  );
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const moved = useRef(false);
  /** Groups the pins for the zoom the map is at now, and notes that zoom (see the pins' effect). */
  const settleRegroup = useRef<(() => void) | null>(null);
  /** Set while the map moves by itself (framing the photos, flying to a place), not by the user. */
  const byApp = useRef(false);
  const pointsRef = useRef<MapPoint[]>([]);
  /** Runs a move the app makes by itself, so it is not taken for the user's. */
  const asApp = (move: () => void) => {
    byApp.current = true;
    try {
      move();
    } finally {
      byApp.current = false;
    }
  };
  /** Frames every photo, or the whole world when there are none yet. */
  const frame = () => {
    const map = mapRef.current;
    if (!map) return;
    const pts = pointsRef.current;
    if (pts.length === 0) {
      asApp(() => map.fitBounds(WORLD, { animate: false }));
      return;
    }
    const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lon] as [number, number]));
    asApp(() => map.fitBounds(bounds, { padding: [60, 60], maxZoom: FIT_MAX_ZOOM, animate: false }));
  };
  const [pins, setPins] = useState<Pin[]>([]);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!host.current) return;
    const map = L.map(host.current, {
      zoomControl: false,
      // New tiles take their place at once rather than cross-fading over the old level (which
      // still shows, scaled, until they arrive): two levels half-showing at a zoom's end.
      fadeAnimation: false,
      // Zooms are drawn a frame at a time instead (see smoothZoom): WebKitGTK showed the
      // view from before a zoom for a frame as Leaflet's CSS zoom ended.
      zoomAnimation: false,
      maxBounds: WORLD,
      maxBoundsViscosity: 1,
      maxZoom: 19,
    }).setView([30, 10], 2);
    smoothZoom(map);
    map.attributionControl.setPrefix(false);
    // Bottom right, beside the credit: the top corners belong to the page's title and the
    // places search.
    L.control.zoom({ position: "bottomright" }).addTo(map);
    map.on("click", () => setListOpen(false));
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      noWrap: true,
      bounds: WORLD,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    asApp(() => map.setMinZoom(fillZoom(map)));
    // The map follows its box: a new size sets a new widest zoom, and frames the photos
    // again until the user has moved the map themselves.
    const sized = new ResizeObserver(() => {
      asApp(() => {
        map.invalidateSize();
        // Not setMinZoom: below the new floor it zooms with an animation, and the floor holds
        // at once.
        const floor = fillZoom(map);
        map.options.minZoom = floor;
        if (map.getZoom() < floor) map.setZoom(floor, { animate: false });
      });
      if (!moved.current) frame();
    });
    sized.observe(host.current);
    const touched = () => {
      moved.current = true;
    };
    map.on("dragstart", touched);
    // Any zoom the app did not make is the user's: the buttons, a double-click, the keys, a
    // pinch, as well as the wheel. Left unmarked, the next batch of photos framed the map again
    // and threw it back to where it was.
    map.on("zoomstart", () => {
      if (!byApp.current) touched();
    });
    map.getContainer().addEventListener("wheel", touched, { passive: true });
    return () => {
      sized.disconnect();
      map.remove();
      // Their layer goes with the map: a map made again starts with no pins drawn.
      markers.current.clear();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // The pins follow the zoom; the photos arrive in batches, so the first ones also frame the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    pointsRef.current = points;
    const regroup = () => setPins(pinsAt(map, points));
    if (!moved.current) frame();
    regroup();
    // Once the zoom has settled, not at the end of each step of it: a turn of the wheel is
    // several quick steps, and pins grouped again after each one drew every grouping in
    // between for a frame or two, the pins of a moment ago coming and going. Between, the
    // pins ride the map's own zoom as they are.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const regroupSoon = () => {
      clearTimeout(settle);
      settle = setTimeout(() => settleRegroup.current?.(), REGROUP_AFTER_MS);
    };
    const holdOff = () => clearTimeout(settle);
    // A flight cut short (by a drag, say) ends with no zoomend: the zoom it
    // stopped at is grouped once the map has stopped.
    let grouped = map.getZoom();
    const regroupNow = regroup;
    const checkZoom = () => {
      if (map.getZoom() !== grouped) regroupSoon();
    };
    const regroupAndNote = () => {
      grouped = map.getZoom();
      regroupNow();
    };
    settleRegroup.current = regroupAndNote;
    map.on("zoomend", regroupSoon);
    map.on("zoomstart", holdOff);
    map.on("moveend", checkZoom);
    return () => {
      clearTimeout(settle);
      settleRegroup.current = null;
      map.off("zoomend", regroupSoon);
      map.off("zoomstart", holdOff);
      map.off("moveend", checkZoom);
    };
  }, [points]);

  const covers = useThumbnails(useMemo(() => pins.map((p) => p.cover), [pins]));

  // The pins on the map, kept from one change to the next: a pin still there keeps its marker,
  // and only one whose picture or count changed is drawn again. Clearing and rebuilding them
  // all at every zoom and every arriving picture made them blink.
  const markers = useRef(new Map<string, { marker: L.Marker; html: string; uids: string[] }>());
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const kept = markers.current;
    const now = new Set<string>();
    for (const pin of pins) {
      // By its newest photo and how many it holds, not by the grid cell of this zoom: a pin
      // that is the same group at the next zoom keeps its marker and picture, and moves.
      const key = `${pin.cover}|${pin.uids.length}`;
      now.add(key);
      // The picture from the shared cache at once when the hook has not handed it over yet:
      // a pin drawn empty and filled a frame later blinked.
      const html = pinHtml(covers[pin.cover] ?? cachedThumbnail(pin.cover), pin.uids.length);
      const icon = () => L.divIcon({ className: "map-pinwrap", html, iconSize: [56, 64], iconAnchor: [28, 64] });
      const have = kept.get(key);
      if (have) {
        have.uids = pin.uids;
        const at = have.marker.getLatLng();
        if (at.lat !== pin.lat || at.lng !== pin.lon) have.marker.setLatLng([pin.lat, pin.lon]);
        if (have.html !== html) {
          have.marker.setIcon(icon());
          have.html = html;
        }
        continue;
      }
      const entry = { marker: L.marker([pin.lat, pin.lon], { icon: icon(), keyboard: false }), html, uids: pin.uids };
      entry.marker.on("click", () => onOpenRef.current(entry.uids));
      layer.addLayer(entry.marker);
      kept.set(key, entry);
    }
    for (const [key, entry] of kept) {
      if (now.has(key)) continue;
      layer.removeLayer(entry.marker);
      kept.delete(key);
    }
  }, [pins, covers]);

  /** Takes the map to a town, close enough to tell its streets apart. */
  const flyTo = (place: Place<MapPoint>) => {
    moved.current = true;
    mapRef.current?.flyTo([place.city.lat, place.city.lon], 12, { duration: 0.8 });
  };

  return (
    <div className="map-view">
      <div ref={host} className="map-canvas" />
      {title && <div className="map-titlepill">{title}</div>}
      {places.length > 0 && (
        <div className={`map-places${listOpen ? " open" : ""}`}>
          <div className="map-placesearch">
            <SearchIcon size={16} />
            <input
              value={query}
              placeholder={t("map.searchPlaces")}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                setListOpen(true);
              }}
              onFocus={() => setListOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setListOpen(false);
                  e.currentTarget.blur();
                } else if (e.key === "Enter" && shownPlaces[0]) {
                  flyTo(shownPlaces[0]);
                }
              }}
            />
            {listOpen && (
              <button
                className="map-placeclose"
                title={t("common.close")}
                onClick={() => {
                  setListOpen(false);
                  setQuery("");
                }}
              >
                <CloseIcon size={14} />
              </button>
            )}
          </div>
          {listOpen && (
            <ul className="map-placelist">
              {shownPlaces.map((place) => (
                <li key={place.key} className="map-placerow">
                  <button className="map-place" onClick={() => flyTo(place)}>
                    <span className="map-placethumb">
                      {placeCovers[place.items[0].uid] ? (
                        <img src={placeCovers[place.items[0].uid]!} alt="" draggable={false} />
                      ) : null}
                    </span>
                    <span className="map-placetext">
                      <span className="map-placename">{place.city.name}</span>
                      <span className="map-placesub">
                        {countryName(place.city.country)} ·{" "}
                        {t(place.items.length === 1 ? "common.photoCount.one" : "common.photoCount.other", {
                          count: place.items.length,
                        })}
                      </span>
                    </span>
                  </button>
                  {onOpenPlace && (
                    <button
                      className="map-placeopen"
                      title={t("map.showPhotos")}
                      aria-label={t("map.showPhotos")}
                      onClick={() => onOpenPlace(place.city.name, place.items.map((i) => i.uid))}
                    >
                      <ChevronRightIcon size={18} />
                    </button>
                  )}
                </li>
              ))}
              {shownPlaces.length === 0 && <li className="map-placeempty">{t("map.noPlaces")}</li>}
            </ul>
          )}
        </div>
      )}
      {progress && (
        <div className="map-progress">{t("library.mapLoading", { done: progress.done, total: progress.total })}</div>
      )}
      {!progress && settled && points.length === 0 && <div className="map-progress">{t("library.mapEmpty")}</div>}
    </div>
  );
}
