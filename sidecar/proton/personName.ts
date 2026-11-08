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

/**
 * Name compare for "is this the same name": spaces around it, how its letters are composed and their case
 * aside, accents kept, as on the phone. "adam" and "Adam" are one person, "Ádám" and "Adam" two.
 */
export function foldPersonName(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

/** The key a piece of curation is kept under: its kind, the name as folded, and what it points at. */
export function curationKey(kind: number, name: string, ref: string): string {
  return `${kind}\u0000${foldPersonName(name)}\u0000${ref}`;
}

/** How older builds folded names, accents dropped too; only to bring the keys they stored up to date. */
export function legacyFoldPersonName(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
}
