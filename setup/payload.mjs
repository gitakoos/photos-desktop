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

// What a release's payload holds, file by file, and what changed since the last one,
// for the update installer that carries only the changed files.
//
//   node setup/payload.mjs from-installer <setup.exe>       print the embedded payload's files and sha256
//   node setup/payload.mjs changed <stage-dir> <setup.exe> <out-dir>
//        copy into <out-dir> every file of <stage-dir> that the installer's payload lacks
//        or holds with other bytes, and print how many and how large
//
// The previous installer is read rather than a list kept on the side: it is exactly
// what is installed on the machines the update installer will run on.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const norm = (name) => name.replaceAll("\\", "/");

/**
 * The zip the installer embeds, found by its end record: the one whose central
 * directory starts with a central header where the record says it does. The zip sits
 * inside the executable, so its offsets are relative to where it begins.
 */
function embeddedZip(exe) {
  const buf = readFileSync(exe);
  for (let at = buf.length - 22; at >= 0; at--) {
    if (buf.readUInt32LE(at) !== EOCD) continue;
    const entries = buf.readUInt16LE(at + 10);
    const cdSize = buf.readUInt32LE(at + 12);
    const cdOffset = buf.readUInt32LE(at + 16);
    const cdStart = at - cdSize;
    if (cdStart < 0 || buf.readUInt32LE(cdStart) !== CENTRAL) continue;
    const zipStart = cdStart - cdOffset;
    if (zipStart < 0) continue;
    return { buf, zipStart, cdStart, entries };
  }
  throw new Error(`no embedded payload in ${exe}`);
}

/** Every file in the installer's payload, by its forward-slash path, with its sha256. */
export function installerFiles(exe) {
  const { buf, zipStart, cdStart, entries } = embeddedZip(exe);
  const files = new Map();
  let p = cdStart;
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error("broken central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = zipStart + buf.readUInt32LE(p + 42);
    const name = norm(buf.toString("utf8", p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (buf.readUInt32LE(local) !== LOCAL) throw new Error(`broken local header: ${name}`);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + compressed);
    const bytes = method === 8 ? inflateRawSync(raw) : method === 0 ? raw : null;
    if (!bytes) throw new Error(`unsupported compression ${method}: ${name}`);
    files.set(name, sha256(bytes));
  }
  return files;
}

function walk(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, out);
    else out.push(norm(relative(root, full).split(sep).join("/")));
  }
  return out;
}

function changed(stage, exe, outDir) {
  const before = installerFiles(exe);
  rmSync(outDir, { recursive: true, force: true });
  let count = 0;
  let bytes = 0;
  const kept = [];
  for (const rel of walk(stage)) {
    const full = join(stage, rel);
    if (before.get(rel) === sha256(readFileSync(full))) {
      kept.push(rel);
      continue;
    }
    mkdirSync(dirname(join(outDir, rel)), { recursive: true });
    copyFileSync(full, join(outDir, rel));
    count++;
    bytes += statSync(full).size;
    console.log(`changed: ${rel}`);
  }
  console.log(`${count} changed (${(bytes / 1e6).toFixed(1)} MB), ${kept.length} unchanged`);
  if (count === 0) throw new Error("nothing changed since that installer");
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "from-installer" && args.length === 1) {
    for (const [name, hash] of installerFiles(args[0])) console.log(`${hash}  ${name}`);
  } else if (command === "changed" && args.length === 3) {
    changed(args[0], args[1], args[2]);
  } else {
    console.error("usage: payload.mjs from-installer <setup.exe> | changed <stage-dir> <setup.exe> <out-dir>");
    process.exit(2);
  }
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
