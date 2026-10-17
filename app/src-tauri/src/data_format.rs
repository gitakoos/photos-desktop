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

// What the app's data directory holds, in one number.
//
// An upgrade replaces the app but leaves `<install>\data` where it is, so the
// sign-in, the settings and the caches survive it. That is only safe while the new
// app can still read what the old one wrote, and this is where that is declared:
// the app owns the number because the app defines the formats — the sealed key, the
// session, the vault, and the thumbnail and metadata caches.
//
// The installer compiles this same file. It holds nothing but the constants and
// imports nothing so that it can: a copy kept by hand would eventually drift from
// the app's, and this number decides whether a user keeps their sign-in.

/// Bump ONLY when this build cannot read a data directory an earlier build wrote.
/// The installer answers a bump by clearing the directory, which costs the user
/// their sign-in and every cached thumbnail, so an addition that older data
/// survives is not a reason to touch it. There has been one format so far.
pub const DATA_FORMAT: u32 = 1;

/// Names the file in the data directory that carries `DATA_FORMAT`, written by the
/// installer as it hands the folder to a build.
pub const FORMAT_STAMP: &str = "format.txt";
