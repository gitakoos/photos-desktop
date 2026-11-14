/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { formatVideoTime } from "./durations";
import type { TileBadges, TypeMark } from "./tileBadges";

/**
 * How the canvas grid paints one tile: its picture, the selected look, and the corner
 * badges, to the same measures as the DOM tile's stylesheet (Photos.css: `.g-cell`,
 * `.g-play`, `.g-tilebadge`, `.g-badgerow`, `.g-cloud`, `.g-typepill`, `.g-seldot`), so the
 * two grids look alike. Everything is in device pixels at whole-pixel places.
 */

/** `.g-cell`'s corner radius. */
export const TILE_RADIUS = 10;

export type Sprites = Record<"play" | "offline" | "cloud" | "heart" | "check" | TypeMark, ImageBitmap>;

export type Palette = { bg: string; bg2: string; accent: string; synced: string; font: string };

/**
 * The page's colours and font, as the stylesheet has them now (they follow the theme). The
 * background is what the list really sits on: the first painted background around it, so
 * the canvas matches the page and the sidebar layout's panel alike.
 */
export function readPalette(around?: Element): Palette {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  let bg = "";
  for (let el: Element | null = around ?? null; el && !bg; el = el.parentElement) {
    const c = getComputedStyle(el).backgroundColor;
    if (c && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c)) bg = c;
  }
  return {
    bg: bg || getComputedStyle(document.body).backgroundColor || get("--bg0", "#090909"),
    bg2: get("--bg2", "#1a1a1a"),
    accent: get("--accent", "#8b7cff"),
    synced: get("--status-synced", "#30d158"),
    font: getComputedStyle(document.body).fontFamily || "sans-serif",
  };
}

/** Writes an icon component's SVG out as text. The app's icons are plain SVG elements, no hooks. */
export function svgText(node: ReactNode, color: string): string {
  const attr: Record<string, string> = {
    strokeWidth: "stroke-width",
    strokeLinecap: "stroke-linecap",
    strokeLinejoin: "stroke-linejoin",
    fillRule: "fill-rule",
    clipRule: "clip-rule",
    viewBox: "viewBox",
  };
  const write = (n: ReactNode): string => {
    if (Array.isArray(n)) return n.map(write).join("");
    if (!isValidElement(n)) return "";
    const el = n as ReactElement<Record<string, unknown>>;
    if (typeof el.type === "function") return write((el.type as (p: unknown) => ReactNode)(el.props));
    if (typeof el.type !== "string") return write(el.props.children as ReactNode);
    let out = `<${el.type}`;
    if (el.type === "svg") out += ` xmlns="http://www.w3.org/2000/svg" color="${color}"`;
    for (const [k, v] of Object.entries(el.props)) {
      if (k === "children" || k.startsWith("aria") || v === undefined || v === null || v === false) continue;
      const name = attr[k] ?? k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
      out += ` ${name}="${String(v).replace(/"/g, "&quot;")}"`;
    }
    return `${out}>${write(el.props.children as ReactNode)}</${el.type}>`;
  };
  return write(node);
}

async function sprite(node: ReactNode, color: string): Promise<ImageBitmap> {
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText(node, color));
  await img.decode();
  return createImageBitmap(img);
}

/**
 * The marks as small pictures at this screen's pixel ratio, made once. `icons` are the
 * app's own icon components at their badge sizes in device pixels.
 */
export async function makeSprites(icons: (px: (css: number) => number) => Record<keyof Sprites, ReactNode>, dpr: number, p: Palette): Promise<Sprites> {
  const nodes = icons((css) => Math.round(css * dpr));
  const entries = await Promise.all(
    (Object.keys(nodes) as (keyof Sprites)[]).map(async (k) => [k, await sprite(nodes[k], k === "cloud" ? p.synced : "#fff")] as const),
  );
  return Object.fromEntries(entries) as Sprites;
}

export type TileState = { selected: boolean; hovered: boolean };

/** A square of the background colour with a round hole: its quarters are the corner masks. */
let mask: { canvas: HTMLCanvasElement; r: number; bg: string } | null = null;

function cornerMask(r: number, bg: string): HTMLCanvasElement {
  if (mask && mask.r === r && mask.bg === bg) return mask.canvas;
  const canvas = mask?.canvas ?? document.createElement("canvas");
  canvas.width = canvas.height = Math.max(1, 2 * r);
  const c = canvas.getContext("2d")!;
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = bg;
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.globalCompositeOperation = "destination-out";
  c.beginPath();
  c.arc(r, r, r, 0, Math.PI * 2);
  c.fill();
  mask = { canvas, r, bg };
  return canvas;
}

function roundCorners(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, bg: string): void {
  if (r <= 0) return;
  const m = cornerMask(r, bg);
  ctx.drawImage(m, 0, 0, r, r, x, y, r, r);
  ctx.drawImage(m, r, 0, r, r, x + w - r, y, r, r);
  ctx.drawImage(m, 0, r, r, r, x, y + h - r, r, r);
  ctx.drawImage(m, r, r, r, r, x + w - r, y + h - r, r, r);
}

const BADGE_BG = "rgba(0, 0, 0, 0.55)";

/** Widths of the length labels already measured, by text and font. */
const textWidths = new Map<string, number>();

/**
 * Paints one tile at (x, y), w x h, all in device pixels. `picture` is drawn as it is when
 * it is already cut to w x h, else scaled; its corners are rounded here.
 */
export function paintTile(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  p: Palette,
  sprites: Sprites | null,
  x: number,
  y: number,
  w: number,
  h: number,
  picture: ImageBitmap | undefined,
  marks: TileBadges,
  state: TileState,
): void {
  const d = (css: number) => Math.round(css * dpr);
  const radius = d(TILE_RADIUS);
  ctx.fillStyle = p.bg;
  ctx.fillRect(x, y, w, h);
  ctx.save();
  if (state.hovered) {
    // `.g-cell:hover`: the tile shrinks a little about its centre.
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(0.97, 0.97);
    ctx.translate(-(x + w / 2), -(y + h / 2));
  }
  if (picture) {
    if (picture.width === w && picture.height === h) ctx.drawImage(picture, x, y);
    else {
      // Cut for another size (a zoom or a resize under way): scaled until its own comes.
      const k = Math.max(w / picture.width, h / picture.height);
      const sw = w / k;
      const sh = h / k;
      ctx.drawImage(picture, (picture.width - sw) / 2, (picture.height - sh) / 2, sw, sh, x, y, w, h);
    }
    // The corners rounded by stamping the background over them: four small copies rather
    // than a clip to a rounded path for every tile.
    roundCorners(ctx, x, y, w, h, radius, p.bg);
  } else {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fillStyle = p.bg2;
    ctx.fill();
  }
  if (state.selected) {
    // `.g-cell.sel`: the picture a little darker, a 2.5 px accent ring inside the edge.
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    ctx.fill();
    const lw = Math.max(1, 2.5 * dpr);
    ctx.beginPath();
    ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, Math.max(0, radius - lw / 2));
    ctx.lineWidth = lw;
    ctx.strokeStyle = p.accent;
    ctx.stroke();
  }
  if (sprites) paintBadges(ctx, d, p, sprites, x, y, w, h, marks);
  if (state.selected) {
    // `.g-cell.sel .g-seldot`: a filled accent dot with a tick, a touch larger.
    const r = (20 * 1.08 * dpr) / 2;
    const cx = x + d(6) + d(10);
    const cy = y + d(6) + d(10);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = p.accent;
    ctx.fill();
    if (sprites) ctx.drawImage(sprites.check, Math.round(cx - sprites.check.width / 2), Math.round(cy - sprites.check.height / 2));
  }
  ctx.restore();
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = BADGE_BG;
  ctx.fill();
}

function centred(ctx: CanvasRenderingContext2D, s: ImageBitmap, x: number, y: number, w: number, h: number): void {
  ctx.drawImage(s, Math.round(x + (w - s.width) / 2), Math.round(y + (h - s.height) / 2));
}

function paintBadges(
  ctx: CanvasRenderingContext2D,
  d: (css: number) => number,
  p: Palette,
  s: Sprites,
  x: number,
  y: number,
  w: number,
  h: number,
  marks: TileBadges,
): void {
  if (marks.play) {
    // `.g-play`: a 28 px dark disc in the middle with the play arrow.
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, d(14), 0, Math.PI * 2);
    ctx.fillStyle = BADGE_BG;
    ctx.fill();
    centred(ctx, s.play, cx - d(14), cy - d(14), d(28), d(28));
  }
  const size = d(18);
  const top = y + h - d(4) - size;
  // Bottom-start: the pin, then the length, 3 px apart.
  let at = x + d(4);
  if (marks.offline) {
    box(ctx, at, top, size, size, d(4));
    centred(ctx, s.offline, at, top, size, size);
    at += size + d(3);
  }
  if (marks.durationMs !== null) {
    const text = formatVideoTime(marks.durationMs);
    ctx.font = `${d(11)}px ${p.font}`;
    const key = `${ctx.font}|${text}`;
    let tw = textWidths.get(key);
    if (tw === undefined) {
      tw = ctx.measureText(text).width;
      textWidths.set(key, tw);
    }
    const bw = Math.max(size, Math.ceil(tw) + d(10));
    box(ctx, at, top, bw, size, d(4));
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, at + bw / 2, top + size / 2 + 0.5);
  }
  // Bottom-end: the cloud, and the heart and type mark just inside it.
  if (marks.local) {
    const bx = x + w - d(4) - size;
    box(ctx, bx, top, size, size, d(4));
    centred(ctx, s.cloud, bx, top, size, size);
  }
  const inPill = (marks.favorite ? 1 : 0) + (marks.type ? 1 : 0);
  if (inPill > 0) {
    const icon = d(11);
    const pad = Math.round(3.5 * (d(100) / 100));
    const bw = Math.max(size, pad * 2 + inPill * icon + (inPill - 1) * d(3));
    const bx = x + w - (marks.local ? d(25) : d(4)) - bw;
    box(ctx, bx, top, bw, size, d(4));
    let ix = bx + pad;
    if (marks.favorite) {
      centred(ctx, s.heart, ix, top, icon, size);
      ix += icon + d(3);
    }
    if (marks.type) centred(ctx, s[marks.type], ix, top, icon, size);
  }
}
