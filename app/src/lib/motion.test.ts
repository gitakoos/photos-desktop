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
import { clipBlob, isHold, motionKindOf } from "./motion";
import { TAG } from "./tags";

describe("motionKindOf", () => {
  it("tells the two kinds of clip apart", () => {
    expect(motionKindOf([TAG.LivePhoto])).toBe("live");
    expect(motionKindOf([TAG.Favorite, TAG.MotionPhoto])).toBe("motion");
  });

  it("is null for a photo with no clip", () => {
    expect(motionKindOf([TAG.Favorite, TAG.Panorama])).toBeNull();
    expect(motionKindOf([])).toBeNull();
    expect(motionKindOf(undefined)).toBeNull();
    expect(motionKindOf(null)).toBeNull();
  });
});

describe("clipBlob", () => {
  it("decodes the bytes and keeps the type", async () => {
    const blob = clipBlob({ base64: btoa("abc"), mime: "video/quicktime" });
    expect(blob.type).toBe("video/quicktime");
    expect(blob.size).toBe(3);
  });

  it("defaults the type to MP4", () => {
    expect(clipBlob({ base64: "", mime: "" }).type).toBe("video/mp4");
  });
});

describe("isHold", () => {
  it("allows a little drift and no pan", () => {
    expect(isHold(0, 0)).toBe(true);
    expect(isHold(3, 3)).toBe(true);
    expect(isHold(6, 6)).toBe(false);
  });
});
