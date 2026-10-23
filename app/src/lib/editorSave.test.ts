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
import { fitEdge } from "./editorRender";
import { copyFormatFor } from "./localFile";

describe("the save size", () => {
  it("keeps the full size when no edge is set or the photo already fits", () => {
    expect(fitEdge(4032, 3024, null)).toEqual({ w: 4032, h: 3024 });
    expect(fitEdge(800, 600, 1024)).toEqual({ w: 800, h: 600 });
  });

  it("shrinks the long side to the edge and keeps the shape", () => {
    expect(fitEdge(4032, 3024, 2048)).toEqual({ w: 2048, h: 1536 });
    expect(fitEdge(3024, 4032, 1024)).toEqual({ w: 768, h: 1024 });
  });

  it("never rounds a thin side away", () => {
    expect(fitEdge(10000, 2, 1024)).toEqual({ w: 1024, h: 1 });
  });
});

describe("the copy's default format", () => {
  it("keeps a PNG or WebP as it is and makes everything else a JPEG", () => {
    expect(copyFormatFor("C:\pics\shot.PNG")).toBe("png");
    expect(copyFormatFor("/pics/a.b.webp")).toBe("webp");
    expect(copyFormatFor("C:\pics\IMG_1.jpg")).toBe("jpeg");
    expect(copyFormatFor("C:\pics\IMG_2.heic")).toBe("jpeg");
    expect(copyFormatFor("C:\pics\noext")).toBe("jpeg");
  });
});
