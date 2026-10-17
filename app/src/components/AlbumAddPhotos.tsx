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
import { PhotoGrid } from "./PhotoGrid";
import { VirtualSections } from "./VirtualSections";
import { CloseIcon } from "./icons";
import { useT } from "../lib/i18n";
import { locale } from "../lib/format";
import "../styles/AlbumAddPhotos.css";

/** A timeline photo offered for adding: the uid, when it was taken (for the month
 *  headers) and its tags (so the grid can badge it like everywhere else). */
type Candidate = { uid: string; captureTime: number; tags?: number[] };

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}`;
}
function monthLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
}

/**
 * Picks timeline photos to add to the open album, the way the web client's "Add photos"
 * does. Purely a chooser: the parent owns the add call, the toast and the reload, so this
 * holds only the selection. The candidate list already excludes what the album holds, so
 * every photo shown is one that can actually be added.
 *
 * The grid is the same one the timeline uses, so thumbnails load lazily per visible cell
 * and the month sections virtualise; a large library opens the picker without loading
 * every thumbnail at once.
 */
export function AlbumAddPhotos({
  albumName,
  candidates,
  cellSize,
  busy,
  onConfirm,
  onClose,
}: {
  albumName: string;
  candidates: Candidate[];
  cellSize: number;
  busy: boolean;
  onConfirm: (uids: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (uid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });

  // Escape closes, matching the rest of the app's modals. Captured and stopped so it
  // does not also reach anything underneath.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const sections = useMemo(() => {
    const map = new Map<string, { label: string; items: Candidate[] }>();
    for (const it of candidates) {
      const k = monthKey(it.captureTime);
      let s = map.get(k);
      if (!s) {
        s = { label: monthLabel(it.captureTime), items: [] };
        map.set(k, s);
      }
      s.items.push(it);
    }
    return [...map.values()];
  }, [candidates]);
  const virtualSections = useMemo(
    () => sections.map((s) => ({ key: s.label, items: s.items })),
    [sections],
  );

  return (
    <div className="ap-veil" onMouseDown={onClose}>
      <div
        className="ap-card"
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="ap-head">
          <span className="ap-title">{t("albums.addPhotos")}</span>
          <span className="ap-sub">{albumName}</span>
          <span className="ap-spacer" />
          <button className="ap-x" onClick={onClose} title={t("common.close")}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="ap-body">
          {candidates.length === 0 ? (
            <div className="ap-empty">{t("photos.noPhotos")}</div>
          ) : (
            // Only the rows near the view are built: this lists the whole timeline.
            <VirtualSections
              scroller=".ap-body"
              sections={virtualSections}
              cellSize={cellSize}
              header={(s) => (
                <div className="g-monthhdr">
                  <span className="g-monthtitle">{s.key}</span>
                </div>
              )}
              grid={(_, items) => (
                <PhotoGrid
                  items={items}
                  cellSize={cellSize}
                  selected={selected}
                  onToggle={toggle}
                  onOpen={toggle}
                />
              )}
            />
          )}
        </div>

        <div className="ap-foot">
          <button className="ap-cancel" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            className="ap-add"
            onClick={() => onConfirm([...selected])}
            disabled={busy || selected.size === 0}
          >
            {t("albums.addPhotos")}
            {selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
