/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect } from "vitest";
import { svgText } from "./tileArt";
import { CheckIcon, CloudIcon, OfflinePinIcon, RawIcon } from "../components/icons";

describe("an icon written out for the canvas", () => {
  it("is standalone SVG in the given colour, at the given size", () => {
    const svg = svgText(<CheckIcon size={22} />, "#fff");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" color="#fff"/);
    expect(svg).toContain('width="22"');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('<path d="M9 16.17');
    expect(svg).not.toContain("aria");
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("spells React's attribute names as SVG's", () => {
    expect(svgText(<RawIcon size={11} />, "#fff")).toContain('fill-rule="evenodd"');
    expect(svgText(<OfflinePinIcon size={11} filled />, "#fff")).toContain('fill="currentColor"');
    expect(svgText(<CloudIcon size={11} filled />, "#30d158")).toContain('color="#30d158"');
  });
});
