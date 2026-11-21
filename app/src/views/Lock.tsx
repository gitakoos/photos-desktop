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

import { useState, type FormEvent } from "react";
import { rpc } from "../lib/rpc";
import { requestSignOut } from "../lib/signOut";
import { useT } from "../lib/i18n";
import { SignOutConfirm, SignOutUnsaved } from "../components/SignOutConfirm";
import "../styles/App.css";

type UnlockResult =
  | { status: "ok"; email: string }
  | { status: "relogin" }
  | { status: "offline" }
  | { status: "error"; error: string };

/**
 * The cold-start lock screen of a vault opened by a password: the user's own one, or for an
 * account signed in before the browser sign-in, the Proton password it was signed in with.
 * The tokens are still on disk, so the password alone opens the app again.
 */
export function Lock({
  email,
  onResult,
  onDifferentAccount,
}: {
  email: string | null;
  onResult: (r: UnlockResult) => void;
  onDifferentAccount: () => void;
}) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  /** Changes that had not reached Drive when the app locked, which a sign-out from here would delete. */
  const [unsaved, setUnsaved] = useState<string[] | null>(null);

  async function onUnlock(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      const r = await rpc<UnlockResult>("unlock", { password });
      if (r.status === "error") {
        setStatus(r.error === "wrong password" ? t("lock.wrongPassword") : r.error || t("lock.failed"));
        setBusy(false);
        return;
      }
      // "ok", or "relogin" when the saved session lapsed, which only Proton's page can
      // redo. Hand it to the app, which leaves the lock screen and shows that step.
      setPassword("");
      onResult(r);
    } catch (err) {
      setStatus(String(err));
      setBusy(false);
    }
  }

  async function useDifferentAccount(discard = false) {
    setBusy(true);
    setStatus("");
    const outcome = await requestSignOut(rpc, discard);
    setBusy(false);
    // Held: the user unlocks to save them, or chooses to lose them.
    if (outcome.kind === "held") {
      setUnsaved(outcome.unsaved);
      return;
    }
    setUnsaved(null);
    if (outcome.kind === "failed") {
      setStatus(t("signOut.failed"));
      return;
    }
    setPassword("");
    onDifferentAccount();
  }

  return (
    <div className="app-content">
      <div className="login-card">
        <h1 className="login-title">Photos for Proton</h1>
        <p className="login-sub">{t("lock.subtitle")}</p>
        {email && <p className="lock-email">{email}</p>}

        <form className="login-form" onSubmit={onUnlock}>
          <label>
            <span>{t("login.passwordLabel")}</span>
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              placeholder={t("login.passwordPlaceholder")}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? t("lock.unlocking") : t("lock.unlock")}
          </button>
          <button type="button" className="link" onClick={() => setConfirmSignOut(true)} disabled={busy}>
            {t("lock.differentAccount")}
          </button>
        </form>

        {status && <p className="login-status">{status}</p>}
      </div>
      {confirmSignOut && (
        <SignOutConfirm
          onConfirm={() => {
            setConfirmSignOut(false);
            void useDifferentAccount();
          }}
          onCancel={() => setConfirmSignOut(false)}
        />
      )}
      {unsaved && (
        <SignOutUnsaved
          unsaved={unsaved}
          locked
          onRetry={() => setUnsaved(null)}
          onSignOut={() => void useDifferentAccount(true)}
          onCancel={() => setUnsaved(null)}
        />
      )}
    </div>
  );
}
