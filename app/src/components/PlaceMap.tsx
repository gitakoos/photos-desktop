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

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const ZOOM = 12;

/**
 * A small, fixed map with a pin at one place, for the viewer's details. It cannot be panned
 * or zoomed; it only shows where.
 */
export function PlaceMap({ lat, lon, label }: { lat: number; lon: number; label: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const map = L.map(host.current, {
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
    }).setView([lat, lon], ZOOM);
    map.attributionControl.setPrefix(false);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    L.marker([lat, lon], {
      icon: L.divIcon({
        className: "placemap-pinwrap",
        html: '<span class="placemap-pin"></span>',
        iconSize: [22, 30],
        iconAnchor: [11, 30],
      }),
      interactive: false,
      keyboard: false,
    }).addTo(map);
    return () => {
      map.remove();
    };
  }, [lat, lon]);

  return <div className="placemap" ref={host} role="img" aria-label={label} />;
}
