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

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CONTEXT_LENGTH, ClipTokenizer } from "./clipTokenizer.ts";

const vocabulary = gunzipSync(readFileSync(new URL("./assets/bpe_simple_vocab_16e6.txt.gz", import.meta.url))).toString(
  "utf8",
);
const tokenizer = new ClipTokenizer(vocabulary);

/** The ids before the padding, which is all zeros after them. */
function content(text: string): number[] {
  const ids = [...tokenizer.encode(text)];
  expect(ids).toHaveLength(CONTEXT_LENGTH);
  const end = ids.indexOf(49407);
  expect(ids.slice(end + 1).every((id) => id === 0)).toBe(true);
  return ids.slice(0, end + 1);
}

describe("the CLIP tokenizer", () => {
  // The same ids the Android app pins, each open_clip's SimpleTokenizer output.
  it("encodes common queries to the open_clip reference ids", () => {
    expect(content("a photo of a cat")).toEqual([49406, 320, 1125, 539, 320, 2368, 49407]);
    expect(content("cat")).toEqual([49406, 2368, 49407]);
    expect(content("dog")).toEqual([49406, 1929, 49407]);
    expect(content("car")).toEqual([49406, 1615, 49407]);
    expect(content("beach")).toEqual([49406, 2117, 49407]);
    expect(content("sunset")).toEqual([49406, 3424, 49407]);
    expect(content("a dog in the snow")).toEqual([49406, 320, 1929, 530, 518, 2583, 49407]);
  });

  it("folds case and spacing, and reads entities as the reference does", () => {
    expect(content("  A   Dog  ")).toEqual(content("a dog"));
    expect(content("cat &amp; dog")).toEqual(content("cat & dog"));
  });

  it("keeps the start, the end and the length for a query longer than the context", () => {
    const ids = tokenizer.encode(Array.from({ length: 200 }, () => "cat").join(" "));
    expect(ids).toHaveLength(CONTEXT_LENGTH);
    expect(ids[0]).toBe(49406);
    expect(ids[CONTEXT_LENGTH - 1]).toBe(49407);
  });

  it("encodes words outside the plain alphabet without failing", () => {
    expect(content("kutya a hóban").length).toBeGreaterThan(3);
    expect(content("2024").length).toBe(6);
  });
});
