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
import {
  AppsIcon,
  CalendarIcon,
  CheckIcon,
  ComputerIcon,
  ContentCopyIcon,
  DevicesIcon,
  DownloadIcon,
  FaceIcon,
  FilterIcon,
  FingerprintIcon,
  FolderOpenIcon,
  LockIcon,
  OfflinePinIcon,
  SearchIcon,
  SignOutIcon,
  SwapHorizIcon,
  TuneIcon,
  UploadArrowIcon,
} from "./icons";
import { isWindows } from "../lib/platform";
import "../styles/WhatsNew.css";

/** Which "what's new" a reader has seen; a new one gets a new id. */
export const WHATS_NEW_ID = "2026-11-faces";

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

  type Item = { icon: ReactNode; title: string; body: string };
  const item = (icon: ReactNode, key: string): Item => ({
    icon,
    title: t(`whatsNew.${key}Title`),
    body: t(`whatsNew.${key}Body`),
  });
  // The Proton Photos folder and File Explorer are Windows only.
  const added: Item[] = [
    item(<FaceIcon size={20} />, "faces"),
    item(<SearchIcon size={20} />, "search"),
    item(<TuneIcon size={20} />, "ml"),
    item(<DevicesIcon size={20} />, "phone"),
    item(<SwapHorizIcon size={20} />, "faceSync"),
    item(<ContentCopyIcon size={20} />, "copyText"),
    item(<FilterIcon size={20} />, "duplicates"),
    // Behind Windows Hello on Windows, behind a password on Linux.
    { ...item(<LockIcon size={20} />, "hidden"), ...(isWindows ? {} : { body: t("whatsNew.hiddenBodyLinux") }) },
    item(<CalendarIcon size={20} />, "dates"),
    // A camera or phone over USB is picked on Windows only.
    { ...item(<UploadArrowIcon size={20} />, "addPhotos"), ...(isWindows ? {} : { body: t("whatsNew.addPhotosBodyLinux") }) },
    ...(isWindows ? [item(<OfflinePinIcon size={20} />, "keep")] : []),
    item(<AppsIcon size={20} />, "sidebar"),
    item(<SignOutIcon size={20} />, "signIn"),
    item(<ComputerIcon size={20} />, "linux"),
  ];
  const improved: Item[] = [
    ...(isWindows ? [item(<FolderOpenIcon size={20} />, "explorer")] : []),
    item(<FingerprintIcon size={20} />, "accounts"),
    item(<DownloadIcon size={20} />, "updates"),
    item(<CheckIcon size={20} />, "smallFixes"),
  ];
  const sections: { heading: string; items: Item[] }[] = [
    { heading: t("whatsNew.newHeading"), items: added },
    { heading: t("whatsNew.improvedHeading"), items: improved },
  ];

  return (
    <div className="wn-backdrop" onClick={onClose}>
      <div className="wn-card" role="dialog" aria-label={t("whatsNew.title")} onClick={(e) => e.stopPropagation()}>
        <h2 className="wn-title">{t("whatsNew.title")}</h2>
        {sections.map((section) => (
          <section className="wn-section" key={section.heading}>
            <h3 className="wn-heading">{section.heading}</h3>
            <ul className="wn-list">
              {section.items.map((entry) => (
                <li className="wn-item" key={entry.title}>
                  <span className="wn-icon">{entry.icon}</span>
                  <span className="wn-text">
                    <span className="wn-itemtitle">{entry.title}</span>
                    <span className="wn-itembody">{entry.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <button className="wn-done" onClick={onClose} autoFocus>
          {t("whatsNew.done")}
        </button>
      </div>
    </div>
  );
}
