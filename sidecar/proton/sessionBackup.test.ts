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

import { afterEach, describe, expect, it, vi } from "vitest";

import { session } from "./session.ts";

/** The labels' part of the shared backup, with the switch at `labels` and labels to save. */
function labelsPart(labels: boolean) {
  const self = session as any;
  self.backupKinds = { faces: false, labels, search: false, faceData: false };
  vi.spyOn(self, "labelsEmpty").mockReturnValue(false);
  const copyGone = vi.spyOn(self, "copyGone").mockResolvedValue(true);
  const part = self.backup.parts().find((p: { kind: string }) => p.kind === "labels");
  return { part, copyGone };
}

describe("the labels' copy gone from Drive", () => {
  afterEach(() => {
    (session as any).backupKinds = null;
    vi.restoreAllMocks();
  });

  it("is not sent again, nor looked for, with the Labels switch off", async () => {
    const { part, copyGone } = labelsPart(false);
    expect(await part.gone()).toBe(false);
    expect(copyGone).not.toHaveBeenCalled();
  });

  it("is sent again with the Labels switch on", async () => {
    const { part, copyGone } = labelsPart(true);
    expect(await part.gone()).toBe(true);
    expect(copyGone).toHaveBeenCalledOnce();
  });
});
