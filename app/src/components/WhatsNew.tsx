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

import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import {
  BackupIcon,
  CheckIcon,
  CollageIcon,
  CollectionsIcon,
  CompressIcon,
  ComputerIcon,
  FilmstripIcon,
  FolderOpenIcon,
  InfoIcon,
  LabelIcon,
  PlaceIcon,
  ScheduleIcon,
  SignOutIcon,
  SlideshowIcon,
  SortIcon,
  TrashIcon,
  UploadArrowIcon,
  VisibilityOffIcon,
} from "./icons";
import { isMac, isWindows } from "../lib/platform";
import { whatsNewSections, type WhatsNewIcon } from "../lib/whatsNewCards";
import { backdropClose } from "../lib/backdrop";
import "../styles/WhatsNew.css";

/** Which "what's new" a reader has seen; a new one gets a new id. */
export const WHATS_NEW_ID = "2026-11-1.4.0";

const ICONS: Record<WhatsNewIcon, ReactNode> = {
  video: <FilmstripIcon size={20} />,
  collage: <CollageIcon size={20} />,
  slideshow: <SlideshowIcon size={20} />,
  details: <InfoIcon size={20} />,
  label: <LabelIcon size={20} />,
  sort: <SortIcon size={20} />,
  place: <PlaceIcon size={20} />,
  compress: <CompressIcon size={20} />,
  hide: <VisibilityOffIcon size={20} />,
  themes: <CollectionsIcon size={20} />,
  backup: <BackupIcon size={20} />,
  import: <UploadArrowIcon size={20} />,
  folder: <FolderOpenIcon size={20} />,
  computer: <ComputerIcon size={20} />,
  signOut: <SignOutIcon size={20} />,
  trash: <TrashIcon size={20} />,
  speed: <ScheduleIcon size={20} />,
  check: <CheckIcon size={20} />,
};

/** What this version brought, shown once, the first time the new version opens. */
export function WhatsNew({ onClose }: { onClose: () => void }) {
  const t = useT();
  const done = useRef<HTMLButtonElement>(null);
  // autoFocus would scroll a long list to its end, past the title and the first cards.
  useEffect(() => done.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sections = whatsNewSections(isWindows ? "windows" : isMac ? "mac" : "linux").map((section) => ({
    heading: t(section.heading),
    items: section.cards.map((card) => ({ icon: ICONS[card.icon], title: t(card.title), body: t(card.body) })),
  }));

  return (
    <div className="wn-backdrop" {...backdropClose(onClose, false)}>
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
        <button className="wn-done" ref={done} onClick={onClose}>
          {t("whatsNew.done")}
        </button>
      </div>
    </div>
  );
}
