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

/**
 * The value formatting shared by the two detail panels, cloud and local, so a
 * file reads the same whichever side of the app is showing it.
 */

export function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * The locale dates are formatted in. The system's tag is not always a valid BCP 47 one:
 * on Linux the WebView derives it from LANG, which is often `C` or `C.UTF-8`, and Intl
 * throws on `C`. Anything Intl cannot use falls back to English.
 */
export const locale: string = (() => {
  try {
    return Intl.getCanonicalLocales(navigator.language)[0] ?? "en";
  } catch {
    return "en";
  }
})();

export function formatDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(locale);
}

/**
 * Width/height live in the encrypted extended attributes, inside the `Media`
 * block that also carries the video duration. Reading them off the top level
 * instead is why this row never appeared. The top level is still searched as a
 * fallback, and the casing varies either way, which is also what lets a local
 * file hand its own plain width and height straight to this.
 */
export function dimensionsOf(extra: Record<string, unknown> | null): string | null {
  if (!extra) return null;
  const media = (extra.Media ?? extra.media) as Record<string, unknown> | undefined;
  const pick = (...keys: string[]) => {
    for (const source of [media, extra]) {
      if (!source) continue;
      for (const k of keys) {
        const v = source[k];
        if (typeof v === "number" && v > 0) return v;
      }
    }
    return null;
  };
  const w = pick("Width", "width");
  const h = pick("Height", "height");
  return w && h ? `${w} × ${h}` : null;
}
