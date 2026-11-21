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
import { SYNC_IDS, applyValues, changedValues, chosenValues, type SyncedSettings } from "./settingsSyncMap";

const defaults: SyncedSettings = {
  theme: "dark",
  palette: "default",
  amoled: false,
  hideAlbumPhotos: false,
  lang: "en",
  compressPhotos: false,
  compressHdr: false,
  compressTier: "balanced",
  compressVideos: false,
  compressVideoTier: "balanced",
  compressCodec: "avc",
  albumSort: "activity",
  albumOrder: [],
};
const ctx = { defaults, langs: ["en", "hu", "de"] };

describe("which settings are reported", () => {
  it("names exactly the ids the sidecar syncs", () => {
    expect([...SYNC_IDS].sort()).toEqual(
      [
        "albums.hidePhotosInAlbums",
        "albums.order",
        "albums.sortMode",
        "appearance.amoled",
        "appearance.language",
        "appearance.palette",
        "appearance.theme",
        "upload.compressCodec",
        "upload.compressHdr",
        "upload.compressPhotos",
        "upload.compressTier",
        "upload.compressVideoTier",
        "upload.compressVideos",
      ].sort(),
    );
  });

  it("reports only what changed, by sync id", () => {
    const after = { ...defaults, theme: "light" as const, compressTier: "small" as const };
    expect(changedValues(defaults, after, ctx)).toEqual([
      { id: "appearance.theme", x: "light" },
      { id: "upload.compressTier", x: "small" },
    ]);
    expect(changedValues(defaults, defaults, ctx)).toEqual([]);
  });

  it("reports a setting put back to its default, as a choice", () => {
    expect(changedValues({ ...defaults, amoled: true }, defaults, ctx)).toEqual([{ id: "appearance.amoled", x: false }]);
  });

  it("never reports the legacy amoled palette, nor a language the app lacks", () => {
    expect(changedValues({ ...defaults, palette: "amoled" }, defaults, ctx)).toEqual([]);
    expect(changedValues(defaults, { ...defaults, palette: "amoled" }, ctx)).toEqual([]);
    expect(changedValues(defaults, { ...defaults, lang: "system" as never }, ctx)).toEqual([]);
    expect(changedValues(defaults, { ...defaults, lang: "tr" as never }, ctx)).toEqual([]);
  });

  it("leaves settings outside the list out, whatever changed", () => {
    const after = { ...defaults, zoom: 3, lockOnHide: true } as SyncedSettings;
    expect(changedValues(defaults, after, ctx)).toEqual([]);
  });

  it("stamps what is already chosen: the values off their defaults", () => {
    expect(chosenValues(defaults, ctx)).toEqual([]);
    expect(chosenValues({ ...defaults, palette: "sea", compressVideos: true, lang: "hu" }, ctx)).toEqual([
      { id: "appearance.palette", x: "sea" },
      { id: "appearance.language", x: "hu" },
      { id: "upload.compressVideos", x: true },
    ]);
    expect(chosenValues({ ...defaults, palette: "amoled", amoled: true }, ctx)).toEqual([{ id: "appearance.amoled", x: true }]);
  });
});

describe("which settings are taken in", () => {
  it("sets the values it knows and lists what ended up different", () => {
    const { next, changed } = applyValues(
      defaults,
      [
        { id: "appearance.theme", x: "light", t: 1 },
        { id: "appearance.palette", x: "default", t: 1 },
        { id: "upload.compressCodec", x: "hevc", t: 1 },
      ],
      ctx,
    );
    expect(next).toEqual({ ...defaults, theme: "light", compressCodec: "hevc" });
    expect(changed).toEqual(["theme", "compressCodec"]);
  });

  it("puts a setting back to its default on a null", () => {
    const { next, changed } = applyValues({ ...defaults, theme: "light", lang: "hu" }, [
      { id: "appearance.theme", x: null, t: 1 },
      { id: "appearance.language", x: null, t: 1 },
    ], ctx);
    expect(next.theme).toBe("dark");
    expect(next.lang).toBe("en");
    expect(changed).toEqual(["theme", "lang"]);
  });

  it("ignores an unknown id, a value of the wrong kind, the legacy palette and a tag it does not have", () => {
    const { next, changed } = applyValues(
      defaults,
      [
        { id: "android.clockFormat", x: "24h", t: 1 },
        { id: "appearance.theme", x: "purple", t: 1 },
        { id: "appearance.amoled", x: "yes", t: 1 },
        { id: "appearance.palette", x: "amoled", t: 1 },
        { id: "appearance.language", x: "tr", t: 1 },
        { id: "appearance.language", x: "system", t: 1 },
        { id: "upload.compressTier", x: 2, t: 1 },
      ],
      ctx,
    );
    expect(next).toEqual(defaults);
    expect(changed).toEqual([]);
  });

  it("reports and takes the album list's sort and arrangement as album link ids", () => {
    const after = { ...defaults, albumSort: "custom" as const, albumOrder: ["vol~b", "a"] };
    expect(changedValues(defaults, after, ctx)).toEqual([
      { id: "albums.sortMode", x: "custom" },
      { id: "albums.order", x: ["b", "a"] },
    ]);
    expect(changedValues(after, { ...after, albumOrder: ["vol~b", "a"] }, ctx)).toEqual([]);
    const { next, changed } = applyValues(defaults, [{ id: "albums.order", x: ["b", "a"], t: 1 }], ctx);
    expect(next.albumOrder).toEqual(["b", "a"]);
    expect(changed).toEqual(["albumOrder"]);
    expect(applyValues(next, [{ id: "albums.order", x: ["b", "a"], t: 2 }], ctx).changed).toEqual([]);
    const bad = applyValues(defaults, [
      { id: "albums.order", x: ["a|b"], t: 1 },
      { id: "albums.sortMode", x: "size", t: 1 },
    ], ctx);
    expect(bad.changed).toEqual([]);
  });

  it("takes a language tag the app has", () => {
    expect(applyValues(defaults, [{ id: "appearance.language", x: "de", t: 1 }], ctx).next.lang).toBe("de");
  });
});
