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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("./rpc", () => ({ rpc: (...args: unknown[]) => rpc(...args) }));

import { offlineStatus, watchOffline, type OfflineStatus } from "./offline";

const status = (pinned: string[], ready = pinned.length): OfflineStatus => ({
  pinned,
  ready,
  bytes: ready * 100,
  running: false,
  done: 0,
  total: 0,
  failed: 0,
});

describe("watchOffline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("notifies only when the reading changes", async () => {
    rpc.mockResolvedValue(status(["a", "b"]));
    const seen: OfflineStatus[] = [];
    const stop = watchOffline((s) => seen.push(s));

    await vi.advanceTimersByTimeAsync(0);
    await offlineStatus();
    await offlineStatus();
    expect(seen).toHaveLength(1);

    rpc.mockResolvedValue(status(["a", "b", "c"]));
    await offlineStatus();
    expect(seen.map((s) => s.pinned)).toEqual([["a", "b"], ["a", "b", "c"]]);

    rpc.mockResolvedValue(status(["a", "b", "c"], 2));
    await offlineStatus();
    expect(seen).toHaveLength(3);
    stop();
  });
});
