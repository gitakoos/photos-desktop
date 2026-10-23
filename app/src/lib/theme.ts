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
export type PaletteKey =
  | "default"
  | "forest"
  | "sunset"
  | "sea"
  | "sepia"
  | "mono"
  | "lavender"
  | "rose"
  | "mint"
  | "gold"
  | "ruby"
  | "amoled";

type Accent = { accent: string; accent2: string };
type SurfaceOverrides = {
  bg0: string;
  bg2: string;
  pageBg: string;
  surface: string;
  /** The frame around the page in the sidebar layout, its search field, and the page's edge. */
  frameBg: string;
  stripField: string;
  panelEdge: string;
};

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
    key: "lavender",
    labelKey: "settings.palette.lavender",
    dark: { accent: "#c9a7eb", accent2: "#9b7fd4" },
    light: { accent: "#9575cd", accent2: "#6a4caf" },
  },
  {
    key: "rose",
    labelKey: "settings.palette.rose",
    dark: { accent: "#f48fb1", accent2: "#e06699" },
    light: { accent: "#d6336c", accent2: "#a61e4d" },
  },
  {
    key: "mint",
    labelKey: "settings.palette.mint",
    dark: { accent: "#6fe0c4", accent2: "#2fb89c" },
    light: { accent: "#12a98c", accent2: "#0b7a66" },
  },
  {
    key: "gold",
    labelKey: "settings.palette.gold",
    dark: { accent: "#ffd166", accent2: "#e9ae3c" },
    light: { accent: "#cc8a00", accent2: "#995f00" },
  },
  {
    key: "ruby",
    labelKey: "settings.palette.ruby",
    dark: { accent: "#ff7a88", accent2: "#e84c5e" },
    light: { accent: "#c62838", accent2: "#8e1b27" },
  },
  {
    key: "amoled",
    labelKey: "settings.palette.amoled",
    dark: { accent: "#8b7cff", accent2: "#6957d7" },
    light: { accent: "#6957d7", accent2: "#4a37bc" },
    surfaces: {
      bg0: "#000000",
      bg2: "#101010",
      pageBg: "#000000",
      surface: "#0c0c0d",
      frameBg: "#000000",
      stripField: "#121214",
      panelEdge: "rgba(255, 255, 255, 0.08)",
    },
  },
];

import { mix, textOnAccent } from "./colour";

const prefersLight = window.matchMedia("(prefers-color-scheme: light)");
let mode: ThemeMode = "dark";
let palette: PaletteKey = "default";
/** Pure black behind everything in dark mode, whatever the palette. */
let amoled = false;

/** The palettes offered to pick from: AMOLED is a switch of its own, not one of them. */
export const PICKABLE_PALETTES = PALETTES.filter((p) => p.key !== "amoled");

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

/** The frame and its search field, as theme.css paints them, leaned a touch toward the
 *  palette's accent so the window's chrome belongs to it. Mono stays neutral. */
const FRAME = { dark: { frame: "#19191b", field: "#232326" }, light: { frame: "#e7e7eb", field: "#ffffff" } };
const FRAME_TINT = { dark: 0.05, light: 0.035 };

function paint(): void {
  const light = resolvedMode(mode) === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";

  // A palette saved as "amoled" before it became a switch is the default palette in black.
  const black = amoled || palette === "amoled";
  const p = paletteDef(palette === "amoled" ? "default" : palette);
  const a = light ? p.light : p.dark;
  const rgb = hexToRgb(a.accent);
  const style = document.documentElement.style;
  style.setProperty("--accent", a.accent);
  style.setProperty("--accent-2", a.accent2);
  style.setProperty("--accent-rgb", rgb);
  // Washes track the accent; the alphas match the light / dark blocks in theme.css.
  style.setProperty("--accent-wash", `rgba(${rgb}, ${light ? 0.14 : 0.18})`);
  style.setProperty("--accent-wash-strong", `rgba(${rgb}, ${light ? 0.18 : 0.2})`);
  style.setProperty("--on-accent", textOnAccent(a.accent));
  const side = light ? "light" : "dark";
  const tint = p.key === "mono" ? 0 : FRAME_TINT[side];
  style.setProperty("--frame-bg", mix(FRAME[side].frame, a.accent, tint));
  style.setProperty("--strip-field", light ? FRAME[side].field : mix(FRAME[side].field, a.accent, tint));
  style.removeProperty("--panel-edge");
  // The viewer stands on an even dark grey, as Windows Photos does, tinted toward the
  // palette like the window's frame; pure black under AMOLED. It stays dark in the light
  // theme, where a photo still reads best on a dark ground.
  const ground = black && !light ? "#000000" : mix("#1f1f1f", p.dark.accent, p.key === "mono" ? 0 : FRAME_TINT.dark);
  style.setProperty("--viewer-ground", ground);

  // Only AMOLED overrides the base surfaces, and only in dark mode; every other
  // palette (and light mode) clears the overrides so theme.css applies.
  const s = black ? paletteDef("amoled").surfaces : undefined;
  if (s && !light) {
    style.setProperty("--bg0", s.bg0);
    style.setProperty("--bg2", s.bg2);
    style.setProperty("--page-bg", s.pageBg);
    style.setProperty("--surface", s.surface);
    style.setProperty("--frame-bg", s.frameBg);
    style.setProperty("--strip-field", s.stripField);
    style.setProperty("--panel-edge", s.panelEdge);
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

export function applyTheme(nextMode: ThemeMode, nextPalette?: PaletteKey, nextAmoled?: boolean): void {
  mode = nextMode;
  if (nextPalette) palette = nextPalette;
  if (nextAmoled !== undefined) amoled = nextAmoled;
  paint();
}
