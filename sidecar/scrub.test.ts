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

import { describe, it, expect } from "vitest";
import { scrubSecrets } from "./scrub.ts";

describe("scrubSecrets", () => {
  it("redacts a PGP armored key block", () => {
    const s =
      "decrypt failed:\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: OpenPGP\n\nlQdGBGaB3xQBEACxyz1234567890abcdefGHIJKLmnop/qrstuvwXYZ+0123456789\nAAAABBBBCCCCDDDDEEEEFFFF0000111122223333=\n-----END PGP PRIVATE KEY BLOCK-----\ndone";
    const out = scrubSecrets(s);
    expect(out).not.toContain("BEGIN PGP");
    expect(out).toContain("[redacted PGP block]");
    expect(out).toContain("done");
  });

  it("redacts a long base64 run (session key / token / passphrase)", () => {
    const s =
      "[console.info] userKeyPassphrase: TW9yZVNlY3JldEtleU1hdGVyaWFsQmFzZTY0RW5jb2RlZFN0dWZmSGVyZTEyMzQ1Njc4OTA=";
    const out = scrubSecrets(s);
    expect(out).toContain("[redacted]");
    expect(out).not.toMatch(/[A-Za-z0-9+/]{40,}/);
  });

  it("redacts a long hex run (raw session key)", () => {
    const s = "sessionKey=9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddccbbaa99887766554433221100 algo=aes256";
    const out = scrubSecrets(s);
    expect(out).toContain("[redacted]");
    expect(out).toContain("algo=aes256");
  });

  it("redacts a base64url token (- and _ instead of + and /)", () => {
    const s = "[console.info] token: TW9yZVNlY3JldEtleU1hdGVyaWFs-QmFzZTY0dXJsRW5jb2RlZFN0dWZm_SGVyZTEyMw";
    const out = scrubSecrets(s);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("TW9yZVNlY3JldEtleU1hdGVyaWFs");
  });

  it("redacts the Windows account name but keeps the rest of the path", () => {
    const s =
      "[upload] drain failed: Error: boom\n    at drain (C:\\Users\\jsmith\\AppData\\Local\\Photos for Proton\\sidecar.js:12:9)";
    const out = scrubSecrets(s);
    expect(out).not.toContain("jsmith");
    expect(out).toContain("C:\\Users\\[user]\\AppData\\Local");
    expect(out).toContain("sidecar.js");
  });

  it("redacts the account name from an fs error path", () => {
    const s = "ENOENT: no such file or directory, unlink 'C:/Users/jane.doe/AppData/Local/x/session.enc'";
    const out = scrubSecrets(s);
    expect(out).not.toContain("jane.doe");
    expect(out).toContain("[user]");
  });

  it("leaves a normal diagnostic line untouched", () => {
    const s = "[sidecar] getTimeline done, 924 items in 812ms";
    expect(scrubSecrets(s)).toBe(s);
  });

  it("leaves a normal hydrate diagnostic untouched", () => {
    const s = "[cloud] hydrate start (size=349828 by=explorer.exe explicit=false)";
    expect(scrubSecrets(s)).toBe(s);
  });

  it("redacts a 32-character session token, which the long-run rule misses", () => {
    const token = "k3j9x0q2m5n8b7v1c4z6a0s9d8f7g6h5";
    const out = scrubSecrets(`refresh failed for uid ${token}: 401`);
    expect(out).not.toContain(token);
    expect(out).toBe("refresh failed for uid [redacted]: 401");
  });

  it("keeps a long word with no digit in it", () => {
    const s = "[drive] listing: counterrevolutionarieswithoutdigits";
    expect(scrubSecrets(s)).toBe(s);
  });

  it("stops a name from forging a line or an escape sequence", () => {
    const out = scrubSecrets("upload failed: IMG\r[sidecar] signed out\x1b[2J.jpg");
    expect(out).not.toMatch(/[\r\x1b]/);
    // A stack trace's own lines and tabs are what it is made of.
    expect(scrubSecrets("Error: x\n\tat f (a.ts:1:2)")).toBe("Error: x\n\tat f (a.ts:1:2)");
  });
});
