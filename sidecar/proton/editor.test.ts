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

import { describe, it, expect, vi } from "vitest";

import { addCopyToAlbum, cameraOf, downloadToBuffer, editedName, joinSourceAlbum, locationOf, savedEditName } from "./editor.ts";
import { isStall } from "./stallGuard.ts";

describe("editedName", () => {
  const when = new Date(2026, 8, 5, 14, 3, 9); // 2026-09-05 14:03:09 local

  it("names a copy that is not an edit by the stem it is given, without the edit tag", () => {
    expect(savedEditName({ name: "Collage", fileStem: "Collage" }, when)).toBe("Collage_20260905_140309.jpg");
    expect(savedEditName({ name: "beach.jpg" }, when)).toBe("beach_edit_20260905_140309.jpg");
    expect(savedEditName({ name: "beach.jpg", fileStem: "../a/b:c" }, when)).toBe("..abc_20260905_140309.jpg");
    expect(savedEditName({ name: "beach.jpg", fileStem: "  " }, when)).toBe("beach_edit_20260905_140309.jpg");
  });

  it("keeps the stem and stamps a local timestamp with a .jpg extension", () => {
    expect(editedName("beach.HEIC", when)).toBe("beach_edit_20260905_140309.jpg");
  });

  it("replaces the source extension whatever it was", () => {
    expect(editedName("clip.png", when)).toBe("clip_edit_20260905_140309.jpg");
  });

  it("handles a name with no extension", () => {
    expect(editedName("noext", when)).toBe("noext_edit_20260905_140309.jpg");
  });

  it("handles a name that is only an extension (a dotfile)", () => {
    // lastIndexOf('.') is 0, so the whole thing is the stem, not an extension.
    expect(editedName(".gitignore", when)).toBe(".gitignore_edit_20260905_140309.jpg");
  });

  it("falls back to a stem for an empty or blank name", () => {
    expect(editedName("", when)).toBe("photo_edit_20260905_140309.jpg");
    expect(editedName("   ", when)).toBe("photo_edit_20260905_140309.jpg");
  });

  it("zero-pads every field", () => {
    expect(editedName("x.jpg", new Date(2026, 0, 1, 0, 0, 0))).toBe("x_edit_20260101_000000.jpg");
  });
});

describe("locationOf", () => {
  it("reads a valid pair in either casing", () => {
    expect(locationOf({ Location: { Latitude: 47.5, Longitude: 19.05 } })).toEqual({
      latitude: 47.5,
      longitude: 19.05,
    });
    expect(locationOf({ location: { latitude: -33.9, longitude: 151.2 } })).toEqual({
      latitude: -33.9,
      longitude: 151.2,
    });
  });

  it("keeps a real zero coordinate", () => {
    expect(locationOf({ Location: { Latitude: 0, Longitude: 0 } })).toEqual({
      latitude: 0,
      longitude: 0,
    });
  });

  it("rejects a half pair, out-of-range values, and a missing block", () => {
    expect(locationOf({ Location: { Latitude: 47.5 } })).toEqual({ latitude: null, longitude: null });
    expect(locationOf({ Location: { Latitude: 200, Longitude: 19 } })).toEqual({
      latitude: null,
      longitude: null,
    });
    expect(locationOf(null)).toEqual({ latitude: null, longitude: null });
    expect(locationOf({})).toEqual({ latitude: null, longitude: null });
  });
});

describe("cameraOf", () => {
  it("reads and trims the device in either casing", () => {
    expect(cameraOf({ Camera: { Device: "  Apple iPhone 15  " } })).toBe("Apple iPhone 15");
    expect(cameraOf({ camera: { device: "Pixel 8" } })).toBe("Pixel 8");
  });

  it("is null when absent or blank", () => {
    expect(cameraOf(null)).toBeNull();
    expect(cameraOf({})).toBeNull();
    expect(cameraOf({ Camera: { Device: "   " } })).toBeNull();
  });
});

describe("addCopyToAlbum", () => {
  it("adds the saved copy, alone, to the album it was opened from", async () => {
    const add = vi.fn(async () => [{ uid: "vol~copy", ok: true }]);
    const added = await addCopyToAlbum(add, "vol~album", "vol~copy");
    expect(added).toBe(true);
    expect(add).toHaveBeenCalledWith("vol~album", ["vol~copy"]);
  });

  it("reports a copy the server refused to add", async () => {
    const add = async () => [{ uid: "vol~copy", ok: false, error: "album is full" }];
    expect(await addCopyToAlbum(add, "vol~album", "vol~copy")).toBe(false);
  });

  it("reports an add that came back with no answer for the copy", async () => {
    const add = async () => [];
    expect(await addCopyToAlbum(add, "vol~album", "vol~copy")).toBe(false);
  });

  it("reports a thrown add instead of failing the save", async () => {
    const add = async (): Promise<{ uid: string; ok: boolean }[]> => {
      throw new Error("Not signed in");
    };
    expect(await addCopyToAlbum(add, "vol~album", "vol~copy")).toBe(false);
  });
});

describe("joinSourceAlbum", () => {
  it("leaves a copy saved outside an album as it is, without asking to add it", async () => {
    const add = vi.fn(async () => [{ uid: "vol~copy", ok: true }]);
    const out = await joinSourceAlbum(add, { uid: "vol~copy", size: 10 }, null);
    expect(out).toEqual({ uid: "vol~copy", size: 10 });
    expect(add).not.toHaveBeenCalled();
  });

  it("returns the saved copy unmarked once it is in the album", async () => {
    const add = async () => [{ uid: "vol~copy", ok: true }];
    expect(await joinSourceAlbum(add, { uid: "vol~copy" }, "vol~album")).toEqual({ uid: "vol~copy" });
  });

  it("keeps the saved copy and marks it when the album add fails", async () => {
    const add = async () => [{ uid: "vol~copy", ok: false, error: "refused" }];
    expect(await joinSourceAlbum(add, { uid: "vol~copy", size: 10 }, "vol~album")).toEqual({
      uid: "vol~copy",
      size: 10,
      albumFailed: true,
    });
  });
});

describe("a download under a time limit", () => {
  /** A client whose one slot is held, so a downloader waits for it until its signal fires; `free` lets it through. */
  function heldSlot() {
    const state = { asked: 0, released: 0, free: () => {} };
    const client = {
      getFileDownloader(_uid: string, signal: AbortSignal) {
        state.asked++;
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
          state.free = () =>
            resolve({
              downloadToStream: () => ({
                completion: async () => {
                  state.released++;
                  if (signal.aborted) throw new Error("AbortError");
                },
              }),
            });
        });
      },
    };
    return { client, state };
  }

  it("gives up on the wait for a download slot", async () => {
    const { client } = heldSlot();
    const err = await downloadToBuffer(client, "vol~a", 20).catch((e) => e);
    expect(isStall(err)).toBe(true);
  });

  it("hands back a slot that comes after the wait was given up on", async () => {
    const { client, state } = heldSlot();
    client.getFileDownloader = (_uid: string, _signal: AbortSignal) => {
      state.asked++;
      return new Promise((resolve) => {
        state.free = () =>
          resolve({
            downloadToStream: () => ({
              completion: async () => {
                state.released++;
              },
            }),
          });
      });
    };
    await expect(downloadToBuffer(client, "vol~a", 20)).rejects.toSatisfy(isStall);
    state.free();
    await vi.waitFor(() => expect(state.released).toBe(1));
  });
});
