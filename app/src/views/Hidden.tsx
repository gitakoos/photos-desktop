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

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { ContextMenu } from "../components/ContextMenu";
import { EntryGrid, type LibraryEntry } from "../components/Library";
import { LocalPasswordForm, useLocalLockKind } from "../components/LocalPassword";
import { PhotoGrid } from "../components/PhotoGrid";
import { CalendarIcon, LockIcon, VisibilityIcon } from "../components/icons";
import { SelectionBar } from "../hooks/useSelection";
import { useThumbnails } from "../hooks/useThumbnails";
import { useT } from "../lib/i18n";
import { isWindows } from "../lib/platform";
import type { Album } from "./Albums";
import "../styles/Hidden.css";

/** Whether the page is open: behind Windows Hello, or open without it where Hello is not set up. */
export type HiddenAccess = "locked" | "verified" | "unprotected";

type Verification = "verified" | "canceled" | "failed" | "unavailable";

/**
 * Hidden, as on the phone: the photos and albums hidden from everywhere else, behind the lock
 * this Windows account signs in with. Where Windows Hello is not set up it opens all the same,
 * and says it is not protected, as the phone does on a device without a lock. On Linux, where no
 * app can ask for the person's own sign-in, it asks for the local lock's password (`LocalPassword`).
 */
export function Hidden({
  access,
  onAccess,
  photos,
  albums,
  cellSize,
  cardSize,
  onOpenPhoto,
  onOpenAlbum,
  onUnhidePhotos,
  onUnhideAlbum,
  onEditDate,
}: {
  access: HiddenAccess;
  onAccess: (access: HiddenAccess) => void;
  /** The photos hidden on their own, newest first. */
  photos: { uid: string; tags?: number[] }[];
  albums: Album[];
  cellSize: number;
  cardSize: number;
  onOpenPhoto: (uid: string) => void;
  onOpenAlbum: (album: Album) => void;
  onUnhidePhotos: (uids: string[]) => void;
  onUnhideAlbum: (album: Album) => void;
  /** Opens the date editor for these photos. */
  onEditDate?: (uids: string[]) => void;
}) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; album?: Album; uid?: string } | null>(null);
  const asked = useRef(false);

  // Linux has no Windows Hello: the page asks for the local lock's password instead.
  const [lockKind] = useLocalLockKind();

  async function unlock() {
    if (asking || !isWindows) return;
    setAsking(true);
    try {
      const answer = await invoke<Verification>("hello_verify", { message: t("hidden.helloPrompt") });
      if (answer === "verified") onAccess("verified");
      else if (answer === "unavailable") onAccess("unprotected");
    } catch {
      /* stays locked; the button asks again */
    } finally {
      setAsking(false);
    }
  }

  // The prompt comes up by itself on arriving, as on the phone.
  useEffect(() => {
    if (access !== "locked" || asked.current) return;
    asked.current = true;
    void unlock();
    // Once per arrival; `unlock` reads the current state when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access]);

  const thumbs = useThumbnails(useMemo(() => (access === "locked" ? [] : photos.map((p) => p.uid)), [photos, access]));
  const entries: LibraryEntry[] = useMemo(
    () => albums.map((a) => ({ name: a.name || t("albums.untitled"), uids: [], count: a.photoCount, cover: a.coverUid, box: null, key: a.uid })),
    [albums, t],
  );

  if (access === "locked") {
    return (
      <div className="hd-lock">
        <span className="hd-lockmark" aria-hidden>
          <LockIcon size={30} />
        </span>
        <h2 className="hd-locktitle">{t("hidden.title")}</h2>
        {isWindows ? (
          <>
            <p className="hd-locktext">{t("hidden.authPrompt")}</p>
            <button className="hd-unlock" onClick={() => void unlock()} disabled={asking}>
              {t("hidden.unlock")}
            </button>
          </>
        ) : (
          lockKind && <LocalPasswordForm kind={lockKind} onDone={() => onAccess("verified")} />
        )}
      </div>
    );
  }

  const toggle = (uid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });

  return (
    <div className="hd-page">
      {access === "unprotected" && <p className="hd-note">{t("hidden.noHello")}</p>}

      {albums.length === 0 && photos.length === 0 ? (
        <div className="g-empty">
          <p className="g-empty-title">{t("hidden.emptyTitle")}</p>
          <p className="g-empty-sub">{t("hidden.emptySub")}</p>
        </div>
      ) : (
        <>
          {albums.length > 0 && (
            <section className="hd-section">
              <h3 className="hd-head">{t("hidden.albums")}</h3>
              <EntryGrid
                entries={entries}
                cardSize={cardSize}
                onOpen={(entry) => {
                  const album = albums.find((a) => a.uid === entry.key);
                  if (album) onOpenAlbum(album);
                }}
                onContext={(entry, e) => {
                  const album = albums.find((a) => a.uid === entry.key);
                  if (album) setMenu({ x: e.clientX, y: e.clientY, album });
                }}
              />
            </section>
          )}
          {photos.length > 0 && (
            <section className="hd-section">
              <h3 className="hd-head">{t("hidden.photos")}</h3>
              <PhotoGrid
                items={photos}
                thumbs={thumbs}
                cellSize={cellSize}
                selected={selected}
                onToggle={(uid) => toggle(uid)}
                onOpen={(uid) => (selected.size > 0 ? toggle(uid) : onOpenPhoto(uid))}
                onContext={(uid, e) => setMenu({ x: e.clientX, y: e.clientY, uid })}
              />
            </section>
          )}
        </>
      )}

      <SelectionBar
        count={selected.size}
        onCancel={() => setSelected(new Set())}
        onUnhide={() => {
          onUnhidePhotos([...selected]);
          setSelected(new Set());
        }}
        onEditDate={
          onEditDate
            ? () => {
                onEditDate([...selected]);
                setSelected(new Set());
              }
            : undefined
        }
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          actions={[
            {
              key: "unhide",
              label: t(menu.album ? "hidden.unhideAlbum" : "selection.unhide"),
              icon: <VisibilityIcon size={14} />,
              onSelect: () => {
                if (menu.album) onUnhideAlbum(menu.album);
                else if (menu.uid) onUnhidePhotos(selected.has(menu.uid) ? [...selected] : [menu.uid]);
                setSelected(new Set());
              },
            },
            ...(onEditDate && menu.uid && !menu.album
              ? [
                  {
                    key: "editDate",
                    label: t("selection.editDate"),
                    icon: <CalendarIcon size={14} />,
                    onSelect: () => {
                      const uid = menu.uid!;
                      onEditDate(selected.has(uid) ? [...selected] : [uid]);
                      setSelected(new Set());
                    },
                  },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}
