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

import { useEffect, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { DownloadIcon, FaceIcon, ImageIcon, LibraryAddIcon, TuneIcon } from "./icons";
import { isWindows } from "../lib/platform";
import "../styles/WhatsNew.css";

/** Which "what's new" a reader has seen; a new one gets a new id. */
export const WHATS_NEW_ID = "2026-10-editor";

/** What this version brought, shown once, the first time the new version opens. */
export function WhatsNew({ onClose }: { onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const items: { icon: ReactNode; title: string; body: string }[] = [
    { icon: <TuneIcon size={20} />, title: t("whatsNew.editorTitle"), body: t("whatsNew.editorBody") },
    { icon: <FaceIcon size={20} />, title: t("whatsNew.facesTitle"), body: t("whatsNew.facesBody") },
    { icon: <ImageIcon size={20} />, title: t("whatsNew.viewerTitle"), body: t("whatsNew.viewerBody") },
    { icon: <LibraryAddIcon size={20} />, title: t("whatsNew.albumsTitle"), body: t("whatsNew.albumsBody") },
    // The self-updater is Windows only; the Linux build updates through Flatpak.
    ...(isWindows
      ? [
          {
            icon: <DownloadIcon size={20} />,
            title: t("whatsNew.updatesTitle"),
            body: t("whatsNew.updatesBody", { place: `${t("settings.title")} › ${t("settings.about")}` }),
          },
        ]
      : []),
  ];

  return (
    <div className="wn-backdrop" onClick={onClose}>
      <div className="wn-card" role="dialog" aria-label={t("whatsNew.title")} onClick={(e) => e.stopPropagation()}>
        <h2 className="wn-title">{t("whatsNew.title")}</h2>
        <ul className="wn-list">
          {items.map((item) => (
            <li className="wn-item" key={item.title}>
              <span className="wn-icon">{item.icon}</span>
              <span className="wn-text">
                <span className="wn-itemtitle">{item.title}</span>
                <span className="wn-itembody">{item.body}</span>
              </span>
            </li>
          ))}
        </ul>
        <button className="wn-done" onClick={onClose} autoFocus>
          {t("whatsNew.done")}
        </button>
      </div>
    </div>
  );
}
