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

// How people's names are told apart, the same rule as the phone's `personNameKey`.

import { randomBytes } from "node:crypto";

/**
 * Name compare for "is this the same name": spaces around it, how its letters are composed and their case
 * aside, accents kept, as on the phone. "adam" and "Adam" are one person, "Ádám" and "Adam" two.
 */
export function foldPersonName(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

const HIDDEN_TOKEN = /^hidden[0-9a-f]{32}$/;
const HIDDEN_TOKEN_PREFIX = "hidden";

/**
 * Whether `name` is the reserved label of an unnamed group that was hidden: it travels as an ordinary
 * name so the group stays together on every device, and is never shown as one.
 */
export function isHiddenToken(name: string): boolean {
  return HIDDEN_TOKEN.test(name);
}

/** Whether a typed name collides with the reserved labels, which no one can give. */
export function isReservedName(name: string): boolean {
  return name.startsWith(HIDDEN_TOKEN_PREFIX);
}

/** A fresh reserved label for an unnamed group about to be hidden. */
export function newHiddenToken(): string {
  return HIDDEN_TOKEN_PREFIX + randomBytes(16).toString("hex");
}

/** The name to show for `name`: null for no name and for a reserved label. */
export function shownName(name: string | null): string | null {
  return name && !isHiddenToken(name) ? name : null;
}

/** The key a piece of curation is kept under: its kind, the name as folded, and what it points at. */
export function curationKey(kind: number, name: string, ref: string): string {
  return `${kind}\u0000${foldPersonName(name)}\u0000${ref}`;
}

/** How older builds folded names, accents dropped too; only to bring the keys they stored up to date. */
export function legacyFoldPersonName(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
}
