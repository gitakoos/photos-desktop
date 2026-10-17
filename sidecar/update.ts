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
// installer with a SHA-256 check. The Rust host then runs it in `--update` mode.
// The repo is public, so no auth. `/releases/latest` skips prereleases, so the
// full list is read and the newest release that ships an .exe wins.

import { createHash } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO = "gitakoos/photos-desktop";
const UA = { "User-Agent": "PhotosForProton-Updater" };

export type UpdateInfo = {
  tag: string;
  version: string; // tag without a leading "v"
  notes: string;
  url: string;
  sha256: string | null; // hex, from the GitHub asset digest
  size: number;
} | null;

/** The newest published release (prereleases included) that ships an installer. */
export async function checkUpdate(): Promise<UpdateInfo> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=15`, {
    headers: { Accept: "application/vnd.github+json", ...UA },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const releases = (await res.json()) as any[];

  let best: { r: any; asset: any } | null = null;
  for (const r of releases) {
    if (r.draft) continue;
    const asset = (r.assets ?? []).find((a: any) => String(a.name).toLowerCase().endsWith(".exe"));
    if (!asset) continue;
    if (!best || new Date(r.published_at).getTime() > new Date(best.r.published_at).getTime()) {
      best = { r, asset };
    }
  }
  if (!best) return null;

  const digest: string = best.asset.digest ?? ""; // "sha256:<hex>"
  return {
    tag: best.r.tag_name,
    version: String(best.r.tag_name).replace(/^v/i, ""),
    notes: best.r.body ?? "",
    url: best.asset.browser_download_url,
    sha256: digest.startsWith("sha256:") ? digest.slice(7) : null,
    size: best.asset.size ?? 0,
  };
}

/**
 * The single path a verified installer is ever written to. Fixed rather than
 * per-pid because the Rust host launches exactly this path, computed on its own
 * side, instead of being handed one to execute.
 */
export function updatePath(): string {
  return join(tmpdir(), "pfp-update.exe");
}

/**
 * Download the newest installer to `updatePath()` and verify its SHA-256.
 *
 * Takes no arguments on purpose. The URL and the digest are re-read from the
 * GitHub API here rather than accepted from the caller, so nothing the renderer
 * says can point the updater at another host or suppress the hash check. Fails
 * closed: no digest means no install.
 */
export async function downloadUpdate(): Promise<string> {
  const info = await checkUpdate();
  if (!info) throw new Error("NO_UPDATE");
  // The digest is the only thing standing between us and running a foreign binary,
  // so a missing one is a hard stop, never a skipped check.
  if (!info.sha256) throw new Error("NO_DIGEST");

  const u = new URL(info.url);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "github.com" ||
    !u.pathname.startsWith(`/${REPO}/releases/download/`)
  ) {
    throw new Error("BAD_ORIGIN");
  }

  const res = await fetch(info.url, { headers: UA, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`);

  // Hash while streaming: the installer is ~57 MB and never needs to sit in memory.
  const hash = createHash("sha256");
  const dest = updatePath();
  await pipeline(
    Readable.fromWeb(res.body as any),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(dest),
  );

  if (hash.digest("hex").toLowerCase() !== info.sha256.toLowerCase()) {
    try {
      rmSync(dest, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error("HASH_MISMATCH");
  }
  return dest;
}
