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

import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

import { ProtonSession } from "./session.ts";
import { initStore, metaPut, setDataKey } from "./store.ts";

describe("the names the viewer can show at once", () => {
  it("come from the cache only, and leave out photos with none", () => {
    setDataKey(randomBytes(32));
    initStore(mkdtempSync(join(tmpdir(), "pfp-names-")));
    metaPut("uid-A", { name: "beach.jpg", mediaType: "image/jpeg" });
    const session = new ProtonSession();
    // No Proton client: nothing may be fetched for a name.
    expect(session.cachedNames(["uid-A", "uid-B"])).toEqual({ "uid-A": "beach.jpg" });
  });
});
