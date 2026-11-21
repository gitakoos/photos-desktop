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

import { join } from "node:path";

import { ACCOUNT_FILE, readSealedOrSetAside, storeDir, writeSealedAtomic } from "./store.ts";

export type AccountMatch = "same" | "different" | "unknown";

/**
 * Whether the account that just signed in is the one whose session lapsed. Keys that share
 * nothing are another account. With nothing to compare against it is not known, and an
 * unknown never counts as another account: that answer deletes what the vault holds.
 */
export function accountMatch(previousKeyIds: readonly string[], currentKeyIds: readonly string[]): AccountMatch {
  if (previousKeyIds.length === 0 || currentKeyIds.length === 0) return "unknown";
  const previous = new Set(previousKeyIds);
  return currentKeyIds.some((id) => previous.has(id)) ? "same" : "different";
}

/**
 * The user key ids of the account the store belongs to, as last recorded; empty when none were.
 * Throws while the store is locked.
 */
export function recordedAccountKeys(): string[] {
  const raw = readSealedOrSetAside(join(storeDir(), ACCOUNT_FILE));
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw.toString("utf8"))?.keyIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

/** Records the account's user key ids beside the session, so they outlive a lost session file. */
export function recordAccountKeys(keyIds: readonly string[]): void {
  if (keyIds.length === 0) return;
  writeSealedAtomic(join(storeDir(), ACCOUNT_FILE), Buffer.from(JSON.stringify({ keyIds: [...keyIds].sort() }), "utf8"));
}
