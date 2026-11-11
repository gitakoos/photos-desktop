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

import { useMemo } from "react";
import { FaceCover } from "./Library";
import { useThumbnails } from "../hooks/useThumbnails";
import { useT } from "../lib/i18n";
import type { PersonFace } from "../lib/localFaces";
import "../styles/Library.css";

/** At most this many faces are drawn in the strip. */
const MAX_STRIP_FACES = 80;

/** A person's faces above their photos, the best first, each opening the photo it is on. */
export function FaceStrip({ faces, onOpen }: { faces: PersonFace[]; onOpen: (uid: string) => void }) {
  const t = useT();
  const strip = useMemo(() => faces.slice(0, MAX_STRIP_FACES), [faces]);
  const thumbs = useThumbnails(useMemo(() => [...new Set(strip.map((f) => f.uid))], [strip]));
  return (
    <section className="lib-strip">
      <h3 className="lib-strip-title">{t("faces.strip", { count: faces.length })}</h3>
      <div className="lib-strip-row">
        {strip.map((f, i) => (
          <button key={`${f.uid}:${i}`} className="lib-strip-face" aria-label={t("faces.open")} onClick={() => onOpen(f.uid)}>
            {thumbs[f.uid] ? (
              <span className="lib-facebox">
                <FaceCover uid={f.uid} thumb={thumbs[f.uid]!} box={f.box} />
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );
}
