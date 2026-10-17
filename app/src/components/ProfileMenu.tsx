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

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GearIcon, PowerIcon, SignOutIcon } from "./icons";
import { useT } from "../lib/i18n";
import { isWindows } from "../lib/platform";
import "../styles/ProfileMenu.css";

export type Account = {
  email: string;
  displayName: string;
  initial: string;
  usedSpace: number;
  maxSpace: number;
};

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

/** Same thresholds as the avatar's storage arc. */
export function barColor(fraction: number): string {
  if (fraction < 0.7) return "#30d158";
  if (fraction < 0.9) return "#ff9f0a";
  return "#ff453a";
}

export function ProfileMenu({
  account,
  onClose,
  onSettings,
  onSignOut,
  placement = "topright",
}: {
  account: Account | null;
  onClose: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** Where the popover anchors: under the top-bar avatar, or above the sidebar's foot. */
  placement?: "topright" | "sidebar";
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Deferred, so the click that opened the menu does not close it again.
    const id = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const fraction = account && account.maxSpace > 0 ? account.usedSpace / account.maxSpace : 0;
  const percent = Math.round(fraction * 100);

  return (
    <div className={`pm${placement === "sidebar" ? " pm-sidebar" : ""}`} ref={ref}>
      <div className="pm-head">
        <div className="pm-circle">{account?.initial ?? "?"}</div>
        <div className="pm-id">
          <div className="pm-name">{account?.displayName ?? "…"}</div>
          <div className="pm-email">{account?.email ?? ""}</div>
        </div>
      </div>

      {account && account.maxSpace > 0 && (
        <div className="pm-storage">
          <div className="pm-storage-row">
            <span>{t("profile.storage")}</span>
            <span className="pm-dim">{percent}%</span>
          </div>
          <div className="pm-bar">
            <div
              className="pm-barfill"
              style={{ width: `${Math.min(100, percent)}%`, background: barColor(fraction) }}
            />
          </div>
          <div className="pm-storage-row pm-dim">
            <span>{t("profile.used", { size: formatBytes(account.usedSpace) })}</span>
            <span>{t("profile.total", { size: formatBytes(account.maxSpace) })}</span>
          </div>
        </div>
      )}

      <div className="pm-sep" />

      <button className="pm-item" onClick={onSettings}>
        <GearIcon size={15} />
        {t("settings.title")}
      </button>
      {/* Linux has no tray, and closing the window can leave the app running for the
          file-manager drive, so quitting for real lives here. */}
      {!isWindows && (
        <button className="pm-item" onClick={() => void invoke("quit_app")}>
          <PowerIcon size={15} />
          {t("menu.quit")}
        </button>
      )}
      <button className="pm-item danger" onClick={onSignOut}>
        <SignOutIcon size={15} />
        {t("profile.signOut")}
      </button>
    </div>
  );
}
