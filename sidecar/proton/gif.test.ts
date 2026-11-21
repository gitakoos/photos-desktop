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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { gifBegin, gifCancel, gifFrame, gifName, joinFrames } from "./gif.ts";

describe("the GIF maker's writing side", () => {
  it("joins frames into a looping GIF of their size, one delay each", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-gif-test-"));
    try {
      const files: string[] = [];
      for (const [i, colour] of ["#d02020", "#20d020", "#2020d0", "#d0d020"].entries()) {
        const f = join(dir, `${i}.img`);
        writeFileSync(f, await sharp({ create: { width: 80, height: 60, channels: 3, background: colour } }).jpeg().toBuffer());
        files.push(f);
      }
      const gif = await joinFrames(files, 80, 60);
      const meta = await sharp(gif, { animated: true }).metadata();
      expect(meta.format).toBe("gif");
      expect(meta.pages).toBe(4);
      expect(meta.width).toBe(80);
      expect(meta.pageHeight).toBe(60);
      expect(meta.loop).toBe(0);
      expect(meta.delay).toEqual([80, 80, 80, 80]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes frames only for a job it knows, within ten seconds of them, at an offered size", () => {
    expect(() => gifBegin(4000, 3000)).toThrow();
    const { job } = gifBegin(720, 405);
    expect(gifFrame(job, 0, Buffer.from("x").toString("base64")).count).toBe(1);
    expect(() => gifFrame(job, 120, "eA==")).toThrow();
    gifCancel(job);
    expect(() => gifFrame(job, 1, "eA==")).toThrow();
  });

  it("names the GIF after the video, marked and stamped", () => {
    expect(gifName("VID_20240101_101010.mp4", new Date(2026, 10, 8, 9, 5, 3))).toBe("VID_20240101_101010_gif_20261108_090503.gif");
  });
});
