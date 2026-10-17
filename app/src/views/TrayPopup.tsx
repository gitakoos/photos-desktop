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

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LockIcon, OpenWindowIcon, PowerIcon, RefreshIcon, SignOutIcon } from "../components/icons";
import { rpc } from "../lib/rpc";
// Reuse the profile menu's account shape, storage formatting and header styles
// so the popup header is identical to the one inside the main window.
import { barColor, formatBytes, type Account } from "../components/ProfileMenu";
import { useT } from "../lib/i18n";
import "../styles/ProfileMenu.css";
import "../styles/TrayPopup.css";

/** Whether a saved account exists and whether it is unlocked (see the sidecar's `lockStatus`). */
type LockStatus = { hasVault: boolean; unlocked: boolean; email: string | null };

/**
 * The popup's account header resolves to exactly one of these. `loading` is the
 * brief first paint before the auth state is known; the other three are the
 * definite outcomes. There is deliberately no perpetual spinner: a locked or
 * signed-out account is a settled state, not a pending one.
 */
type AuthView =
  | { kind: "loading" }
  | { kind: "signedIn"; account: Account }
  | { kind: "locked"; email: string | null }
  | { kind: "signedOut" };

/**
 * A stand-in account for when the identity is known (the vault is unlocked) but
 * the Drive figures have not arrived yet. `maxSpace: 0` hides the storage bar, so
 * the header shows who is signed in without implying that anything is still loading.
 */
function accountFromEmail(email: string): Account {
  return {
    email,
    displayName: email,
    initial: (email.trim()[0] ?? "?").toUpperCase(),
    usedSpace: 0,
    maxSpace: 0,
  };
}

/**
 * The system-tray menu. Rendered (instead of <App/>) into the transparent,
 * frameless "tray_popup" window. The page body is transparent; this card is the
 * only visible surface, so it carries the rounded corners, border and shadow.
 */
export function TrayPopup() {
  const t = useT();
  const [view, setView] = useState<AuthView>({ kind: "loading" });
  const [syncing, setSyncing] = useState(false);
  // Only the newest refresh may commit: a stale in-flight one (e.g. a slow
  // getAccountInfo left over from a previous open) must not overwrite the current
  // state, or a just-switched account could flash back to the old one.
  const runSeq = useRef(0);

  // Derive the header from the real auth state instead of a single account fetch,
  // so the popup always lands on one of the three definite outcomes. The popup
  // window is created before sign-in, so this runs on mount AND every time the
  // tray reopens (the host emits "tray-shown" on show); the latter is what keeps
  // it in step after a lock, unlock, sign-out or account switch made elsewhere.
  const refresh = useCallback(async () => {
    const seq = ++runSeq.current;
    const stale = () => seq !== runSeq.current;

    let status: LockStatus;
    try {
      status = await rpc<LockStatus>("lockStatus");
    } catch {
      // The sidecar is momentarily unreachable. Never strand the popup on the
      // loading skeleton: the first, never-resolved load settles on the neutral
      // signed-out placeholder, while a later blip keeps the state already shown.
      setView((prev) => (prev.kind === "loading" ? { kind: "signedOut" } : prev));
      return;
    }
    if (stale()) return;

    if (!status.hasVault) {
      setView({ kind: "signedOut" });
      return;
    }
    if (!status.unlocked) {
      setView({ kind: "locked", email: status.email });
      return;
    }

    // Unlocked: show the current identity at once so a previous account can never
    // linger, but keep a matching one intact so its storage bar does not flicker.
    // Then fill in the Drive figures.
    const email = status.email ?? "";
    setView((prev) =>
      prev.kind === "signedIn" && prev.account.email === email
        ? prev
        : { kind: "signedIn", account: accountFromEmail(email) },
    );
    try {
      const info = await rpc<Account>("getAccountInfo");
      if (!stale()) setView({ kind: "signedIn", account: info });
    } catch {
      // Unlocked, but the storage lookup failed: keep the identity shell. The bar
      // stays hidden rather than showing a spinner that would never resolve here.
    }
  }, []);

  useEffect(() => {
    void refresh();
    // On each open the host emits "tray-shown": re-derive, and pull focus so the
    // very first click outside dismisses it (Windows will not focus it on show).
    const unlisten = listen("tray-shown", () => {
      void refresh();
      void getCurrentWindow().setFocus();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [refresh]);

  // Live sync status. Seed it from the host on open (the mount may already be
  // busy), then follow the "mount-busy" transitions the host emits.
  useEffect(() => {
    let cancelled = false;
    async function loadBusy() {
      try {
        const b = await invoke<boolean>("sync_busy");
        if (!cancelled) setSyncing(b);
      } catch {
        /* ignore */
      }
    }
    void loadBusy();
    const unBusy = listen<boolean>("mount-busy", (e) => setSyncing(!!e.payload));
    const unShown = listen("tray-shown", () => void loadBusy());
    return () => {
      cancelled = true;
      void unBusy.then((f) => f());
      void unShown.then((f) => f());
    };
  }, []);

  // Dismiss on click-outside: losing window focus hides the popup.
  useEffect(() => {
    function onBlur() {
      void invoke("hide_tray_popup");
    }
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // Escape dismisses the popup, matching every other transient surface.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") void invoke("hide_tray_popup");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function openMain() {
    await invoke("open_main_from_tray").catch(() => {});
  }

  async function syncNow() {
    setSyncing(true); // optimistic; the host confirms via "mount-busy"
    // Bounded refresh: syncs only the albums kept offline and reloads the view. It
    // never bulk-downloads the whole library.
    await invoke("sync_now").catch(() => {});
  }

  async function signOut() {
    await rpc("signOut").catch(() => {});
    await emit("tray-signout").catch(() => {});
    await invoke("hide_tray_popup").catch(() => {});
  }

  async function quit() {
    await invoke("quit_app").catch(() => {});
  }

  const account = view.kind === "signedIn" ? view.account : null;
  const fraction = account && account.maxSpace > 0 ? account.usedSpace / account.maxSpace : 0;
  const percent = Math.round(fraction * 100);

  return (
    <div className="tray-root">
      <div className="tray-card">
        <div className="pm-head">
          <div className="pm-circle">
            {view.kind === "signedIn" ? (
              view.account.initial
            ) : view.kind === "locked" ? (
              <LockIcon size={18} />
            ) : (
              "?"
            )}
          </div>
          <div className="pm-id">
            {view.kind === "loading" ? (
              <>
                <div className="tray-skeleton tray-skeleton-name" />
                <div className="tray-skeleton tray-skeleton-email" />
              </>
            ) : view.kind === "signedIn" ? (
              <>
                <div className="pm-name">{view.account.displayName}</div>
                <div className="pm-email">{view.account.email}</div>
              </>
            ) : view.kind === "locked" ? (
              <>
                <div className="pm-name">{view.email ?? t("tray.locked")}</div>
                <div className="pm-email">{view.email ? t("tray.locked") : t("tray.lockedHint")}</div>
              </>
            ) : (
              <>
                <div className="pm-name">{t("tray.signedOut")}</div>
                <div className="pm-email">{t("tray.signedOutHint")}</div>
              </>
            )}
          </div>
        </div>

        {view.kind === "loading" ? (
          <div className="pm-storage">
            <div className="pm-storage-row">
              <span className="pm-dim">{t("profile.storage")}</span>
            </div>
            <div className="pm-bar">
              <div className="tray-skeleton tray-skeleton-bar" />
            </div>
          </div>
        ) : account && account.maxSpace > 0 ? (
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
        ) : null}

        <div className="pm-sep" />

        <div className="tray-status" role="status" aria-live="polite">
          <span className={`tray-dot${syncing ? " on" : ""}`} aria-hidden="true" />
          <span>{syncing ? t("tray.syncing") : t("tray.synced")}</span>
        </div>
        <button className="tray-row" onClick={syncNow} disabled={syncing}>
          <span className={syncing ? "tray-spin" : undefined}>
            <RefreshIcon size={16} />
          </span>
          <span>{t("tray.syncNow")}</span>
        </button>

        <button className="tray-row" onClick={openMain}>
          <OpenWindowIcon size={16} />
          <span>{t("tray.open")}</span>
        </button>
        <button className="tray-row" onClick={signOut}>
          <SignOutIcon size={16} />
          <span>{t("profile.signOut")}</span>
        </button>
        <button className="tray-row danger" onClick={quit}>
          <PowerIcon size={16} />
          <span>{t("menu.quit")}</span>
        </button>
      </div>
    </div>
  );
}
