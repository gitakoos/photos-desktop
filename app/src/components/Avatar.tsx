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

import { GearIcon, UploadArrowIcon } from "./icons";
import { useT } from "../lib/i18n";
import "../styles/Avatar.css";

/*
 * Ported 1:1 from the Android app's AvatarButton.
 *
 *  - Idle:        a storage arc on the avatar circle, starting at 12 o'clock.
 *  - Syncing:     a comet tracing the pill outline, blue.
 *  - Transferring: the same comet in green, plus an up arrow that widens the pill.
 *
 * Every number below is the Android value, in px where it used dp.
 */
const HEIGHT = 46;
const STROKE = 2.6;
const GLYPH_WIDTH = 28;
const CIRCLE = 32;

/** The comet covers 32% of the pill's outline and laps it once a second. */
const COMET_PERCENT = 32;

const RING_TRANSFER = "#34d399"; // photos actually moving
const RING_SYNC = "#60afff"; // a plain sync

function storageArcColor(fraction: number): string {
  if (fraction < 0.7) return "#30d158";
  if (fraction < 0.9) return "#ff9f0a";
  return "#ff453a";
}

type Props = {
  initial: string;
  storageFraction: number;
  uploading?: boolean;
  syncing?: boolean;
  onClick: () => void;
  onArrowClick?: () => void;
};

export function Avatar({
  initial,
  storageFraction,
  uploading = false,
  syncing = false,
  onClick,
  onArrowClick,
}: Props) {
  const t = useT();
  const transferring = uploading;
  const ringActive = transferring || syncing;
  const ringColor = transferring ? RING_TRANSFER : RING_SYNC;

  const glyphs = uploading ? 1 : 0;
  const width = HEIGHT + glyphs * GLYPH_WIDTH;

  const fraction = Math.min(1, Math.max(0, storageFraction));
  const circleCx = width - HEIGHT / 2;
  const circleCy = HEIGHT / 2;
  const radius = (HEIGHT - STROKE) / 2;

  return (
    <button
      className="av-pill"
      style={{ width }}
      onClick={onClick}
      title={uploading ? t("avatar.uploading") : syncing ? t("avatar.syncing") : t("avatar.account")}
    >
      <svg className="av-ring" width={width} height={HEIGHT} aria-hidden>
        <rect
          x={STROKE / 2}
          y={STROKE / 2}
          width={width - STROKE}
          height={HEIGHT - STROKE}
          rx={(HEIGHT - STROKE) / 2}
          fill="none"
          stroke="#2c2c2e"
          strokeWidth={STROKE}
        />

        {ringActive ? (
          <rect
            className="av-comet"
            x={STROKE / 2}
            y={STROKE / 2}
            width={width - STROKE}
            height={HEIGHT - STROKE}
            rx={(HEIGHT - STROKE) / 2}
            fill="none"
            stroke={ringColor}
            strokeWidth={STROKE}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${COMET_PERCENT} ${100 - COMET_PERCENT}`}
          />
        ) : (
          fraction > 0 && (
            <circle
              cx={circleCx}
              cy={circleCy}
              r={radius}
              fill="none"
              stroke={storageArcColor(fraction)}
              strokeWidth={STROKE}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${fraction * 100} 100`}
              transform={`rotate(-90 ${circleCx} ${circleCy})`}
            />
          )
        )}
      </svg>

      {uploading && (
        <span
          className="av-glyph"
          style={{ color: ringColor }}
          title={t("avatar.showUploads")}
          onClick={(e) => {
            e.stopPropagation();
            onArrowClick?.();
          }}
        >
          <UploadArrowIcon size={13} />
        </span>
      )}

      <span className="av-circle" style={{ width: CIRCLE, height: CIRCLE }}>
        {initial || "?"}
      </span>
      <span className="av-gear">
        <GearIcon size={10} />
      </span>
    </button>
  );
}
