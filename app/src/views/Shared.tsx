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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { downloadMessage, downloadPhotos } from "../lib/download";
import { useThumbnails } from "../hooks/useThumbnails";
import { PhotoGrid, PhotoGridSkeleton } from "../components/PhotoGrid";
import { VirtualSections } from "../components/VirtualSections";
import { Lightbox } from "../components/Lightbox";
import { ShareDialog } from "../components/ShareDialog";
import { Confirm } from "../components/Confirm";
import { ContextMenu, type MenuAction, type MenuAt } from "../components/ContextMenu";
import { DownloadIcon, ShareIcon } from "../components/icons";
import { useT } from "../lib/i18n";
import { prefetchAfter } from "../lib/previewStore";
import type { AlbumPhoto } from "./Albums";

export type SharedItem = {
  uid: string;
  name: string;
  type: string;
  mediaType: string | null;
  isShared: boolean;
  isSharedPublicly: boolean;
  captureTime: number | null;
  /** Album-only, null on a photo. The same three facts the albums screen draws from. */
  coverUid: string | null;
  photoCount: number | null;
  lastActivityTime: number | null;
};

export type Tab = "by" | "with";

/**
 * Sharing, served entirely by the SDK (`iterateSharedNodes` / `...WithMe`).
 * The by-me / with-me toggle lives in the top bar (like the other views), so the
 * active tab is controlled from above and the count is reported back up for it.
 *
 * A shared album opens here the way an own album opens on the albums screen, and
 * for the same reason: it is an album, and being shared is not a reason to draw it
 * as anything else. Its contents come from the same `getAlbumPhotos` the albums
 * screen calls, which needs nothing extra to reach across volumes because the SDK
 * takes the volume from the uid it is handed. The open album is controlled from the
 * shell, which owns the header the back button lives in.
 */
export function Shared({
  cellSize,
  tab,
  open,
  onOpenChange,
  onPhotoUids,
  initial,
  onCount,
  onData,
}: {
  cellSize: number;
  tab: Tab;
  /** The shared album being looked into, or null for the list. */
  open: SharedItem | null;
  onOpenChange: (album: SharedItem | null) => void;
  /** The open album's photo uids, lifted for the masthead's Download; [] on the list. */
  onPhotoUids?: (uids: string[]) => void;
  /** What the shell warmed for this tab, for the first paint only. */
  initial?: SharedItem[] | null;
  onCount?: (n: number | null) => void;
  /** The fresh read, so the shell's snapshot keeps up with this view. */
  onData?: (rows: SharedItem[]) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<SharedItem[]>(initial ?? []);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState("");
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [managing, setManaging] = useState<SharedItem | null>(null);
  // Right-click, and the node it landed on. Only what the user shares out can be
  // changed from here, so the with-me tab opens no menu at all.
  const [menu, setMenu] = useState<MenuAt<SharedItem> | null>(null);
  const [stopping, setStopping] = useState<SharedItem | null>(null);
  // A shared photo's own right-click menu (getting a copy out), plus its transient
  // result line. The album cards keep the manage/stop menu above; this is for photos.
  const [photoMenu, setPhotoMenu] = useState<MenuAt<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Revoking the last share drops the node off this list, so it is re-read rather
  // than patched: only the server knows what is still shared.
  const [reloadKey, setReloadKey] = useState(0);
  /** The tab `items` belong to, so only a real tab change clears them. */
  const shownTab = useRef<Tab>(tab);

  // Always re-reads, warmed or not: what the shell handed over is a first paint,
  // never the answer.
  useEffect(() => {
    let cancelled = false;
    setError("");
    // Rows belong to a tab, so switching tabs has to blank them; re-reading the
    // same tab does not, or the photos already on screen would flash away.
    if (shownTab.current !== tab) {
      shownTab.current = tab;
      setItems([]);
      setLoading(true);
    }
    setLightboxIdx(null);
    (async () => {
      try {
        const list = await rpc<SharedItem[]>("getShared", { withMe: tab === "with" });
        if (cancelled) return;
        setItems(list);
        onData?.(list);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // A brief result line (download outcome) that clears itself.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // The list splits in two, because it holds two different things: albums are drawn
  // as cards with a cover, photos as tiles. Feeding both to one photo grid is what
  // made an album a blank square, since an album node has no thumbnail of its own.
  const albums = useMemo(
    () =>
      items
        .filter((i) => i.type === "album")
        .sort((a, b) => (b.lastActivityTime ?? 0) - (a.lastActivityTime ?? 0)),
    [items],
  );
  const topPhotos = useMemo(() => items.filter((i) => i.type === "photo"), [items]);

  // Keyed on the uid rather than the object, so a re-read of the list that hands
  // down an equal-but-new album does not refetch its contents.
  const openUid = open?.uid ?? null;
  const [albumPhotos, setAlbumPhotos] = useState<AlbumPhoto[]>([]);
  const [albumLoading, setAlbumLoading] = useState(false);

  useEffect(() => {
    setLightboxIdx(null);
    // Cleared on the way in and on the way out: an album that failed to open must
    // not leave its message sitting over the list the back button returns to.
    setError("");
    if (!openUid) {
      setAlbumPhotos([]);
      setAlbumLoading(false);
      return;
    }
    let cancelled = false;
    setAlbumLoading(true);
    (async () => {
      try {
        const list = await rpc<AlbumPhoto[]>("getAlbumPhotos", { uid: openUid });
        if (cancelled) return;
        setAlbumPhotos(list);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
      if (!cancelled) setAlbumLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [openUid, reloadKey]);

  useEffect(() => {
    onPhotoUids?.(openUid ? albumPhotos.map((p) => p.uid) : []);
  }, [openUid, albumPhotos, onPhotoUids]);

  // Report the count up to the top bar (null while loading), so the header can show
  // it next to the tab toggle it owns. An open album reports its own, which is what
  // the header beside its name is counting.
  useEffect(() => {
    if (openUid) {
      onCount?.(albumLoading ? null : albumPhotos.length);
      return;
    }
    onCount?.(loading ? null : items.length);
  }, [openUid, albumLoading, albumPhotos.length, loading, items.length, onCount]);

  // What the grid and the viewer are looking at: an open album's photos, or the
  // shared photos at the top level. Only one of the two is ever on screen.
  const photos: { uid: string; name?: string; mediaType?: string | null }[] = openUid
    ? albumPhotos
    : topPhotos;

  // Covers for the cards, tiles for the photos, and neither while the other is up.
  const coverUids = useMemo(
    () => (openUid ? [] : albums.map((a) => a.coverUid).filter((u): u is string => !!u)),
    [albums, openUid],
  );
  const covers = useThumbnails(coverUids);
  const photoUids = useMemo(() => photos.map((p) => p.uid), [photos]);
  const thumbs = useThumbnails(photoUids);

  /** The same list the viewer steps through, as little of it as its strip needs. */
  const strip = useMemo(
    () =>
      photos.map((p) => ({
        uid: p.uid,
        name: p.name,
        video: (p.mediaType ?? "").startsWith("video/"),
      })),
    [photos],
  );

  useEffect(() => {
    if (lightboxIdx === null) return;
    const current = photos[lightboxIdx];
    if (!current) return;
    const near: string[] = [];
    for (let d = 1; d <= 2; d++) {
      if (photos[lightboxIdx + d]) near.push(photos[lightboxIdx + d].uid);
      if (photos[lightboxIdx - d]) near.push(photos[lightboxIdx - d].uid);
    }
    return prefetchAfter(current.uid, near);
  }, [lightboxIdx, photos]);

  function onOpen(uid: string) {
    const idx = photos.findIndex((p) => p.uid === uid);
    if (idx >= 0) setLightboxIdx(idx);
  }

  /** Nothing here is selectable, so the menu acts on what the click landed on. */
  function onCellContext(uid: string, e: { clientX: number; clientY: number }) {
    if (tab !== "by") return;
    const item = items.find((i) => i.uid === uid);
    if (item) setMenu({ x: e.clientX, y: e.clientY, target: item });
  }

  /** Ends every share on the node at once. The list refetches: only the server
   *  knows whether the node still belongs on it. */
  async function stopSharing(item: SharedItem) {
    try {
      await rpc("stopSharing", { uid: item.uid });
      reload();
    } catch (e) {
      setError(String(e));
    }
  }

  // Get a copy of one shared photo out, in whichever download mode is active: the one
  // thing a with-me recipient most needs from an open album.
  async function downloadOne(uid: string) {
    if (busy) return;
    setBusy(true);
    try {
      // Say it has started, so a large original saving to a folder is not a frozen
      // right-click. The result line below takes its place, or clears it on a cancel.
      const result = await downloadPhotos([uid], {
        onStart: () => setToast(t("download.running")),
      });
      const message = downloadMessage(result);
      setToast(message ? t(message.key, message.vars) : "");
    } catch (e) {
      setToast(String(e));
    } finally {
      setBusy(false);
    }
  }

  const photoActions: MenuAction[] = photoMenu
    ? [
        {
          key: "download",
          label: t("selection.download"),
          icon: <DownloadIcon size={14} />,
          onSelect: () => void downloadOne(photoMenu.target),
        },
      ]
    : [];

  // The dialog is where sharing is changed in detail; the menu is the short way
  // to it, plus the one action worth reaching without opening it at all.
  const actions: MenuAction[] = menu
    ? [
        {
          key: "manage",
          label: t("shared.manage"),
          icon: <ShareIcon size={14} />,
          onSelect: () => setManaging(menu.target),
        },
        {
          key: "stop",
          label: t("share.stopSharing"),
          separator: true,
          danger: true,
          onSelect: () => setStopping(menu.target),
        },
      ]
    : [];

  const current = lightboxIdx !== null ? photos[lightboxIdx] : null;

  return (
    <>
      {error && <div className="g-error">{error}</div>}

      {/* An open album shows its photos and nothing else; the list it came from is
          behind the back button the shell puts in the header. */}
      {openUid ? (
        <>
          {albumLoading && <PhotoGridSkeleton count={12} cellSize={cellSize} />}

          {!albumLoading && albumPhotos.length === 0 && !error && (
            <div className="g-empty">
              <p className="g-empty-title">{t("albums.empty")}</p>
            </div>
          )}

          {!albumLoading && albumPhotos.length > 0 && (
            <VirtualSections
              sections={[{ key: "shared-album", items: albumPhotos }]}
              cellSize={cellSize}
              grid={(_, items) => (
                <PhotoGrid
                  items={items}
                  thumbs={thumbs}
                  cellSize={cellSize}
                  onOpen={onOpen}
                  onContext={(uid, e) => setPhotoMenu({ x: e.clientX, y: e.clientY, target: uid })}
                />
              )}
            />
          )}
        </>
      ) : (
        <>
          {loading && <PhotoGridSkeleton count={12} cellSize={cellSize} />}

          {!loading && items.length === 0 && !error && (
            <div className="g-empty">
              <p className="g-empty-title">
                {tab === "by" ? t("shared.emptyByTitle") : t("shared.emptyWithTitle")}
              </p>
              <p className="g-empty-sub">
                {tab === "by" ? t("shared.emptyBySub") : t("shared.emptyWithSub")}
              </p>
            </div>
          )}

          {/* Albums lead, drawn as the albums screen draws them: a cover, a name and
              a count. The manage control is a span rather than a button because the
              card is already one, and a button inside a button is not valid markup. */}
          {!loading && albums.length > 0 && (
            <div className="g-albums">
              {albums.map((a) => (
                <button
                  className="g-album"
                  key={a.uid}
                  onClick={() => onOpenChange(a)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onCellContext(a.uid, e);
                  }}
                >
                  <div className="g-album-cover">
                    {a.coverUid && covers[a.coverUid] ? (
                      <img src={covers[a.coverUid]!} alt="" draggable={false} />
                    ) : (
                      <div className="g-cell-ph" />
                    )}
                    {a.isSharedPublicly && (
                      <div className="g-shared-badges">
                        <span className="g-badge" title={t("shared.publicLink")}>
                          🔗
                        </span>
                      </div>
                    )}
                    {tab === "by" && (
                      <span
                        className="g-shared-manage"
                        role="button"
                        tabIndex={0}
                        title={t("shared.manage")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setManaging(a);
                        }}
                      >
                        <ShareIcon size={13} />
                      </span>
                    )}
                  </div>
                  <div className="g-album-name">{a.name || t("albums.untitled")}</div>
                  <div className="g-album-count">
                    {t(
                      a.photoCount === 1 ? "common.photoCount.one" : "common.photoCount.other",
                      { count: a.photoCount ?? 0 },
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {!loading && topPhotos.length > 0 && (
            <VirtualSections
              className="g-grid-after-albums"
              sections={[{ key: "shared-photos", items: topPhotos }]}
              cellSize={cellSize}
              grid={(_, items) => (
                <PhotoGrid
                  items={items}
                  thumbs={thumbs}
                  cellSize={cellSize}
                  onOpen={onOpen}
                  onContext={(uid, e) =>
                    tab === "with"
                      ? setPhotoMenu({ x: e.clientX, y: e.clientY, target: uid })
                      : onCellContext(uid, e)
                  }
                  showBadges={false}
                  showName
                  renderOverlay={(item) => {
                    const it = topPhotos.find((i) => i.uid === item.uid);
                    if (!it) return null;
                    return (
                      <>
                        {it.isSharedPublicly && (
                          <div className="g-shared-badges">
                            <span className="g-badge" title={t("shared.publicLink")}>
                              🔗
                            </span>
                          </div>
                        )}
                        {/* Only what the user shares out is theirs to change. */}
                        {tab === "by" && (
                          <button
                            className="g-shared-manage"
                            title={t("shared.manage")}
                            onClick={(e) => {
                              e.stopPropagation();
                              setManaging(it);
                            }}
                          >
                            <ShareIcon size={13} />
                          </button>
                        )}
                      </>
                    );
                  }}
                />
              )}
            />
          )}
        </>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} actions={actions} onClose={() => setMenu(null)} />
      )}

      {photoMenu && (
        <ContextMenu
          x={photoMenu.x}
          y={photoMenu.y}
          actions={photoActions}
          onClose={() => setPhotoMenu(null)}
        />
      )}

      {toast && <div className="g-toast">{toast}</div>}

      {managing && (
        <ShareDialog
          uid={managing.uid}
          title={managing.name}
          onClose={() => setManaging(null)}
          onChanged={reload}
        />
      )}

      {stopping && (
        <Confirm
          title={t("confirm.stopSharingTitle")}
          message={t("confirm.stopSharingMessage")}
          confirmLabel={t("confirm.stopSharingConfirm")}
          danger
          onCancel={() => setStopping(null)}
          onConfirm={() => {
            const item = stopping;
            setStopping(null);
            void stopSharing(item);
          }}
        />
      )}

      {current && (
        <Lightbox
          uid={current.uid}
          fallbackUrl={thumbs[current.uid] ?? null}
          items={strip}
          index={lightboxIdx!}
          onJump={setLightboxIdx}
          hasPrev={lightboxIdx! > 0}
          hasNext={lightboxIdx! < photos.length - 1}
          onPrev={() => setLightboxIdx((i) => (i === null ? i : Math.max(0, i - 1)))}
          onNext={() =>
            setLightboxIdx((i) => (i === null ? i : Math.min(photos.length - 1, i + 1)))
          }
          onClose={() => setLightboxIdx(null)}
          // Whichever list is on screen is the one the photo left, so only that one
          // is patched. Patching the shared list while an album is open would drop a
          // row nothing is showing and leave the open album still holding the photo.
          onTrashed={(uid) => {
            if (openUid) setAlbumPhotos((prev) => prev.filter((p) => p.uid !== uid));
            else setItems((prev) => prev.filter((i) => i.uid !== uid));
            setLightboxIdx(null);
          }}
          onRenamed={(uid, name) => {
            if (openUid) return; // an album listing carries no name to patch
            setItems((prev) => prev.map((i) => (i.uid === uid ? { ...i, name } : i)));
          }}
          // A shared photo is read through a share-scoped path the editor's source does
          // not take, so editing (which saves a copy to this account) is left off here.
          editable={false}
        />
      )}
    </>
  );
}
