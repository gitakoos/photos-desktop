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
 * A refresh of the library refreshes what the shared backup carries as well (settings, faces,
 * labels, hidden, album order): a change waiting for its save goes out now, then the other
 * devices' copies on Drive are looked at, and taken in only when one is newer. The call is started
 * and left to run, so the photos' own refresh never waits for it. Nothing is asked with the backup
 * off or with no connection. Returns whether it was asked.
 */
export function refreshSharedBackup(on: boolean, online: boolean, call: (method: string) => Promise<unknown>): boolean {
  if (!on || !online) return false;
  void call("sharedBackupRefresh").catch(() => {});
  return true;
}
