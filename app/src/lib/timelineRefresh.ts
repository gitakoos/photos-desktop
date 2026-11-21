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

/** How old the last timeline read must be before a window coming back reads it again itself. */
export const TIMELINE_STALE_MS = 60_000;

/**
 * The window came back into focus or onto the screen. The photos feed in the sidecar is asked to
 * look now; a change it finds reaches the window as `timeline-changed`. Only when the feed says it
 * is not to be trusted (not running, or its last look failed or is overdue) does the window read
 * the timeline again itself, and then only when it is online and its last read is over a minute
 * old. A call that fails reads nothing. Answers whether to read again.
 */
export async function timelineReadOnReturn(
  readAt: number,
  online: boolean,
  call: (method: string) => Promise<{ healthy?: boolean } | null | undefined>,
  now: number = Date.now(),
): Promise<boolean> {
  let healthy: boolean;
  try {
    healthy = (await call("checkPhotoEvents"))?.healthy === true;
  } catch {
    return false;
  }
  if (healthy || !online || readAt <= 0) return false;
  return now - readAt > TIMELINE_STALE_MS;
}
