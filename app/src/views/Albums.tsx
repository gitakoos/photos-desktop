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

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { rpc } from "../lib/rpc";
import { downloadMessage, downloadPhotos, explorerMode, type SaveProgress } from "../lib/download";
import { pinOffline, unpinOffline } from "../lib/offline";
import { DownloadProgress } from "../components/DownloadProgress";
import { useThumbnails } from "../hooks/useThumbnails";
import { filterAlbums } from "../lib/albumSearch";
import { PhotoGrid, PhotoGridSkeleton } from "../components/PhotoGrid";
import { VirtualSections } from "../components/VirtualSections";
import { Marquee, SelectionBar, useSelection } from "../hooks/useSelection";
import { Lightbox } from "../components/Lightbox";
import { Confirm } from "../components/Confirm";
import { ContextMenu, type MenuAction, type MenuAt } from "../components/ContextMenu";
import { AlbumFreeUpDialog, AlbumPicker, NameDialog } from "../components/AlbumDialogs";
import { ShareDialog } from "../components/ShareDialog";
import {
  CloudIcon,
  DownloadIcon,
  FolderOpenIcon,
  HeartIcon,
  LibraryAddIcon,
  LibraryRemoveIcon,
  OfflinePinIcon,
  ShareIcon,
  TrashIcon,
} from "../components/icons";
import { useT } from "../lib/i18n";
import { dropPreview, prefetchAfter } from "../lib/previewStore";

const PREFETCH_RADIUS = 2;

export type Album = {
  uid: string;
  name: string;
  photoCount: number;
  coverUid: string | null;
  lastActivityTime: number;
};
/** How the album grid is ordered: the server's last-activity order, by name, or by size. */
export type AlbumSort = "activity" | "name" | "count";
export type AlbumPhoto = { uid: string; captureTime: number };

/**
 * Albums, served entirely by the SDK (`iterateAlbums` / `iterateAlbum`).
 * The open album is controlled from above so its header can live in the top bar,
 * which is also where renaming and deleting it are offered.
 */
export function Albums({
  cellSize,
  albumCellSize = 190,
  open,
  onOpenChange,
  localUids,
  offlineUids,
  reloadKey,
  initial,
  onCount,
  onChanged,
  onAlbumContext,
  onData,
  onPhotoUids,
  query = "",
  sort = "activity",
  favoriteUids,
  onFavoriteChanged,
}: {
  cellSize: number;
  /** The album LIST card min-width in px, from the shell's album zoom (Ctrl+wheel). */
  albumCellSize?: number;
  open: Album | null;
  onOpenChange: (album: Album | null) => void;
  /** Photos currently downloaded, for the per-photo cloud badge. */
  localUids: Set<string>;
  /** The app's own encrypted copies, which are not the Explorer ones. */
  offlineUids: Set<string>;
  reloadKey: number;
  /** The album list the shell warmed, for the first paint only. */
  initial?: Album[] | null;
  /** The fresh read, so the shell's snapshot keeps up with this view. */
  onData?: (rows: Album[]) => void;
  /** The open album's live photo count, for the header (null while loading). */
  onCount?: (count: number | null) => void;
  /** Album membership moved, so the timeline may owe the user a redraw. */
  onChanged?: () => void;
  /** Right-click on an album in the list. The shell owns the menu, because it
   *  owns the rename and delete the menu offers. */
  onAlbumContext?: (album: Album, e: MouseEvent) => void;
  /** The open album's photo uids, lifted so the shell's top-bar Download can act on
   *  the whole album. Reported as the album loads, and cleared to [] on the list. */
  onPhotoUids?: (uids: string[]) => void;
  /** The album-list search query (filters by name) and the sort order, owned by the shell. */
  query?: string;
  sort?: AlbumSort;
  /**
   * The favourites the shell knows from the timeline. An album lists uids alone, so
   * this is how its menu and viewer tell which way the heart points; a photo found
   * only in albums reads as not a favourite, and favouriting it again is harmless.
   */
  favoriteUids?: Set<string>;
  /** A heart flipped here, so the shell's timeline keeps the same state. */
  onFavoriteChanged?: (uid: string, favorite: boolean) => void;
}) {
  const t = useT();
  const [albums, setAlbums] = useState<Album[]>(initial ?? []);
  const [photos, setPhotos] = useState<AlbumPhoto[]>([]);
  // The list and the open album share this flag. Arriving straight into an album
  // has nothing warmed for it, so that always starts out loading; a warmed list
  // does not, and paints instead of shimmering. The reads below run either way.
  const [loading, setLoading] = useState(!!open || !initial);
  const [error, setError] = useState("");

  // Albums the user chose to download (their photos arrive automatically). Downloading
  // a whole album can only work through the Explorer mount, so with the mount off the
  // badge is not offered at all rather than sitting there inert.
  const [syncedAlbums, setSyncedAlbums] = useState<Set<string>>(new Set());
  const [explorer, setExplorer] = useState(false);
  useEffect(() => {
    void invoke<string[]>("synced_albums")
      .then((a) => setSyncedAlbums(new Set(a)))
      .catch(() => {});
    void explorerMode().then(setExplorer);
  }, []);

  // Turning the badge off stops the album downloading itself, but what it already
  // downloaded stays on the device until someone says otherwise. Nothing else in
  // the app would ever mention those photos again, so this is the one moment the
  // storage can be offered back — and it is only worth asking about when the album
  // actually put something there.
  const [freeUpAsk, setFreeUpAsk] = useState<{ uid: string; count: number } | null>(null);
  const [freeUpBusy, setFreeUpBusy] = useState(false);

  async function toggleSync(uid: string) {
    const on = !syncedAlbums.has(uid);
    setSyncedAlbums((prev) => {
      const next = new Set(prev);
      if (on) next.add(uid);
      else next.delete(uid);
      return next;
    });
    try {
      await invoke("set_album_synced", { uid, enabled: on });
    } catch (e) {
      // The host refused, so the badge goes back to what it was: leaving it lit would
      // have this album claiming to download itself until the view was rebuilt.
      setSyncedAlbums((prev) => {
        const next = new Set(prev);
        if (on) next.delete(uid);
        else next.add(uid);
        return next;
      });
      setToast(String(e));
      return; // the toggle did not take, so there is nothing to ask about
    }
    if (on) return;
    const count = await invoke<number>("album_local_count", { uid }).catch(() => 0);
    if (count > 0) setFreeUpAsk({ uid, count });
  }

  /** Frees the copies that album downloaded, and reports what actually went. */
  async function freeUpAlbum(uid: string) {
    setFreeUpBusy(true);
    try {
      const freed = await invoke<number>("free_up_album", { uid });
      setToast(freed === 0 ? t("download.freedUpNone") : t("download.freedUp", { count: freed }));
    } catch (e) {
      setToast(String(e));
    } finally {
      setFreeUpBusy(false);
      setFreeUpAsk(null);
    }
  }

  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [creating, setCreating] = useState(false);
  // The photos in here get the same right-click menu the timeline has, holding
  // what an album can do rather than what the timeline can.
  const [photoMenu, setPhotoMenu] = useState<MenuAt<string> | null>(null);
  const [sharing, setSharing] = useState<{ uid: string; name: string } | null>(null);
  // `busy` drives the "Downloading…" toast, so the album actions keep their own
  // flag: they are one request each and only need to bar a second click.
  const [albumBusy, setAlbumBusy] = useState(false);
  const [pickAlbum, setPickAlbum] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveProgress, setSaveProgress] = useState<SaveProgress | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const sel = useSelection(detailRef, lightboxIdx === null);
  // Whether one of the selection's actions is still working, so the bar can stand
  // down instead of taking a second click on work already in flight. The ref is what
  // actually bars it: the right-click menu offers the same actions and does not wait
  // for a render to know.
  const [selectionBusy, setSelectionBusy] = useState(false);
  const selectionRunning = useRef(false);

  /** Runs one selection action, holding the bar down for as long as it takes. */
  const runSelection = useCallback(async (action: () => Promise<void>) => {
    if (selectionRunning.current) return;
    selectionRunning.current = true;
    setSelectionBusy(true);
    try {
      await action();
    } finally {
      selectionRunning.current = false;
      setSelectionBusy(false);
    }
  }, []);

  // A brief confirmation toast (download results) that clears itself.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // Always re-reads, warmed or not: what the shell handed over is a first paint,
  // never the answer. The counts and covers here only hold because they come off
  // the albums endpoint every time (see the sidecar's albums module).
  useEffect(() => {
    let cancelled = false;
    setError("");
    (async () => {
      try {
        const list = await rpc<Album[]>("getAlbums");
        if (cancelled) return;
        setAlbums(list);
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
  }, [reloadKey]);

  // Keyed on the album's uid, not the object: renaming it from the header hands
  // down a fresh one, and that is no reason to refetch its photos.
  const openUid = open?.uid ?? null;
  useEffect(() => {
    setLightboxIdx(null);
    sel.clear();
    setError("");
    if (!openUid) {
      setPhotos([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await rpc<AlbumPhoto[]>("getAlbumPhotos", { uid: openUid });
        if (cancelled) return;
        setPhotos(list);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openUid, reloadKey]);

  // Report the open album's count up to the top bar, which owns the header.
  useEffect(() => {
    onCount?.(!openUid || loading ? null : photos.length);
  }, [openUid, loading, photos.length, onCount]);

  // Report the open album's photo uids up, so the top bar's Download can act on the
  // whole album. Cleared to [] on the list (no album open).
  useEffect(() => {
    onPhotoUids?.(!openUid || loading ? [] : photos.map((p) => p.uid));
  }, [openUid, loading, photos, onPhotoUids]);

  // Covers for the list cards; the open album's own cover is resolved by the shell for
  // the masthead, so an open album needs none here.
  // The album list after the shell's search and sort: filter by name, then order by the
  // chosen mode ("activity" keeps the server's own most-recent-first order).
  const shown = useMemo(() => {
    const base = filterAlbums(albums, query);
    if (sort === "name") {
      return [...base].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }
    if (sort === "count") {
      return [...base].sort((a, b) => b.photoCount - a.photoCount);
    }
    return base;
  }, [albums, query, sort]);

  const coverUids = useMemo(
    () => (open ? [] : shown.map((a) => a.coverUid).filter((u): u is string => !!u)),
    [shown, open],
  );
  const covers = useThumbnails(coverUids);

  const photoUids = useMemo(() => photos.map((p) => p.uid), [photos]);

  // The album's own order, for the viewer's filmstrip and contents list. An album
  // listing carries neither a name nor a tag, so only the uid goes across and the
  // viewer resolves the rest. Memoised because the viewer reads the array's identity
  // as "the list changed".
  //
  // Up here with the other hooks, not down in the branch that uses it: a hook behind
  // an `if` runs on some renders and not others, and React unmounts the whole tree
  // the moment the count changes.
  const viewerItems = useMemo(() => photos.map((p) => ({ uid: p.uid })), [photos]);
  const photoThumbs = useThumbnails(photoUids);

  // Warm the lightbox neighbours, exactly as the timeline does: after the open
  // photo's own preview resolves, so the warm never competes with it.
  useEffect(() => {
    if (lightboxIdx === null) return;
    const current = photos[lightboxIdx];
    if (!current) return;
    const uids: string[] = [];
    for (let d = 1; d <= PREFETCH_RADIUS; d++) {
      if (photos[lightboxIdx + d]) uids.push(photos[lightboxIdx + d].uid);
      if (photos[lightboxIdx - d]) uids.push(photos[lightboxIdx - d].uid);
    }
    return prefetchAfter(current.uid, uids);
  }, [lightboxIdx, photos]);

  sel.order.current = open ? photos.map((p) => p.uid) : [];

  function onCellClick(uid: string, e?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
    if (sel.wasDragging()) return;
    if (sel.selected.size > 0 || e?.shiftKey || e?.ctrlKey || e?.metaKey) sel.toggle(uid, e);
    else setLightboxIdx(photos.findIndex((p) => p.uid === uid));
  }

  function removeLocally(uids: Set<string>) {
    uids.forEach(dropPreview);
    setPhotos((prev) => prev.filter((p) => !uids.has(p.uid)));
  }

  /** Same as the timeline's: only what actually went leaves the grid, and the
   *  count says so rather than letting a kept photo look trashed. */
  async function trashSelected() {
    const uids = [...sel.selected];
    if (uids.length === 0) return;
    setError("");
    try {
      const results = await rpc<{ uid: string; ok: boolean }[]>("trashPhotos", { uids });
      const gone = new Set(results.filter((r) => r.ok).map((r) => r.uid));
      removeLocally(gone);
      sel.clear();
      const failed = results.length - gone.size;
      setToast(
        failed > 0
          ? t("trash.movedPartial", { ok: gone.size, failed })
          : t("trash.moved", { count: gone.size }),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  async function createAlbum(name: string) {
    setAlbumBusy(true);
    try {
      const album = await rpc<Album>("createAlbum", { name });
      // It has just been touched, so it sorts to the front of the list as it is.
      setAlbums((prev) => [album, ...prev]);
      setCreating(false);
      onChanged?.();
    } catch (e) {
      setToast(String(e));
      setCreating(false);
    } finally {
      setAlbumBusy(false);
    }
  }

  /**
   * Takes the selected photos out of the album. The server answers per batch of
   * ten rather than per photo, so this counts what came back and never pins a
   * failure on one photo.
   */
  async function removeSelectedFromAlbum() {
    if (!open) return;
    const uids = [...sel.selected];
    if (uids.length === 0) return;
    setAlbumBusy(true);
    try {
      const results = await rpc<{ uid: string; ok: boolean }[]>("removePhotosFromAlbum", {
        albumUid: open.uid,
        uids,
      });
      const gone = new Set(results.filter((r) => r.ok).map((r) => r.uid));
      setPhotos((prev) => prev.filter((p) => !gone.has(p.uid)));
      sel.clear();
      const failed = results.length - gone.size;
      setToast(
        failed > 0
          ? t("albums.removePartial", { ok: gone.size, failed })
          : t("albums.removed", { count: gone.size }),
      );
      if (gone.size > 0) onChanged?.();
    } catch (e) {
      setToast(String(e));
    } finally {
      setAlbumBusy(false);
    }
  }

  /** Makes the one selected photo the album's cover. */
  async function setCoverFromSelection() {
    if (!open) return;
    const [coverUid] = [...sel.selected];
    if (!coverUid) return;
    setAlbumBusy(true);
    try {
      await rpc<{ uid: string; coverUid: string }>("setAlbumCover", {
        uid: open.uid,
        coverUid,
      });
      // The cover shows in the list, not in here, so the list is patched rather
      // than refetched: the server took the uid we sent.
      setAlbums((prev) => prev.map((a) => (a.uid === open.uid ? { ...a, coverUid } : a)));
      sel.clear();
      setToast(t("albums.coverSet"));
    } catch (e) {
      setToast(String(e));
    } finally {
      setAlbumBusy(false);
    }
  }

  // Download the selected album photos: the same Download the timeline offers, so it
  // fills the Proton Photos folder or a folder the user picks, as the mode dictates.
  async function downloadSelected() {
    const uids = [...sel.selected].filter((u) => !localUids.has(u));
    if (uids.length === 0) {
      setToast(t("download.alreadyDownloaded"));
      sel.clear();
      return;
    }
    try {
      const result = await downloadPhotos(uids, {
        onStart: () => setBusy(true),
        onProgress: setSaveProgress,
      });
      if (result.mode === "cancelled") return;
      sel.clear();
      const message = downloadMessage(result);
      if (message) setToast(t(message.key, message.vars));
    } catch (e) {
      setToast(String(e));
    } finally {
      setBusy(false);
      setSaveProgress(null);
    }
  }

  // Drop the local copy of the selected album photos (dehydrate every copy).
  // Reports the photos the host actually freed, not the ones asked for.
  async function freeUpSelected() {
    const uids = [...sel.selected].filter((u) => localUids.has(u));
    if (uids.length === 0) {
      setToast(t("download.notDownloaded"));
      sel.clear();
      return;
    }
    try {
      const freed = await invoke<number>("free_up_selected", { uids });
      sel.clear();
      setToast(freed === 0 ? t("download.freedUpNone") : t("download.freedUp", { count: freed }));
    } catch (e) {
      setToast(String(e));
    }
  }

  // Only one of the two is on the bar at a time, the way the right-click menu has
  // always picked one: taking the copies back is offered once there is nothing left
  // in the selection to keep. The timeline decides the same way.
  const allSelectedOffline = useMemo(
    () => sel.selected.size > 0 && [...sel.selected].every((u) => offlineUids.has(u)),
    [sel.selected, offlineUids],
  );

  // Keep the app's own encrypted copies of the selection, or drop them. The same
  // action the timeline offers, and just as separate from Download.
  async function offlineAddSelected() {
    const uids = [...sel.selected].filter((u) => !offlineUids.has(u));
    if (uids.length === 0) {
      setToast(t("offline.alreadyOffline"));
      sel.clear();
      return;
    }
    try {
      const added = await pinOffline(uids);
      sel.clear();
      setToast(t(added === 1 ? "offline.added.one" : "offline.added.other", { count: added }));
    } catch (e) {
      setToast(String(e));
    }
  }

  async function offlineRemoveSelected() {
    const uids = [...sel.selected].filter((u) => offlineUids.has(u));
    if (uids.length === 0) {
      setToast(t("offline.noneOffline"));
      sel.clear();
      return;
    }
    try {
      const removed = await unpinOffline(uids);
      sel.clear();
      setToast(
        t(removed === 1 ? "offline.removed.one" : "offline.removed.other", { count: removed }),
      );
    } catch (e) {
      setToast(String(e));
    }
  }

  function handleTrashed(uid: string) {
    removeLocally(new Set([uid]));
    setLightboxIdx((i) => {
      if (i === null) return null;
      const remaining = photos.length - 1;
      return remaining <= 0 ? null : Math.min(i, remaining - 1);
    });
  }

  /**
   * A right-click acts on what is highlighted, so a photo outside the selection
   * becomes the selection first, exactly as the timeline does it. Right-clicking
   * inside a selection leaves it alone, so a menu can act on all of it.
   */
  function onCellContext(uid: string, e: { clientX: number; clientY: number }) {
    if (!sel.selected.has(uid)) sel.setSelected(new Set([uid]));
    setPhotoMenu({ x: e.clientX, y: e.clientY, target: uid });
  }

  /**
   * Favourites the selection. The hearts flip now and the ones the server refuses
   * flip back, the way the timeline does it.
   */
  async function favoriteSelected(favorite: boolean) {
    const uids = [...sel.selected];
    if (uids.length === 0) return;
    uids.forEach((u) => onFavoriteChanged?.(u, favorite));
    try {
      const results = await rpc<{ uid: string; ok: boolean }[]>("setFavorite", { uids, favorite });
      const failed = results.filter((r) => !r.ok);
      failed.forEach((r) => onFavoriteChanged?.(r.uid, !favorite));
      if (failed.length > 0) setToast(t("viewer.favoriteFailed"));
    } catch (e) {
      uids.forEach((u) => onFavoriteChanged?.(u, !favorite));
      setToast(String(e));
    }
  }

  /** Puts the selection in another album as well; this one keeps them. */
  async function addSelectedToAlbum(albumUid: string) {
    const uids = [...sel.selected];
    if (uids.length === 0) return;
    setAlbumBusy(true);
    try {
      const results = await rpc<{ uid: string; ok: boolean }[]>("addPhotosToAlbum", {
        albumUid,
        uids,
      });
      const added = results.filter((r) => r.ok).length;
      const failed = results.length - added;
      setToast(
        failed > 0
          ? t("albums.addPartial", { ok: added, failed })
          : t("albums.added", { count: added }),
      );
      sel.clear();
      if (added > 0) onChanged?.();
    } catch (e) {
      setToast(String(e));
    } finally {
      setPickAlbum(false);
      setAlbumBusy(false);
    }
  }

  /** Shows the photo's copy in the Proton Photos folder, selected, in File Explorer. */
  async function revealPhoto(uid: string) {
    await invoke("reveal_photo", { uid }).catch((e) => setToast(String(e)));
  }

  /**
   * Opens the share dialog for one photo. An album carries capture times and
   * uids only, so the name is fetched for the subtitle; without one the dialog
   * still opens, because the name is not what is being shared.
   */
  async function openShare(uid: string) {
    const rows = await rpc<{ uid: string; name: string }[]>("getMetadata", { uids: [uid] }).catch(
      () => [],
    );
    setSharing({ uid, name: rows[0]?.name ?? "" });
  }

  if (error) return <div className="g-error">{error}</div>;

  // What an album offers on one of its photos. Setting a cover and sharing each
  // name a single photo, so they stand down while a selection does; the rest act
  // on everything highlighted. Removing from the album sits above trashing, both
  // last, as they do in the selection bar.
  const photoFavorite = !!photoMenu && !!favoriteUids?.has(photoMenu.target);
  const photoActions: MenuAction[] = photoMenu
    ? [
        {
          key: "album",
          label: t("selection.addToAlbum"),
          icon: <LibraryAddIcon size={14} />,
          onSelect: () => setPickAlbum(true),
        },
        {
          key: "favorite",
          label: photoFavorite ? t("selection.unfavorite") : t("selection.favorite"),
          icon: <HeartIcon size={14} filled={photoFavorite} />,
          onSelect: () => void favoriteSelected(!photoFavorite),
        },
        ...(sel.selected.size === 1
          ? [
              {
                key: "cover",
                label: t("selection.setCover"),
                onSelect: () => void runSelection(setCoverFromSelection),
              },
              {
                key: "share",
                label: t("selection.share"),
                icon: <ShareIcon size={14} />,
                onSelect: () => void openShare(photoMenu.target),
              },
            ]
          : []),
        {
          key: "download",
          label: t("selection.download"),
          icon: <DownloadIcon size={14} />,
          onSelect: () => void runSelection(downloadSelected),
        },
        ...(sel.selected.size === 1 && localUids.has(photoMenu.target)
          ? [
              {
                key: "reveal",
                label: t("selection.showInFolder"),
                icon: <FolderOpenIcon size={14} />,
                onSelect: () => void revealPhoto(photoMenu.target),
              },
            ]
          : []),
        {
          key: "offline",
          label: t(
            offlineUids.has(photoMenu.target) ? "selection.offlineRemove" : "selection.offlineAdd",
          ),
          icon: <OfflinePinIcon size={14} />,
          onSelect: () =>
            void runSelection(
              offlineUids.has(photoMenu.target) ? offlineRemoveSelected : offlineAddSelected,
            ),
        },
        {
          key: "remove",
          label: t("selection.removeFromAlbum"),
          icon: <LibraryRemoveIcon size={14} />,
          onSelect: () => setConfirmRemove(true),
        },
        {
          key: "trash",
          label: t("selection.trash"),
          icon: <TrashIcon size={14} />,
          separator: true,
          danger: true,
          onSelect: () => setConfirmTrash(true),
        },
      ]
    : [];

  // ---- Album detail ----
  if (open) {
    const current = lightboxIdx !== null ? photos[lightboxIdx] : null;
    return (
      <div ref={detailRef} {...sel.containerProps}>
        {loading && photos.length === 0 && <PhotoGridSkeleton count={18} cellSize={cellSize} />}

        {!loading && photos.length === 0 && (
          <div className="g-empty">
            <p className="g-empty-title">{t("albums.empty")}</p>
          </div>
        )}

        <VirtualSections
          sections={[{ key: "album", items: photos }]}
          cellSize={cellSize}
          grid={(_, items) => (
            <PhotoGrid
              items={items}
              thumbs={photoThumbs}
              cellSize={cellSize}
              selected={sel.selected}
              onToggle={sel.toggle}
              onOpen={onCellClick}
              onContext={onCellContext}
              offlineUids={offlineUids}
              localUids={localUids}
            />
          )}
        />

        {photoMenu && (
          <ContextMenu
            x={photoMenu.x}
            y={photoMenu.y}
            actions={photoActions}
            onClose={() => setPhotoMenu(null)}
          />
        )}

        {sharing && (
          <ShareDialog
            uid={sharing.uid}
            title={sharing.name}
            onClose={() => setSharing(null)}
          />
        )}

        <Marquee rect={sel.marquee} />
        <SelectionBar
          count={sel.selected.size}
          busy={selectionBusy}
          onCancel={sel.clear}
          onSetCover={
            sel.selected.size === 1 ? () => void runSelection(setCoverFromSelection) : undefined
          }
          onDownload={() => void runSelection(downloadSelected)}
          onFreeUp={() => void runSelection(freeUpSelected)}
          onOfflineAdd={
            allSelectedOffline ? undefined : () => void runSelection(offlineAddSelected)
          }
          onOfflineRemove={
            allSelectedOffline ? () => void runSelection(offlineRemoveSelected) : undefined
          }
          onAddToAlbum={() => setPickAlbum(true)}
          onRemoveFromAlbum={() => setConfirmRemove(true)}
          onTrash={() => setConfirmTrash(true)}
        />

        {pickAlbum && (
          <AlbumPicker
            count={sel.selected.size}
            busy={albumBusy}
            exclude={open.uid}
            onPick={(albumUid) => void addSelectedToAlbum(albumUid)}
            onCancel={() => setPickAlbum(false)}
          />
        )}

        {confirmRemove && (
          <Confirm
            title={t("confirm.removeTitle")}
            message={t(
              sel.selected.size === 1 ? "confirm.removeCount.one" : "confirm.removeCount.other",
              { count: sel.selected.size },
            )}
            confirmLabel={t("confirm.removeConfirm")}
            onCancel={() => setConfirmRemove(false)}
            onConfirm={() => {
              setConfirmRemove(false);
              void runSelection(removeSelectedFromAlbum);
            }}
          />
        )}

        {confirmTrash && (
          <Confirm
            title={t("confirm.trashTitle")}
            message={t(
              sel.selected.size === 1 ? "confirm.trashCount.one" : "confirm.trashCount.other",
              { count: sel.selected.size },
            )}
            confirmLabel={t("confirm.trashConfirm")}
            danger
            onCancel={() => setConfirmTrash(false)}
            onConfirm={() => {
              setConfirmTrash(false);
              void runSelection(trashSelected);
            }}
          />
        )}

        {current && (
          <Lightbox
            uid={current.uid}
            isLocal={localUids.has(current.uid)}
            isOffline={offlineUids.has(current.uid)}
            fallbackUrl={photoThumbs[current.uid] ?? null}
            hasPrev={lightboxIdx! > 0}
            hasNext={lightboxIdx! < photos.length - 1}
            onPrev={() => setLightboxIdx((i) => (i === null ? i : Math.max(0, i - 1)))}
            onNext={() =>
              setLightboxIdx((i) => (i === null ? i : Math.min(photos.length - 1, i + 1)))
            }
            items={viewerItems}
            index={lightboxIdx!}
            onJump={setLightboxIdx}
            onClose={() => setLightboxIdx(null)}
            onTrashed={handleTrashed}
            onRenamed={() => {}}
            onEdited={onChanged}
            // Only a known favourite is passed on; otherwise the viewer's own lookup decides.
            isFavorite={favoriteUids?.has(current.uid) ? true : undefined}
            onFavoriteChanged={onFavoriteChanged}
          />
        )}

        {(busy || toast) && (
          <div className="g-toast">
            {busy ? (
              saveProgress && saveProgress.total > 0 ? (
                <DownloadProgress
                  label={t("download.progress", {
                    done: saveProgress.done,
                    total: saveProgress.total,
                  })}
                  done={saveProgress.done}
                  failed={saveProgress.failed}
                  total={saveProgress.total}
                />
              ) : (
                t("download.running")
              )
            ) : (
              toast
            )}
          </div>
        )}
      </div>
    );
  }

  // ---- Album list ----
  const nameDialog = creating && (
    <NameDialog
      title={t("albums.newTitle")}
      confirmLabel={t("albums.create")}
      busy={albumBusy}
      onConfirm={(name) => void createAlbum(name)}
      onCancel={() => setCreating(false)}
    />
  );

  if (loading && albums.length === 0) {
    return (
      <div
      className="g-albums"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${albumCellSize}px, 1fr))` }}
    >
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="g-album g-skel" key={i} />
        ))}
      </div>
    );
  }

  if (albums.length === 0) {
    return (
      <>
        <div className="g-empty">
          <p className="g-empty-title">{t("albums.none")}</p>
          <p className="g-empty-sub">{t("albums.noneSub")}</p>
          <button className="g-empty-btn" onClick={() => setCreating(true)}>
            {t("albums.newAlbum")}
          </button>
        </div>
        {nameDialog}
        {toast && <div className="g-toast">{toast}</div>}
      </>
    );
  }

  // A search that matched no album name: say so, rather than leaving just the
  // "new album" card floating in an otherwise empty grid.
  if (query.trim() && shown.length === 0) {
    return (
      <>
        <div className="g-empty">
          <p className="g-empty-title">{t("albums.searchEmpty")}</p>
        </div>
        {nameDialog}
        {toast && <div className="g-toast">{toast}</div>}
      </>
    );
  }

  return (
    <div
      className="g-albums"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${albumCellSize}px, 1fr))` }}
    >
      <button className="g-album g-album-new" onClick={() => setCreating(true)}>
        <div className="g-album-newbox">
          <span className="g-album-newplus">+</span>
        </div>
        <div className="g-album-name">{t("albums.newAlbum")}</div>
      </button>

      {shown.map((a) => (
        <button
          className="g-album"
          key={a.uid}
          onClick={() => onOpenChange(a)}
          onContextMenu={
            onAlbumContext &&
            ((e) => {
              e.preventDefault();
              // This album's menu answers the click; the shell's document
              // listener must not open its own on top of it.
              e.stopPropagation();
              onAlbumContext(a, e);
            })
          }
        >
          <div className="g-album-cover">
            {a.coverUid && covers[a.coverUid] ? (
              <img src={covers[a.coverUid]!} alt="" draggable={false} />
            ) : (
              <div className="g-cell-ph" />
            )}
            {explorer && (
              <span
                className={`g-album-sync${syncedAlbums.has(a.uid) ? " on" : ""}`}
                role="button"
                tabIndex={0}
                title={
                  syncedAlbums.has(a.uid) ? t("albums.keptDownloaded") : t("albums.keepDownloaded")
                }
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleSync(a.uid);
                }}
              >
                <CloudIcon size={14} />
              </span>
            )}
          </div>
          <div className="g-album-name">{a.name || t("albums.untitled")}</div>
          <div className="g-album-count">
            {t(a.photoCount === 1 ? "common.photoCount.one" : "common.photoCount.other", {
              count: a.photoCount,
            })}
          </div>
        </button>
      ))}

      {nameDialog}

      {freeUpAsk && (
        <AlbumFreeUpDialog
          count={freeUpAsk.count}
          busy={freeUpBusy}
          onKeep={() => setFreeUpAsk(null)}
          onFreeUp={() => void freeUpAlbum(freeUpAsk.uid)}
        />
      )}

      {toast && <div className="g-toast">{toast}</div>}
    </div>
  );
}
