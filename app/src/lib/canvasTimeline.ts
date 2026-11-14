/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { bench, benchCount, benchSpan } from "./benchProbe";
import { GRID_GAP, TileRange, sectionOfIndex, type GridLayout } from "./gridLayout";

/** Whether two layouts put tiles in the same places: same width, columns, tile size and headers. */
function sameGeometry(a: GridLayout, b: GridLayout): boolean {
  return a.width === b.width && a.columns === b.columns && Math.abs(a.tile - b.tile) < 1e-6 && a.header === b.header;
}
import { isVideo as classifyVideo, TAG } from "./tags";
import { cachedMediaType, requestMediaType } from "./mediaTypes";
import { cachedDuration, requestDuration } from "./durations";
import { badgeTier, tileBadges } from "./tileBadges";
import { TILE_RADIUS, paintTile, readPalette, type Palette, type Sprites } from "./tileArt";
import { TileLoader } from "./tileLoader";
import { thumbPxFor, thumbUrlFor } from "./thumbSize";
import { ScrollSpeed } from "./scrollSpeed";

/**
 * The timeline drawn on a canvas, the way a native grid draws: no element per tile, so
 * nothing for the webview to style, lay out or paint tile by tile. Measured on the
 * reporter's 3440x1386 window: the DOM grid ran at 15 frames a
 * second with the window's thread 94% busy; this one at 60 with it 14% busy, as native.
 *
 *   - The canvas is a screen taller than the view on either side and moves with the list:
 *     a scroll step that stays inside it draws nothing. Near its edge it is moved to centre
 *     on the view again: what is drawn is shifted by one copy of itself and only the newly
 *     exposed strip is drawn.
 *   - Thumbnails are fetched and decoded in a worker, cut to the tile's size in device
 *     pixels (see tileLoader), so drawing one is a copy; the corners are stamped round. Those on
 *     screen are asked for first, from the edge the list moves towards, then a screen
 *     ahead; none while the list moves faster than four screens a second; and fetches for
 *     tiles that went far away are called off.
 *   - A thumbnail, a media type or a length that arrives redraws its tile alone.
 *
 * Plain code, not a component: React draws the month headers and the one tile under the
 * pointer (see CanvasSections), and never runs on a scroll step.
 */

export type TimelineItem = { uid: string; tags?: number[] };

export type TimelineData = {
  layout: GridLayout;
  sections: { items: TimelineItem[] }[];
  selected: ReadonlySet<string>;
  offline: ReadonlySet<string> | undefined;
  local: ReadonlySet<string> | undefined;
  showBadges: boolean;
};

/** The tallest canvas made, in device pixels: GPU textures stop at 8192 on many cards. */
const MAX_CANVAS = 8000;
/** Screens ahead of the view whose thumbnails are asked for. */
const AHEAD = 1;
/** Screens either side beyond which a fetch still under way is called off. */
const KEEP = 2;
/** Faster than this many screens a second, no new thumbnail is asked for. */
const FAST_SCREENS_S = 4;

export class CanvasTimeline {
  private ctx: CanvasRenderingContext2D;
  private dpr = window.devicePixelRatio || 1;
  private palette: Palette;
  private sprites: Sprites | null = null;
  private loader: TileLoader | null = null;
  private data: TimelineData | null = null;
  /** Every photo's place in the list, by uid, for redrawing one tile when something of it arrives. */
  private indexOf = new Map<string, number>();
  private indexedFrom: TimelineData["sections"] | null = null;
  private px: number | null = null;

  /** The view's height, and the canvas: its height and where its top is in the list (CSS px). */
  private viewH = 0;
  private bufH = 0;
  private margin = 0;
  private bufTop = 0;
  private lastTop = 0;
  private hover = -1;
  /** Where the list starts in the scroll area's content, read once per scroll step. */
  private offset = 0;

  private view = new TileRange();
  private strip = new TileRange();
  private ahead = new TileRange();
  private marks = new TileRange();
  /** Media types and lengths asked for the tiles near the screen, by uid. */
  private asking = new Map<string, () => void>();
  private redraw = new Set<number>();
  private frame = 0;
  private full = false;
  private speed: ScrollSpeed;
  private onScroll = () => this.scrolled();
  private sized: ResizeObserver;
  private themed: MutationObserver;
  private ratio: MediaQueryList | null = null;
  private onRatio = () => this.measure(true);
  private gone = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private scroller: HTMLElement,
    private wrap: HTMLElement,
    private base: string,
    private sprite: (dpr: number, p: Palette) => Promise<Sprites>,
    /** The stretch of the list the canvas covers changed: headers there are worth drawing. */
    private onSpan: (from: number, to: number) => void,
    /** The list moved under the pointer. */
    private onMoved: () => void,
    /** The list stopped moving: what is under the pointer is worth looking at again. */
    private onStill: () => void,
  ) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.palette = readPalette(scroller);
    this.speed = new ScrollSpeed(1, () => this.settled());
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.sized = new ResizeObserver(() => this.measure());
    this.sized.observe(scroller);
    // A theme change restyles the page, and the canvas has to be painted again for it. The
    // accent and the AMOLED black are set as inline styles on the root, hence "style".
    this.themed = new MutationObserver(() => {
      this.palette = readPalette(scroller);
      this.redrawAll();
    });
    this.themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    this.watchRatio();
    this.loadSprites();
  }

  /** The marks as pictures at the current pixel ratio; any made before are let go. */
  private loadSprites(): void {
    const dpr = this.dpr;
    void this.sprite(dpr, this.palette).then((made) => {
      if (this.gone || dpr !== this.dpr) {
        for (const b of Object.values(made)) b.close();
        return;
      }
      for (const old of Object.values(this.sprites ?? {})) old.close();
      this.sprites = made;
      this.redrawAll();
    });
  }

  /** A window moved to a screen of another pixel ratio is drawn again at that ratio. */
  private watchRatio(): void {
    this.ratio?.removeEventListener("change", this.onRatio);
    this.ratio = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.ratio.addEventListener("change", this.onRatio);
  }

  /** The tile size in device pixels and the thumbnail size, from the layout and the ratio. */
  private sizeLoader(): void {
    const l = this.data?.layout;
    if (!l) return;
    this.px = thumbPxFor(l.tile, this.dpr);
    const size = { w: this.d(l.tile), h: this.d(l.rowH), r: this.d(TILE_RADIUS) };
    if (this.loader) this.loader.setSize(size);
    else this.loader = new TileLoader((uid) => this.arrived(uid), size);
  }

  /** What to draw: called on every change of layout, photos, selection or marks. */
  setData(data: TimelineData): void {
    const was = this.data;
    this.data = data;
    if (data.sections !== this.indexedFrom) {
      this.indexedFrom = data.sections;
      this.indexOf.clear();
      let i = 0;
      for (const s of data.sections) for (const item of s.items) this.indexOf.set(item.uid, i++);
    }
    const l = data.layout;
    this.sizeLoader();
    this.offset = this.readOffset();
    if (!was || !sameGeometry(was.layout, l)) this.measure(true);
    else if (was.layout.height !== l.height || was.sections !== data.sections) {
      // The photos changed, as they do with every batch of a timeline still being listed,
      // which mostly adds photos far from the screen. The canvas is made again only if its
      // height must change, and drawn again only if what it shows changed.
      if (this.bufferHeight(l) !== this.bufH) this.measure(true);
      else if (this.shows(was) !== this.shows(data) || !this.sameMarks(was, data)) this.follow(true);
    } else if (this.onlySelectionChanged(was, data)) {
      // A selection changed (as it does on every move of the rubber band): only the tiles
      // that changed are drawn again, unless every tile's play icon comes or goes with it.
      for (const uid of was.selected) if (!data.selected.has(uid)) this.redrawUid(uid);
      for (const uid of data.selected) if (!was.selected.has(uid)) this.redrawUid(uid);
    } else this.redrawAll();
    this.pump();
  }

  /** The canvas's height for a list of this layout: the view and up to a screen either side, never taller than the list. */
  private bufferHeight(l: GridLayout): number {
    return Math.max(1, Math.min(this.viewH + 2 * this.margin, Math.ceil(l.height)));
  }

  /** What the canvas shows from `d`: every photo in its span, and where it is. */
  private shows(d: TimelineData): string {
    const r = this.marks.fill(d.layout, this.bufTop, this.bufTop + this.bufH);
    let out = "";
    for (let i = 0; i < r.n; i++) {
      const p = r.tiles[i];
      out += `${d.sections[p.s].items[p.k].uid}@${Math.round(p.y)}|`;
    }
    return out;
  }

  private sameMarks(was: TimelineData, now: TimelineData): boolean {
    return was.selected === now.selected && was.offline === now.offline && was.local === now.local && was.showBadges === now.showBadges;
  }

  private onlySelectionChanged(was: TimelineData, now: TimelineData): boolean {
    return (
      was.layout === now.layout &&
      was.sections === now.sections &&
      was.offline === now.offline &&
      was.local === now.local &&
      was.showBadges === now.showBadges &&
      was.selected.size > 0 === now.selected.size > 0
    );
  }

  private redrawUid(uid: string): void {
    const index = this.indexOf.get(uid);
    if (index === undefined) return;
    this.redraw.add(index);
    this.schedule();
  }

  /** The tile under the pointer (its index in the list), drawn a little smaller; -1 for none. */
  setHover(index: number): void {
    if (index === this.hover) return;
    if (this.hover >= 0) this.redraw.add(this.hover);
    this.hover = index;
    if (index >= 0) this.redraw.add(index);
    this.schedule();
  }

  /** Whether the thumbnails are drawn by the worker, for the measurement. */
  where(): string {
    return this.loader?.where ?? "starting";
  }

  /** Tiles on screen now, and how many show their picture. */
  onScreen(): { tiles: number; shown: number } {
    const d = this.data;
    if (!d) return { tiles: 0, shown: 0 };
    const top = this.viewTop();
    const r = new TileRange().fill(d.layout, top, top + this.viewH);
    let shown = 0;
    for (let i = 0; i < r.n; i++) if (this.loader?.bitmap(this.uidAt(r.tiles[i].s, r.tiles[i].k))) shown++;
    return { tiles: r.n, shown };
  }

  destroy(): void {
    this.gone = true;
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.sized.disconnect();
    this.themed.disconnect();
    this.speed.stop();
    this.ratio?.removeEventListener("change", this.onRatio);
    cancelAnimationFrame(this.frame);
    for (const stop of this.asking.values()) stop();
    this.asking.clear();
    this.loader?.close();
    this.loader = null;
    for (const s of Object.values(this.sprites ?? {})) s.close();
    this.sprites = null;
  }

  // ---- where things are

  private d(css: number): number {
    return Math.round(css * this.dpr);
  }

  /** Where the list starts in the scroll area's content: other things may sit above it. */
  private readOffset(): number {
    return this.wrap.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
  }

  /** Where the view's top is in the list (CSS px), from the offset last read. */
  private viewTop(): number {
    return this.scroller.scrollTop - this.offset;
  }

  private uidAt(s: number, k: number): string {
    return this.data!.sections[s].items[k].uid;
  }

  /** The view's height and the window's pixel ratio may have changed: the canvas is made again. */
  private measure(force = false): void {
    if (this.gone || !this.data) return;
    const l = this.data.layout;
    const viewH = this.scroller.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (!force && viewH === this.viewH && dpr === this.dpr && this.canvas.width === this.d(l.width)) return;
    this.viewH = viewH;
    this.offset = this.readOffset();
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.watchRatio();
      this.loadSprites();
      this.sizeLoader();
    }
    this.speed.setFast(viewH * FAST_SCREENS_S);
    this.margin = Math.max(0, Math.min(viewH, Math.floor((MAX_CANVAS / dpr - viewH) / 2)));
    // Never taller than the list: the canvas must not make it scroll further than it is long.
    this.bufH = this.bufferHeight(l);
    // Setting a canvas's size, even to the size it has, throws its pixels away and makes
    // it anew: only when it really changes.
    const cw = Math.max(1, this.d(l.width));
    const ch = Math.max(1, this.d(this.bufH));
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    this.canvas.style.width = `${l.width}px`;
    this.canvas.style.height = `${this.bufH}px`;
    this.ctx.imageSmoothingEnabled = true;
    this.follow(true);
  }

  // ---- drawing

  private schedule(full = false): void {
    if (full) this.full = true;
    if (this.frame || this.gone) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.full) {
        this.full = false;
        this.redraw.clear();
        this.drawSpan(this.bufTop, this.bufTop + this.bufH);
        return;
      }
      for (const index of this.redraw) this.paintIndex(index);
      this.redraw.clear();
    });
  }

  private redrawAll(): void {
    this.schedule(true);
  }

  /**
   * Keeps the view inside the canvas with room to spare. Moving the canvas shifts what is
   * drawn by one copy of itself and draws only the strip that was not there.
   */
  private follow(force = false): void {
    const d = this.data;
    if (!d) return;
    const top = this.viewTop();
    const lowest = Math.max(0, Math.floor((d.layout.height - this.bufH) * this.dpr) / this.dpr);
    const want = Math.min(lowest, Math.max(0, Math.round((top - this.margin) * this.dpr) / this.dpr));
    const above = top - this.bufTop;
    const below = this.bufTop + this.bufH - (top + this.viewH);
    const nearEdge = (above < this.margin / 2 && this.bufTop > 0) || (below < this.margin / 2 && this.bufTop < lowest);
    if (!force && !nearEdge && above >= 0 && below >= 0) return;
    const shift = want - this.bufTop;
    // Above the list's start, in the padding below its end, or a list shorter than the
    // view: nowhere better to put the canvas, and nothing new to draw.
    if (!force && shift === 0) return;
    if (force || Math.abs(shift) >= this.bufH) {
      this.bufTop = want;
      this.drawSpan(this.bufTop, this.bufTop + this.bufH);
    } else if (shift !== 0) {
      this.ctx.drawImage(this.canvas, 0, -(this.d(want) - this.d(this.bufTop)));
      const was = this.bufTop;
      this.bufTop = want;
      if (shift > 0) this.drawSpan(was + this.bufH, this.bufTop + this.bufH);
      else this.drawSpan(this.bufTop, was);
    }
    this.canvas.style.transform = `translateY(${this.bufTop}px)`;
    this.onSpan(this.bufTop, this.bufTop + this.bufH);
    this.askMarks();
    this.trim();
  }

  /** Draws everything between `from` and `to` (list px) into the canvas. Headers are the page's. */
  private drawSpan(from: number, to: number): void {
    const d = this.data;
    if (!d || to <= from) return;
    const t0 = bench.on ? performance.now() : 0;
    const ctx = this.ctx;
    const y0 = this.d(from) - this.d(this.bufTop);
    const y1 = this.d(to) - this.d(this.bufTop);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y0, this.canvas.width, y1 - y0);
    ctx.clip();
    ctx.fillStyle = this.palette.bg;
    ctx.fillRect(0, y0, this.canvas.width, y1 - y0);
    this.strip.fill(d.layout, from, to);
    for (let i = 0; i < this.strip.n; i++) {
      const p = this.strip.tiles[i];
      this.paint(p.s, p.k, p.index, p.x, p.y);
    }
    ctx.restore();
    if (bench.on) {
      benchCount("vs");
      benchCount("cells", this.strip.n);
      benchSpan("vs_ms", t0);
    }
  }

  /** Paints tile `index` of the list again, if it is in the canvas. */
  private paintIndex(index: number): void {
    const d = this.data;
    if (!d || index < 0) return;
    const l = d.layout;
    const s = sectionOfIndex(l, index);
    const k = index - l.starts[s];
    if (k < 0 || k >= l.counts[s]) return;
    const x = (k % l.columns) * (l.tile + GRID_GAP);
    const y = l.tops[s] + l.header + Math.floor(k / l.columns) * l.pitch;
    this.paint(s, k, index, x, y);
  }

  private paint(s: number, k: number, index: number, x: number, y: number): void {
    const d = this.data!;
    const l = d.layout;
    const Y = this.d(y) - this.d(this.bufTop);
    const W = this.d(l.tile);
    const H = this.d(l.rowH);
    if (Y + H <= 0 || Y >= this.canvas.height) return;
    const item = d.sections[s].items[k];
    const uid = item.uid;
    const video = classifyVideo(item.tags, cachedMediaType(uid)) ?? false;
    const marks = tileBadges({
      tags: item.tags,
      isVideo: video,
      durationMs: video ? cachedDuration(uid) : null,
      offline: !!d.offline?.has(uid),
      local: !!d.local?.has(uid),
      tier: badgeTier(l.tile),
      selectionMode: d.selected.size > 0,
      showBadges: d.showBadges,
    });
    paintTile(
      this.ctx,
      this.dpr,
      this.palette,
      this.sprites,
      this.d(x),
      Y,
      W,
      H,
      this.loader?.bitmap(uid),
      marks,
      { selected: d.selected.has(uid), hovered: index === this.hover },
    );
  }

  // ---- scrolling

  private scrolled(): void {
    this.offset = this.readOffset();
    const top = this.viewTop();
    this.speed.step(top);
    if (this.hover >= 0) {
      this.setHover(-1);
      this.onMoved();
    }
    this.follow();
    this.prune(top);
    this.pump();
    this.lastTop = top;
  }

  private settled(): void {
    this.pump();
    this.askMarks();
    this.onStill();
  }

  // ---- thumbnails

  private arrived(uid: string): void {
    const index = this.indexOf.get(uid);
    if (index !== undefined) {
      this.redraw.add(index);
      this.schedule();
    }
    this.pump();
  }

  /** Asks for what is on screen first, from the edge the list is moving towards, then a screen ahead. */
  private pump(): void {
    const d = this.data;
    const loader = this.loader;
    if (!d || !loader || this.speed.isFast() || loader.room() === 0) return;
    const top = this.viewTop();
    const down = top >= this.lastTop;
    const l = d.layout;
    this.view.fill(l, top, top + this.viewH);
    const v = this.view;
    for (let i = 0; i < v.n && loader.room() > 0; i++) {
      const p = v.tiles[down ? v.n - 1 - i : i];
      this.ask(p.s, p.k);
    }
    if (down) this.ahead.fill(l, top + this.viewH, top + this.viewH * (1 + AHEAD));
    else this.ahead.fill(l, top - this.viewH * AHEAD, top);
    const a = this.ahead;
    for (let i = 0; i < a.n && loader.room() > 0; i++) {
      const p = a.tiles[down ? i : a.n - 1 - i];
      this.ask(p.s, p.k);
    }
  }

  private ask(s: number, k: number): void {
    const uid = this.uidAt(s, k);
    this.loader!.want(uid, () => thumbUrlFor(this.base, uid, this.px, 0));
  }

  /** Calls off fetches for tiles that went far from the view. */
  private prune(top: number): void {
    const loader = this.loader;
    const d = this.data;
    if (!loader || !d) return;
    const lo = top - this.viewH * KEEP;
    const hi = top + this.viewH * (1 + KEEP);
    // Cancelling takes the key out of the set being walked, which a Set allows.
    for (const uid of loader.inFlight()) {
      const y = this.yOf(uid);
      if (y === null || y + d.layout.rowH < lo || y > hi) loader.cancel(uid);
    }
  }

  /** Lets the oldest thumbnails go once over budget, but none in or a screen around the canvas. Once per move of the canvas. */
  private trim(): void {
    const loader = this.loader;
    const d = this.data;
    if (!loader || !d || !loader.overBudget()) return;
    const lo = this.bufTop - this.viewH;
    const hi = this.bufTop + this.bufH + this.viewH;
    loader.trim((uid) => {
      const y = this.yOf(uid);
      return y !== null && y + d.layout.rowH >= lo && y <= hi;
    });
  }

  private yOf(uid: string): number | null {
    const index = this.indexOf.get(uid);
    const l = this.data?.layout;
    if (index === undefined || !l) return null;
    const s = sectionOfIndex(l, index);
    return l.tops[s] + l.header + Math.floor((index - l.starts[s]) / l.columns) * l.pitch;
  }

  // ---- media types and lengths

  /**
   * Asks for what the tiles in the canvas need to show their play icon and their length,
   * and lets go of what was asked for tiles that left it. Each answer redraws its tile.
   */
  private askMarks(): void {
    const d = this.data;
    if (!d) return;
    if (!d.showBadges) {
      for (const stop of this.asking.values()) stop();
      this.asking.clear();
      return;
    }
    const l = d.layout;
    const tier = badgeTier(l.tile);
    const wanted = new Set<string>();
    const m = this.marks.fill(l, this.bufTop, this.bufTop + this.bufH);
    for (let i = 0; i < m.n; i++) {
      const p = m.tiles[i];
      const item = d.sections[p.s].items[p.k];
      const uid = item.uid;
      const tagged = !!item.tags?.includes(TAG.Video);
      const type = cachedMediaType(uid);
      if (!tagged && type === undefined) wanted.add(uid);
      else if (tier !== "minimal" && classifyVideo(item.tags, type) && cachedDuration(uid) === undefined) wanted.add(uid);
    }
    for (const [uid, stop] of this.asking) {
      if (wanted.has(uid)) continue;
      stop();
      this.asking.delete(uid);
    }
    for (const uid of wanted) {
      if (this.asking.has(uid)) continue;
      const item = this.itemOf(uid);
      if (!item) continue;
      const redraw = () => {
        const index = this.indexOf.get(uid);
        if (index === undefined) return;
        this.redraw.add(index);
        this.schedule();
      };
      const stops: (() => void)[] = [];
      const tagged = !!item.tags?.includes(TAG.Video);
      if (!tagged && cachedMediaType(uid) === undefined) {
        stops.push(
          requestMediaType(uid, (type) => {
            redraw();
            // Now known to be a video: its length is wanted too.
            if (type?.toLowerCase().startsWith("video/") && tier !== "minimal") stops.push(requestDuration(uid, redraw));
          }),
        );
      } else {
        stops.push(requestDuration(uid, redraw));
      }
      this.asking.set(uid, () => stops.forEach((s) => s()));
    }
  }

  private itemOf(uid: string): TimelineItem | null {
    const index = this.indexOf.get(uid);
    const d = this.data;
    if (index === undefined || !d) return null;
    const s = sectionOfIndex(d.layout, index);
    return d.sections[s].items[index - d.layout.starts[s]] ?? null;
  }
}
