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

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { barColor, formatBytes, type Account } from "./ProfileMenu";
import { ChevronDownIcon, ChevronRightIcon, GearIcon, MenuIcon, SignOutIcon } from "./icons";
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

/** One row of the sidebar: a page, its icon, and whether it is the one shown. */
export type SidebarEntry = {
  key: string;
  label: string;
  icon: ReactNode;
  selected: boolean;
  onClick: () => void;
  /** A dot over the icon, as over Shared while an invitation waits. */
  badge?: boolean;
};

/** A titled group of rows: Photos, Collections, Utilities. */
export type SidebarSection = { key: string; title: string; entries: SidebarEntry[] };

const CLOSED_KEY = "pfp.sidebar.closedSections";

function readClosed(): Set<string> {
  try {
    const raw = localStorage.getItem(CLOSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/**
 * The left navigation of the sidebar layout, standing in for the bottom dock, the Albums
 * tab's shortcut tiles and the top-bar avatar: the menu button that folds it, the pages in
 * titled groups (Photos, Collections, Utilities), and the account at the foot. A group's
 * title folds its rows away, and that stays on this computer. The upload lives on the top
 * strip beside it. The sidebar folds to an icon-only rail; every icon keeps its place while
 * it does, and the words fade, so the fold is one smooth move. The caller persists that choice.
 *
 * The account opens in place: the storage, the settings and the sign-out come up under it,
 * the account and its rows rising together from the foot as one block. A click elsewhere or
 * Escape closes it.
 */
export function Sidebar({
  sections,
  collapsed,
  onToggleCollapsed,
  account,
  email,
  onSettings,
  onSignOut,
}: {
  sections: SidebarSection[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  account: Account | null;
  email: string;
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
  const [closed, setClosed] = useState<Set<string>>(readClosed);
  const toggleSection = (key: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
      } catch {
        /* folded for this session only */
      }
      return next;
    });
  useEffect(() => {
    if (collapsed) setAccountOpen(false);
  }, [collapsed]);
  const footRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Whether the rows are laid out. Closing keeps them until the block has slid back down.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (accountOpen) setShown(true);
  }, [accountOpen]);
  // One move each way: the foot, account and rows together, slides up by the rows' height
  // as they appear, and back down before they go. The sidebar clips what is below it.
  useLayoutEffect(() => {
    const foot = footRef.current;
    const body = bodyRef.current;
    if (!foot || !body || !shown) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lift = `translateY(${body.offsetHeight}px)`;
    if (accountOpen) {
      if (!still) foot.animate([{ transform: lift }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
      return;
    }
    if (still) {
      setShown(false);
      return;
    }
    // Held at the bottom when it ends, until the rows are gone in the same frame as it lets go.
    const move = foot.animate([{ transform: "none" }, { transform: lift }], {
      duration: 170,
      easing: "cubic-bezier(0.4, 0, 1, 1)",
      fill: "forwards",
    });
    move.onfinish = () => setShown(false);
    return () => move.cancel();
  }, [accountOpen, shown]);
  useEffect(() => {
    if (!accountOpen) return;
    const away = (e: PointerEvent) => {
      if (!footRef.current?.contains(e.target as Node)) setAccountOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAccountOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  }, [accountOpen]);

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
        {sections.map((section, i) => {
          // A folded rail has no room for titles: a hairline parts the groups, and every row shows.
          const open = collapsed || !closed.has(section.key);
          return (
            <div key={section.key} className="g-sb-section">
              {collapsed ? (
                i > 0 && <div className="g-sb-split" />
              ) : (
                <button className="g-sb-head" onClick={() => toggleSection(section.key)} aria-expanded={open}>
                  <span>{section.title}</span>
                  {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                </button>
              )}
              {open &&
                section.entries.map((entry) =>
                  item(
                    entry.key,
                    <span className="g-sb-libico">
                      {entry.icon}
                      {entry.badge && <span className="g-sb-dot" />}
                    </span>,
                    entry.label,
                    entry.selected,
                    entry.onClick,
                  ),
                )}
            </div>
          );
        })}
      </nav>

      <div className="g-sb-grow" />

      <div ref={footRef} className={`g-sb-foot${accountOpen ? " open" : ""}${shown ? " shown" : ""}`}>
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

        {/* Under the account, opened in place. */}
        <div ref={bodyRef} className="g-sb-acctbody" aria-hidden={!accountOpen}>
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
