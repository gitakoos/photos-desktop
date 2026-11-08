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

// A sign-in again after the session lapsed lands in the vault the last account left open.
// Whether it is that same account is read from the user keys both sessions unlocked: a
// key keeps its ID through a password change, and no two accounts share one.

/**
 * Whether the account that just signed in is the one whose session lapsed. With nothing
 * to compare against it counts as another account: the cost of that mistake is a cache
 * built again, the cost of the other one is one account's data shown to another.
 */
export function sameAccount(previousKeyIds: readonly string[], currentKeyIds: readonly string[]): boolean {
  if (previousKeyIds.length === 0 || currentKeyIds.length === 0) return false;
  const previous = new Set(previousKeyIds);
  return currentKeyIds.some((id) => previous.has(id));
}
