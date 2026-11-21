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

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotReadyError, PhotoEvents, sealedAnchorStore, type AnchorStore, type FeedEvent } from "./photoEvents.ts";
import { PHOTO_EVENTS_FILE, StoreLockedError, clearDataKey, initStore, setDataKey, storeDir, wipeCache } from "./store.ts";

type Anchor = { scope: string; eventId: string } | null;

function memoryStore(initial: Anchor = null): AnchorStore & { value: Anchor; writes: number } {
  const store = {
    value: initial,
    writes: 0,
    read: () => store.value,
    write: (a: Anchor) => {
      store.writes++;
      store.value = a;
    },
  };
  return store;
}

/** A feed answering each call with the next scripted list of events, or throwing it. */
function scriptedFeed(script: (FeedEvent[] | Error)[]) {
  const calls: (string | undefined)[] = [];
  const feed = (_scope: string, last: string | undefined) => {
    calls.push(last);
    const next = script.shift() ?? [];
    return (async function* () {
      if (next instanceof Error) throw next;
      for (const e of next) yield e;
    })();
  };
  return { feed, calls };
}

const ev = (type: string, eventId: string): FeedEvent => ({ type, eventId });
const refused = () => Object.assign(new Error("Invalid event id"), { name: "ValidationError", status: 422 });
const offline = () => Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });

describe("the photos event feed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("takes a fresh anchor on the first look and tells nothing", async () => {
    const store = memoryStore();
    const { feed, calls } = scriptedFeed([[ev("fast_forward", "E1")]]);
    const onChange = vi.fn();
    const events = new PhotoEvents(feed, async () => "vol", store, onChange);
    events.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toEqual([undefined]);
    expect(store.value).toEqual({ scope: "vol", eventId: "E1" });
    expect(onChange).not.toHaveBeenCalled();
    events.stop();
  });

  it("resumes from the stored anchor and tells a trash once, after the debounce", async () => {
    const store = memoryStore({ scope: "vol", eventId: "E5" });
    const { feed, calls } = scriptedFeed([[ev("node_updated", "E6"), ev("node_deleted", "E7")]]);
    const onChange = vi.fn();
    const events = new PhotoEvents(feed, async () => "vol", store, onChange, { debounceMs: 1_500 });
    events.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["E5"]);
    expect(store.value).toEqual({ scope: "vol", eventId: "E7" });
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onChange).toHaveBeenCalledTimes(1);
    events.stop();
  });

  it("gathers changes from looks close together into one", async () => {
    const store = memoryStore({ scope: "vol", eventId: "E1" });
    const { feed } = scriptedFeed([[ev("node_created", "E2")], [ev("node_updated", "E3")]]);
    const onChange = vi.fn();
    const events = new PhotoEvents(feed, async () => "vol", store, onChange, { shownMs: 1_000, debounceMs: 1_500 });
    events.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(store.value?.eventId).toBe("E3");
    events.stop();
  });

  it("an anchor the server no longer knows means one full read and a fresh anchor", async () => {
    const store = memoryStore({ scope: "vol", eventId: "OLD" });
    const { feed, calls } = scriptedFeed([[ev("tree_remove", "none")], [ev("fast_forward", "NEW")]]);
    const onChange = vi.fn();
    const events = new PhotoEvents(feed, async () => "vol", store, onChange, { debounceMs: 10 });
    events.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(["OLD", undefined]);
    expect(store.value).toEqual({ scope: "vol", eventId: "NEW" });
    expect(onChange).toHaveBeenCalledTimes(1);
    events.stop();
  });

  it("an anchor refused for good is dropped, the timeline read once, and a fresh one taken", async () => {
    const store = memoryStore({ scope: "vol", eventId: "BAD" });
    const { feed, calls } = scriptedFeed([refused(), [ev("fast_forward", "NEW")]]);
    const onChange = vi.fn();
    const events = new PhotoEvents(feed, async () => "vol", store, onChange, { shownMs: 1_000, debounceMs: 10 });
    events.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(store.value).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(["BAD", undefined]);
    expect(store.value).toEqual({ scope: "vol", eventId: "NEW" });
    expect(onChange).toHaveBeenCalledTimes(1);
    events.stop();
  });

  it("a network that is down keeps the anchor and backs off", async () => {
    const store = memoryStore({ scope: "vol", eventId: "E1" });
    const { feed, calls } = scriptedFeed([offline(), offline(), [ev("node_deleted", "E2")]]);
    const onChange = vi.fn();
    const events = new PhotoEvents(feed, async () => "vol", store, onChange, { shownMs: 1_000, debounceMs: 10 });
    events.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.healthy()).toBe(false);
    // 2 s after the first failure, 4 s after the second.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toEqual(["E1", "E1", "E1"]);
    expect(store.value?.eventId).toBe("E2");
    await vi.advanceTimersByTimeAsync(10);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(events.healthy()).toBe(true);
    events.stop();
  });

  it("no signed-in client is waited out, never taken for a refused anchor", async () => {
    const store = memoryStore({ scope: "vol", eventId: "E1" });
    const onChange = vi.fn();
    const events = new PhotoEvents(
      () => {
        throw new NotReadyError();
      },
      async () => "vol",
      store,
      onChange,
      { debounceMs: 10 },
    );
    events.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.value).toEqual({ scope: "vol", eventId: "E1" });
    expect(onChange).not.toHaveBeenCalled();
    events.stop();
  });

  it("another volume's anchor is not used", async () => {
    const store = memoryStore({ scope: "other", eventId: "X9" });
    const { feed, calls } = scriptedFeed([[ev("fast_forward", "E1")]]);
    const events = new PhotoEvents(feed, async () => "vol", store, vi.fn());
    events.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([undefined]);
    expect(store.value).toEqual({ scope: "vol", eventId: "E1" });
    events.stop();
  });

  it("a lock stops the looks, drops a change not yet told and writes nothing", async () => {
    const store = memoryStore({ scope: "vol", eventId: "E1" });
    const { feed, calls } = scriptedFeed([[ev("node_deleted", "E2")], [ev("node_deleted", "E3")]]);
    const onChange = vi.fn();
    const events = new PhotoEvents(feed, async () => "vol", store, onChange, { shownMs: 1_000, debounceMs: 1_500 });
    events.start();
    await vi.advanceTimersByTimeAsync(0);
    events.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).not.toHaveBeenCalled();
    expect(calls.length).toBe(1);
    expect(events.running).toBe(false);
    expect(events.check()).toEqual({ healthy: false });
  });

  it("a store locked under a look is left as it is", async () => {
    const writes: Anchor[] = [];
    const store: AnchorStore = {
      read: () => {
        throw new StoreLockedError();
      },
      write: (a) => void writes.push(a),
    };
    const onChange = vi.fn();
    const { feed, calls } = scriptedFeed([]);
    const events = new PhotoEvents(feed, async () => "vol", store, onChange, { debounceMs: 10 });
    events.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    events.stop();
  });

  it("focus asks for a look and says whether the feed is to be trusted", async () => {
    const store = memoryStore({ scope: "vol", eventId: "E1" });
    const { feed, calls } = scriptedFeed([[], [], []]);
    const events = new PhotoEvents(feed, async () => "vol", store, vi.fn(), { shownMs: 30_000, hiddenMs: 300_000 });
    events.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.check()).toEqual({ healthy: true });
    expect(calls.length).toBe(1);
    // Hidden, the looks are minutes apart and still trusted.
    events.setShown(false);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(events.healthy()).toBe(true);
    // A minute after coming back with no look answered, it is not.
    events.setShown(true);
    events.stop();
    expect(events.check()).toEqual({ healthy: false });
  });
});

describe("the sealed anchor", () => {
  let key: Buffer;
  beforeEach(() => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-events-")));
    key = randomBytes(32);
    setDataKey(Buffer.from(key));
  });

  it("survives a restart, is unreadable while locked and goes with the account", () => {
    const store = sealedAnchorStore();
    expect(store.read()).toBeNull();
    store.write({ scope: "vol", eventId: "E42" });
    const path = join(storeDir(), PHOTO_EVENTS_FILE);
    const sealed = readFileSync(path);
    expect(sealed.includes(Buffer.from("E42"))).toBe(false);
    clearDataKey();
    expect(() => sealedAnchorStore().read()).toThrow(StoreLockedError);
    expect(() => sealedAnchorStore().write({ scope: "vol", eventId: "E43" })).toThrow(StoreLockedError);
    expect(readFileSync(path).equals(sealed)).toBe(true);
    setDataKey(Buffer.from(key));
    expect(sealedAnchorStore().read()).toEqual({ scope: "vol", eventId: "E42" });
    store.write(null);
    expect(sealedAnchorStore().read()).toBeNull();
    store.write({ scope: "vol", eventId: "E44" });
    wipeCache();
    expect(existsSync(path)).toBe(false);
  });
});
