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
 * Theme switching. The base palette lives in `theme.css`; this decides which of
 * its two blocks is active by stamping `data-theme` on <html>, and it layers the
 * chosen accent palette on top as inline custom properties.
 *
 * "system" keeps following the OS after it is chosen, so a machine that flips to
 * light at sunset flips the app with it.
 *
 * The palettes mirror the Android app 1:1 (ProtonPhotosTheme.kt): every token but
 * `accent` / `accent-2` stays palette-agnostic, so applying a palette only rewrites
 * the accent variables. The AMOLED palette additionally drops the base surfaces to
 * true black, exactly as the Android AMOLED override does — and only in dark mode.
 */
export type ThemeMode = "dark" | "light" | "system";

/** Storage keys match Android's `ThemePalette.storageKey`. */
export type PaletteKey = "default" | "forest" | "sunset" | "sea" | "sepia" | "mono" | "amoled";

type Accent = { accent: string; accent2: string };
type SurfaceOverrides = { bg0: string; bg2: string; pageBg: string; surface: string };

export type PaletteDef = {
  key: PaletteKey;
  labelKey: string;
  dark: Accent;
  light: Accent;
  /** AMOLED only: pushes the base surfaces to true black in dark mode. */
  surfaces?: SurfaceOverrides;
};

/**
 * The Android palettes, copied verbatim from ProtonPhotosTheme.kt. Default is the
 * original Proton purple; AMOLED keeps that accent and blacks out the surfaces.
 */
export const PALETTES: PaletteDef[] = [
  {
    key: "default",
    labelKey: "settings.palette.default",
    dark: { accent: "#8b7cff", accent2: "#6957d7" },
    light: { accent: "#6957d7", accent2: "#4a37bc" },
  },
  {
    key: "forest",
    labelKey: "settings.palette.forest",
    dark: { accent: "#7bc47f", accent2: "#3f8c44" },
    light: { accent: "#388e3c", accent2: "#1b5e20" },
  },
  {
    key: "sunset",
    labelKey: "settings.palette.sunset",
    dark: { accent: "#ff8a65", accent2: "#e64a19" },
    light: { accent: "#e64a19", accent2: "#bf360c" },
  },
  {
    key: "sea",
    labelKey: "settings.palette.sea",
    dark: { accent: "#4fc3f7", accent2: "#0288d1" },
    light: { accent: "#0288d1", accent2: "#01579b" },
  },
  {
    key: "sepia",
    labelKey: "settings.palette.sepia",
    dark: { accent: "#d4a574", accent2: "#8b6f47" },
    light: { accent: "#8b6f47", accent2: "#5d4037" },
  },
  {
    key: "mono",
    labelKey: "settings.palette.mono",
    dark: { accent: "#e0e0e0", accent2: "#9e9e9e" },
    light: { accent: "#424242", accent2: "#212121" },
  },
  {
    key: "amoled",
    labelKey: "settings.palette.amoled",
    dark: { accent: "#8b7cff", accent2: "#6957d7" },
    light: { accent: "#6957d7", accent2: "#4a37bc" },
    surfaces: { bg0: "#000000", bg2: "#101010", pageBg: "#000000", surface: "#0c0c0d" },
  },
];

const prefersLight = window.matchMedia("(prefers-color-scheme: light)");
let mode: ThemeMode = "dark";
let palette: PaletteKey = "default";

/** Resolve a mode to a concrete side, following the OS while on "system". */
export function resolvedMode(m: ThemeMode): "dark" | "light" {
  if (m === "system") return prefersLight.matches ? "light" : "dark";
  return m;
}

function paletteDef(key: PaletteKey): PaletteDef {
  return PALETTES.find((p) => p.key === key) ?? PALETTES[0];
}

/** "#8b7cff" -> "139, 124, 255", for the rgba(var(--accent-rgb), α) tokens. */
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function paint(): void {
  const light = resolvedMode(mode) === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";

  const p = paletteDef(palette);
  const a = light ? p.light : p.dark;
  const rgb = hexToRgb(a.accent);
  const style = document.documentElement.style;
  style.setProperty("--accent", a.accent);
  style.setProperty("--accent-2", a.accent2);
  style.setProperty("--accent-rgb", rgb);
  // Washes track the accent; the alphas match the light / dark blocks in theme.css.
  style.setProperty("--accent-wash", `rgba(${rgb}, ${light ? 0.14 : 0.18})`);
  style.setProperty("--accent-wash-strong", `rgba(${rgb}, ${light ? 0.18 : 0.2})`);

  // Only AMOLED overrides the base surfaces, and only in dark mode; every other
  // palette (and light mode) clears the overrides so theme.css applies.
  const s = p.surfaces;
  if (s && !light) {
    style.setProperty("--bg0", s.bg0);
    style.setProperty("--bg2", s.bg2);
    style.setProperty("--page-bg", s.pageBg);
    style.setProperty("--surface", s.surface);
  } else {
    style.removeProperty("--bg0");
    style.removeProperty("--bg2");
    style.removeProperty("--page-bg");
    style.removeProperty("--surface");
  }
}

prefersLight.addEventListener("change", () => {
  if (mode === "system") paint();
});

export function applyTheme(nextMode: ThemeMode, nextPalette?: PaletteKey): void {
  mode = nextMode;
  if (nextPalette) palette = nextPalette;
  paint();
}
