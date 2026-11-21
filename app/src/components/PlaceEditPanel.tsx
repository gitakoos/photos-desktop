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
import { CloseIcon, SearchIcon } from "./icons";
import { rpc } from "../lib/rpc";
import { useLang, useT } from "../lib/i18n";
import { loadCities, nearestCity, searchCities, type City, type CityIndex } from "../lib/geocoder";
import citiesUrl from "../assets/geo/cities15000.tsv?url";
import { errorText, type DateEditInfo, type DateEditStatus } from "../lib/dateEdit";
import { placeChange, type PlacePoint } from "../lib/placeEdit";
import "../styles/Library.css";
import "../styles/Settings.css";
import "../styles/DateEdit.css";
import "../styles/Map.css";

const WORLD = L.latLngBounds([-85, -180], [85, 180]);
const PIN_ZOOM = 12;

/**
 * Sets or takes away the place of the chosen photos, as the phone's editor does: a pin dropped on
 * the map or a town picked from the list. A side panel beside the grid, with every photo's old and
 * new place before anything is changed, and the run's progress after.
 */
export function PlaceEditPanel({
  uids,
  status,
  onStarted,
  onClose,
  top = 0,
  embedded = false,
}: {
  uids: string[];
  status: DateEditStatus | null;
  onStarted: () => void;
  onClose: () => void;
  top?: number;
  /** Inside the viewer's docked side, which places it, rather than beside the grid. */
  embedded?: boolean;
}) {
  const t = useT();
  const { lang } = useLang();
  const regions = useMemo(() => {
    try {
      return new Intl.DisplayNames([lang], { type: "region" });
    } catch {
      return null;
    }
  }, [lang]);
  const country = (code: string) => {
    try {
      return regions?.of(code) ?? code;
    } catch {
      return code;
    }
  };
  const [info, setInfo] = useState<DateEditInfo[] | null>(null);
  const [error, setError] = useState("");
  const [pin, setPin] = useState<PlacePoint | null>(null);
  const [remove, setRemove] = useState(false);
  const [query, setQuery] = useState("");
  const [cities, setCities] = useState<CityIndex | null>(null);
  const [started, setStarted] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    let live = true;
    void rpc<DateEditInfo[]>("dateEditInfo", { uids })
      .then((list) => {
        if (!live) return;
        setInfo(list);
        const first = list.find((i) => i.place);
        if (first?.place && list.length === 1) setPin({ lat: first.place[0], lon: first.place[1] });
      })
      .catch((e) => live && setError(String(e)));
    void loadCities(citiesUrl).then(
      (index) => live && setCities(index),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [uids.join(",")]);

  useEffect(() => {
    if (!host.current) return;
    const map = L.map(host.current, {
      zoomControl: false,
      maxBounds: WORLD,
      maxBoundsViscosity: 1,
      maxZoom: 19,
      minZoom: 1,
    }).setView([30, 10], 1);
    map.attributionControl.setPrefix(false);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      noWrap: true,
      bounds: WORLD,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => {
      setRemove(false);
      setPin({ lat: e.latlng.lat, lon: L.Util.wrapNum(e.latlng.lng, [-180, 180], true) });
    });
    mapRef.current = map;
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(host.current);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // The pin on the map follows the chosen place; the first time it is set the map goes to it.
  const framed = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!pin || remove) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const icon = L.divIcon({ className: "pe-pin", html: '<div class="pe-pinhead"></div>', iconSize: [22, 22], iconAnchor: [11, 22] });
    if (markerRef.current) markerRef.current.setLatLng([pin.lat, pin.lon]);
    else markerRef.current = L.marker([pin.lat, pin.lon], { icon, keyboard: false }).addTo(map);
    if (!framed.current) {
      framed.current = true;
      map.setView([pin.lat, pin.lon], PIN_ZOOM);
    }
  }, [pin, remove]);

  const suggestions = useMemo(() => (cities && query.trim() ? searchCities(cities, query, 8) : []), [cities, query]);

  function pickCity(city: City) {
    setRemove(false);
    setPin({ lat: city.lat, lon: city.lon });
    setQuery("");
    mapRef.current?.setView([city.lat, city.lon], PIN_ZOOM);
    framed.current = true;
  }

  const target: PlacePoint | null | undefined = remove ? null : pin ?? undefined;
  const rows = useMemo(() => (info ?? []).map((item) => ({ item, next: placeChange(item, target) })), [info, target]);
  const changes = rows.filter((r) => r.next.kind === "change");
  const anyPlaced = (info ?? []).some((i) => i.place && !i.blocked);

  const placeName = (p: [number, number] | PlacePoint | null) => {
    if (!p) return "";
    const lat = Array.isArray(p) ? p[0] : p.lat;
    const lon = Array.isArray(p) ? p[1] : p.lon;
    const city = cities ? nearestCity(cities, lat, lon) : null;
    return city ? `${city.name}, ${country(city.country)}` : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  };

  async function start() {
    if (changes.length === 0 || target === undefined) return;
    setError("");
    try {
      await rpc("startDateEdit", {
        items: changes.map((r) => ({ uid: r.item.uid, captureMs: 0, place: target })),
      });
      setStarted(true);
      onStarted();
    } catch (e) {
      setError(String(e));
    }
  }

  const running = !!status?.running;
  const showRun = started || running;

  return (
    <aside
      className={embedded ? "de-panel de-embedded pe-panel" : "lib-findpanel de-panel pe-panel"}
      style={embedded ? undefined : { top }}
      aria-label={t("placeEdit.title")}
    >
      <div className="lib-findhead">
        <h2 className="lib-findtitle">{t("placeEdit.title")}</h2>
        <button className="lib-findclose" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
          <CloseIcon size={18} />
        </button>
      </div>

      {showRun && status ? (
        <div className="lib-findsweep">
          <p className="lib-findnote">
            {running
              ? t("placeEdit.running", { done: status.done, total: status.total })
              : t("placeEdit.done", { changed: status.changed, failed: status.failed })}
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
              {status.errors.slice(-20).map((e, i) => (
                <li key={`${e.uid}-${i}`}>{errorText(e, t)}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="lib-findsweep">
          <div className="pe-search">
            <SearchIcon size={15} />
            <input
              className="pe-searchinput"
              type="search"
              value={query}
              placeholder={t("placeEdit.search")}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && suggestions[0]) pickCity(suggestions[0]);
              }}
            />
            {suggestions.length > 0 && (
              <ul className="pe-suggest" role="listbox">
                {suggestions.map((c) => (
                  <li key={`${c.name}|${c.lat}|${c.lon}`}>
                    <button className="pe-suggestbtn" onClick={() => pickCity(c)}>
                      <span>{c.name}</span>
                      <span className="pe-country">{country(c.country)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={`pe-map${remove ? " off" : ""}`} ref={host} />
          <p className="lib-findnote">
            {remove ? t("placeEdit.removing") : pin ? placeName(pin) : t("placeEdit.hint")}
          </p>
          {anyPlaced && (
            <label className="pe-remove">
              <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.currentTarget.checked)} />
              <span>{t("placeEdit.remove")}</span>
            </label>
          )}
          <p className="lib-findnote">{t("placeEdit.note")}</p>
          <button className="de-start" disabled={!info || changes.length === 0} onClick={() => void start()}>
            {changes.length > 0
              ? t(remove ? "placeEdit.startRemove" : "placeEdit.start", { count: changes.length })
              : t("placeEdit.title")}
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
                    {item.place ? placeName(item.place) : t("placeEdit.none")}
                  </span>
                  {next.kind === "change" ? (
                    <span className="de-new">{next.place ? placeName(next.place) : t("placeEdit.none")}</span>
                  ) : next.kind === "pick" ? null : (
                    <span className="de-skip">{t(`placeEdit.${next.kind}`)}</span>
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
