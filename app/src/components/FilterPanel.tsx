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
import { CloseIcon } from "./icons";
import { useT } from "../lib/i18n";
import { CATEGORIES } from "../lib/tags";
import "../styles/FilterPanel.css";

/** Timeline media-type filter, read straight off the item tags (no index needed). */
export type MediaType = "all" | "photo" | "video";

const MEDIA_TYPES: { value: MediaType; labelKey: string }[] = [
  { value: "all", labelKey: "filter.mediaAll" },
  { value: "photo", labelKey: "filter.mediaPhotos" },
  { value: "video", labelKey: "filter.videos" },
];

/**
 * The timeline content filter, mirroring the Android app's ContentFilterSheet:
 * a Categories section (the photo tags, multi-select — OR across selections) and
 * a Type section (All / Photos / Videos, single-select). A rounded popover
 * anchored under the header filter button; every toggle applies in real time.
 */
export function FilterPanel({
  categories,
  onToggleCategory,
  mediaType,
  onMediaType,
  activeCount,
  onReset,
  onClose,
}: {
  categories: Set<string>;
  onToggleCategory: (key: string) => void;
  mediaType: MediaType;
  onMediaType: (m: MediaType) => void;
  activeCount: number;
  onReset: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target)) return;
      // The trigger pill toggles itself; let its own click handle the close.
      if (target.closest?.(".g-filterpill")) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Deferred, so the click that opened the panel does not immediately close it.
    const id = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="fp" ref={ref} role="dialog" aria-label={t("filter.title")}>
      <div className="fp-head">
        <span className="fp-title">{t("filter.title")}</span>
        {activeCount > 0 && (
          <button className="fp-reset" onClick={onReset}>
            {t("filter.reset")}
          </button>
        )}
        <button className="fp-x" onClick={onClose} title={t("common.close")}>
          <CloseIcon size={14} />
        </button>
      </div>

      <div className="fp-label">{t("filter.categories")}</div>
      <div className="fp-chips">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            className={`g-chip ${categories.has(c.key) ? "sel" : ""}`}
            aria-pressed={categories.has(c.key)}
            onClick={() => onToggleCategory(c.key)}
          >
            {t(`category.${c.key}`)}
          </button>
        ))}
      </div>

      <div className="fp-label">{t("filter.type")}</div>
      <div className="fp-chips" role="group" aria-label={t("filter.type")}>
        {MEDIA_TYPES.map((m) => (
          <button
            key={m.value}
            className={`g-chip ${mediaType === m.value ? "sel" : ""}`}
            aria-pressed={mediaType === m.value}
            onClick={() => onMediaType(m.value)}
          >
            {t(m.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}
