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

// Signs the installer for the app's own updater, in the minisign format (Ed25519 over
// the file's BLAKE2b-512 hash). The trusted comment carries the version, and the
// signature covers it, so an older signed installer cannot be passed off as a newer one.
//
//   node setup/sign-update.mjs generate <secret-key-file>
//   node setup/sign-update.mjs sign <secret-key-file> <installer.exe> <version> [<from-version>]
//
// An update installer, which carries only what changed since one version, is signed
// with that version as `from`: the app runs it only over exactly that version.
//
// The secret key never belongs in this repository. Only its public half is in the app.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const VERSION_SHAPE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The minisign public key line: "Ed", the key id, then the raw 32-byte key. */
function publicKeyLine(keyId, privateKey) {
  const raw = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
}

function generate(file) {
  if (existsSync(file)) throw new Error(`${file} already exists; a new key would orphan every install`);
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  writeFileSync(file, JSON.stringify({ keyId: keyId.toString("hex"), pkcs8: pkcs8.toString("base64") }) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(`secret key -> ${file}`);
  console.log(`public key: ${publicKeyLine(keyId, privateKey)}`);
}

function load(file) {
  const stored = JSON.parse(readFileSync(file, "utf8"));
  const keyId = Buffer.from(stored.keyId, "hex");
  if (keyId.length !== 8) throw new Error("bad key id");
  const privateKey = createPrivateKey({ key: Buffer.from(stored.pkcs8, "base64"), format: "der", type: "pkcs8" });
  return { keyId, privateKey };
}

function signInstaller(keyFile, installer, version, from) {
  if (!VERSION_SHAPE.test(version)) throw new Error(`not a version: ${version}`);
  if (from !== undefined && !VERSION_SHAPE.test(from)) throw new Error(`not a version: ${from}`);
  const { keyId, privateKey } = load(keyFile);
  const hash = createHash("blake2b512").update(readFileSync(installer)).digest();
  const signature = sign(null, hash, privateKey);
  const trusted =
    `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${basename(installer)}\tversion:${version}` +
    (from === undefined ? "" : `\tfrom:${from}`);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
  const out = `${installer}.minisig`;
  writeFileSync(
    out,
    [
      "untrusted comment: Photos for Proton installer signature",
      Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
      `trusted comment: ${trusted}`,
      global.toString("base64"),
      "",
    ].join("\n"),
  );
  console.log(`signature -> ${out}`);
  console.log(`signed with key ${publicKeyLine(keyId, privateKey)}`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "generate" && args.length === 1) generate(args[0]);
  else if (command === "sign" && (args.length === 3 || args.length === 4)) signInstaller(...args);
  else {
    console.error("usage: sign-update.mjs generate <key> | sign <key> <installer.exe> <version> [<from-version>]");
    process.exit(2);
  }
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
