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

// A model file fetched once on the user's say-so and pinned to the release's bytes: its size
// is checked as it arrives and its digest before it is kept, and again before the native
// runtime is handed a copy that has been sitting on disk.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { storeDir } from "./store.ts";

export type PinnedModelSpec = { url: string; file: string; size: number; sha256: string };

export type PinnedModelStatus =
  | { state: "absent" }
  | { state: "downloading"; done: number; total: number }
  | { state: "ready" }
  | { state: "failed"; error: string };

export type PinnedModel = {
  path: () => string;
  status: () => PinnedModelStatus;
  /** Fetches the model in the background; `status` follows it. */
  startDownload: () => PinnedModelStatus;
  remove: () => PinnedModelStatus;
  /** Whether the file on disk is the pinned one, checked byte for byte once a run. */
  intact: () => Promise<boolean>;
};

export function pinnedModel(spec: PinnedModelSpec, tag: string): PinnedModel {
  let download: { done: number; total: number } | null = null;
  let lastError: string | null = null;
  let verified = false;

  const dir = () => join(storeDir(), "models");
  const path = () => join(dir(), spec.file);

  function ready(): boolean {
    try {
      return statSync(path()).size === spec.size;
    } catch {
      return false;
    }
  }

  function status(): PinnedModelStatus {
    if (download) return { state: "downloading", ...download };
    if (ready()) return { state: "ready" };
    if (lastError) return { state: "failed", error: lastError };
    return { state: "absent" };
  }

  async function fetchModel(): Promise<void> {
    mkdirSync(dir(), { recursive: true });
    const part = `${path()}.part`;
    const response = await fetch(spec.url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const hash = createHash("sha256");
    const out = createWriteStream(part);
    let received = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        // Anything longer than the published size is not the model, and stops here rather
        // than filling the disk before the check.
        if (received > spec.size) throw new Error("the model is larger than its published size");
        hash.update(value);
        if (!out.write(value)) await new Promise((r) => out.once("drain", r));
        if (download) download.done += value.length;
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    } catch (e) {
      out.destroy();
      rmSync(part, { force: true });
      throw e;
    }
    if (hash.digest("hex") !== spec.sha256 || statSync(part).size !== spec.size) {
      rmSync(part, { force: true });
      throw new Error("the model did not match its published digest");
    }
    renameSync(part, path());
    verified = true;
  }

  function startDownload(): PinnedModelStatus {
    if (download || ready()) return status();
    download = { done: 0, total: spec.size };
    lastError = null;
    void fetchModel()
      .catch((e) => {
        lastError = (e as Error).message || "download failed";
        process.stderr.write(`[${tag}] the model download failed: ${(e as Error).name}\n`);
      })
      .finally(() => {
        download = null;
      });
    return status();
  }

  function remove(): PinnedModelStatus {
    verified = false;
    rmSync(path(), { force: true });
    rmSync(`${path()}.part`, { force: true });
    lastError = null;
    return status();
  }

  async function intact(): Promise<boolean> {
    if (!ready()) return false;
    if (verified) return true;
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      createReadStream(path())
        .on("data", (chunk) => hash.update(chunk))
        .on("end", () => resolve())
        .on("error", reject);
    });
    verified = hash.digest("hex") === spec.sha256;
    if (!verified) {
      process.stderr.write(`[${tag}] the model on disk did not match its digest and was removed\n`);
      rmSync(path(), { force: true });
    }
    return verified;
  }

  return { path, status, startDownload, remove, intact };
}
