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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { tempFor } from "./compression.ts";
import { compressedUploadOf, forgetCompressedUploads, MAX_REMEMBERED, rememberCompressedUpload } from "./compressedUploads.ts";
import { initStore, setDataKey, wipeCache } from "./store.ts";

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-compressed-")));
  setDataKey(randomBytes(32));
  forgetCompressedUploads();
});

describe("the lighter copies uploaded from here", () => {
  it("remembers which photo an original went up as, across a restart", () => {
    expect(compressedUploadOf("sha-a")).toBeNull();
    rememberCompressedUpload("sha-a", "vol~photo1");
    forgetCompressedUploads();
    expect(compressedUploadOf("sha-a")).toBe("vol~photo1");
  });

  it("keeps the newest upload of an original, and drops the oldest past the cap", () => {
    rememberCompressedUpload("sha-a", "vol~old");
    rememberCompressedUpload("sha-a", "vol~new");
    expect(compressedUploadOf("sha-a")).toBe("vol~new");
    expect(MAX_REMEMBERED).toBeGreaterThan(1000);
  });

  it("is gone with the account's other data at a sign-out", () => {
    rememberCompressedUpload("sha-a", "vol~photo1");
    wipeCache();
    forgetCompressedUploads();
    expect(compressedUploadOf("sha-a")).toBeNull();
  });
});

describe("a lighter copy's temp file", () => {
  it("is its own for every copy, so two uploads of one file never share one", () => {
    const a = tempFor("C:/v/clip.mov", 100, "video:avc", ".mp4");
    const b = tempFor("C:/v/clip.mov", 100, "video:avc", ".mp4");
    expect(a).not.toBe(b);
    expect(basename(a).endsWith(".mp4")).toBe(true);
  });
});
