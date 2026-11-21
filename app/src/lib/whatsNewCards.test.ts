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
import { cs } from "./locales/cs";
import { de } from "./locales/de";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { hu } from "./locales/hu";
import { it as itLocale } from "./locales/it";
import { nl } from "./locales/nl";
import { pl } from "./locales/pl";
import { sk } from "./locales/sk";
import { sl } from "./locales/sl";
import { whatsNewSections, type WhatsNewSection } from "./whatsNewCards";

const bodies = (sections: WhatsNewSection[]) => sections.map((s) => [s.heading, s.cards.map((c) => c.body)]);

describe("the what's new cards", () => {
  it("show the folder move and File Explorer cards on Windows", () => {
    expect(bodies(whatsNewSections("windows"))).toEqual([
      [
        "whatsNew.newHeading",
        [
          "whatsNew.videoEditorBody", "whatsNew.collageBody", "whatsNew.slideshowBody", "whatsNew.detailsBody",
          "whatsNew.labelSearchBody", "whatsNew.albumOrderBody", "whatsNew.placeInfoBody", "whatsNew.compressBody",
          "whatsNew.hidePersonBody", "whatsNew.themesBody", "whatsNew.backupBody", "whatsNew.importBody",
          "whatsNew.folderBody", "whatsNew.macosBody",
        ],
      ],
      [
        "whatsNew.improvedHeading",
        [
          "whatsNew.signOutBody", "whatsNew.trashBody", "whatsNew.videosBody", "whatsNew.explorerBody",
          "whatsNew.speedBody", "whatsNew.smallFixesBody",
        ],
      ],
    ]);
  });

  it("show the file manager and Linux video cards on Linux, without the folder move", () => {
    expect(bodies(whatsNewSections("linux"))).toEqual([
      [
        "whatsNew.newHeading",
        [
          "whatsNew.videoEditorBody", "whatsNew.collageBody", "whatsNew.slideshowBody", "whatsNew.detailsBody",
          "whatsNew.labelSearchBody", "whatsNew.albumOrderBody", "whatsNew.placeInfoBody", "whatsNew.compressBody",
          "whatsNew.hidePersonBody", "whatsNew.themesBody", "whatsNew.backupBody", "whatsNew.importBody",
          "whatsNew.macosBody",
        ],
      ],
      [
        "whatsNew.improvedHeading",
        [
          "whatsNew.signOutBody", "whatsNew.trashBody", "whatsNew.videosBodyLinux", "whatsNew.fileManagerBody",
          "whatsNew.speedBody", "whatsNew.smallFixesBody",
        ],
      ],
    ]);
  });

  it("word the collage and videos for a Mac, with no folder, file manager or macOS card", () => {
    expect(bodies(whatsNewSections("mac"))).toEqual([
      [
        "whatsNew.newHeading",
        [
          "whatsNew.videoEditorBody", "whatsNew.collageBodyMac", "whatsNew.slideshowBody", "whatsNew.detailsBody",
          "whatsNew.labelSearchBody", "whatsNew.albumOrderBody", "whatsNew.placeInfoBody", "whatsNew.compressBody",
          "whatsNew.hidePersonBody", "whatsNew.themesBody", "whatsNew.backupBody", "whatsNew.importBody",
        ],
      ],
      [
        "whatsNew.improvedHeading",
        ["whatsNew.signOutBody", "whatsNew.trashBody", "whatsNew.videosBodyMac", "whatsNew.speedBody", "whatsNew.smallFixesBody"],
      ],
    ]);
  });

  // The window asks for these keys through a template, which the key scan of the sources cannot see.
  it("have a title and a text on every platform in every locale", () => {
    const dicts = { en, cs, de, es, fr, hu, it: itLocale, nl, pl, sk, sl } as Record<string, Record<string, string>>;
    const keys = (["windows", "linux", "mac"] as const).flatMap((p) =>
      whatsNewSections(p).flatMap((s) => [s.heading, ...s.cards.flatMap((c) => [c.title, c.body])]),
    );
    const missing = Object.entries(dicts).flatMap(([lang, dict]) => keys.filter((k) => !dict[k]).map((k) => `${lang} ${k}`));
    expect(Object.keys(dicts)).toHaveLength(11);
    expect(missing).toEqual([]);
  });
});
