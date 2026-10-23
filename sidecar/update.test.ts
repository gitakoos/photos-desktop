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

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkUpdate, downloadUpdate, signedVersion } from "./update.ts";

const SIGNATURE = [
  "untrusted comment: Photos for Proton installer signature",
  "RUQeJbkgahsNY1rSYFbxRc94JmWDCJ9njXg2UHl11QVI2AdCjgq3UgX9SjoXC6ujjRB0GSOmeUMozDhhOovTW499Rt8wPpToow4=",
  "trusted comment: timestamp:1792708619\tfile:fixture.exe\tversion:1.2.0",
  "oyE7Fap3182ytzsPvkUYxWqAUB6+zazRnrv/QLsKUrwlh2Hrff3W9Ry/Df6tTSn9us6JUwJPyycri3VtCppODA==",
  "",
].join("\n");

const BASE = "https://github.com/gitakoos/photos-desktop/releases/download/v1.2.0";

/** The API's answer for one release, with or without a signature beside the installer. */
function release(withSignature: boolean) {
  const assets: any[] = [
    {
      name: "Photos-for-Proton-Setup.exe",
      browser_download_url: `${BASE}/Photos-for-Proton-Setup.exe`,
      digest: "sha256:" + "0".repeat(64),
      size: 10,
    },
  ];
  if (withSignature) {
    assets.push({
      name: "Photos-for-Proton-Setup.exe.minisig",
      browser_download_url: `${BASE}/Photos-for-Proton-Setup.exe.minisig`,
    });
  }
  return [{ tag_name: "v1.2.0", published_at: "2026-10-23T00:00:00Z", body: "", assets }];
}

/** Answers the releases list, then the signature; any download of the installer fails the test. */
function serve(withSignature: boolean, signature: string) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    if (url.includes("/releases?")) return new Response(JSON.stringify(release(withSignature)));
    if (url.endsWith(".minisig")) return new Response(signature);
    throw new Error(`the installer must not be fetched: ${url}`);
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the updater's signature", () => {
  it("reads the version from the signed comment", () => {
    expect(signedVersion(SIGNATURE)).toBe("1.2.0");
    expect(signedVersion("untrusted comment: x\nAAAA\n")).toBeNull();
  });

  it("downloads nothing for a release with no signature", async () => {
    const asked = serve(false, "");
    await expect(downloadUpdate()).rejects.toThrow("NO_SIGNATURE");
    expect(asked.some((u) => u.endsWith(".exe"))).toBe(false);
  });

  it("downloads nothing when the signature names another version", async () => {
    const asked = serve(true, SIGNATURE.replace("version:1.2.0", "version:1.1.9"));
    await expect(downloadUpdate()).rejects.toThrow("BAD_SIGNATURE");
    expect(asked.some((u) => u.endsWith(".exe"))).toBe(false);
  });
});

describe("the update installer and the download", () => {
  const PATCH_SIGNATURE = SIGNATURE.replace("version:1.2.0", "version:1.2.0\tfrom:1.1.0");
  const BODY = Buffer.from("installer bytes, long enough to be cut in two halves for the resume test");
  const DIGEST = createHash("sha256").update(BODY).digest("hex");
  let dir = "";

  /** A release with the full installer, and an update installer for `patchFor` when given. */
  function releaseWith(patchFor: string | null, patchSigned = true) {
    const asset = (name: string, extra: object = {}) => ({ name, browser_download_url: `${BASE}/${name}`, ...extra });
    const assets: any[] = [
      asset("Photos-for-Proton-Setup.exe", { digest: "sha256:" + DIGEST, size: BODY.length }),
      asset("Photos-for-Proton-Setup.exe.minisig"),
    ];
    if (patchFor) {
      assets.push(asset(`Photos-for-Proton-Update-from-${patchFor}.exe`, { digest: "sha256:" + DIGEST, size: BODY.length }));
      if (patchSigned) assets.push(asset(`Photos-for-Proton-Update-from-${patchFor}.exe.minisig`));
    }
    return [{ tag_name: "v1.2.0", published_at: "2026-10-23T00:00:00Z", body: "", assets }];
  }

  /** Serves the release, the signatures and the installer; `cut` ends the first body early. */
  function serveAll(releases: any[], opts: { cut?: boolean } = {}) {
    const asked: { url: string; range: string | null }[] = [];
    let cut = opts.cut ?? false;
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
      const range = init?.headers?.Range ?? null;
      asked.push({ url, range });
      if (url.includes("/releases?")) return new Response(JSON.stringify(releases));
      if (url.endsWith("Update-from-1.1.0.exe.minisig")) return new Response(PATCH_SIGNATURE);
      if (url.endsWith(".minisig")) return new Response(SIGNATURE);
      if (range) {
        const from = Number(/bytes=(\d+)-/.exec(range)![1]);
        return new Response(BODY.subarray(from), { status: 206 });
      }
      if (cut) {
        cut = false;
        const half = BODY.subarray(0, 20);
        const body = new ReadableStream({
          start(c) {
            c.enqueue(half);
            // Dropped once what had arrived is on disk, as a real connection drops.
            setTimeout(() => c.error(new Error("connection dropped")), 50);
          },
        });
        return new Response(body);
      }
      return new Response(BODY);
    });
    return asked;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pfp-update-test-"));
    vi.stubEnv("TEMP", dir);
    vi.stubEnv("TMP", dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes the update installer made for this version", async () => {
    vi.stubEnv("PFP_APP_VERSION", "1.1.0");
    serveAll(releaseWith("1.1.0"));
    const info = await checkUpdate();
    expect(info?.url.endsWith("Update-from-1.1.0.exe")).toBe(true);
    expect(info?.patchFrom).toBe("1.1.0");
  });

  it("takes the full installer for any other version, or an unsigned update installer", async () => {
    vi.stubEnv("PFP_APP_VERSION", "1.0.0");
    serveAll(releaseWith("1.1.0"));
    expect((await checkUpdate())?.url.endsWith("Photos-for-Proton-Setup.exe")).toBe(true);

    vi.stubEnv("PFP_APP_VERSION", "1.1.0");
    serveAll(releaseWith("1.1.0", false));
    const info = await checkUpdate();
    expect(info?.url.endsWith("Photos-for-Proton-Setup.exe")).toBe(true);
    expect(info?.patchFrom).toBeNull();
  });

  it("downloads and stages the installer beside its signature", async () => {
    vi.stubEnv("PFP_APP_VERSION", "1.1.0");
    serveAll(releaseWith("1.1.0"));
    const dest = await downloadUpdate();
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(readFileSync(`${dest}.minisig`, "utf8")).toContain("from:1.1.0");
  });

  it("picks up an interrupted download where it stopped", async () => {
    vi.stubEnv("PFP_APP_VERSION", "1.0.0");
    const asked = serveAll(releaseWith(null), { cut: true });
    await expect(downloadUpdate()).rejects.toThrow();
    const dest = await downloadUpdate();
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(asked.some((a) => a.range === "bytes=20-")).toBe(true);
  });
});
