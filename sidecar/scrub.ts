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

// Redact anything shaped like account key material, plus the one piece of personal
// data every absolute path carries, before it can reach the on-disk log: PGP armor
// blocks, long base64 / base64url / hex runs (armored key bodies, session keys,
// tokens, passphrases), and the Windows account name. Extracted into its own module
// so it can be unit-tested without server.ts's stdio side effects.
export function scrubSecrets(s: string): string {
  return s
    .replace(/-----BEGIN [\s\S]*?-----END[^-]*-----/g, "[redacted PGP block]")
    // The Windows account name, as it appears in every absolute path a Node stack
    // trace or fs error carries. Only the name goes: the rest of the path is what
    // makes a stack trace worth logging, and it is not personal.
    .replace(/([A-Za-z]:[\\/]Users[\\/])([^\\/\s"'<>|]+)/gi, "$1[user]")
    // base64 and base64url ("-" and "_" instead of "+" and "/"), which is what
    // tokens actually travel as.
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]")
    .replace(/\b[0-9a-fA-F]{40,}\b/g, "[redacted]")
    // Proton's session uid, access and refresh tokens are 32 lowercase letters and
    // digits, under the length above; so is the file-manager drive's token. A run that
    // long mixing both is a token, never a word.
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{32,39}\b/g, "[redacted]")
    // Control characters, but for the tab and the newline a stack trace is made of: a
    // name or a server message carrying a carriage return or an escape sequence would
    // otherwise forge a line of its own in the log, or repaint the terminal reading it.
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
}
