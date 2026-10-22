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

import { useEffect, useState, type ReactElement } from "react";
import { barColor, formatBytes, type Account } from "./ProfileMenu";
import type { Tile } from "./Library";
import { ChevronRightIcon, GearIcon, MenuIcon, NavAlbumsIcon, NavPhotosIcon, NavTrashIcon, SignOutIcon } from "./icons";
import { useT } from "../lib/i18n";
import "../styles/Sidebar.css";

/** The four gallery destinations, mirrored from the bottom dock's tabs. */
export type View = "photos" | "albums" | "shared" | "trash";

/**
 * What the upload button announces while something is moving, shown in place of "Upload".
 * The transfers carry a count (`3/12`); the background jobs are their own state, no number.
 */
export type Activity =
  | { kind: "upload"; label: string }
  | { kind: "download"; label: string }
  | { kind: "index" }
  | { kind: "sync"; label?: string; why?: string };

/** The two main destinations; the library's shortcuts and the bin follow, each group set
 *  apart by a hairline. */
const NAV: { key: View; labelKey: string; Icon: (props: { size?: number }) => ReactElement }[] = [
  { key: "photos", labelKey: "nav.photos", Icon: NavPhotosIcon },
  { key: "albums", labelKey: "nav.albums", Icon: NavAlbumsIcon },
];

/**
 * The left navigation of the sidebar layout, standing in for the bottom dock, the Albums
 * tab's shortcut tiles and the top-bar avatar: the menu button that folds it, Photos and
 * Albums, the library's shortcuts (Collection, Shared, Map, People, Labels, Offline), the
 * bin, and the account at the foot. The upload lives on the top strip beside it. It folds
 * to an icon-only rail; every icon keeps its place while it does, and the words fade, so
 * the fold is one smooth move. The caller persists that choice.
 *
 * The account opens in place: it rises, and the storage, the settings and the sign-out
 * come in under it.
 */
export function Sidebar({
  view,
  onView,
  collapsed,
  onToggleCollapsed,
  account,
  email,
  library,
  librarySelected,
  onSettings,
  onSignOut,
}: {
  /** The destination shown, or null while a library shortcut's page is. */
  view: View | null;
  onView: (v: View) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  account: Account | null;
  email: string;
  /** The library's shortcuts, the Albums tab's tiles in the dock layout. */
  library: Tile[];
  /** The shortcut whose page is shown, or null. */
  librarySelected: string | null;
  onSettings: () => void;
  /** Asks first; the caller's confirmation says what signing out takes away. */
  onSignOut: () => void;
}) {
  const t = useT();
  const initial = account?.initial ?? email.charAt(0).toUpperCase();
  const fraction = account && account.maxSpace > 0 ? account.usedSpace / account.maxSpace : 0;
  const percent = Math.round(fraction * 100);

  // The account opened in place at the foot. A folded rail has no room for it, so it opens
  // the rail first; folding it again closes the account.
  const [accountOpen, setAccountOpen] = useState(false);
  useEffect(() => {
    if (collapsed) setAccountOpen(false);
  }, [collapsed]);

  /** One destination row: its icon in a fixed place, the word beside it fading with the fold. */
  const item = (
    key: string,
    icon: ReactElement,
    label: string,
    selected: boolean,
    onClick: () => void,
  ) => (
    <button
      key={key}
      className={`g-sb-item${selected ? " sel" : ""}`}
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-current={selected ? "page" : undefined}
    >
      <span className="g-sb-ico">{icon}</span>
      <span className="g-sb-label">{label}</span>
    </button>
  );

  return (
    <aside className={`g-sidebar${collapsed ? " collapsed" : ""}`}>
      <button
        className="g-sb-item g-sb-menu"
        onClick={onToggleCollapsed}
        title={t(collapsed ? "sidebar.expand" : "sidebar.collapse")}
        aria-label={t(collapsed ? "sidebar.expand" : "sidebar.collapse")}
        aria-expanded={!collapsed}
      >
        <span className="g-sb-ico">
          <MenuIcon size={18} />
        </span>
      </button>

      <nav className="g-sb-nav">
        {NAV.map(({ key, labelKey, Icon }) =>
          item(key, <Icon size={19} />, t(labelKey), view === key, () => onView(key)),
        )}

        <div className="g-sb-split" />
        {library.map((tile) =>
          item(
            tile.key,
            <span className="g-sb-libico">
              {tile.icon}
              {tile.badge && <span className="g-sb-dot" />}
            </span>,
            tile.label,
            librarySelected === tile.key,
            tile.onClick,
          ),
        )}

        <div className="g-sb-split" />
        {item("trash", <NavTrashIcon size={19} />, t("nav.trash"), view === "trash", () => onView("trash"))}
      </nav>

      <div className="g-sb-grow" />

      <div className={`g-sb-foot${accountOpen ? " open" : ""}`}>
        <button
          className="g-sb-account"
          onClick={() => {
            if (collapsed) {
              onToggleCollapsed();
              setAccountOpen(true);
            } else setAccountOpen((o) => !o);
          }}
          title={t("avatar.account")}
          aria-expanded={accountOpen}
        >
          <span className="g-sb-avatar">{initial}</span>
          <span className="g-sb-id">
            <span className="g-sb-name">{account?.displayName ?? email}</span>
            <span className="g-sb-mail">{account?.email ?? email}</span>
          </span>
          <span className="g-sb-acctcaret" aria-hidden>
            <ChevronRightIcon size={14} />
          </span>
        </button>

        {/* Under the account, opened in place: the room grows from nothing, so the account
            rises as it opens instead of a panel dropping over the page. */}
        <div className="g-sb-acctbody" aria-hidden={!accountOpen}>
          <div className="g-sb-acctinner">
            {account && account.maxSpace > 0 && (
              <div className="g-sb-storage">
                <div className="g-sb-storagerow">
                  <span>{t("profile.storage")}</span>
                  <span>{percent}%</span>
                </div>
                <div className="g-sb-bar">
                  <div
                    className="g-sb-barfill"
                    style={{ width: `${Math.min(100, percent)}%`, background: barColor(fraction) }}
                  />
                </div>
                <div className="g-sb-storagerow">
                  <span>{t("profile.used", { size: formatBytes(account.usedSpace) })}</span>
                  <span>{t("profile.total", { size: formatBytes(account.maxSpace) })}</span>
                </div>
              </div>
            )}
            <button className="g-sb-acctitem" tabIndex={accountOpen ? 0 : -1} onClick={onSettings}>
              <GearIcon size={16} />
              {t("settings.title")}
            </button>
            <button
              className="g-sb-acctitem danger"
              tabIndex={accountOpen ? 0 : -1}
              onClick={() => {
                setAccountOpen(false);
                onSignOut();
              }}
            >
              <SignOutIcon size={16} />
              {t("profile.signOut")}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
