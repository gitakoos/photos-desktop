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

import { requestSignOut } from "./signOut";

describe("signing out", () => {
  it("is out once the sidecar answers that it let the account go", async () => {
    const call = vi.fn(() => Promise.resolve({ ok: true }));
    expect(await requestSignOut(call, false)).toEqual({ kind: "out" });
    expect(call).toHaveBeenCalledWith("signOut", {});
  });

  it("passes on the choice to lose what is not on Drive", async () => {
    const call = vi.fn(() => Promise.resolve({ ok: true }));
    await requestSignOut(call, true);
    expect(call).toHaveBeenCalledWith("signOut", { discard: true });
  });

  it("is held with the kinds of change not on Drive yet", async () => {
    const call = vi.fn(() => Promise.resolve({ ok: false, unsaved: ["labels", "faces"] }));
    expect(await requestSignOut(call, false)).toEqual({ kind: "held", unsaved: ["labels", "faces"] });
  });

  it("fails, and so stays signed in, when the sidecar does not answer", async () => {
    const call = vi.fn(() => Promise.reject(new Error("signOut timed out after 180000ms")));
    expect(await requestSignOut(call, false)).toEqual({ kind: "failed" });
  });

  it("fails when the answer neither lets go nor names what holds it", async () => {
    expect(await requestSignOut(vi.fn(() => Promise.resolve({ ok: false })), false)).toEqual({ kind: "failed" });
    expect(await requestSignOut(vi.fn(() => Promise.resolve(null)), false)).toEqual({ kind: "failed" });
  });
});
