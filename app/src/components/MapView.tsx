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
import { useLang, useT } from "../lib/i18n";
import { groupByCity, loadCities, type Place } from "../lib/geocoder";
import citiesUrl from "../assets/geo/cities15000.tsv?url";
import { foldWord } from "../lib/dateQuery";
import { ChevronRightIcon, CloseIcon, SearchIcon } from "./icons";
import "../styles/Map.css";

/** One photo on the map, with the time it was taken for picking the newest of a place. */
export type MapPoint = { uid: string; lat: number; lon: number; captureTime: number };

type Pin = { key: string; lat: number; lon: number; uids: string[]; cover: string };

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
  /** Places still being read, for the line at the top; null once all are in. */
  progress: { done: number; total: number } | null;
  onOpen: (uids: string[]) => void;
  /** The page's name, floated over the map when the map takes the whole page. */
  title?: string;
  /** Opens one town's photos, named after it. */
  onOpenPlace?: (name: string, uids: string[]) => void;
};

/** Towns listed at most, the ones with the most photos first; the search reaches them all. */
const PLACE_LIST_LIMIT = 200;

/** Every photo that carries a place, on OpenStreetMap, one pin per neighbourhood. */
export function MapView({ points, progress, onOpen, title, onOpenPlace }: Props) {
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
  const pointsRef = useRef<MapPoint[]>([]);
  /** Frames every photo, or the whole world when there are none yet. */
  const frame = () => {
    const map = mapRef.current;
    if (!map) return;
    const pts = pointsRef.current;
    if (pts.length === 0) {
      map.fitBounds(WORLD);
      return;
    }
    const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lon] as [number, number]));
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: FIT_MAX_ZOOM });
  };
  const [pins, setPins] = useState<Pin[]>([]);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!host.current) return;
    const map = L.map(host.current, {
      zoomControl: false,
      maxBounds: WORLD,
      maxBoundsViscosity: 1,
      maxZoom: 19,
    }).setView([30, 10], 2);
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
    map.setMinZoom(fillZoom(map));
    // The map follows its box: a new size sets a new widest zoom, and frames the photos
    // again until the user has moved the map themselves.
    const sized = new ResizeObserver(() => {
      map.invalidateSize();
      map.setMinZoom(fillZoom(map));
      if (!moved.current) frame();
    });
    sized.observe(host.current);
    const touched = () => {
      moved.current = true;
    };
    map.on("dragstart", touched);
    map.getContainer().addEventListener("wheel", touched, { passive: true });
    return () => {
      sized.disconnect();
      map.remove();
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
    map.on("zoomend", regroup);
    return () => {
      map.off("zoomend", regroup);
    };
  }, [points]);

  const covers = useThumbnails(useMemo(() => pins.map((p) => p.cover), [pins]));

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const pin of pins) {
      const marker = L.marker([pin.lat, pin.lon], {
        icon: L.divIcon({ className: "map-pinwrap", html: pinHtml(covers[pin.cover], pin.uids.length), iconSize: [56, 64], iconAnchor: [28, 64] }),
        keyboard: false,
      });
      marker.on("click", () => onOpenRef.current(pin.uids));
      layer.addLayer(marker);
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
      {!progress && points.length === 0 && <div className="map-progress">{t("library.mapEmpty")}</div>}
    </div>
  );
}
