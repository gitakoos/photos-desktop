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

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { rpc } from "../lib/rpc";
import { useT } from "../lib/i18n";
import "../styles/Confirm.css";
import "../styles/LocalPassword.css";
import { backdropClose } from "../lib/backdrop";

/**
 * What Hidden and the app lock ask for where no Windows Hello answers (Linux): the password the
 * app opens with, a password set for them alone, or nothing set yet.
 */
export type LocalLockKind = "vault" | "own" | "none";

/** The shortest password taken, as the app password. */
export const LOCAL_LOCK_MIN = 8;

/** The local lock's kind, read from the sidecar, and a way to read it again after a change. */
export function useLocalLockKind(): [LocalLockKind | null, () => void] {
  const [kind, setKind] = useState<LocalLockKind | null>(null);
  const refresh = useCallback(() => {
    void rpc<{ kind: LocalLockKind }>("localLockState")
      .then((s) => setKind(s.kind))
      .catch(() => setKind(null));
  }, []);
  useEffect(refresh, [refresh]);
  return [kind, refresh];
}

/** Whether `password` opens the local lock. */
export async function checkLocalPassword(password: string): Promise<boolean> {
  return rpc<{ ok: boolean }>("localLockCheck", { password })
    .then((r) => r.ok)
    .catch(() => false);
}

/**
 * The form that asks for the local lock's password, or sets one where none is set yet, or with
 * `change` changes the one set. `onDone` is called once the password was right or was saved.
 */
export function LocalPasswordForm({
  kind,
  change = false,
  confirmLabel,
  onDone,
  onCancel,
}: {
  kind: LocalLockKind;
  change?: boolean;
  /** The button's word where the password confirms a change rather than opening a lock. */
  confirmLabel?: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const setting = kind === "none" || change;
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!setting) {
      if (!password) return;
      setBusy(true);
      const ok = await checkLocalPassword(password);
      setBusy(false);
      if (ok) onDone();
      else {
        setError(t("localLock.wrong"));
        setPassword("");
      }
      return;
    }
    if (password.length < LOCAL_LOCK_MIN) return setError(t("protect.tooShort", { n: LOCAL_LOCK_MIN }));
    if (password !== repeat) return setError(t("protect.mismatch"));
    setBusy(true);
    const saved = await rpc<{ ok: boolean }>("localLockSet", { password, current: change ? current : undefined })
      .then((r) => r.ok)
      .catch(() => false);
    setBusy(false);
    if (saved) onDone();
    else setError(t(change ? "localLock.wrong" : "localLock.notSaved"));
  }

  return (
    <form className="lp-form" onSubmit={(e) => void submit(e)}>
      <p className="lp-text">
        {t(setting ? "localLock.setText" : kind === "vault" ? "localLock.enterVault" : "localLock.enterOwn")}
      </p>
      {change && (
        <label className="lp-field">
          <span>{t("localLock.current")}</span>
          <input
            className="lp-input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={current}
            onChange={(e) => setCurrent(e.currentTarget.value)}
          />
        </label>
      )}
      <label className="lp-field">
        <span>{t(setting ? "localLock.newPassword" : "localLock.password")}</span>
        <input
          className="lp-input"
          type="password"
          autoComplete={setting ? "new-password" : "current-password"}
          autoFocus={!change}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </label>
      {setting && (
        <label className="lp-field">
          <span>{t("protect.repeatPassword")}</span>
          <input
            className="lp-input"
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.currentTarget.value)}
          />
        </label>
      )}
      {error && <p className="lp-error">{error}</p>}
      <div className="lp-actions">
        {onCancel && (
          <button type="button" className="lp-secondary" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        )}
        <button type="submit" className="lp-primary" disabled={busy}>
          {setting ? t("localLock.save") : (confirmLabel ?? t("localLock.unlock"))}
        </button>
      </div>
    </form>
  );
}

/** The form over the page, for Settings: Escape and a click outside cancel it. */
export function LocalPasswordDialog({
  title,
  kind,
  change = false,
  onDone,
  onCancel,
}: {
  title: string;
  kind: LocalLockKind;
  change?: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div
      className="cf-backdrop"
      {...backdropClose(onCancel)}
    >
      <div className="cf-panel lp-panel" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3 className="cf-title">{title}</h3>
        <LocalPasswordForm
          kind={kind}
          change={change}
          confirmLabel={t("protect.continue")}
          onDone={onDone}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}
