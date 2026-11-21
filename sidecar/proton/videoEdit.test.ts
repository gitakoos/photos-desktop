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

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  editDownloadDir,
  editedMediaName,
  EditorDownloads,
  isEditOutput,
  isEditThumb,
  isHydratedDownload,
  saveEditedMedia,
  sourceExtension,
  stageSource,
  stagingRoot,
  STAGING_DIR,
} from "./videoEdit.ts";

const made: string[] = [];
afterEach(() => {
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});

// The host names its staging folder; this file stands in for it with one of its own.
let base = "";
let root = "";
beforeAll(() => {
  // Resolved like the output the app passes in: on macOS the temp folder sits behind a link.
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "pfp-vedit-test-")));
  root = join(base, STAGING_DIR);
  process.env.PFP_VEDIT_DIR = root;
  mkdirSync(editDownloadDir(), { recursive: true });
});
afterAll(() => {
  delete process.env.PFP_VEDIT_DIR;
  rmSync(base, { recursive: true, force: true });
});

const DOWNLOAD = "pfp-hyd-0b9cf1d2-5a1e-4f6b-8c3a-1d2e3f4a5b6c.bin";
const file = (path: string, body: string | Buffer = "x") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
};

describe("the names of an edit's files", () => {
  const when = new Date(2026, 10, 14, 9, 5, 3);

  it("stamps a video, a GIF and a frame as what they are", () => {
    expect(editedMediaName("beach.MOV", "mp4", when)).toBe("beach_edit_20261114_090503.mp4");
    expect(editedMediaName("beach.mp4", "gif", when)).toBe("beach_gif_20261114_090503.gif");
    expect(editedMediaName("beach.mp4", "jpg", when)).toBe("beach_frame_20261114_090503.jpg");
    expect(editedMediaName("noext", "mp4", when)).toBe("noext_edit_20261114_090503.mp4");
    expect(editedMediaName("", "mp4", when)).toBe("video_edit_20261114_090503.mp4");
  });

  it("refuses an extension the editor does not write", () => {
    expect(() => editedMediaName("a.mp4", "exe", when)).toThrow();
  });

  it("names the container ffmpeg reads from the media type, then the name", () => {
    expect(sourceExtension("video/quicktime", "x.bin")).toBe("mov");
    expect(sourceExtension("video/mp4; codecs=avc1", "x")).toBe("mp4");
    expect(sourceExtension("application/octet-stream", "clip.MKV")).toBe("mkv");
    expect(sourceExtension("", "clip.exe")).toBe("mp4");
  });
});

describe("which files the editor may take and give", () => {
  it("uses the staging folder the host names, and only one named for it", () => {
    expect(stagingRoot()).toBe(root);
    process.env.PFP_VEDIT_DIR = join(base, "elsewhere");
    expect(stagingRoot()).toBe(join(tmpdir(), STAGING_DIR));
    process.env.PFP_VEDIT_DIR = root;
  });

  it("accepts only an output the host wrote in its staging folder", () => {
    const dir = join(root, "3f2a-90bc");
    for (const name of ["out.mp4", "out.gif", "out.jpg", "thumb.jpg", "out.exe"]) file(join(dir, name));
    expect(isEditOutput(join(dir, "out.mp4"))).toBe(true);
    expect(isEditOutput(join(dir, "out.gif"))).toBe(true);
    expect(isEditOutput(join(dir, "out.jpg"))).toBe(true);
    expect(isEditOutput(join(dir, "thumb.jpg"))).toBe(false);
    expect(isEditOutput(join(dir, "out.exe"))).toBe(false);
    expect(isEditOutput(join(dir, "missing", "out.mp4"))).toBe(false);
    expect(isEditOutput(file(join(root, "out.mp4")))).toBe(false);
    expect(isEditOutput(file(join(base, "elsewhere", "3f2a", "out.mp4")))).toBe(false);
    expect(isEditOutput(join(root, "..", "elsewhere", "3f2a", "out.mp4"))).toBe(false);
    expect(isEditOutput("out.mp4")).toBe(false);
  });

  it("resolves a link before judging it, so one pointing out of the folder is refused", () => {
    const secret = file(join(base, "secret.mp4"), "private");
    const job = join(root, "linked");
    mkdirSync(job, { recursive: true });
    try {
      symlinkSync(secret, join(job, "out.mp4"));
    } catch {
      return; // links need a privilege this machine does not grant
    }
    expect(isEditOutput(join(job, "out.mp4"))).toBe(false);
  });

  it("takes a thumbnail only from beside the output", () => {
    const dir = join(root, "job1");
    const out = file(join(dir, "out.mp4"));
    file(join(dir, "thumb.jpg"));
    file(join(dir, "other.jpg"));
    expect(isEditThumb(join(dir, "thumb.jpg"), out)).toBe(true);
    expect(isEditThumb(join(dir, "other.jpg"), out)).toBe(false);
    expect(isEditThumb(file(join(root, "thumb.jpg")), out)).toBe(false);
  });

  it("takes a GIF or a frame as its own thumbnail, and nothing else of that folder", () => {
    const dir = join(root, "job2");
    const out = file(join(dir, "out.gif"));
    file(join(dir, "out.jpg"));
    file(join(dir, "thumb.gif"));
    file(join(dir, "other.gif"));
    file(join(dir, "out.mp4"));
    expect(isEditThumb(out, out)).toBe(true);
    expect(isEditThumb(join(dir, "out.jpg"), out)).toBe(true);
    expect(isEditThumb(join(dir, "thumb.gif"), out)).toBe(false);
    expect(isEditThumb(join(dir, "other.gif"), out)).toBe(false);
    expect(isEditThumb(join(dir, "out.mp4"), out)).toBe(false);
    expect(isEditThumb(file(join(root, "job3", "out.gif")), out)).toBe(false);
    expect(isEditThumb("out.gif", out)).toBe(false);
  });

  it("recognises a finished download of the editor by its shape and folder", () => {
    const at = file(join(editDownloadDir(), DOWNLOAD));
    made.push(at);
    expect(isHydratedDownload(at)).toBe(true);
    expect(isHydratedDownload(file(join(editDownloadDir(), "pfp-hyd-x.bin")))).toBe(false);
    expect(isHydratedDownload(file(join(base, DOWNLOAD)))).toBe(false);
    expect(isHydratedDownload(DOWNLOAD)).toBe(false);
  });
});

describe("staging a download", () => {
  it("moves it under a name that carries its container", () => {
    const from = file(join(editDownloadDir(), DOWNLOAD), "video");
    const { path } = stageSource(from, "mov");
    made.push(join(path, ".."));
    expect(path.startsWith(root)).toBe(true);
    expect(path.endsWith("source.mov")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(from)).toBe(false);
  });

  it("refuses a file that is not one of the editor's downloads", () => {
    const stray = file(join(base, "pfp-stray-test.bin"));
    made.push(stray);
    expect(() => stageSource(stray, "mp4")).toThrow();
    expect(existsSync(stray)).toBe(true);
  });

  it("falls back to mp4 for an odd extension", () => {
    const from = file(join(editDownloadDir(), "pfp-hyd-1b9cf1d2-5a1e-4f6b-8c3a-1d2e3f4a5b6c.bin"), "video");
    const { path } = stageSource(from, "../../x");
    made.push(join(path, ".."));
    expect(path.endsWith("source.mp4")).toBe(true);
  });
});

describe("the editor's own downloads", () => {
  const io = () => {
    const calls: string[] = [];
    const state = new Map<string, { done: boolean; error: string | null }>();
    return {
      calls,
      state,
      downloads: new EditorDownloads({
        progress: (path) => state.get(path) ?? { done: false, error: "unknown download" },
        cancel: (path) => void calls.push(`cancel:${path}`),
      }),
    };
  };

  it("refuses to report on, stop or stage a path it did not start", () => {
    const { downloads, calls } = io();
    const other = join(tmpdir(), DOWNLOAD);
    expect(() => downloads.progress(other)).toThrow("not a download of the editor");
    expect(() => downloads.cancel(other)).toThrow("not a download of the editor");
    expect(() => downloads.stage(other, "mp4")).toThrow("not a download of the editor");
    expect(calls).toEqual([]);
  });

  it("follows, stages and stops what it started", () => {
    const { downloads, state, calls } = io();
    const a = file(join(editDownloadDir(), DOWNLOAD), "video");
    downloads.add(a);
    state.set(a, { done: false, error: null });
    expect(downloads.progress(a)).toEqual({ done: false, error: null });
    expect(() => downloads.stage(a, "mp4")).toThrow("not finished");
    state.set(a, { done: true, error: null });
    const { path } = downloads.stage(a, "mp4");
    made.push(join(path, ".."));
    expect(() => downloads.progress(a)).toThrow();

    const b = file(join(editDownloadDir(), "pfp-hyd-2b9cf1d2-5a1e-4f6b-8c3a-1d2e3f4a5b6c.bin"), "part");
    downloads.add(b);
    expect(downloads.cancel(b)).toEqual({ cancelled: true });
    expect(calls).toEqual([`cancel:${b}`]);
    expect(existsSync(b)).toBe(false);
    expect(() => downloads.cancel(b)).toThrow();
  });
});

describe("uploading an edit", () => {
  it("refuses a file the host did not make", async () => {
    await expect(
      saveEditedMedia({}, {
        path: file(join(base, "photo.jpg")),
        thumb: null,
        name: "a.mp4",
        captureTime: null,
        camera: null,
        latitude: null,
        longitude: null,
        width: null,
        height: null,
        durationMs: null,
      }),
    ).rejects.toThrow("not a file of the editor");
  });

  it("sends the capture time, size and type of the output to the uploader", async () => {
    const dir = join(root, "job-upload-test");
    mkdirSync(dir, { recursive: true });
    made.push(dir);
    const out = join(dir, "out.mp4");
    writeFileSync(out, Buffer.alloc(2048, 7));

    let given: { name: string; meta: any } | null = null;
    const photos = {
      getFileUploader: async (name: string, meta: any) => {
        given = { name, meta };
        return {
          uploadFromStream: async (stream: any) => {
            for await (const _ of stream) void _;
            return { completion: async () => ({ nodeUid: "node-1" }) };
          },
        };
      },
    };
    const result = await saveEditedMedia(photos, {
      path: out,
      thumb: null,
      name: "holiday.mov",
      captureTime: Date.UTC(2022, 4, 6, 7, 8, 9),
      camera: "Pixel 8",
      latitude: 47.5,
      longitude: 19.04,
      width: 1280,
      height: 720,
      durationMs: 5500,
    });

    expect(result).toEqual({ uid: "node-1", size: 2048 });
    expect(given!.name).toMatch(/^holiday_edit_\d{8}_\d{6}\.mp4$/);
    expect(given!.meta.mediaType).toBe("video/mp4");
    expect(given!.meta.expectedSize).toBe(2048);
    expect(given!.meta.expectedSha1).toMatch(/^[0-9a-f]{40}$/);
    expect(given!.meta.captureTime.getTime()).toBe(Date.UTC(2022, 4, 6, 7, 8, 9));
    expect(given!.meta.tags.length).toBeGreaterThan(0);
    expect(given!.meta.additionalMetadata).toMatchObject({
      Media: { Width: 1280, Height: 720, Duration: 5.5 },
      Location: { Latitude: 47.5, Longitude: 19.04 },
      Camera: { Device: "Pixel 8" },
    });
  });

  it("makes the thumbnails of an animated GIF from its first frame", async () => {
    const dir = join(root, "job-gif-test");
    mkdirSync(dir, { recursive: true });
    made.push(dir);
    const frame = (r: number, g: number, b: number) =>
      sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g, b } } }).png().toBuffer();
    const frames = await Promise.all([frame(255, 0, 0), frame(0, 0, 255), frame(0, 255, 0)]);
    const out = join(dir, "out.gif");
    await sharp(frames, { join: { animated: true } }).gif({ loop: 0, delay: 100 }).toFile(out);
    expect((await sharp(out, { pages: -1 }).metadata()).pages).toBe(3);

    let thumbs: any[] = [];
    let mediaType = "";
    const photos = {
      getFileUploader: async (_name: string, meta: any) => {
        mediaType = meta.mediaType;
        return {
          uploadFromStream: async (stream: any, thumbnails: any[]) => {
            thumbs = thumbnails;
            for await (const _ of stream) void _;
            return { completion: async () => ({ nodeUid: "node-gif" }) };
          },
        };
      },
    };
    const result = await saveEditedMedia(photos, {
      path: out,
      thumb: out,
      name: "clip.mp4",
      captureTime: null,
      camera: null,
      latitude: null,
      longitude: null,
      width: 64,
      height: 48,
      durationMs: 300,
    });

    expect(result.uid).toBe("node-gif");
    expect(mediaType).toBe("image/gif");
    expect(thumbs).toHaveLength(2);
    for (const t of thumbs) {
      const img = sharp(Buffer.from(t.thumbnail));
      const meta = await img.metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.pages ?? 1).toBe(1);
      const { data } = await img.raw().toBuffer({ resolveWithObject: true });
      expect(data[0]).toBeGreaterThan(200);
      expect(data[2]).toBeLessThan(60);
    }
  });

  it("uploads a GIF as an image and a frame as a JPEG", async () => {
    const dir = join(root, "job-upload-types");
    mkdirSync(dir, { recursive: true });
    made.push(dir);
    const seen: string[] = [];
    const photos = {
      getFileUploader: async (_name: string, meta: any) => {
        seen.push(meta.mediaType);
        return {
          uploadFromStream: async (stream: any) => {
            for await (const _ of stream) void _;
            return { completion: async () => ({ nodeUid: "n" }) };
          },
        };
      },
    };
    for (const file of ["out.gif", "out.jpg"]) {
      writeFileSync(join(dir, file), Buffer.alloc(64, 1));
      await saveEditedMedia(photos, {
        path: join(dir, file),
        thumb: null,
        name: "clip.mp4",
        captureTime: null,
        camera: null,
        latitude: null,
        longitude: null,
        width: null,
        height: null,
        durationMs: null,
      });
    }
    expect(seen).toEqual(["image/gif", "image/jpeg"]);
  });
});
