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

// Covering the app before its window goes away, so a lock is on screen (or a blank sheet until
// the lock is due) when it comes back, never the photos for a moment first. The main window's
// page registers how; the window buttons ask it before they minimise.

type Cover = (why: "tray" | "minimize") => Promise<void>;

let cover: Cover | null = null;

/** Sets how the page covers itself; null when there is nothing to cover. */
export function setAppCover(next: Cover | null): void {
  cover = next;
}

/** Covers the app, where it has a lock to keep, before its window goes away. */
export async function coverApp(why: "tray" | "minimize"): Promise<void> {
  if (cover) await cover(why).catch(() => undefined);
}
