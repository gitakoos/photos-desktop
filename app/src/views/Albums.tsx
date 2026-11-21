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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { photoSpan } from "../lib/albumSpan";
import { invoke } from "@tauri-apps/api/core";
import { rpc } from "../lib/rpc";
import { downloadMessage, downloadPhotos, type SaveProgress } from "../lib/download";
import { pinOffline, unpinOffline } from "../lib/offline";
import { DownloadProgress } from "../components/DownloadProgress";
import { useThumbnails } from "../hooks/useThumbnails";
import { filterAlbums } from "../lib/albumSearch";
import {
  dragTo,
  forSave,
  gather,
  linkOf,
  moveOnto,
  moveToEnd,
  moveToStart,
  newestOf,
  nudge,
  nudgeBlock,
  orderPhotos,
  sortAlbums,
  viewerIndexAfterRemoval,
  type AlbumLayout,
  type AlbumPhotoOrder,
  type AlbumSort,
} from "../lib/albumView";
import { PhotoGrid, PhotoGridSkeleton } from "../components/PhotoGrid";
import { VirtualSections } from "../components/VirtualSections";
import { Marquee, SelectionBar, useSelection } from "../hooks/useSelection";
import { Lightbox } from "../components/Lightbox";
import { Confirm } from "../components/Confirm";
import { ContextMenu, type MenuAction, type MenuAt } from "../components/ContextMenu";
import { AlbumPicker, NameDialog } from "../components/AlbumDialogs";
import { ShareDialog } from "../components/ShareDialog";
import {
  CalendarIcon,
  PlaceIcon,
  CompressIcon,
  CloudIcon,
  DownloadIcon,
  DragHandleIcon,
  FolderOpenIcon,
  HeartIcon,
  ImageIcon,
  LibraryAddIcon,
  LibraryRemoveIcon,
  OfflinePinIcon,
  ShareIcon,
  TextIcon,
  TrashIcon,
  VisibilityOffIcon,
} from "../components/icons";
import { useT } from "../lib/i18n";
import { isWindows } from "../lib/platform";
import { locale } from "../lib/format";
import { dropPreview, prefetchAfter } from "../lib/previewStore";

const PREFETCH_RADIUS = 2;

export type Album = {
  uid: string;
  name: string;
  photoCount: number;
  coverUid: string | null;
  lastActivityTime: number;
};
export type { AlbumSort };
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
  onSpan,
  onEditDate,
  onEditPlace,
  onEditMeta,
  onCompress,
  onMakeGif,
  onDateEditStarted,
  contentsRequest = 0,
  slideshowRequest = 0,
  query = "",
  sort = "activity",
  layout = "grid",
  order = [],
  onOrderChange,
  arranging = false,
  photoOrder = "newest",
  arrangement,
  photoOrderReady = true,
  photoArranging = false,
  arrangeCommand,
  onArrangeState,
  onArrangeSave,
  onArrangeEnd,
  favoriteUids,
  onFavoriteChanged,
  hidden,
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
  /** The open album's first and last capture time, for its header; null while loading or empty. */
  onSpan?: (span: [number, number] | null) => void;
  /** Opens the date editor for these photos. */
  onEditDate?: (uids: string[]) => void;
  onEditPlace?: (uids: string[]) => void;
  /** Opens the description and strip editor for these photos. */
  onEditMeta?: (uids: string[], kind: "text" | "strip") => void;
  onCompress?: (uids: string[]) => void;
  onMakeGif?: (uid: string) => void;
  /** A date change its viewer started, for the caller to follow. */
  onDateEditStarted?: (kind?: "date" | "place" | "meta") => void;
  /** Raised by the album's More menu: opens the viewer on its first photo with the contents list. */
  contentsRequest?: number;
  /** Goes up each time the album's menu asks to play it as a slideshow. */
  slideshowRequest?: number;
  /** The album-list search query (filters by name) and the sort order, owned by the shell. */
  query?: string;
  sort?: AlbumSort;
  /** The album list as cards or as rows. */
  layout?: AlbumLayout;
  /** The reader's own arrangement (album uids), which the "custom" sort follows. */
  order?: string[];
  /** The arrangement after a drag or a key move; the albums not on screen keep their place. */
  onOrderChange?: (order: string[]) => void;
  /** Whether the list is being rearranged: cards drag and the albums do not open. */
  arranging?: boolean;
  /** The open album's photo order. */
  photoOrder?: AlbumPhotoOrder;
  /** The open album's hand-made order (photo link ids), which "custom" follows. */
  arrangement?: string[];
  /** Whether the open album's order has been read; its photos wait for it, so they do not jump. */
  photoOrderReady?: boolean;
  /** Whether the open album's photos are being arranged: they drag, select on a click and do not open. */
  photoArranging?: boolean;
  /** A press on the masthead's arrange controls, answered once per `n`. */
  arrangeCommand?: { kind: "start" | "end" | "done" | "cancel"; n: number };
  /** How many photos the arranging has selected, and whether it moved any. */
  onArrangeState?: (state: { selected: number; changed: boolean }) => void;
  /** Saves the album's new order, photo link ids. */
  onArrangeSave?: (order: string[]) => Promise<void>;
  /** The arranging is over, saved or not. */
  onArrangeEnd?: () => void;
  /**
   * The favourites the shell knows from the timeline. An album lists uids alone, so
   * this is how its menu and viewer tell which way the heart points; a photo found
   * only in albums reads as not a favourite, and favouriting it again is harmless.
   */
  favoriteUids?: Set<string>;
  /** A heart flipped here, so the shell's timeline keeps the same state. */
  onFavoriteChanged?: (uid: string, favorite: boolean) => void;
  /**
   * What is hidden: a hidden album stays off the list, and a hidden photo out of any album
   * that is not itself hidden. A hidden album, opened from the Hidden page, shows them all.
   */
  hidden?: { isPhoto: (uid: string) => boolean; isAlbum: (uid: string) => boolean; version: number };
}) {
  const t = useT();
  const [albums, setAlbums] = useState<Album[]>(initial ?? []);
  const [allPhotos, setPhotos] = useState<AlbumPhoto[]>([]);
  const openHidden = !!open && !!hidden?.isAlbum(open.uid);
  const ordered = useMemo(
    () =>
      photoOrderReady
        ? orderPhotos(hidden && !openHidden ? allPhotos.filter((p) => !hidden.isPhoto(p.uid)) : allPhotos, photoOrder, arrangement)
        : [],
    [allPhotos, hidden, openHidden, photoOrder, arrangement, photoOrderReady],
  );
  // While arranging, the grid shows the order being made; everything else keeps the saved one.
  const [working, setWorking] = useState<string[] | null>(null);
  const photos = useMemo(() => {
    if (!working) return ordered;
    const byUid = new Map(ordered.map((p) => [p.uid, p]));
    return working.map((uid) => byUid.get(uid)).filter((p): p is AlbumPhoto => !!p);
  }, [ordered, working]);
  // The list and the open album share this flag. Arriving straight into an album
  // has nothing warmed for it, so that always starts out loading; a warmed list
  // does not, and paints instead of shimmering. The reads below run either way.
  const [loading, setLoading] = useState(!!open || !initial);
  const [error, setError] = useState("");

  // Albums kept available offline in the app, their photos and the ones added later. An earlier
  // build downloaded such an album into the Explorer folder instead; one left from it is moved
  // over once, and what it downloaded there goes back to the cloud.
  const [syncedAlbums, setSyncedAlbums] = useState<Set<string>>(new Set());
  useEffect(() => {
    void (async () => {
      const moved = await invoke<string[]>("synced_albums").catch(() => [] as string[]);
      for (const uid of moved) {
        try {
          await rpc("offlineAlbumSet", { uid, on: true });
          await invoke("free_up_album", { uid }).catch(() => 0);
          await invoke("set_album_synced", { uid, enabled: false });
        } catch {
          /* tried again the next time the albums open */
        }
      }
      const kept = await rpc<string[]>("offlineAlbums").catch(() => [] as string[]);
      setSyncedAlbums(new Set(kept));
    })();
  }, []);

  async function toggleSync(uid: string) {
    const on = !syncedAlbums.has(uid);
    const flip = (keep: boolean) =>
      setSyncedAlbums((prev) => {
        const next = new Set(prev);
        if (keep) next.add(uid);
        else next.delete(uid);
        return next;
      });
    flip(on);
    try {
      await rpc("offlineAlbumSet", { uid, on });
      setToast(t(on ? "albums.offlineOn" : "albums.offlineOff"));
    } catch (e) {
      // Refused, so the badge goes back to what it was.
      flip(!on);
      setToast(String(e));
    }
  }

  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  // Saving an edit writes a copy and reloads the album, whose list may then hold other photos at
  // the viewer's position. Once the new list is in, the viewer goes to the copy if the album has
  // it, and otherwise back to the photo it showed. Before the paint, so no other photo flashes up.
  const editFocus = useRef<{ copy?: string; from: string; album: string | null; list: AlbumPhoto[] } | null>(null);
  function handleEdited(copy?: string) {
    const from = lightboxIdx !== null ? photos[lightboxIdx]?.uid : undefined;
    if (from && onChanged) editFocus.current = { copy, from, album: open?.uid ?? null, list: allPhotos };
    onChanged?.();
  }
  useLayoutEffect(() => {
    const focus = editFocus.current;
    if (!focus || focus.list === allPhotos) return;
    editFocus.current = null;
    if (lightboxIdx === null) return;
    const at = focus.copy ? photos.findIndex((p) => p.uid === focus.copy) : -1;
    const back = photos.findIndex((p) => p.uid === focus.from);
    if (at >= 0 || back >= 0) setLightboxIdx(at >= 0 ? at : back);
  }, [allPhotos, photos]);
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

  // ---- Arranging the open album's photos ----
  const arrangeStart = useRef<string[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => {
    if (photoArranging && open) {
      const start = ordered.map((p) => p.uid);
      arrangeStart.current = start;
      setWorking(start);
    } else {
      setWorking(null);
      setConfirmDiscard(false);
    }
    sel.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoArranging, open?.uid]);
  // A photo added or taken away while arranging joins at the end or leaves the order being made.
  useEffect(() => {
    if (!working) return;
    const have = new Set(ordered.map((p) => p.uid));
    const kept = working.filter((u) => have.has(u));
    const keptSet = new Set(kept);
    const added = ordered.filter((p) => !keptSet.has(p.uid)).map((p) => p.uid);
    if (added.length > 0 || kept.length !== working.length) setWorking([...kept, ...added]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered]);
  const arrangeChanged =
    !!working &&
    (working.length !== arrangeStart.current.length || working.some((u, i) => u !== arrangeStart.current[i]));
  useEffect(() => {
    onArrangeState?.({ selected: photoArranging ? sel.selected.size : 0, changed: arrangeChanged });
  }, [photoArranging, sel.selected.size, arrangeChanged, onArrangeState]);

  const finishArranging = useCallback(async () => {
    if (!working) return;
    // A photo the album no longer holds leaves the stored order; one hidden here keeps its place.
    const members = new Set(allPhotos.map((p) => linkOf(p.uid)));
    const order = forSave(arrangement ?? [], working.map(linkOf), members);
    try {
      await onArrangeSave?.(order);
      setToast(t("albums.arrangeSaved"));
      onArrangeEnd?.();
    } catch (e) {
      setToast(String(e));
    }
  }, [working, allPhotos, arrangement, onArrangeSave, onArrangeEnd, t]);

  const answeredCommand = useRef(arrangeCommand?.n ?? 0);
  useEffect(() => {
    if (!arrangeCommand || arrangeCommand.n === answeredCommand.current) return;
    answeredCommand.current = arrangeCommand.n;
    if (!working) return;
    const moving = new Set(sel.selected);
    if (arrangeCommand.kind === "start") setWorking(moveToStart(working, moving));
    else if (arrangeCommand.kind === "end") setWorking(moveToEnd(working, moving));
    else if (arrangeCommand.kind === "done") void finishArranging();
    else if (arrangeChanged) setConfirmDiscard(true);
    else onArrangeEnd?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrangeCommand]);

  // Escape saves, as Done does, once nothing is selected (the first Escape lets the selection go).
  // The arrow keys carry the selection one place earlier or later.
  useEffect(() => {
    if (!photoArranging || !working) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (confirmDiscard || (e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable=true]")) return;
      if (e.key === "Escape") {
        if (sel.selected.size === 0) void finishArranging();
        return;
      }
      const by = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
      if (by === 0 || sel.selected.size === 0) return;
      e.preventDefault();
      setWorking(nudgeBlock(working, new Set(sel.selected), by));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photoArranging, working, sel.selected, confirmDiscard, finishArranging]);

  // A photo is dragged by the pointer: the held one, or the whole selection when it is in it,
  // which lands as one run before or after the photo it is dropped on.
  const [photoDrag, setPhotoDrag] = useState<Set<string> | null>(null);
  const [photoOver, setPhotoOver] = useState<string | null>(null);
  const photoDragRef = useRef<{ uid: string; x: number; y: number; moved: boolean; px: number; py: number } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const overAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-uid]");
    return el && detailRef.current?.contains(el) ? (el.dataset.uid ?? null) : null;
  };
  const dragScroll = () => {
    const d = photoDragRef.current;
    const scroller = detailRef.current?.closest<HTMLElement>(".g-scroll");
    if (!d?.moved || !scroller) {
      dragFrame.current = null;
      return;
    }
    const r = scroller.getBoundingClientRect();
    const dy = d.py < r.top + 64 ? -Math.ceil((r.top + 64 - d.py) / 4) : d.py > r.bottom - 64 ? Math.ceil((d.py - r.bottom + 64) / 4) : 0;
    if (dy === 0) {
      dragFrame.current = null;
      return;
    }
    scroller.scrollTop += dy;
    setPhotoOver(overAt(d.px, d.py));
    dragFrame.current = requestAnimationFrame(dragScroll);
  };
  const stopDragScroll = () => {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
  };
  useEffect(() => stopDragScroll, []);
  const arrangePointer = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const cell = target.closest<HTMLElement>("[data-uid]");
      if (!cell?.dataset.uid || target.closest(".g-seldot")) return;
      photoDragRef.current = { uid: cell.dataset.uid, x: e.clientX, y: e.clientY, moved: false, px: e.clientX, py: e.clientY };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = photoDragRef.current;
      if (!d) return;
      d.px = e.clientX;
      d.py = e.clientY;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
        d.moved = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        setPhotoDrag(sel.selected.has(d.uid) ? new Set(sel.selected) : new Set([d.uid]));
      }
      setPhotoOver(overAt(e.clientX, e.clientY));
      if (dragFrame.current === null) dragFrame.current = requestAnimationFrame(dragScroll);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => endPhotoDrag(e, false),
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => endPhotoDrag(e, true),
  };
  const suppressCellClick = useRef(false);
  function endPhotoDrag(e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) {
    const d = photoDragRef.current;
    photoDragRef.current = null;
    stopDragScroll();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const moving = photoDrag;
    const target = photoOver;
    setPhotoDrag(null);
    setPhotoOver(null);
    if (!d?.moved) return;
    suppressCellClick.current = true;
    window.setTimeout(() => (suppressCellClick.current = false), 0);
    if (cancelled || !moving || !target || moving.has(target) || !working) return;
    setWorking(dragTo(gather(working, moving, d.uid), moving, target));
  }
  const arrangeCellClass = (uid: string) =>
    photoDrag?.has(uid) ? "arr-drag" : photoOver === uid && photoDrag ? "arr-over" : "";

  // A brief confirmation toast (download results) that clears itself.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // Always re-reads, warmed or not: what the shell handed over is a first paint,
  // never the answer. The counts and covers here only hold because they come off
  // the albums endpoint every time (see the sidecar's albums module). Not while an album
  // is open: arriving straight into one, its photos come first, and the list is read when
  // it closes.
  const listShown = !open;
  useEffect(() => {
    if (!listShown) return;
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
  }, [reloadKey, listShown]);

  // Keyed on the album's uid, not the object: renaming it from the header hands
  // down a fresh one, and that is no reason to refetch its photos.
  const openUid = open?.uid ?? null;
  useEffect(() => {
    // The reload after a saved edit keeps the viewer open; see `editFocus`.
    if (editFocus.current?.album !== openUid) {
      editFocus.current = null;
      setLightboxIdx(null);
    }
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
        editFocus.current = null;
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openUid, reloadKey]);

  // The dates its photos have, for the header, in place of when the album last changed.
  useEffect(() => {
    onSpan?.(!openUid || loading ? null : photoSpan(photos));
  }, [openUid, loading, photos, onSpan]);

  // The contents list asked for from the album's menu: the viewer opens on the first photo with
  // the list beside it, once the photos are read. Each request is answered once.
  const [openWithContents, setOpenWithContents] = useState(false);
  const answeredContents = useRef(contentsRequest);
  useEffect(() => {
    if (contentsRequest === answeredContents.current || loading || photos.length === 0) return;
    answeredContents.current = contentsRequest;
    setOpenWithContents(true);
    setLightboxIdx(0);
  }, [contentsRequest, loading, photos.length]);

  // The slideshow asked for from the album's menu starts on the first photo, once they are read.
  const [openWithSlideshow, setOpenWithSlideshow] = useState(false);
  const answeredSlideshow = useRef(slideshowRequest);
  useEffect(() => {
    if (slideshowRequest === answeredSlideshow.current || loading || photos.length < 2) return;
    answeredSlideshow.current = slideshowRequest;
    setOpenWithSlideshow(true);
    setLightboxIdx(0);
  }, [slideshowRequest, loading, photos.length]);

  // Report the open album's count up to the top bar, which owns the header.
  useEffect(() => {
    onCount?.(!openUid || loading ? null : photos.length);
  }, [openUid, loading, photos.length, onCount]);

  // Report the open album's photo uids up, so the top bar's Download can act on the
  // whole album. Cleared to [] on the list (no album open).
  useEffect(() => {
    onPhotoUids?.(!openUid || loading ? [] : photos.map((p) => p.uid));
  }, [openUid, loading, photos, onPhotoUids]);

  // The newest photo's capture time per album, read one album at a time the first time
  // "newest photo" is the sort; an album whose size changed is read again.
  const [newestTimes, setNewestTimes] = useState<Map<string, number>>(new Map());
  const newestRead = useRef(new Map<string, number>());
  useEffect(() => {
    if (sort !== "newest" || open) return;
    let cancelled = false;
    (async () => {
      for (const a of albums) {
        if (cancelled) return;
        if (newestRead.current.get(a.uid) === a.photoCount) continue;
        try {
          const list = await rpc<AlbumPhoto[]>("getAlbumPhotos", { uid: a.uid });
          if (cancelled) return;
          newestRead.current.set(a.uid, a.photoCount);
          const at = newestOf(list);
          setNewestTimes((prev) => {
            const next = new Map(prev);
            if (at === null) next.delete(a.uid);
            else next.set(a.uid, at);
            return next;
          });
        } catch {
          /* the album keeps its place by activity */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sort, open, albums]);

  // Covers for the list cards; the open album's own cover is resolved by the shell for
  // the masthead, so an open album needs none here.
  // The album list after the shell's search and sort: filter by name, then order by the
  // chosen mode ("activity" keeps the server's own most-recent-first order).
  const shown = useMemo(() => {
    // A hidden photo is no album's cover here: the card shows no picture instead.
    const visible = hidden
      ? albums
          .filter((a) => !hidden.isAlbum(a.uid))
          .map((a) => (a.coverUid && hidden.isPhoto(a.coverUid) ? { ...a, coverUid: null } : a))
      : albums;
    return sortAlbums(filterAlbums(visible, query), sort, order, newestTimes);
  }, [albums, query, sort, order, newestTimes, hidden]);

  // The albums in the reader's arrangement, search aside: what a drag or a key move works on.
  const arranged = useMemo(
    () =>
      sortAlbums(
        hidden ? albums.filter((a) => !hidden.isAlbum(a.uid)) : albums,
        "custom",
        order,
      ).map((a) => a.uid),
    [albums, order, hidden],
  );
  const commitOrder = (moved: string[]) => {
    const links = moved.map(linkOf);
    const onScreen = new Set(links);
    onOrderChange?.([...links, ...order.filter((id) => !onScreen.has(id))]);
  };
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [overUid, setOverUid] = useState<string | null>(null);
  const drag = useRef<{ uid: string; x: number; y: number; moved: boolean } | null>(null);
  const startDrag = (e: ReactPointerEvent<HTMLElement>, uid: string) => {
    if (!arranging || e.button !== 0) return;
    drag.current = { uid, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    d.moved = true;
    setDragUid(d.uid);
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-album-uid]");
    setOverUid(target?.dataset.albumUid ?? null);
    // The page scrolls while a card is held near its top or bottom edge.
    const scroller = e.currentTarget.closest<HTMLElement>(".g-scroll");
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      if (e.clientY < r.top + 56) scroller.scrollBy(0, -18);
      else if (e.clientY > r.bottom - 56) scroller.scrollBy(0, 18);
    }
  };
  const endDrag = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const target = overUid;
    setDragUid(null);
    setOverUid(null);
    if (d?.moved) {
      // The click that ends a drag must not open the album it ended on.
      suppressOpen.current = true;
      window.setTimeout(() => (suppressOpen.current = false), 0);
      if (!cancelled && target && target !== d.uid) commitOrder(moveOnto(arranged, d.uid, target));
    }
  };
  const suppressOpen = useRef(false);
  const keyMove = (e: ReactKeyboardEvent<HTMLElement>, uid: string) => {
    if (!arranging) return;
    const by = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
    if (by === 0) return;
    e.preventDefault();
    commitOrder(nudge(arranged, uid, by));
    // The card keeps the focus through its move, so the keys can carry on.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-album-uid="${CSS.escape(uid)}"]`)?.focus(),
    );
  };
  const dragProps = (uid: string) => ({
    "data-album-uid": uid,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => startDrag(e, uid),
    onPointerMove: moveDrag,
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => endDrag(e, false),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => endDrag(e, true),
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => keyMove(e, uid),
  });
  const openAlbum = (a: Album) => {
    if (arranging || suppressOpen.current) return;
    onOpenChange(a);
  };

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
    if (photoArranging) {
      if (!suppressCellClick.current) sel.toggle(uid, e);
      return;
    }
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
    setLightboxIdx((i) => viewerIndexAfterRemoval(i, photos.length - 1));
  }

  /** The viewer took its photo out of the album; it stays in the library, so its preview is kept. */
  function handleRemovedFromAlbum(uid: string) {
    const rest = allPhotos.filter((p) => p.uid !== uid);
    const shown = photos.filter((p) => p.uid !== uid);
    const at = viewerIndexAfterRemoval(lightboxIdx, shown.length);
    setPhotos(rest);
    setLightboxIdx(at);
    setToast(t("albums.removed", { count: 1 }));
    // The reload that follows keeps the viewer on the photo now in this slot; see `editFocus`.
    const stay = at === null ? undefined : shown[at]?.uid;
    if (stay && onChanged) editFocus.current = { from: stay, album: open?.uid ?? null, list: rest };
    onChanged?.();
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
        ...(onEditDate
          ? [
              {
                key: "editDate",
                label: t("selection.editDate"),
                icon: <CalendarIcon size={14} />,
                onSelect: () => onEditDate([...sel.selected]),
              },
            ]
          : []),
        ...(onEditPlace
          ? [
              {
                key: "editPlace",
                label: t("selection.editPlace"),
                icon: <PlaceIcon size={14} />,
                onSelect: () => onEditPlace([...sel.selected]),
              },
            ]
          : []),
        ...(onEditMeta
          ? [
              {
                key: "editText",
                label: t("metaEdit.menuText"),
                icon: <TextIcon size={14} />,
                onSelect: () => onEditMeta([...sel.selected], "text"),
              },
              {
                key: "stripMeta",
                label: t("metaEdit.menuStrip"),
                icon: <VisibilityOffIcon size={14} />,
                onSelect: () => onEditMeta([...sel.selected], "strip"),
              },
            ]
          : []),
        ...(onCompress
          ? [
              {
                key: "compress",
                label: t("selection.compress"),
                icon: <CompressIcon size={14} />,
                onSelect: () => onCompress([...sel.selected]),
              },
            ]
          : []),
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
                icon: <ImageIcon size={14} />,
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
      <div
        ref={detailRef}
        className={photoArranging ? "g-arranging" : undefined}
        {...(photoArranging ? arrangePointer : sel.containerProps)}
      >
        {(loading || !photoOrderReady) && photos.length === 0 && <PhotoGridSkeleton count={18} cellSize={cellSize} />}

        {!loading && photoOrderReady && photos.length === 0 && (
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
              onContext={photoArranging ? undefined : onCellContext}
              offlineUids={offlineUids}
              localUids={localUids}
              cellClass={photoArranging ? arrangeCellClass : undefined}
              cellTitle={photoArranging ? t("albums.arrangeHint") : undefined}
            />
          )}
        />

        {confirmDiscard && (
          <Confirm
            title={t("albums.arrangeDiscardTitle")}
            message={t("albums.arrangeDiscardBody")}
            confirmLabel={t("albums.arrangeDiscard")}
            cancelLabel={t("albums.arrangeKeep")}
            onConfirm={() => {
              setConfirmDiscard(false);
              onArrangeEnd?.();
            }}
            onCancel={() => setConfirmDiscard(false)}
          />
        )}

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
          count={photoArranging ? 0 : sel.selected.size}
          busy={selectionBusy}
          onCancel={sel.clear}
          onSetCover={
            sel.selected.size === 1 ? () => void runSelection(setCoverFromSelection) : undefined
          }
          onDownload={() => void runSelection(downloadSelected)}
          onFreeUp={isWindows ? () => void runSelection(freeUpSelected) : undefined}
          onOfflineAdd={
            allSelectedOffline ? undefined : () => void runSelection(offlineAddSelected)
          }
          onOfflineRemove={
            allSelectedOffline ? () => void runSelection(offlineRemoveSelected) : undefined
          }
          onAddToAlbum={() => setPickAlbum(true)}
          onEditDate={onEditDate ? () => onEditDate([...sel.selected]) : undefined}
          onEditPlace={onEditPlace ? () => onEditPlace([...sel.selected]) : undefined}
          onCompress={onCompress ? () => onCompress([...sel.selected]) : undefined}
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
            onClose={() => {
              setLightboxIdx(null);
              setOpenWithContents(false);
              setOpenWithSlideshow(false);
            }}
            openWith={openWithContents ? "contents" : undefined}
            startSlideshow={openWithSlideshow}
            onDateEditStarted={onEditDate ? onDateEditStarted : undefined}
            onCompress={onCompress ? (uid) => onCompress([uid]) : undefined}
            onMakeGif={onMakeGif}
            onTrashed={handleTrashed}
            onRemovedFromAlbum={handleRemovedFromAlbum}
            onRenamed={() => {}}
            onEdited={handleEdited}
            album={open?.uid}
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

  const cover = (a: Album) =>
    a.coverUid && covers[a.coverUid] ? (
      <img src={covers[a.coverUid]!} alt="" draggable={false} />
    ) : (
      <div className="g-cell-ph" />
    );
  const contextOf = (a: Album) =>
    onAlbumContext &&
    ((e: MouseEvent) => {
      e.preventDefault();
      // This album's menu answers the click; the shell's document
      // listener must not open its own on top of it.
      e.stopPropagation();
      onAlbumContext(a, e);
    });
  const countLabel = (a: Album) =>
    t(a.photoCount === 1 ? "common.photoCount.one" : "common.photoCount.other", { count: a.photoCount });
  const stateClass = (uid: string) =>
    `${arranging ? " arranging" : ""}${dragUid === uid ? " drag" : ""}${overUid === uid && dragUid !== uid ? " over" : ""}`;

  if (layout === "list") {
    return (
      <div className={`al-list${arranging ? " arranging" : ""}`}>
        {!arranging && (
          <button className="al-row al-row-new" onClick={() => setCreating(true)}>
            <span className="th al-newbox">
              <span className="g-album-newplus">+</span>
            </span>
            <span className="nm">{t("albums.newAlbum")}</span>
            <span />
            <span />
          </button>
        )}
        {shown.map((a) => (
          <button
            className={`al-row${stateClass(a.uid)}`}
            key={a.uid}
            onClick={() => openAlbum(a)}
            onContextMenu={contextOf(a)}
            title={arranging ? t("albums.arrangeHint") : undefined}
            {...dragProps(a.uid)}
          >
            <span className="handle" aria-hidden>
              <DragHandleIcon size={18} />
            </span>
            <span className="th">{cover(a)}</span>
            <span className="nm" title={arranging ? undefined : a.name || undefined}>
              {a.name || t("albums.untitled")}
            </span>
            <span className="ct">{countLabel(a)}</span>
            <span className="la">
              {a.lastActivityTime ? new Date(a.lastActivityTime).toLocaleDateString(locale) : ""}
            </span>
          </button>
        ))}

        {nameDialog}

        {toast && <div className="g-toast">{toast}</div>}
      </div>
    );
  }

  return (
    <div
      className={`g-albums${arranging ? " arranging" : ""}`}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${albumCellSize}px, 1fr))` }}
    >
      {!arranging && (
        <button className="g-album g-album-new" onClick={() => setCreating(true)}>
          <div className="g-album-newbox">
            <span className="g-album-newplus">+</span>
          </div>
          <div className="g-album-name">{t("albums.newAlbum")}</div>
        </button>
      )}

      {shown.map((a) => (
        <button
          className={`g-album${stateClass(a.uid)}`}
          key={a.uid}
          onClick={() => openAlbum(a)}
          onContextMenu={contextOf(a)}
          title={arranging ? t("albums.arrangeHint") : undefined}
          {...dragProps(a.uid)}
        >
          <div className="g-album-cover">
            {cover(a)}
            {!arranging && (
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
          <div className="g-album-name" title={arranging ? undefined : a.name || undefined}>
            {a.name || t("albums.untitled")}
          </div>
          <div className="g-album-count">{countLabel(a)}</div>
        </button>
      ))}

      {nameDialog}

      {toast && <div className="g-toast">{toast}</div>}
    </div>
  );
}
