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

// This version's "what's new" cards as locale keys, so each platform's list is testable without a window.

export type WhatsNewPlatform = "windows" | "mac" | "linux";

export type WhatsNewIcon =
  | "video"
  | "collage"
  | "slideshow"
  | "details"
  | "label"
  | "sort"
  | "place"
  | "compress"
  | "hide"
  | "themes"
  | "backup"
  | "import"
  | "folder"
  | "computer"
  | "signOut"
  | "trash"
  | "speed"
  | "check";

export type WhatsNewCard = { icon: WhatsNewIcon; title: string; body: string };
export type WhatsNewSection = { heading: string; cards: WhatsNewCard[] };

const card = (icon: WhatsNewIcon, key: string, bodyVariant = ""): WhatsNewCard => ({
  icon,
  title: `whatsNew.${key}Title`,
  body: `whatsNew.${key}Body${bodyVariant}`,
});

/** The New and Fixed and improved cards for `platform`, in the order they show. */
export function whatsNewSections(platform: WhatsNewPlatform): WhatsNewSection[] {
  const windows = platform === "windows";
  const mac = platform === "mac";
  const added: WhatsNewCard[] = [
    card("video", "videoEditor"),
    card("collage", "collage", mac ? "Mac" : ""),
    card("slideshow", "slideshow"),
    card("details", "details"),
    card("label", "labelSearch"),
    card("sort", "albumOrder"),
    card("place", "placeInfo"),
    card("compress", "compress"),
    card("hide", "hidePerson"),
    card("themes", "themes"),
    card("backup", "backup"),
    card("import", "import"),
    // Moving the folder and File Explorer's keep and free up are Windows only.
    ...(windows ? [card("folder", "folder")] : []),
    ...(mac ? [] : [card("computer", "macos")]),
  ];
  const improved: WhatsNewCard[] = [
    card("signOut", "signOut"),
    card("trash", "trash"),
    card("video", "videos", windows ? "" : mac ? "Mac" : "Linux"),
    ...(windows ? [card("folder", "explorer")] : mac ? [] : [card("folder", "fileManager")]),
    card("speed", "speed"),
    card("check", "smallFixes"),
  ];
  return [
    { heading: "whatsNew.newHeading", cards: added },
    { heading: "whatsNew.improvedHeading", cards: improved },
  ];
}
