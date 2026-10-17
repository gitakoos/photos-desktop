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

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { rpc } from "../lib/rpc";
import { useT } from "../lib/i18n";
import { isWindows } from "../lib/platform";
import { CloseIcon } from "./icons";
import "../styles/UpdateBanner.css";

// Only what the banner shows. The download URL and digest deliberately stay on the
// sidecar side: it re-reads them from GitHub when installing, so nothing this
// window holds can redirect the updater or skip its hash check.
type Info = { tag: string; version: string; notes: string; size: number };

/**
 * Is `latest` a newer version than `current`? Numeric major.minor.patch first,
 * then a final release beats a prerelease of the same numbers, then the prerelease
 * label lexically ("0.1.0" > "0.1.0-beta" > "0.1.0-alpha").
 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre = ""] = v.split("-", 2);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre };
  };
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const x = a.nums[i] ?? 0;
    const y = b.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  if (a.pre === b.pre) return false;
  if (a.pre === "") return true; // a final release beats any prerelease
  if (b.pre === "") return false;
  return a.pre > b.pre;
}

/** A thin banner offering the update when the GitHub release is newer than us. */
export function UpdateBanner() {
  const t = useT();
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // The Linux (Flatpak) build is updated through Flatpak, so it never checks for or
    // offers an in-app update: the self-updater downloads a Windows installer.
    if (!isWindows) return;
    // A short delay so the check does not compete with the startup session restore.
    const id = setTimeout(async () => {
      try {
        const current = await getVersion();
        const latest = await rpc<Info | null>("checkUpdate");
        if (latest && isNewer(latest.version, current)) setInfo(latest);
      } catch {
        /* offline, or the repo is not public yet — simply no banner */
      }
    }, 2500);
    return () => clearTimeout(id);
  }, []);

  if (!info || dismissed) return null;

  async function update() {
    if (!info) return;
    setBusy(true);
    setError("");
    try {
      await rpc<string>("downloadUpdate");
      await invoke("run_updater"); // the app exits here; the installer takes over
    } catch (e) {
      const msg = String(e);
      const bad = msg.includes("HASH_MISMATCH") || msg.includes("NO_DIGEST") || msg.includes("BAD_ORIGIN");
      setError(bad ? t("update.hashError") : t("update.failed"));
      setBusy(false);
    }
  }

  return (
    <div className="upd-banner">
      <span className="upd-text">
        {t("update.available", { version: info.version })}
        {error && <span className="upd-error"> · {error}</span>}
      </span>
      <span className="upd-actions">
        <button className="upd-btn" onClick={update} disabled={busy}>
          {busy ? t("update.updating") : t("update.now")}
        </button>
        <button className="upd-x" onClick={() => setDismissed(true)} title={t("common.close")}>
          <CloseIcon size={12} />
        </button>
      </span>
    </div>
  );
}
