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

// App self-update: read the GitHub releases of this repo, and download the
// installer with a SHA-256 check, beside its signature. The Rust host checks that
// signature against the update key and then runs it in `--update` mode.
// The repo is public, so no auth. `/releases/latest` skips prereleases, so the
// full list is read and the newest release that ships an installer wins.
//
// A release carries the full installer and, for the version before it, an update
// installer holding only the files that changed since then: a few MB instead of the
// whole app. This app downloads that one when it is exactly that version, and the
// full installer otherwise.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO = "gitakoos/photos-desktop";
const UA = { "User-Agent": "PhotosForProton-Updater" };

/** The full installer: what a fresh install and any version without an update installer take. */
export const FULL_INSTALLER = "Photos-for-Proton-Setup.exe";

/** The update installer a release carries for `version`, the release before it. */
export function patchInstaller(version: string): string {
  return `Photos-for-Proton-Update-from-${version}.exe`;
}

const VERSION_SHAPE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** This app's version, as the host hands it over; null when it does not (a dev run). */
function runningVersion(): string | null {
  const v = process.env.PFP_APP_VERSION ?? "";
  return VERSION_SHAPE.test(v) ? v : null;
}

export type UpdateInfo = {
  tag: string;
  version: string; // tag without a leading "v"
  notes: string;
  url: string;
  sha256: string | null; // hex, from the GitHub asset digest
  size: number;
  signatureUrl: string | null; // the installer's `.minisig` beside it
  patchFrom: string | null; // set when `url` is the update installer for this version
} | null;

/** A signature file is four short lines. */
const MAX_SIGNATURE_BYTES = 4096;

const named = (r: any, name: string) =>
  (r.assets ?? []).find((a: any) => String(a.name).toLowerCase() === name.toLowerCase());

/** The newest published release (prereleases included) that ships an installer. */
export async function checkUpdate(): Promise<UpdateInfo> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=15`, {
    headers: { Accept: "application/vnd.github+json", ...UA },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const releases = (await res.json()) as any[];

  let best: any = null;
  for (const r of releases) {
    if (r.draft || !named(r, FULL_INSTALLER)) continue;
    if (!best || new Date(r.published_at).getTime() > new Date(best.published_at).getTime()) best = r;
  }
  if (!best) return null;

  // The update installer only with its own signature beside it; without one the full
  // installer is the safer download, not a reason to fail.
  const current = runningVersion();
  const patch = current ? named(best, patchInstaller(current)) : null;
  const patchSig = patch ? named(best, `${patch.name}.minisig`) : null;
  const asset = patch && patchSig ? patch : named(best, FULL_INSTALLER);
  const signature = patch && patchSig ? patchSig : named(best, `${FULL_INSTALLER}.minisig`);

  const digest: string = asset.digest ?? ""; // "sha256:<hex>"
  return {
    tag: best.tag_name,
    version: String(best.tag_name).replace(/^v/i, ""),
    notes: best.body ?? "",
    url: asset.browser_download_url,
    sha256: digest.startsWith("sha256:") ? digest.slice(7) : null,
    size: asset.size ?? 0,
    signatureUrl: signature?.browser_download_url ?? null,
    patchFrom: patch && patchSig ? current : null,
  };
}

/** One field of a signature file's trusted comment (`version`, `from`), or null. */
export function signedField(text: string, name: string): string | null {
  const line = text.split("\n").find((l) => l.startsWith("trusted comment: "));
  const field = line?.slice("trusted comment: ".length).split("\t").find((f) => f.startsWith(`${name}:`));
  return field ? field.slice(name.length + 1).trim() : null;
}

/** The version a signature file says it was made for, from its trusted comment. */
export function signedVersion(text: string): string | null {
  return signedField(text, "version");
}

/** Only this repo's release downloads, so no answer from the API can point elsewhere. */
function fromThisRepo(url: string): boolean {
  const u = new URL(url);
  return u.protocol === "https:" && u.hostname === "github.com" && u.pathname.startsWith(`/${REPO}/releases/download/`);
}

/**
 * The single path a verified installer is ever written to. Fixed rather than
 * per-pid because the Rust host launches exactly this path, computed on its own
 * side, instead of being handed one to execute.
 */
export function updatePath(): string {
  return join(tmpdir(), "pfp-update.exe");
}

/** What a part file beside the launch path is a part of, so only that download resumes it. */
type PartOf = { url: string; sha256: string };

/** The bytes of a part file left by an interrupted download of this same installer, hashed. */
async function resumable(part: string, info: { url: string; sha256: string; size: number }, hash: ReturnType<typeof createHash>) {
  const meta = `${part}.json`;
  try {
    const was = JSON.parse(readFileSync(meta, "utf8")) as PartOf;
    const have = existsSync(part) ? statSync(part).size : 0;
    if (was.url !== info.url || was.sha256 !== info.sha256 || have === 0 || (info.size > 0 && have >= info.size)) {
      throw new Error("not this download");
    }
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    return have;
  } catch {
    rmSync(part, { force: true });
    writeFileSync(meta, JSON.stringify({ url: info.url, sha256: info.sha256 } satisfies PartOf));
    return 0;
  }
}

/**
 * Download the newest installer to `updatePath()` and verify its SHA-256.
 *
 * Takes no arguments on purpose. The URL and the digest are re-read from the
 * GitHub API here rather than accepted from the caller, so nothing the renderer
 * says can point the updater at another host or suppress the hash check. Fails
 * closed: no digest means no install.
 *
 * An interrupted download is picked up where it stopped, the next time the app
 * opens, when it is the same installer: the part already on disk is hashed again
 * and only the rest is asked for.
 */
export async function downloadUpdate(onProgress?: (received: number, total: number) => void): Promise<string> {
  const info = await checkUpdate();
  if (!info) throw new Error("NO_UPDATE");
  // A missing digest or signature is a hard stop, never a skipped check. The host
  // refuses an installer without a valid signature anyway; failing here says so sooner.
  if (!info.sha256) throw new Error("NO_DIGEST");
  if (!info.signatureUrl) throw new Error("NO_SIGNATURE");
  if (!fromThisRepo(info.url) || !fromThisRepo(info.signatureUrl)) throw new Error("BAD_ORIGIN");

  const signed = await fetch(info.signatureUrl, { headers: UA, redirect: "follow" });
  if (!signed.ok) throw new Error(`signature ${signed.status}`);
  const signature = await signed.text();
  if (signature.length > MAX_SIGNATURE_BYTES) throw new Error("BAD_SIGNATURE");
  // Read before it is checked, and only to fail early: the host checks it for real.
  if (signedVersion(signature) !== info.version) throw new Error("BAD_SIGNATURE");
  if (signedField(signature, "from") !== info.patchFrom) throw new Error("BAD_SIGNATURE");

  // Hash while streaming: the installer is ~70 MB and never needs to sit in memory.
  // It is written beside the launch path and only moved onto it once verified, so the
  // path the host executes never holds a partial or unchecked file.
  const dest = updatePath();
  const part = `${dest}.part`;
  const sigPath = `${dest}.minisig`;
  rmSync(dest, { force: true });
  rmSync(sigPath, { force: true });
  let hash = createHash("sha256");
  let received = await resumable(part, { url: info.url, sha256: info.sha256, size: info.size }, hash);

  const headers: Record<string, string> = { ...UA, ...(received > 0 ? { Range: `bytes=${received}-` } : {}) };
  const res = await fetch(info.url, { headers, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
  if (received > 0 && res.status !== 206) {
    // The server sent the whole file instead: start the part over.
    received = 0;
    hash = createHash("sha256");
  }
  const total = info.size || received + (Number(res.headers.get("content-length")) || 0);
  onProgress?.(received, total);

  await pipeline(
    Readable.fromWeb(res.body as any),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        hash.update(chunk);
        received += chunk.length;
        onProgress?.(received, total);
        yield chunk;
      }
    },
    createWriteStream(part, { flags: received > 0 && res.status === 206 ? "a" : "w" }),
  );
  rmSync(`${part}.json`, { force: true });
  if (hash.digest("hex").toLowerCase() !== info.sha256.toLowerCase()) {
    rmSync(part, { force: true });
    throw new Error("HASH_MISMATCH");
  }
  renameSync(part, dest);
  writeFileSync(sigPath, signature);
  return dest;
}

/** Where a download started by `startUpdateDownload` stands, for the window to draw. */
export type UpdateJob = {
  phase: "idle" | "downloading" | "ready" | "failed";
  received: number;
  total: number;
  error: string;
};

let job: UpdateJob = { phase: "idle", received: 0, total: 0, error: "" };

/**
 * Starts the download and answers at once. The transfer runs inside this process and
 * off the host's single channel, so the app keeps working while it comes down; the
 * window follows it through `updateStatus`.
 */
export function startUpdateDownload(): UpdateJob {
  if (job.phase === "downloading") return job;
  job = { phase: "downloading", received: 0, total: 0, error: "" };
  downloadUpdate((received, total) => {
    job.received = received;
    job.total = total;
  }).then(
    () => {
      job.phase = "ready";
    },
    (e) => {
      job.phase = "failed";
      job.error = (e as Error).message;
    },
  );
  return job;
}

export function updateStatus(): UpdateJob {
  return job;
}
