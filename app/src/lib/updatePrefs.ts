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

const KEY = "pfp.autoUpdate";

/**
 * Whether this copy is a release build. `build-setup.ps1` sets the flag; a copy built
 * from the source by anyone else has it unset, so it does not replace itself with the
 * published release unless its owner turns that on.
 */
export const OFFICIAL_BUILD = import.meta.env.VITE_PFP_OFFICIAL === "1";

/**
 * Whether the app updates itself when it opens. A choice made in Settings stands; with
 * none made, a release build updates and a self-built copy does not. With it off, an
 * update still comes from Settings' "Check for updates".
 */
export function autoUpdateOn(official: boolean = OFFICIAL_BUILD): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    // No storage: the build's own default.
  }
  return official;
}

export function setAutoUpdate(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Not kept; the switch still applies for this run.
  }
}
