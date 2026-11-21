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

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

import { ProtonSession } from "./session.ts";

describe("a shared backup round before the window named the kinds it reads", () => {
  it("reads the copies on Drive first, and holds this computer's copy that would not open", async () => {
    const session = new ProtonSession();
    const read = vi.fn(async () => ({ unreadable: 1, ownUnreadable: ["hidden"] }));
    const saveHidden = vi.fn(async () => true);
    (session as any).getDriveCollections = read;
    (session as any).hiddenDirty = () => true;
    (session as any).saveHidden = saveHidden;

    await session.backup.backUpNow();

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]).toEqual([true, { faces: true, labels: true, search: false, faceData: false }]);
    expect(saveHidden).not.toHaveBeenCalled();
    expect(session.backup.getStatus().failed).toBe(true);
  });
});
