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

import { describe, it, expect } from "vitest";
import {
  SidecarIndex,
  albumFolderOf,
  candidateMediaKeys,
  parseSidecar,
  sidecarKey,
} from "./takeout.ts";

/** The contract the import relies on: a photo finds its sidecar's key among its own. */
const resolves = (media: string, sidecar: string) => candidateMediaKeys(media).includes(sidecarKey(sidecar));

describe("what a sidecar says", () => {
  it("reads the capture date, place, caption, title and favourite", () => {
    const meta = parseSidecar(`{
      "title": "IMG_1234.jpg",
      "description": "Sunset at the lake",
      "creationTime": { "timestamp": "1699999999", "formatted": "upload" },
      "photoTakenTime": { "timestamp": "1673789696", "formatted": "taken" },
      "geoData": { "latitude": 47.4979, "longitude": 19.0402, "altitude": 102.0 },
      "favorited": true
    }`)!;
    // photoTakenTime, not the upload's creationTime.
    expect(meta.takenMs).toBe(1673789696000);
    expect(meta.latitude).toBeCloseTo(47.4979, 9);
    expect(meta.longitude).toBeCloseTo(19.0402, 9);
    expect(meta.description).toBe("Sunset at the lake");
    expect(meta.title).toBe("IMG_1234.jpg");
    expect(meta.favorited).toBe(true);
  });

  it("reads what Ente writes, which has no favourite", () => {
    const meta = parseSidecar(`{
      "title": "beach.jpg",
      "photoTakenTime": { "timestamp": "1595500000", "formatted": "23 Jul 2020" },
      "creationTime": { "timestamp": "1595500000", "formatted": "23 Jul 2020" },
      "modificationTime": { "timestamp": "1600000000", "formatted": "13 Sep 2020" },
      "geoData": { "latitude": 41.38, "longitude": 2.17 }
    }`)!;
    expect(meta.takenMs).toBe(1595500000000);
    expect(meta.latitude).toBeCloseTo(41.38, 9);
    expect(meta.favorited).toBe(false);
  });

  it("falls back to geoDataExif when geoData is the zero for none", () => {
    const meta = parseSidecar(`{
      "photoTakenTime": { "timestamp": "1673789696" },
      "geoData": { "latitude": 0.0, "longitude": 0.0 },
      "geoDataExif": { "latitude": 10.5, "longitude": 20.25 }
    }`)!;
    expect(meta.latitude).toBe(10.5);
    expect(meta.longitude).toBe(20.25);
  });

  it("has no place, date or favourite when it says none", () => {
    const meta = parseSidecar(`{ "geoData": { "latitude": 0.0, "longitude": 0.0 } }`)!;
    expect(meta.latitude).toBeUndefined();
    expect(meta.longitude).toBeUndefined();
    expect(meta.takenMs).toBeUndefined();
    expect(meta.favorited).toBe(false);
  });

  it("refuses a place off the globe or not a number", () => {
    expect(parseSidecar(`{ "geoData": { "latitude": 1e999, "longitude": 19.0 } }`)!.latitude).toBeUndefined();
    expect(parseSidecar(`{ "geoData": { "latitude": 91.0, "longitude": 19.0 } }`)!.latitude).toBeUndefined();
    expect(parseSidecar(`{ "geoData": { "latitude": 47.5, "longitude": -500.0 } }`)!.longitude).toBeUndefined();
  });

  it("keeps a real place far from zero", () => {
    const meta = parseSidecar(`{ "geoData": { "latitude": -33.8688, "longitude": 151.2093 } }`)!;
    expect(meta.latitude).toBe(-33.8688);
    expect(meta.longitude).toBe(151.2093);
  });

  it("has no date without photoTakenTime", () => {
    const meta = parseSidecar(`{ "title": "IMG_1.jpg", "creationTime": { "timestamp": "1673789696" } }`)!;
    expect(meta.takenMs).toBeUndefined();
    expect(meta.title).toBe("IMG_1.jpg");
  });

  it("refuses a date that cannot be a capture date", () => {
    // 315532800 seconds is 1980-01-01, before digital photos.
    expect(parseSidecar(`{ "photoTakenTime": { "timestamp": "315532800" } }`)!.takenMs).toBeUndefined();
    expect(parseSidecar(`{ "photoTakenTime": { "timestamp": "0" } }`)!.takenMs).toBeUndefined();
    expect(parseSidecar(`{ "photoTakenTime": { "timestamp": "not-a-number" } }`)!.takenMs).toBeUndefined();
    expect(parseSidecar(`{ "photoTakenTime": { "timestamp": "9999999999999" } }`)!.takenMs).toBeUndefined();
    expect(
      parseSidecar(`{ "photoTakenTime": { "timestamp": "99999999999999999999" } }`)!.takenMs,
    ).toBeUndefined();
  });

  it("drops a blank caption", () => {
    const meta = parseSidecar(`{ "title": "IMG_9.jpg", "description": "   " }`)!;
    expect(meta.description).toBeUndefined();
    expect(meta.title).toBe("IMG_9.jpg");
  });

  it("returns null for anything that is not a sidecar, without throwing", () => {
    expect(parseSidecar("{ this is : not json ")).toBeNull();
    expect(parseSidecar("not json at all")).toBeNull();
    expect(parseSidecar("")).toBeNull();
    expect(parseSidecar("   ")).toBeNull();
    expect(parseSidecar("[]")).toBeNull();
  });
});

describe("which sidecar is a photo's", () => {
  it("the old form beside the photo", () => {
    expect(resolves("IMG_1234.jpg", "IMG_1234.jpg.json")).toBe(true);
  });

  it("the supplemental-metadata form", () => {
    expect(resolves("IMG_20230115_123456.jpg", "IMG_20230115_123456.jpg.supplemental-metadata.json")).toBe(true);
  });

  it("a clipped supplemental tag", () => {
    const media = "PXL_20230815_142536789.jpg";
    expect(resolves(media, "PXL_20230815_142536789.jpg.supplemental-metad.json")).toBe(true);
    expect(resolves(media, "PXL_20230815_142536789.jpg.suppl.json")).toBe(true);
    expect(resolves(media, "PXL_20230815_142536789.jpg.s.json")).toBe(true);
  });

  it("a sidecar with the extension left off", () => {
    expect(resolves("IMG-20230115-WA0001.jpg", "IMG-20230115-WA0001.json")).toBe(true);
  });

  it("a duplicate counter before or after the extension", () => {
    expect(resolves("IMG_1234(1).jpg", "IMG_1234.jpg(1).json")).toBe(true);
    expect(resolves("IMG_1234(1).jpg", "IMG_1234(1).jpg.json")).toBe(true);
    expect(resolves("IMG_1234(1).jpg", "IMG_1234.jpg.supplemental-metadata(1).json")).toBe(true);
  });

  it("an edited copy shares the original's", () => {
    const sidecar = "IMG_1234.jpg.supplemental-metadata.json";
    expect(resolves("IMG_1234-edited.jpg", sidecar)).toBe(true);
    expect(resolves("IMG_1234-bearbeitet.jpg", sidecar)).toBe(true);
    expect(resolves("IMG_1234-modifié.jpg", sidecar)).toBe(true);
  });

  it("an unrelated sidecar is never matched", () => {
    expect(resolves("IMG_2000.jpg", "IMG_1000.jpg.json")).toBe(false);
    expect(resolves("VID_0001.mp4", "IMG_1234.jpg.supplemental-metadata.json")).toBe(false);
  });
});

describe("the album a photo was in", () => {
  it("is the Takeout folder it sits in", () => {
    expect(albumFolderOf("Takeout/Google Photos/Vacation/IMG_1.jpg")).toBe("Vacation");
  });

  it("is none for Google's year, archive and trash buckets", () => {
    expect(albumFolderOf("Takeout/Google Photos/Photos from 2019/PXL.jpg")).toBeNull();
    expect(albumFolderOf("Takeout/Google Photos/PHOTOS FROM 2019/x.jpg")).toBeNull();
    expect(albumFolderOf("Takeout/Google Photos/Archive/IMG_2.jpg")).toBeNull();
    expect(albumFolderOf("Takeout/Google Photos/Trash/IMG_3.jpg")).toBeNull();
    expect(albumFolderOf("Takeout/Google Photos/Bin/IMG_4.jpg")).toBeNull();
  });

  it("is the Ente folder it sits in, but none for Uncategorized", () => {
    expect(albumFolderOf("Trip 2020/beach.jpg")).toBe("Trip 2020");
    expect(albumFolderOf("Uncategorized/IMG_9.jpg")).toBeNull();
  });

  it("is none straight under the wrapper folders or at the top", () => {
    expect(albumFolderOf("Takeout/Google Photos/IMG_5.jpg")).toBeNull();
    expect(albumFolderOf("Takeout/Google Fotos/IMG_6.jpg")).toBeNull();
    expect(albumFolderOf("IMG_7.jpg")).toBeNull();
  });

  it("is trimmed of spaces", () => {
    expect(albumFolderOf("Takeout/Google Photos/ Vacation /IMG_8.jpg")).toBe("Vacation");
  });
});

describe("finding a photo's sidecar in an export", () => {
  const at = (ms: number) => ({ takenMs: ms, favorited: false });

  it("finds Ente's in the album's metadata folder", () => {
    const index = new SidecarIndex();
    index.add("Trip/metadata/beach.jpg.json", at(1));
    expect(index.find("Trip/beach.jpg")?.takenMs).toBe(1);
  });

  it("keeps two albums' photos of the same name apart", () => {
    const index = new SidecarIndex();
    index.add("Trip/metadata/IMG_0001.jpg.json", at(1));
    index.add("Party/metadata/IMG_0001.jpg.json", at(2));
    expect(index.find("Trip/IMG_0001.jpg")?.takenMs).toBe(1);
    expect(index.find("Party/IMG_0001.jpg")?.takenMs).toBe(2);
  });

  it("falls back to anywhere in the export, for a JSON in another folder", () => {
    const index = new SidecarIndex();
    index.add("Takeout/Google Photos/Photos from 2020/IMG_5.jpg.supplemental-metadata.json", at(5));
    expect(index.find("Takeout/Google Photos/Vacation/IMG_5.jpg")?.takenMs).toBe(5);
  });

  it("finds nothing for a photo with no sidecar", () => {
    const index = new SidecarIndex();
    index.add("Trip/metadata/beach.jpg.json", at(1));
    expect(index.find("Trip/hill.jpg")).toBeUndefined();
  });
});
