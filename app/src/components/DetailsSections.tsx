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

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { rpc } from "../lib/rpc";
import { useLang, useT } from "../lib/i18n";
import { loadCities, nearestCity, type CityIndex } from "../lib/geocoder";
import citiesUrl from "../assets/geo/cities15000.tsv?url";
import {
  cameraName,
  cameraTiles,
  formatCoords,
  type CameraFacts,
} from "../lib/cameraFacts";
import { PlaceMap } from "./PlaceMap";
import { ChevronDownIcon } from "./icons";
import "../styles/ViewerDetails.css";

/** Which sections the reader folded, kept for the session so the next photo opens the same way. */
const folded = new Set<string>();

/** One titled block of the details panel, which folds away under its title. */
export function DetailsSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  const [closed, setClosed] = useState(() => folded.has(id));
  return (
    <section className={`dsec${closed ? " closed" : ""}`}>
      <button
        className="dsec-h"
        aria-expanded={!closed}
        onClick={() => {
          if (closed) folded.delete(id);
          else folded.add(id);
          setClosed(!closed);
        }}
      >
        <span>{title}</span>
        <ChevronDownIcon size={16} />
      </button>
      {!closed && <div className="dsec-b">{children}</div>}
    </section>
  );
}

/** How long, and how often, the camera facts are asked for while they are being read. */
const FACTS_POLL_MS = 500;
const FACTS_POLL_TRIES = 60;

/**
 * The camera behind a photo and its exposure, read from the photo's own EXIF by the sidecar.
 * `ready` waits until the viewer has fetched the photo itself, so the read takes the copy the
 * viewer holds rather than a second download. Nothing is shown for a photo that says nothing.
 */
export function CameraSection({
  uid,
  nodeDevice,
  ready,
}: {
  uid: string;
  /** The device the Drive node records, shown when the file's EXIF gives none. */
  nodeDevice: string | null;
  ready: boolean;
}) {
  const t = useT();
  const [read, setRead] = useState<{ uid: string; facts: CameraFacts | null } | null>(null);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    let timer = 0;
    let tries = 0;
    const ask = async () => {
      try {
        const reply = await rpc<{ state: "working" } | { state: "done"; facts: CameraFacts | null }>("cameraFacts", {
          uid,
        });
        if (!live) return;
        if (reply.state === "done") {
          setRead({ uid, facts: reply.facts });
          return;
        }
      } catch {
        if (live) setRead({ uid, facts: null });
        return;
      }
      if (++tries < FACTS_POLL_TRIES) timer = window.setTimeout(ask, FACTS_POLL_MS);
    };
    void ask();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [uid, ready]);

  const facts = read?.uid === uid ? read.facts : null;
  const name = cameraName(facts, nodeDevice);
  const tiles = facts ? cameraTiles(facts) : [];
  if (!name && !facts?.lens && tiles.length === 0) return null;

  const labels = {
    aperture: t("details.aperture"),
    shutter: t("details.shutter"),
    iso: t("details.iso"),
    focal: t("details.focal"),
  };
  return (
    <DetailsSection id="camera" title={t("details.camera")}>
      {(name || facts?.lens) && (
        <div>
          {name && <div className="cam-model">{name}</div>}
          {facts?.lens && <div className="cam-sub">{facts.lens}</div>}
        </div>
      )}
      {tiles.length > 0 && (
        <div className="cam-tiles">
          {tiles.map((tile) => (
            <div className="cam-tile" key={tile.key}>
              {tile.value}
              <small>{labels[tile.key]}</small>
            </div>
          ))}
        </div>
      )}
    </DetailsSection>
  );
}

const MAP_PREF = "viewer.placeMap";

function readMapPref(): boolean {
  try {
    return localStorage.getItem(MAP_PREF) === "on";
  } catch {
    return false;
  }
}

function writeMapPref(on: boolean): void {
  try {
    localStorage.setItem(MAP_PREF, on ? "on" : "off");
  } catch {
    /* the choice lasts this session only */
  }
}

/**
 * Where the photo was taken: the town it is nearest to, worked out on this computer, the
 * coordinates, and a small map. The map is drawn from OpenStreetMap tiles, so it is only
 * fetched once the reader asks for it, and the choice is remembered.
 */
export function PlaceSection({
  place,
  onChange,
}: {
  place: { lat: number; lon: number } | null;
  /** Opens the editor for the photo's place, when it can be changed. */
  onChange?: () => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const [cities, setCities] = useState<CityIndex | null>(null);
  const [mapOn, setMapOn] = useState(readMapPref);

  useEffect(() => {
    if (!place) return;
    let live = true;
    void loadCities(citiesUrl).then(
      (index) => live && setCities(index),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [place]);

  const country = useMemo(() => {
    try {
      const names = new Intl.DisplayNames([lang], { type: "region" });
      return (code: string) => names.of(code) ?? code;
    } catch {
      return (code: string) => code;
    }
  }, [lang]);

  if (!place && !onChange) return null;
  const city = place && cities ? nearestCity(cities, place.lat, place.lon) : null;

  return (
    <DetailsSection id="place" title={t("details.place")}>
      {place ? (
        <>
          {mapOn && <PlaceMap lat={place.lat} lon={place.lon} label={t("details.map")} />}
          <div>
            {city && (
              <div className="place-name">
                {city.name}, {country(city.country)}
              </div>
            )}
            <div className="place-sub">{formatCoords(place.lat, place.lon)}</div>
          </div>
        </>
      ) : (
        <div className="lbx-dim">{t("placeEdit.none")}</div>
      )}
      <div className="btnrow">
        {place && (
          <button
            className="linkbtn"
            onClick={() => {
              writeMapPref(!mapOn);
              setMapOn(!mapOn);
            }}
          >
            {t(mapOn ? "details.mapHide" : "details.mapShow")}
          </button>
        )}
        {onChange && (
          <button className="linkbtn" onClick={onChange}>
            {t("selection.editPlace")}
          </button>
        )}
      </div>
    </DetailsSection>
  );
}
