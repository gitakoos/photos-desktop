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

/**
 * A one-bit shared signal: is the full-screen viewer open? The single sidecar
 * serves one request at a time, so the background thumbnail loaders read this and
 * hold off starting a new batch while the viewer is up, letting a photo-open (and
 * its neighbours) own the channel instead of queuing behind grid work. The viewer
 * sets it on mount and clears it on close, so it covers every view that opens one.
 */
let open = false;

export function setLightboxOpen(value: boolean): void {
  open = value;
}

export function isLightboxOpen(): boolean {
  return open;
}
