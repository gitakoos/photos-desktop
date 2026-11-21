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

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Confirm } from "./Confirm";
import { SpinnerIcon } from "./icons";
import { useLang, useT } from "../lib/i18n";
import { isMac, isWindows } from "../lib/platform";
import "../styles/Confirm.css";

/**
 * The question before signing out, which says what goes and what stays: signing out
 * empties everything the app keeps on this PC, and nothing of it can be brought back
 * except by downloading it again.
 */
export function SignOutConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  return (
    <Confirm
      title={t("signOut.title")}
      message={t(isWindows ? "signOut.message" : isMac ? "signOut.messageMac" : "signOut.messageLinux")}
      confirmLabel={t("profile.signOut")}
      danger
      irreversible
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** The kinds of change a sign-out would delete, in the order the message names them. */
const KINDS = ["labels", "hidden", "faces", "settings", "albumOrder"];

/**
 * The wait while what sign-out deletes goes to Proton Drive. Cancel stops waiting and keeps the
 * account signed in; the save goes on by itself.
 */
export function SignOutSaving({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return createPortal(
    <div className="cf-backdrop">
      <div className="cf-panel" role="alertdialog" aria-busy="true">
        <h3 className="cf-title">{t("signOut.title")}</h3>
        <p className="cf-saving">
          <span className="cf-spin" aria-hidden>
            <SpinnerIcon size={18} />
          </span>
          {t("signOut.saving")}
        </p>
        <div className="cf-actions">
          <button className="cf-btn" autoFocus onClick={onCancel}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * What the save before a sign-out could not do: `unsaved` names the kinds not on Drive, an empty
 * list a save still under way. Signing out anyway is the user's choice, never the default.
 */
export function SignOutUnsaved({
  unsaved,
  locked = false,
  onRetry,
  onSignOut,
  onCancel,
}: {
  unsaved: string[];
  /** On the lock screen nothing can be saved: unlocking first is the way to keep the changes. */
  locked?: boolean;
  onRetry: () => void;
  onSignOut: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const { lang } = useLang();
  if (unsaved.length === 0 && !locked) {
    return (
      <Confirm
        title={t("signOut.slowTitle")}
        message={t("signOut.slowMessage")}
        confirmLabel={t("signOut.anyway")}
        altLabel={t("signOut.keepWaiting")}
        onAlt={onRetry}
        danger
        irreversible
        onConfirm={onSignOut}
        onCancel={onCancel}
      />
    );
  }
  const names = KINDS.filter((k) => unsaved.includes(k)).map((k) => t(`signOut.kind.${k}`));
  let list: string;
  try {
    // WebView2 and WebKitGTK both have it; the TypeScript lib this app builds against does not.
    const ListFormat = (Intl as unknown as { ListFormat: new (l: string, o: { type: string }) => { format: (x: string[]) => string } }).ListFormat;
    list = new ListFormat(lang, { type: "conjunction" }).format(names);
  } catch {
    list = names.join(", ");
  }
  return (
    <Confirm
      title={t("signOut.unsavedTitle")}
      message={t(locked ? "signOut.unsavedLockedMessage" : "signOut.unsavedMessage", { list })}
      confirmLabel={t("signOut.anyway")}
      altLabel={locked ? undefined : t("signOut.tryAgain")}
      onAlt={locked ? undefined : onRetry}
      danger
      irreversible
      onConfirm={onSignOut}
      onCancel={onCancel}
    />
  );
}
