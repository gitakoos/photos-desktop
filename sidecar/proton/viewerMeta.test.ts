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
import { afterEach, describe, expect, it, vi } from "vitest";

import { CameraFactsJobs, embeddedClip, LIVE_CLIP_MAX_BYTES, localMotionClip, motionClipOf } from "./viewerMeta.ts";

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom", "latin1"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("isommp41", "latin1"),
  Buffer.from("clip-bytes", "latin1"),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6, 0xff, 0xd9]);
const MOTION = Buffer.concat([JPEG, MP4]);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "pfp-motion-"));
  dirs.push(d);
  return d;
};

describe("embeddedClip", () => {
  it("cuts the clip out as base64", () => {
    expect(Buffer.from(embeddedClip(MOTION)!.base64, "base64").equals(MP4)).toBe(true);
    expect(embeddedClip(JPEG)).toBeNull();
  });
});

describe("motionClipOf", () => {
  const video = vi.fn(async () => ({ base64: "VIDEO", mime: "video/quicktime" }));

  it("plays the video related to a Live Photo", async () => {
    const photos = {
      getNode: vi.fn(async (uid: string) =>
        uid === "main"
          ? { mediaType: "image/heic", photo: { relatedPhotoNodeUids: ["clip"] } }
          : { mediaType: "video/quicktime" },
      ),
    };
    const clip = await motionClipOf(photos, "main", { original: async () => null, video });
    expect(clip?.base64).toBe("VIDEO");
    expect(video).toHaveBeenCalledWith(photos, "clip");
  });

  it("cuts the clip out of a motion photo's own bytes", async () => {
    const photos = { getNode: async () => ({ mediaType: "image/jpeg", photo: { relatedPhotoNodeUids: [] } }) };
    const clip = await motionClipOf(photos, "m", { original: async () => MOTION, video });
    expect(Buffer.from(clip!.base64, "base64").equals(MP4)).toBe(true);
  });

  it("has no clip for a plain photo or another format", async () => {
    const jpeg = { getNode: async () => ({ mediaType: "image/jpeg" }) };
    expect(await motionClipOf(jpeg, "p", { original: async () => JPEG, video })).toBeNull();
    const png = { getNode: async () => ({ mediaType: "image/png" }) };
    expect(await motionClipOf(png, "p", { original: async () => MOTION, video })).toBeNull();
  });
});

describe("localMotionClip", () => {
  it("reads the clip inside a motion photo file", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "PXL_1.MP.jpg"), MOTION);
    const clip = await localMotionClip(join(dir, "PXL_1.MP.jpg"));
    expect(Buffer.from(clip!.base64, "base64").equals(MP4)).toBe(true);
  });

  it("reads the movie beside a Live Photo", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "IMG_2210.HEIC"), Buffer.from("heic"));
    writeFileSync(join(dir, "img_2210.MOV"), MP4);
    const clip = await localMotionClip(join(dir, "IMG_2210.HEIC"));
    expect(clip?.mime).toBe("video/quicktime");
    expect(Buffer.from(clip!.base64, "base64").equals(MP4)).toBe(true);
  });

  it("has nothing for a plain picture, a missing file or another type", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "a.jpg"), JPEG);
    writeFileSync(join(dir, "b.png"), MOTION);
    expect(await localMotionClip(join(dir, "a.jpg"))).toBeNull();
    expect(await localMotionClip(join(dir, "b.png"))).toBeNull();
    expect(await localMotionClip(join(dir, "gone.jpg"))).toBeNull();
  });

  it("takes only a small regular movie beside a still, named by an absolute path", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "IMG_1.HEIC"), Buffer.from("heic"));
    writeFileSync(join(dir, "IMG_1.mov"), Buffer.alloc(LIVE_CLIP_MAX_BYTES + 1));
    expect(await localMotionClip(join(dir, "IMG_1.HEIC"))).toBeNull();
    writeFileSync(join(dir, "IMG_1.mp4"), MP4);
    expect((await localMotionClip(join(dir, "IMG_1.HEIC")))?.mime).toBe("video/mp4");
    expect(await localMotionClip("IMG_1.HEIC")).toBeNull();
    writeFileSync(join(dir, "clip.mov"), MP4);
    expect(await localMotionClip(join(dir, "clip.mov"))).toBeNull();
  });
});

describe("CameraFactsJobs", () => {
  it("answers working at first and the facts once read", async () => {
    const read = vi.fn(async () => null);
    const jobs = new CameraFactsJobs(read);
    expect(jobs.ask("a")).toEqual({ state: "working" });
    await vi.waitFor(() => expect(jobs.ask("a")).toEqual({ state: "done", facts: null }));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("is done with no facts when the bytes cannot be had", async () => {
    const jobs = new CameraFactsJobs(async () => {
      throw new Error("offline");
    });
    jobs.ask("a");
    await vi.waitFor(() => expect(jobs.ask("a")).toEqual({ state: "done", facts: null }));
  });
});
