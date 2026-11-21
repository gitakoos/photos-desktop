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

import { describe, expect, it, vi } from "vitest";

import { refreshSharedBackup } from "./backupRefresh";

describe("the shared backup on a refresh of the library", () => {
  it("asks the sidecar once, with the backup on and a connection", () => {
    const call = vi.fn(() => Promise.resolve());
    expect(refreshSharedBackup(true, true, call)).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("sharedBackupRefresh");
  });

  it("asks nothing with the backup off or offline", () => {
    const call = vi.fn(() => Promise.resolve());
    expect(refreshSharedBackup(false, true, call)).toBe(false);
    expect(refreshSharedBackup(true, false, call)).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("does not wait for the answer, and a failed call stays quiet", async () => {
    const never = vi.fn(() => new Promise<void>(() => {}));
    expect(refreshSharedBackup(true, true, never)).toBe(true);
    const fails = vi.fn(() => Promise.reject(new Error("offline")));
    expect(refreshSharedBackup(true, true, fails)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(fails).toHaveBeenCalledTimes(1);
  });
});
