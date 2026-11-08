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
import { LockIcon } from "./icons";
import { LocalPasswordForm, useLocalLockKind } from "./LocalPassword";
import { useT } from "../lib/i18n";
import { isWindows } from "../lib/platform";
import "../styles/Hidden.css";

type Verification = "verified" | "canceled" | "failed" | "unavailable";

/**
 * The app lock: Windows Hello before the photos show again, when the app opens and when it comes
 * back from the tray. Nothing is stored for it; Windows checks the PIN, face or fingerprint this
 * account signs in with. Where Hello is no longer set up the app opens, rather than locking its
 * owner out for good. The prompt comes up when its owner asks for it, by a click or Enter. On
 * Linux, where no app can ask for the person's own sign-in, it asks for the local lock's password.
 */
export function AppLock({ onUnlock }: { onUnlock: () => void }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [lockKind] = useLocalLockKind();

  async function unlock() {
    if (asking || !isWindows) return;
    setAsking(true);
    try {
      const answer = await invoke<Verification>("hello_verify", { message: t("appLock.prompt") });
      if (answer === "verified" || answer === "unavailable") onUnlock();
    } catch {
      /* stays locked; the button asks again */
    } finally {
      setAsking(false);
    }
  }

  // Asked for only when its owner reaches for it, a click anywhere or Enter, never by itself:
  // a prompt coming up on its own met them as the window went away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") void unlock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `unlock` reads the current state when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isWindows) {
    return (
      <div className="app-content app-lock">
        <div className="hd-lock">
          <span className="hd-lockmark" aria-hidden>
            <LockIcon size={30} />
          </span>
          <h2 className="hd-locktitle">{t("appLock.title")}</h2>
          {lockKind && <LocalPasswordForm kind={lockKind} onDone={onUnlock} />}
        </div>
      </div>
    );
  }

  return (
    <div className="app-content app-lock" onClick={() => void unlock()}>
      <div className="hd-lock">
        <span className="hd-lockmark" aria-hidden>
          <LockIcon size={30} />
        </span>
        <h2 className="hd-locktitle">{t("appLock.title")}</h2>
        <p className="hd-locktext">{t("appLock.text")}</p>
        <button
          className="hd-unlock"
          onClick={(e) => {
            e.stopPropagation();
            void unlock();
          }}
          disabled={asking}
        >
          {t("appLock.unlock")}
        </button>
      </div>
    </div>
  );
}
