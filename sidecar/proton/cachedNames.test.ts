/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
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
