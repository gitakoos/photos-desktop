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
import { useT } from "../lib/i18n";
import "../styles/Confirm.css";

type Props = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /**
   * For an action with no way back. Enter stops confirming and the focus rests
   * on Cancel, so the button has to be aimed at and hit deliberately.
   */
  irreversible?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Modal confirmation. It grabs keys in the capture phase and stops them there,
 * so Escape closes this dialog rather than also clearing a selection or the
 * lightbox behind it.
 */
export function Confirm({
  title,
  message,
  confirmLabel,
  danger,
  irreversible,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") onCancel();
      // Enter is a reflex on a dialog, which is fine for something the trash can
      // give back, and not fine for something nothing can.
      else if (e.key === "Enter" && !irreversible) onConfirm();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, onConfirm, irreversible]);

  return (
    <div
      className="cf-backdrop"
      onClick={(e) => {
        // Never let the click reach the lightbox or grid underneath.
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="cf-panel" role="alertdialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="cf-title">{title}</h3>
        <p className="cf-msg">{message}</p>
        <div className="cf-actions">
          <button className="cf-btn" autoFocus={irreversible} onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            className={`cf-btn ${danger ? "danger" : "primary"}`}
            autoFocus={!irreversible}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
