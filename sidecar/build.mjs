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

// Produces everything the shipped app needs to run the sidecar without Node,
// npm or the source tree being present on the user's machine.
//
// Output:
//   sidecar/build/server.mjs        the whole sidecar, bundled
//   sidecar/build/node_modules/     sharp only (a native addon, cannot be inlined)
//   app/src-tauri/binaries/sidecar-<triple>.exe   a copy of node.exe
//
// Why ESM: openpgp's Node build calls `createRequire(import.meta.url)`, which a
// CJS bundle cannot satisfy. Emitting ESM keeps `import.meta` real.
//
// Why the banner: some transitive dependencies are CJS and call `require()` at
// run time. esbuild's ESM output stubs `require` to throw, but its shim defers
// to a `require` already in scope, so defining one here makes those calls work.
//
// Why the alias: `@protontech/crypto` imports `openpgp/lightweight`, a subpath
// that only exports a `browser` condition. Pointing it at the full `openpgp`
// selects the proper Node build, which is why the shipped app does not need the
// `--conditions=browser` crutch the dev spawn relies on.
//
// Why legalComments is none: only a handful of the bundled packages carry a
// banner comment at all, so keeping them would deliver a partial notice and read
// as if it were the whole one. The notices reach the user instead as
// THIRD-PARTY-NOTICES.txt in the install folder, built from every package's own
// declared licence, and build-setup.ps1 stages it beside app.exe.
import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "build");
const binDir = join(here, "..", "app", "src-tauri", "binaries");

const banner = [
  "import { createRequire as __createRequire } from 'module';",
  "import { fileURLToPath as __fileURLToPath } from 'url';",
  "import { dirname as __pathDirname } from 'path';",
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __pathDirname(__filename);",
].join("\n");

await build({
  // Resolve imports, and the openpgp alias below, from the sidecar dir rather than the
  // process working directory, so the bundle builds the same whether it is invoked as
  // `npm run build` here or as `node sidecar/build.mjs` from the repo root, which is how
  // the Flatpak build runs it. Without this the alias resolves against the wrong tree
  // and openpgp is not found.
  absWorkingDir: here,
  entryPoints: [join(here, "server.ts")],
  outfile: join(outDir, "server.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["sharp", "onnxruntime-node"],
  alias: { "openpgp/lightweight": "openpgp" },
  banner: { js: banner },
  legalComments: "none",
  logLevel: "warning",
});
console.log("bundled  -> build/server.mjs");

// sharp is the one dependency that cannot be bundled, so stage just it, with
// its own dependency tree, beside the bundle where Node will resolve it.
// The exact version the sidecar itself is installed with, so the build ships what was
// tested and listed in the notices, not whatever 0.35.x is newest on the day.
const SHARP_VERSION = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).dependencies.sharp;
writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify({ name: "sidecar-dist", private: true, dependencies: { sharp: SHARP_VERSION } }, null, 2),
);
if (process.env.PFP_OFFLINE === "1") {
  // The Flatpak build runs without network, so sharp is copied out of the sidecar's own
  // installed dependencies instead of being installed a second time.
  stageSharpFromDeps();
} else {
  // `shell: true` is required on Windows: since Node 20, spawning a `.cmd` such as
  // npm.cmd without a shell is refused.
  const npm = spawnSync("npm", ["install", "--omit=dev", "--silent"], {
    cwd: outDir,
    stdio: "inherit",
    shell: true,
  });
  if (npm.status !== 0) throw new Error("installing sharp beside the bundle failed");
}
stageOnnxRuntime();
cleanResourceTree(join(outDir, "node_modules"));
console.log("staged   -> build/node_modules (sharp, onnxruntime-node)");

// The vocabulary the search tokenizer reads, beside the bundle where it looks for it.
mkdirSync(join(outDir, "assets"), { recursive: true });
copyFileSync(
  join(here, "proton", "assets", "bpe_simple_vocab_16e6.txt.gz"),
  join(outDir, "assets", "bpe_simple_vocab_16e6.txt.gz"),
);
console.log("staged   -> build/assets (search vocabulary)");

/**
 * The ONNX runtime the search's text encoder runs on, copied from the installed packages with
 * only this platform's binaries: the package carries every platform's, and the GPU providers
 * too (DirectML on Windows, CUDA and TensorRT on Linux), which the CPU provider it runs on
 * never loads.
 */
function stageOnnxRuntime() {
  const deps = join(here, "node_modules");
  for (const name of ["onnxruntime-node", "onnxruntime-common"]) {
    if (!existsSync(join(deps, name, "package.json"))) {
      throw new Error(`${name} is not installed in sidecar/node_modules; run \`npm ci\` there first`);
    }
    const to = join(outDir, "node_modules", name);
    rmSync(to, { recursive: true, force: true });
    cpSync(join(deps, name), to, { recursive: true });
  }
  const bin = join(outDir, "node_modules", "onnxruntime-node", "bin");
  for (const napi of readdirSync(bin)) {
    for (const platform of readdirSync(join(bin, napi))) {
      if (platform !== process.platform) {
        rmSync(join(bin, napi, platform), { recursive: true, force: true });
        continue;
      }
      for (const arch of readdirSync(join(bin, napi, platform))) {
        if (arch !== process.arch) rmSync(join(bin, napi, platform, arch), { recursive: true, force: true });
      }
    }
  }
  if (process.platform === "win32") {
    for (const napi of readdirSync(bin)) {
      const dir = join(bin, napi, "win32", process.arch);
      for (const file of ["DirectML.dll", "dxcompiler.dll", "dxil.dll"]) rmSync(join(dir, file), { force: true });
    }
  }
  if (process.platform === "linux") {
    for (const napi of readdirSync(bin)) {
      const dir = join(bin, napi, "linux", process.arch);
      for (const file of ["libonnxruntime_providers_cuda.so", "libonnxruntime_providers_tensorrt.so"]) {
        rmSync(join(dir, file), { force: true });
      }
    }
  }
  const binding = join(bin, readdirSync(bin)[0], process.platform, process.arch, "onnxruntime_binding.node");
  if (!existsSync(binding)) throw new Error("the ONNX runtime binding for this platform is missing");
}

// sharp and everything it loads at run time: its dependencies, plus the optional ones
// actually installed, which are the platform's own native binaries. Each package keeps
// its place in the tree, since the native addon finds libvips by a relative path.
function stageSharpFromDeps() {
  const deps = join(here, "node_modules");
  if (!existsSync(join(deps, "sharp", "package.json"))) {
    throw new Error("sharp is not installed in sidecar/node_modules; run `npm ci` there first");
  }
  const found = new Set();
  const pending = [join(deps, "sharp")];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (found.has(dir)) continue;
    found.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      // An optional dependency built for another platform is simply not installed.
      const installed = findInstalled(dir, name);
      if (installed) pending.push(installed);
    }
  }
  for (const dir of found) {
    cpSync(dir, join(outDir, "node_modules", relative(deps, dir)), { recursive: true });
  }
  const binding = `@img/sharp-${process.platform}-${process.arch}`;
  if (!existsSync(join(outDir, "node_modules", binding, "package.json"))) {
    throw new Error(`${binding} is not installed in sidecar/node_modules`);
  }
}

// Node's own lookup order: the package's nested node_modules first, then each parent's.
function findInstalled(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === here || dir === dirname(dir)) return null;
  }
}

// Drop npm's bin symlinks under the staged node_modules. They are CLI shims the app
// never runs, and Tauri bundles build/ as a resource: its walker follows a symlink
// and fails with "Not a directory" when it is a real one, which it is on Linux (on
// Windows they were .cmd shims and slipped through). Removing every symlink keeps the
// resource tree a plain file tree on every platform.
function cleanResourceTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    // Symlinks (npm bin shims), the .bin dir, and npm's lock metadata are none of them
    // needed at runtime, and each has tripped Tauri's resource walker on Linux.
    if (entry.isSymbolicLink() || entry.name === ".bin" || entry.name === ".package-lock.json") {
      rmSync(p, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      cleanResourceTree(p);
    }
  }
}

// Tauri's externalBin looks for a target-triple suffix and strips it when it
// copies the file next to the app executable.
const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .split("\n")
  .find((line) => line.startsWith("host:"))
  .slice("host:".length)
  .trim();

mkdirSync(binDir, { recursive: true });
const target = join(binDir, `sidecar-${triple}${process.platform === "win32" ? ".exe" : ""}`);
copyFileSync(process.execPath, target);
console.log(`runtime  -> binaries/sidecar-${triple} (node ${process.version})`);
