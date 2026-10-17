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

import { useEffect, useState, type MouseEvent, type ReactElement } from "react";
import { Avatar } from "./Avatar";
import type { Account } from "./ProfileMenu";
import type { Album } from "../views/Albums";
import {
  ChevronRightIcon,
  ChevronsLeftIcon,
  DownloadIcon,
  NavAlbumsIcon,
  NavPhotosIcon,
  NavSharedIcon,
  NavTrashIcon,
  PinIcon,
  PlusIcon,
  SpinnerIcon,
  UploadArrowIcon,
} from "./icons";
import { useThumbnails } from "../hooks/useThumbnails";
import { rpc } from "../lib/rpc";
import { useT } from "../lib/i18n";
import logo from "../assets/applogo.png";
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
  | { kind: "sync" };

const NAV: { key: View; labelKey: string; Icon: (props: { size?: number }) => ReactElement }[] = [
  { key: "photos", labelKey: "nav.photos", Icon: NavPhotosIcon },
  { key: "albums", labelKey: "nav.albums", Icon: NavAlbumsIcon },
  { key: "shared", labelKey: "nav.shared", Icon: NavSharedIcon },
  { key: "trash", labelKey: "nav.trash", Icon: NavTrashIcon },
];

/**
 * The opt-in left navigation, a widget-card that stands in for the bottom dock, the
 * top-bar upload button and the top-bar avatar at once: upload up top, the four
 * destinations under it, the account at the foot. It collapses to an icon-only rail,
 * and the caller persists that choice so it reopens the way it was left.
 *
 * The Albums row expands into the album list in place, so any album is one click away
 * without stopping at the grid first. The account button here does not carry its own
 * menu; it raises the same profile popover the top-bar avatar does (`onProfile`), which
 * the gallery re-anchors to the bottom-left so it rises just above this foot.
 */
export function Sidebar({
  view,
  onView,
  collapsed,
  onToggleCollapsed,
  account,
  email,
  activity,
  dragging,
  onProfile,
  onUpload,
  onNewAlbum,
  reloadKey,
  initialAlbums,
  openAlbumUid,
  onOpenAlbum,
  pinnedUids,
  recentUids,
  onTogglePin,
  onAlbumContext,
}: {
  view: View;
  onView: (v: View) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  account: Account | null;
  email: string;
  /** The live transfer/index/sync readout, or null when nothing is moving. */
  activity: Activity | null;
  /** A file is being dragged over the window, so the button reads as a drop target. */
  dragging: boolean;
  onProfile: () => void;
  onUpload: () => void;
  onNewAlbum: () => void;
  reloadKey: number;
  /** The album list the shell already warmed, so an expand paints at once. */
  initialAlbums: Album[] | null;
  /** Which album is open, so its row in the list can read as selected. */
  openAlbumUid: string | null;
  onOpenAlbum: (album: Album) => void;
  /** Album UIDs pinned to the top, in pin order (capped at five by the caller). */
  pinnedUids: string[];
  /** Album UIDs in most-recently-opened order, for the list below the pins. */
  recentUids: string[];
  onTogglePin: (uid: string) => void;
  /** Right-click on an album row, so the shell can open the album menu (it owns the
   *  rename, share, download and delete the menu offers). */
  onAlbumContext?: (album: Album, e: MouseEvent) => void;
}) {
  const t = useT();
  const initial = account?.initial ?? email.charAt(0).toUpperCase();
  const fraction = account && account.maxSpace > 0 ? account.usedSpace / account.maxSpace : 0;

  // The Albums row folds the album list out in place. The list is read lazily, the
  // first time it is opened, and again whenever the library changes underneath it
  // (an upload, a new album, a rename), so it never drifts from the grid's view.
  const [albumsExpanded, setAlbumsExpanded] = useState(false);
  const [albumList, setAlbumList] = useState<Album[] | null>(initialAlbums);
  useEffect(() => {
    if (!albumsExpanded || collapsed) return;
    let cancelled = false;
    void rpc<Album[]>("getAlbums")
      .then((list) => {
        if (!cancelled) setAlbumList(list);
      })
      .catch(() => {
        /* leave whatever the list already showed */
      });
    return () => {
      cancelled = true;
    };
  }, [albumsExpanded, collapsed, reloadKey]);

  // The list is a focused slice, not the whole library: up to five pinned albums, then the
  // most recently opened of the rest, capped at ten. The full grid stays one click away under
  // the Albums row. An album missing from the (possibly stale) list is simply skipped.
  const byUid = new Map((albumList ?? []).map((a) => [a.uid, a] as const));
  const pinned = pinnedUids
    .map((u) => byUid.get(u))
    .filter((a): a is Album => !!a)
    .slice(0, 5);
  const pinnedSet = new Set(pinned.map((a) => a.uid));
  const recencyRank = new Map(recentUids.map((u, i) => [u, i] as const));
  const rankOf = (uid: string) => recencyRank.get(uid) ?? Number.MAX_SAFE_INTEGER;
  const recent = (albumList ?? [])
    .filter((a) => !pinnedSet.has(a.uid))
    .sort((a, b) => rankOf(a.uid) - rankOf(b.uid))
    .slice(0, 10);
  const shown = [...pinned, ...recent];

  // Cover thumbnails for what is on show, resolved the way the Albums grid resolves them.
  // Only asked for while the list is actually open, so a collapsed rail decrypts nothing;
  // an empty set leaves the hook standing down.
  const coverUids =
    albumsExpanded && !collapsed
      ? shown.map((a) => a.coverUid).filter((u): u is string => !!u)
      : [];
  const covers = useThumbnails(coverUids);

  // One album row: the open-button plus a pin toggle at its right. Shared by both groups so
  // a pinned and a recent row are the same control, differing only in the pin's state.
  const renderAlbumRow = (a: Album, isPinned: boolean) => {
    const cover = a.coverUid ? covers[a.coverUid] : null;
    return (
      <div
        className="g-sb-subrow"
        key={a.uid}
        onContextMenu={
          onAlbumContext &&
          ((e) => {
            e.preventDefault();
            // This row's menu answers the right-click, so the shell's document
            // listener must not open its own on top of it.
            e.stopPropagation();
            onAlbumContext(a, e);
          })
        }
      >
        <button
          className={`g-sb-subitem${view === "albums" && openAlbumUid === a.uid ? " sel" : ""}`}
          onClick={() => onOpenAlbum(a)}
          title={a.name || t("albums.untitled")}
        >
          <span className="g-sb-subthumb">
            {cover ? <img src={cover} alt="" draggable={false} /> : null}
          </span>
          <span className="g-sb-subname">{a.name || t("albums.untitled")}</span>
        </button>
        <span
          className={`g-sb-pin${isPinned ? " on" : ""}`}
          role="button"
          tabIndex={0}
          title={t(isPinned ? "albums.unpin" : "albums.pin")}
          aria-label={t(isPinned ? "albums.unpin" : "albums.pin")}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(a.uid);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onTogglePin(a.uid);
            }
          }}
        >
          <PinIcon size={13} filled={isPinned} />
        </span>
      </div>
    );
  };

  // The upload button doubles as the activity readout: idle it invites an upload (and, while a file is dragged over the window, says
  // it can be dropped here); busy it shows what is moving and how far. A transfer keeps its
  // arrow, a background job spins, and the whole thing still opens the picker on a click.
  const busy = activity !== null;
  const spinning = activity?.kind === "index" || activity?.kind === "sync";
  const uploadLabel = dragging
    ? t("photos.dropTitle")
    : activity?.kind === "upload" || activity?.kind === "download"
      ? activity.label
      : activity?.kind === "index"
        ? t("sidebar.indexing")
        : activity?.kind === "sync"
          ? t("avatar.syncing")
          : t("upload.title");
  const UploadGlyph = !dragging && activity?.kind === "download" ? DownloadIcon : spinning ? SpinnerIcon : UploadArrowIcon;

  return (
    <aside className={`g-sidebar${collapsed ? " collapsed" : ""}`}>
      {/* The head doubles as a window drag handle, since the title bar steps aside in
          this layout. The logo and toggle are their own targets, so they still click. */}
      <div className="g-sb-head" data-tauri-drag-region>
        <img className="g-sb-logo" src={logo} alt="" draggable={false} />
        <span className="g-sb-brand">Photos for Proton</span>
        <button
          className="g-sb-toggle"
          onClick={onToggleCollapsed}
          title={t(collapsed ? "sidebar.expand" : "sidebar.collapse")}
          aria-label={t(collapsed ? "sidebar.expand" : "sidebar.collapse")}
        >
          <ChevronsLeftIcon size={16} />
        </button>
      </div>

      <button
        className={`g-sb-upload${busy ? " busy" : ""}${spinning ? " spin" : ""}${dragging ? " drop" : ""}`}
        onClick={onUpload}
        title={dragging ? t("photos.dropTitle") : busy ? uploadLabel : t("photos.uploadTitle")}
      >
        <span className="g-sb-ico">
          <UploadGlyph size={19} />
        </span>
        <span className="g-sb-label">{uploadLabel}</span>
        {busy && !dragging && <span className="g-sb-progress" aria-hidden />}
      </button>
      {!collapsed && !busy && !dragging && <p className="g-sb-drophint">{t("sidebar.dropHint")}</p>}

      <nav className="g-sb-nav">
        {NAV.map(({ key, labelKey, Icon }) => {
          const isAlbums = key === "albums" && !collapsed;
          const button = (
            <button
              key={key}
              className={`g-sb-item${view === key ? " sel" : ""}`}
              onClick={() => onView(key)}
              title={collapsed ? t(labelKey) : undefined}
              aria-current={view === key ? "page" : undefined}
            >
              <span className="g-sb-ico">
                <Icon size={19} />
              </span>
              <span className="g-sb-label">{t(labelKey)}</span>
              {isAlbums && (
                <span
                  className={`g-sb-caret${albumsExpanded ? " open" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={t(albumsExpanded ? "sidebar.hideAlbums" : "sidebar.showAlbums")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAlbumsExpanded((o) => !o);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      setAlbumsExpanded((o) => !o);
                    }
                  }}
                >
                  <ChevronRightIcon size={14} />
                </span>
              )}
            </button>
          );

          if (!isAlbums) return button;

          return (
            <div className="g-sb-group" key="albums-group">
              {button}
              {albumsExpanded && (
                <div className="g-sb-sublist">
                  <button className="g-sb-subitem g-sb-subnew" onClick={onNewAlbum}>
                    <span className="g-sb-subthumb g-sb-subnewbox">
                      <PlusIcon size={14} />
                    </span>
                    <span className="g-sb-subname">{t("albums.newAlbum")}</span>
                  </button>
                  {albumList === null ? (
                    <span className="g-sb-subhint">{t("common.loading")}</span>
                  ) : shown.length === 0 ? (
                    <span className="g-sb-subhint">{t("albums.none")}</span>
                  ) : (
                    <>
                      {pinned.map((a) => renderAlbumRow(a, true))}
                      {pinned.length > 0 && recent.length > 0 && <div className="g-sb-subdiv" />}
                      {recent.map((a) => renderAlbumRow(a, false))}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="g-sb-grow" />

      <div className="g-sb-foot">
        {/* Storage only here: the transfer/sync readout moved up to the upload button,
            where it is easier to catch than a ring around a small avatar. */}
        <Avatar initial={initial} storageFraction={fraction} onClick={onProfile} />
        <button className="g-sb-id" onClick={onProfile} title={t("avatar.account")}>
          <span className="g-sb-name">{account?.displayName ?? email}</span>
          <span className="g-sb-mail">{account?.email ?? email}</span>
        </button>
      </div>
    </aside>
  );
}
