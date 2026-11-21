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

import { describe, expect, it } from "vitest";
import { importKey, signData } from "@protontech/crypto/subtle/hmac.ts";

import { LibraryIndex, contentHashOf } from "./importMatch.ts";

const KEY = new Uint8Array(32).map((_, i) => i + 1);
const SHA1 = "a9993e364706816aba3e25717850c26c9cd0d89d";

function index(uids: string[], hashes: [string, string][] = [], hidden = new Set<string>(), listed = new Set(uids)) {
  return new LibraryIndex(uids, hashes, listed, KEY, (uid) => hidden.has(uid));
}

describe("the import's library check", () => {
  it("keys a file's SHA-1 the way Proton keys a content hash", async () => {
    const key = await importKey(KEY);
    const theirs = Buffer.from(await signData(key, new TextEncoder().encode(SHA1))).toString("hex");
    expect(contentHashOf(SHA1, KEY)).toBe(theirs);
  });

  it("finds the same file under any name", () => {
    const lib = index(["v~1"], [["v~1", contentHashOf(SHA1, KEY)]]);
    expect(lib.canMatchContent()).toBe(true);
    expect(lib.sameFile(SHA1)).toBe("v~1");
    expect(lib.sameFile("b".repeat(40))).toBeNull();
  });

  it("finds a Live Photo's video by its bytes, as the photo it belongs to", () => {
    const video = "c".repeat(40);
    const lib = index(["v~1"], [["v~1", contentHashOf(SHA1, KEY)], ["v~1", contentHashOf(video, KEY)]]);
    expect(lib.sameFile(video)).toBe("v~1");
  });

  it("does not take a trashed photo's hash for one still there", () => {
    const lib = index(["v~1"], [["v~gone", contentHashOf(SHA1, KEY)]]);
    expect(lib.sameFile(SHA1)).toBeNull();
  });

  it("points at a shown copy rather than a hidden one, and says when only a hidden one has the bytes", () => {
    const hash = contentHashOf(SHA1, KEY);
    const both = index(["v~h", "v~s"], [["v~h", hash], ["v~s", hash]], new Set(["v~h"]));
    expect(both.sameFile(SHA1)).toBe("v~s");
    const hiddenOnly = index(["v~h"], [["v~h", hash]], new Set(["v~h"]));
    expect(hiddenOnly.hidden(hiddenOnly.sameFile(SHA1)!)).toBe(true);
  });

  it("matches by content only when the listing went through every photo of the library", () => {
    const hashes: [string, string][] = [["v~1", contentHashOf(SHA1, KEY)]];
    expect(index(["v~1", "v~2"], hashes, new Set(), new Set(["v~1"])).canMatchContent()).toBe(false);
    // A photo listed without a hash still counts as gone through: it is found by name and bytes.
    expect(index(["v~1", "v~2"], hashes).canMatchContent()).toBe(true);
  });

  it("cannot match by content without the key", () => {
    expect(new LibraryIndex(["v~1"], [["v~1", contentHashOf(SHA1, KEY)]], new Set(["v~1"]), null).canMatchContent()).toBe(false);
  });

  it("matches against an empty library, which holds nothing to find", () => {
    expect(index([]).canMatchContent()).toBe(true);
    expect(new LibraryIndex([], [], new Set(), null).canMatchContent()).toBe(true);
  });
});
