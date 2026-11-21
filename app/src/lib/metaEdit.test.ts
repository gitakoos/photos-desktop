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
import { describable, DESCRIPTION_READ_MAX_BYTES, emptyFields, fieldsOf, stripChange, textChange, type MetaInfo } from "./metaEdit";

const info = (over: Partial<MetaInfo> = {}): MetaInfo => ({ uid: "v~a", name: "IMG_1.jpg", text: null, blocked: null, ...over });

describe("fieldsOf", () => {
  it("opens with what the file holds, empty for what it lacks", () => {
    expect(fieldsOf(info({ text: { description: "Sunset", copyright: null, author: "Ann" } }))).toEqual({ description: "Sunset", author: "Ann", copyright: "" });
    expect(fieldsOf(info())).toEqual(emptyFields);
    expect(fieldsOf(undefined)).toEqual(emptyFields);
  });
});

describe("textChange", () => {
  const held = { description: "Sunset", author: "Ann", copyright: "" };

  it("one photo: only the fields that changed, an emptied one clearing the field", () => {
    expect(textChange(true, held, held)).toBeNull();
    expect(textChange(true, held, { ...held, description: "Sunrise" })).toEqual({ kind: "text", description: "Sunrise" });
    expect(textChange(true, held, { ...held, author: "  " })).toEqual({ kind: "text", author: "" });
    expect(textChange(true, held, { description: "Sunset", author: "Ann", copyright: "(c) A" })).toEqual({ kind: "text", copyright: "(c) A" });
  });

  it("several photos: the fields with text, never a description", () => {
    expect(textChange(false, emptyFields, emptyFields)).toBeNull();
    expect(textChange(false, emptyFields, { description: "x", author: "Ann", copyright: "" })).toEqual({ kind: "text", author: "Ann" });
    expect(textChange(false, emptyFields, { description: "x", author: "", copyright: "" })).toBeNull();
  });
});

describe("stripChange", () => {
  it("asks only when a group is ticked", () => {
    expect(stripChange({ location: false, camera: false, text: false })).toBeNull();
    expect(stripChange({ location: true, camera: false, text: false })).toEqual({ kind: "strip", location: true, camera: false, text: false });
  });
});

describe("describable", () => {
  it("reads only a JPEG or PNG of a known size up to the cap", () => {
    expect(describable("image/jpeg", 5_000_000)).toBe(true);
    expect(describable("image/PNG; x=y", DESCRIPTION_READ_MAX_BYTES)).toBe(true);
    expect(describable("image/jpeg", DESCRIPTION_READ_MAX_BYTES + 1)).toBe(false);
    expect(describable("image/jpeg", null)).toBe(false);
    expect(describable("video/mp4", 1000)).toBe(false);
    expect(describable("image/heic", 1000)).toBe(false);
    expect(describable(null, 1000)).toBe(false);
  });
});
