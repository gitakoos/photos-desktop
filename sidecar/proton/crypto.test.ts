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

// `getSrpVerifier` was once a stub that threw, and nothing noticed: it is the
// only part of the SDK a public link reaches and nothing else calls it, so
// every photo link failed while the rest of sharing worked. These pin down that
// it asks the server for a modulus and hands one back.
//
// The verifier itself is not computed here. It is derived from a modulus Proton
// signs, and the signature is checked, so there is no fixture to compute it
// from short of a live account.

// Base64 on typed arrays is still a proposal, and the SRP helpers use it. The
// server loads this same polyfill on start, so loading it here is what the
// module would find running for real.
import "@protontech/crypto/polyfill";
import { describe, it, expect } from "vitest";
import { makeSrpModule } from "./crypto.ts";

const MODULUS = { modulus: "-----BEGIN PGP SIGNED MESSAGE-----", modulusId: "modulus-1" };

describe("the SRP module the SDK is handed", () => {
  it("asks for a freshly signed modulus when a public link needs a verifier", async () => {
    let asked = 0;
    const srp = makeSrpModule(async () => {
      asked += 1;
      return MODULUS;
    });
    // The fake modulus above cannot pass Proton's signature check, so the call
    // fails past this point. What matters is that it got that far at all.
    await srp.getSrpVerifier("url-password").catch(() => {});
    expect(asked).toBe(1);
  });

  it("carries the modulus fetch's own failure out rather than burying it", async () => {
    const srp = makeSrpModule(async () => {
      throw new Error("the server returned no SRP modulus");
    });
    await expect(srp.getSrpVerifier("url-password")).rejects.toThrow(
      "the server returned no SRP modulus",
    );
  });

  it("still offers the login-side helpers the account flow uses", () => {
    const srp = makeSrpModule(async () => MODULUS);
    expect(typeof srp.computeKeyPassword).toBe("function");
    expect(srp.generateKeySalt()).toEqual(expect.any(String));
  });
});
