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

// What changed in the photos volume since the last look, read from Drive's event feed for that
// volume from the last event this computer took in (the anchor), as the phone does. A photo
// added, changed, trashed, restored or deleted on another device tells the window to read the
// timeline again, a little after the last such event. The anchor is sealed in the store, so it
// survives a restart and goes with the account; one the server no longer knows means one full
// read and a fresh anchor.

import { join } from "node:path";

import { isTransient } from "./transient.ts";
import { PHOTO_EVENTS_FILE, StoreLockedError, readSealedOrSetAside, rethrowLocked, storeDir, writeSealedAtomic } from "./store.ts";

/** One event as the SDK's `iterateEvents` yields it; only the type and the id are read. */
export type FeedEvent = { type: string; eventId: string };

/** The SDK's `iterateEvents` for one volume: from `lastEventId` on, or only the latest id without one. */
export type EventFeed = (scopeId: string, lastEventId: string | undefined, signal: AbortSignal) => AsyncIterable<FeedEvent>;

/** Where the anchor is kept: the volume it belongs to and the last event id taken in. */
export type AnchorStore = {
  read(): { scope: string; eventId: string } | null;
  write(anchor: { scope: string; eventId: string } | null): void;
};

export type PhotoEventsOptions = {
  /** Between looks while the window is on screen. */
  shownMs: number;
  /** Between looks while the app is in the tray. */
  hiddenMs: number;
  /** The longest pause after failures in a row. */
  maxBackoffMs: number;
  /** How long after the last change the window is told. */
  debounceMs: number;
  now: () => number;
};

export const DEFAULT_OPTIONS: PhotoEventsOptions = {
  shownMs: 30_000,
  hiddenMs: 5 * 60_000,
  maxBackoffMs: 10 * 60_000,
  debounceMs: 1_500,
  now: () => Date.now(),
};

/** How recent a successful look must be for the window to trust the feed rather than read again. */
export const HEALTHY_WITHIN_MS = 60_000;

/** Thrown by the feed or the scope while there is no signed-in client to ask: waited out, never taken for a refused anchor. */
export class NotReadyError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "NotReadyError";
  }
}

const CHANGES = new Set(["node_created", "node_updated", "node_deleted", "tree_refresh"]);

/** The sealed file in the store that holds the anchor. */
export function sealedAnchorStore(): AnchorStore {
  const path = () => join(storeDir(), PHOTO_EVENTS_FILE);
  return {
    read() {
      try {
        const raw = readSealedOrSetAside(path());
        if (!raw) return null;
        const parsed = JSON.parse(raw.toString("utf8")) as { scope?: unknown; eventId?: unknown };
        return typeof parsed.scope === "string" && typeof parsed.eventId === "string" && parsed.eventId
          ? { scope: parsed.scope, eventId: parsed.eventId }
          : null;
      } catch (e) {
        rethrowLocked(e);
        return null;
      }
    },
    write(anchor) {
      writeSealedAtomic(path(), Buffer.from(JSON.stringify(anchor ?? {}), "utf8"));
    },
  };
}

export class PhotoEvents {
  private readonly opts: PhotoEventsOptions;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private polling: Promise<void> | null = null;
  private scopeId: string | null = null;
  private shown = true;
  private shownSince = 0;
  private failures = 0;
  private lastOkAt = 0;
  private lastPollAt = 0;

  constructor(
    private readonly feed: EventFeed,
    private readonly scope: () => Promise<string>,
    private readonly anchors: AnchorStore,
    private readonly onChange: () => void,
    opts: Partial<PhotoEventsOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  get running(): boolean {
    return this.abort !== null;
  }

  /** Starts looking, the first time at once. Nothing happens when already running. */
  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    this.failures = 0;
    this.schedule(0);
  }

  /** Stops looking and forgets the volume and any change not yet told. The anchor stays sealed on disk. */
  stop(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
    this.polling = null;
    this.scopeId = null;
    this.lastOkAt = 0;
    this.lastPollAt = 0;
  }

  /** The window went to the tray or came back: it looks less often while hidden. */
  setShown(shown: boolean): void {
    const was = this.shown;
    this.shown = shown;
    if (shown && !was) this.shownSince = this.opts.now();
    if (shown && !was && this.abort && !this.polling) this.schedule(0);
  }

  /**
   * For the window coming back into focus: starts a look unless one ran in the last few seconds,
   * and answers at once whether the feed is to be trusted: running, and its last look answered
   * on time (within `HEALTHY_WITHIN_MS`, or the slower tray pace plus that while hidden).
   */
  check(): { healthy: boolean } {
    const healthy = this.healthy();
    if (this.abort && this.opts.now() - this.lastPollAt > 5_000) void this.poll();
    return { healthy };
  }

  healthy(): boolean {
    if (!this.abort || this.lastOkAt === 0 || this.failures > 0) return false;
    // Just back from the tray, the last look ran at the tray's pace.
    const trayPace = !this.shown || this.opts.now() - this.shownSince < HEALTHY_WITHIN_MS;
    const allowed = trayPace ? this.opts.hiddenMs + HEALTHY_WITHIN_MS : HEALTHY_WITHIN_MS;
    return this.opts.now() - this.lastOkAt <= allowed;
  }

  /** One look at the feed. A look already running is waited for rather than doubled. */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    const run = this.pollOnce().finally(() => {
      if (this.polling === run) this.polling = null;
    });
    this.polling = run;
    return run;
  }

  private async pollOnce(): Promise<void> {
    const abort = this.abort;
    if (!abort) return;
    const signal = abort.signal;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastPollAt = this.opts.now();
    let saved: string | null = null;
    try {
      const scope = this.scopeId ?? (await this.scope());
      if (signal.aborted) return;
      this.scopeId = scope;
      const stored = this.anchors.read();
      saved = stored && stored.scope === scope ? stored.eventId : null;
      let latest = saved;
      let changed = false;
      let invalid = false;
      for await (const event of this.feed(scope, saved ?? undefined, signal)) {
        if (signal.aborted) return;
        if (event.type === "tree_remove") {
          invalid = true;
          break;
        }
        if (saved && CHANGES.has(event.type)) changed = true;
        if (event.eventId && event.eventId !== "none") latest = event.eventId;
      }
      if (signal.aborted) return;
      if (invalid) {
        this.anchors.write(null);
        if (saved) this.changed();
        this.failures = 0;
        this.lastOkAt = this.opts.now();
        this.schedule(0);
        return;
      }
      if (latest && latest !== saved) this.anchors.write({ scope, eventId: latest });
      this.failures = 0;
      this.lastOkAt = this.opts.now();
      if (changed) this.changed();
    } catch (e) {
      if (signal.aborted || e instanceof StoreLockedError) return;
      this.failures++;
      // Refused for good, not a network that went away: the anchor is not taken any more. One full
      // read stands in for what it would have said, and the next look takes a fresh one.
      if (!isTransient(e) && !(e instanceof NotReadyError) && saved) {
        try {
          this.anchors.write(null);
        } catch {
          /* locked meanwhile: the anchor is left for the next look to try */
        }
        this.changed();
      }
    }
    if (this.abort === abort) this.schedule(this.nextDelay());
  }

  private nextDelay(): number {
    const base = this.shown ? this.opts.shownMs : this.opts.hiddenMs;
    if (this.failures === 0) return base;
    return Math.min(base * 2 ** Math.min(this.failures, 10), this.opts.maxBackoffMs);
  }

  private schedule(ms: number): void {
    if (!this.abort) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, ms);
    this.timer.unref?.();
  }

  private changed(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      if (this.abort) this.onChange();
    }, this.opts.debounceMs);
    this.debounce.unref?.();
  }
}
