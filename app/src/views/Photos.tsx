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
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type WheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { rpc } from "../lib/rpc";
import { locale } from "../lib/format";
import { downloadMessage, downloadPhotos, type SaveProgress } from "../lib/download";
import { pinOffline, unpinOffline, watchOffline } from "../lib/offline";
import { DownloadProgress } from "../components/DownloadProgress";
import { Avatar } from "../components/Avatar";
import { ProfileMenu, type Account } from "../components/ProfileMenu";
import { Sidebar, type Activity } from "../components/Sidebar";
import { Settings, DEFAULT_SETTINGS, type AppSettings } from "./Settings";
import { applyTheme } from "../lib/theme";
import { Albums, type Album, type AlbumSort } from "./Albums";
import { Shared, type SharedItem, type Tab } from "./Shared";
import { Trash } from "./Trash";
import {
  CallMadeIcon,
  CallReceivedIcon,
  ChevronLeftIcon,
  CloseIcon,
  DownloadIcon,
  FolderOpenIcon,
  UploadArrowIcon,
  FilterIcon,
  HeartIcon,
  LibraryAddIcon,
  MoreHorizIcon,
  NavAlbumsIcon,
  NavPhotosIcon,
  NavSharedIcon,
  NavTrashIcon,
  OfflinePinIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ShareIcon,
  SwapHorizIcon,
  TrashIcon,
} from "../components/icons";
import { MEDIA_EXTENSIONS, Upload } from "../components/Upload";
import { ImportReview } from "../components/ImportReview";
import { AlbumAddPhotos } from "../components/AlbumAddPhotos";
import { Lightbox } from "../components/Lightbox";
import { Confirm } from "../components/Confirm";
import { ContextMenu, type MenuAction, type MenuAt } from "../components/ContextMenu";
import { AlbumPicker, AlbumPhotoLossDialog, NameDialog } from "../components/AlbumDialogs";
import { ShareDialog } from "../components/ShareDialog";
import { FilterPanel, type MediaType } from "../components/FilterPanel";
import { PhotoGrid, PhotoGridSkeleton } from "../components/PhotoGrid";
import { VirtualSections } from "../components/VirtualSections";
import {
  cachedThumbnail,
  connectThumbServer,
  disconnectThumbServer,
  thumbUrl,
} from "../lib/thumbStore";
import { useThumbnails } from "../hooks/useThumbnails";
import { DebugHud } from "../components/DebugHud";
import { Marquee, SelectionBar, useSelection } from "../hooks/useSelection";
import { useWarmViews } from "../hooks/useWarmViews";
import { CATEGORIES, isVideo, TAG, withFavorite } from "../lib/tags";
import { cachedMediaType } from "../lib/mediaTypes";
import { useUploads } from "../hooks/useUploads";
import { useT } from "../lib/i18n";
import { dropPreview, prefetchAfter } from "../lib/previewStore";
import "../styles/Photos.css";

/** How many neighbours on each side of the open photo to warm in advance. */
const PREFETCH_RADIUS = 2;

type TimelineItem = { uid: string; captureTime: number; tags: number[] };
type NodeMeta = { name: string; mediaType: string | null };
type View = "photos" | "albums" | "shared" | "trash";

/**
 * What to tell the viewer a photo is, and only when it is actually known.
 *
 * `undefined` is the honest answer for a photo nothing has resolved yet, and it matters:
 * the viewer reads the media type out of the details it fetches anyway, but only for a
 * caller that did not already claim to know. A confident "image" on a video is worse
 * than saying nothing, because it silences that fallback.
 */
function videoKind(item: TimelineItem): "video" | "image" | undefined {
  const known = isVideo(item.tags, cachedMediaType(item.uid));
  if (known === undefined) return undefined;
  return known ? "video" : "image";
}

// Desktop is wide, so use a size-based grid: cells stay small, many per row.
// Zoom changes the minimum cell width (in px). The chosen step is persisted in
// the settings, so the default only applies before a first choice is made.
const CELL_SIZES = [92, 116, 148, 190, 248];

// The album LIST's own zoom ladder (minimum card width in px). The first step is the
// current size, so zooming only ever makes the cards larger, down to a few per row.
const ALBUM_SIZES = [190, 230, 280, 340, 420];

// The album-sort menu's options, in display order, with their label keys.
const ALBUM_SORTS: { key: AlbumSort; labelKey: string }[] = [
  { key: "activity", labelKey: "albums.sortActivity" },
  { key: "name", labelKey: "albums.sortName" },
  { key: "count", labelKey: "albums.sortCount" },
];

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}`;
}
function monthLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
}

/** The open album's date for the masthead, in the reader's locale. Proton times can
 *  arrive in seconds or milliseconds, so normalise before formatting. */
function albumDateLabel(time: number): string {
  const ms = time < 1e11 ? time * 1000 : time;
  return new Date(ms).toLocaleDateString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * An open album's masthead: cover, title, a line of facts and the album's actions. One
 * for the reader's own albums and those shared with or by them, so a shared album opens
 * looking like any other. The shell drives its collapse through `heroRef`.
 */
function AlbumHero({
  heroRef,
  cover,
  title,
  sub,
  children,
}: {
  heroRef: RefObject<HTMLElement | null>;
  cover: string | null | undefined;
  title: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <header className="g-albumhero" ref={heroRef}>
      <div className="g-albumhero-cover">
        {cover ? <img src={cover} alt="" draggable={false} /> : <div className="g-cell-ph" />}
      </div>
      <div className="g-albumhero-meta">
        <h1 className="g-albumhero-title">{title}</h1>
        <div className="g-albumhero-sub">{sub}</div>
        {/* The album's actions, at the masthead's bottom-right like the web. */}
        <div className="g-albumhero-actions">{children}</div>
      </div>
    </header>
  );
}

export function Photos({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const t = useT();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Timeline content filter (view state, not persisted): multi-select categories
  // combined OR, plus a single media type. Both drive the grid in real time.
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [mediaType, setMediaType] = useState<MediaType>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [view, setView] = useState<View>("photos");
  // Lifted so the open album's header can share the top bar row.
  const [albumOpen, setAlbumOpen] = useState<Album | null>(null);
  // Lifted so the Shared by-me / with-me toggle can live in the top bar row too.
  const [sharedTab, setSharedTab] = useState<Tab>("by");
  const [sharedCount, setSharedCount] = useState<number | null>(null);
  // The album list's own search query (transient) and sort order, plus where the sort menu opens.
  const [albumQuery, setAlbumQuery] = useState("");
  const [albumSort, setAlbumSort] = useState<AlbumSort>("activity");
  const [albumSortAt, setAlbumSortAt] = useState<{ x: number; y: number } | null>(null);
  // A shared album looked into, lifted for the same reason as the one above: the
  // header its back button lives in belongs to this row.
  const [sharedAlbumOpen, setSharedAlbumOpen] = useState<SharedItem | null>(null);
  // Lifted so the trash's count and its empty button can share the top bar row.
  const [trashCount, setTrashCount] = useState<number | null>(null);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const [confirmTrash, setConfirmTrash] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [saveProgress, setSaveProgress] = useState<SaveProgress | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Escape belongs to the lightbox while it is open.
  const sel = useSelection(scrollRef, lightboxIdx === null);
  const { selected } = sel;
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

  const [searchFocused, setSearchFocused] = useState(false);
  const [query, setQuery] = useState("");
  const [meta, setMeta] = useState<Record<string, NodeMeta>>({});
  const [indexing, setIndexing] = useState(false);
  /** How far the search index has got, so a run cut short can pick up where it was. */
  const indexedUpTo = useRef(0);

  // Search is always on the bar now, so "engaged" is what a focus or a query makes it,
  // and that is what turns the index build on and shows the type row under the bar.
  const searchActive = searchFocused || query.trim().length > 0;

  // Once the timeline has loaded (the sidecar is signed in), fill the Explorer
  // "Proton Photos" folder with cloud-photo placeholders. Once per session.
  const mountPopulated = useRef(false);
  useEffect(() => {
    if (!mountPopulated.current && items.length > 0) {
      mountPopulated.current = true;
      void invoke("populate_mount").catch(() => {});
    }
  }, [items.length]);

  // Which photos are downloaded (hydrated placeholders) so the grid can badge them.
  // Polled, because Explorer can hydrate/free them independently of the app.
  const [localUids, setLocalUids] = useState<Set<string>>(new Set());
  useEffect(() => {
    let active = true;
    const poll = async () => {
      const uids = await invoke<string[]>("hydrated_uids").catch(() => [] as string[]);
      if (active) setLocalUids(new Set(uids));
    };
    void poll();
    const id = setInterval(poll, 4000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // Which photos the app keeps its own encrypted copy of. A different set from
  // `localUids` above, and a different place: these never reach the Explorer folder.
  // The sidecar owns the state, so this only watches it.
  const [offlineUids, setOfflineUids] = useState<Set<string>>(new Set());
  useEffect(() => watchOffline((s) => setOfflineUids(new Set(s.pinned))), []);

  // The single sidecar serves one request at a time, so the background warmer must
  // yield to more urgent work. It pauses while a photo is open (its full-res load) or
  // while the Explorer mount is populating/hydrating (a "mount-busy" signal from Rust),
  // so those own the channel and never wait behind a warm batch.
  const lightboxOpenRef = useRef(false);
  useEffect(() => {
    lightboxOpenRef.current = lightboxIdx !== null;
  }, [lightboxIdx]);

  // The host's sync state, read the way the tray popup reads it: seeded from
  // `sync_busy` because the mount may already be working when the window opens,
  // then following the transitions. It is state rather than a ref alone so the
  // avatar can show it; the warmer keeps reading the ref below, so a transition
  // does not restart its loop.
  const [mountBusy, setMountBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void invoke<boolean>("sync_busy")
      .then((b) => {
        if (!cancelled) setMountBusy(b);
      })
      .catch(() => {
        /* leave it idle if the host cannot say */
      });
    const un = listen<boolean>("mount-busy", (e) => setMountBusy(!!e.payload));
    return () => {
      cancelled = true;
      void un.then((f) => f());
    };
  }, []);

  const mountBusyRef = useRef(false);
  useEffect(() => {
    mountBusyRef.current = mountBusy;
  }, [mountBusy]);

  // Every thumbnail the warmer decrypts is for the timeline's own grid, so it has
  // no business holding the one channel while the user is looking at something
  // else. This is what made the other views sit there loading: each fetches once on
  // arrival, and that one fetch queued behind a decrypt batch and its pause.
  const offTimelineRef = useRef(false);
  useEffect(() => {
    offTimelineRef.current = view !== "photos";
  }, [view]);

  // Warm the whole thumbnail cache in the background so scrolling to any month is
  // instant instead of decrypting on demand. Gentle: small batches with a pause
  // between, and it stands aside whenever something more urgent needs the sidecar.
  useEffect(() => {
    if (items.length === 0) return;
    let cancelled = false;
    const uids = items.map((it) => it.uid);
    (async () => {
      // Kept small so one uninterruptible warm request is only ever a few
      // thumbnails: an interactive call waits at most one short batch, not twelve.
      const BATCH = 4;
      for (let i = 0; i < uids.length && !cancelled; i += BATCH) {
        // Stand aside while a photo is open, the mount is hydrating, or another
        // view is on screen and wants the channel for its own data.
        while (
          !cancelled &&
          (lightboxOpenRef.current || mountBusyRef.current || offTimelineRef.current)
        ) {
          await new Promise((r) => setTimeout(r, 300));
        }
        if (cancelled) break;
        try {
          await rpc("getThumbnails", { uids: uids.slice(i, i + BATCH) });
        } catch {
          /* keep warming the rest */
        }
        await new Promise((r) => setTimeout(r, 400)); // yield to on-screen requests
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items.length]);

  const [account, setAccount] = useState<Account | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [albumMembers, setAlbumMembers] = useState<Set<string>>(new Set());

  // The open album's header actions, raised into the top bar in the album view.
  // `albumPhotoUids` is lifted from Albums so the top bar's Download can act on the
  // whole album; `albumMoreAt` anchors the More dropdown.
  const [albumPhotoUids, setAlbumPhotoUids] = useState<string[]>([]);
  /** The open shared album's photo uids, for its masthead's Download. */
  const [sharedAlbumPhotoUids, setSharedAlbumPhotoUids] = useState<string[]>([]);
  const [albumMoreAt, setAlbumMoreAt] = useState<{ x: number; y: number } | null>(null);
  const [addPhotosOpen, setAddPhotosOpen] = useState(false);
  /** Where the open album's "Add photos" choice opens: from the library or from disk. */
  const [addPhotosAt, setAddPhotosAt] = useState<{ x: number; y: number } | null>(null);
  const [albumRenaming, setAlbumRenaming] = useState(false);
  // Which album the share dialog is for: the open one when the top bar asks, the
  // right-clicked one when the list or the sidebar does. One target serves all three.
  const [albumShareTarget, setAlbumShareTarget] = useState<Album | null>(null);
  const [albumConfirmDelete, setAlbumConfirmDelete] = useState(false);
  const [albumStranded, setAlbumStranded] = useState<number | null>(null);
  const [albumBusy, setAlbumBusy] = useState(false);
  const [pickAlbum, setPickAlbum] = useState(false);
  // Creating an album from the sidebar's own "New album" affordance, which the grid
  // offers from its first tile too; both end in a reload that keeps the two in step.
  const [albumCreating, setAlbumCreating] = useState(false);
  // Which album rename and delete act on: the open one when the header asks, the
  // right-clicked one when the list does. One pair of handlers serves both.
  const [albumTarget, setAlbumTarget] = useState<Album | null>(null);

  // The right-click menus. Each holds where the click landed and what it landed on.
  const [albumMenu, setAlbumMenu] = useState<MenuAt<Album> | null>(null);
  const [photoMenu, setPhotoMenu] = useState<MenuAt<string> | null>(null);
  const [renamingPhoto, setRenamingPhoto] = useState<{ uid: string; name: string } | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [sharingPhoto, setSharingPhoto] = useState<{ uid: string; name: string } | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Reload everything the account owns: after an upload, and after a restore puts
  // a photo back in the timeline. Stable identity, so the upload poller is not
  // restarted on every render.
  const bumpReload = useCallback(() => setReloadKey((k) => k + 1), []);
  const uploads = useUploads(bumpReload);

  // This window is only mounted while the account is unlocked, so the thumbnail server's
  // token is asked for here and let go on the way out, which is a lock or a sign-out.
  useEffect(() => {
    void connectThumbServer();
    return () => disconnectThumbServer();
  }, []);

  /** Photos and videos picked from this computer, uploaded straight into `album`. */
  async function uploadIntoAlbum(album: Album) {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: t("upload.filterName"), extensions: MEDIA_EXTENSIONS }],
    }).catch(() => null);
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    setUploadOpen(true);
    await uploads.start(paths, { uid: album.uid, name: album.name });
  }

  // Albums, Shared and the trash are mounted only while they are on screen, so
  // each arrival would start from nothing. Read them once the timeline has
  // settled, and only while the timeline is what is on screen.
  const warm = useWarmViews(!loading && items.length > 0, view === "photos", reloadKey);

  // The tray "Sync now" button asks the open window to reload its data (timeline,
  // albums, account), like a manual refresh.
  useEffect(() => {
    const un = listen("refresh-view", () => setReloadKey((k) => k + 1));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // A brief confirmation toast (download results) that clears itself.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  // A drop is accepted anywhere in the window, and the panel it belongs to is usually
  // closed when one lands, so a refused upload says so here instead of nowhere.
  useEffect(() => {
    if (uploads.error) setToast(uploads.error);
  }, [uploads.error]);

  // Account identity and Drive storage, for the avatar arc and the profile menu.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await rpc<Account>("getAccountInfo");
        if (!cancelled) setAccount(info);
      } catch {
        /* the avatar falls back to the email initial */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    (async () => {
      try {
        const raw = await invoke<string | null>("store_get", { name: "settings" });
        if (!raw) return;
        const merged: AppSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
        setSettings(merged);
        applyTheme(merged.theme, merged.palette);
      } catch {
        /* fall back to defaults */
      }
    })();
  }, []);

  function updateSettings(next: AppSettings) {
    setSettings(next);
    void invoke("store_set", { name: "settings", value: JSON.stringify(next) }).catch(() => {});
  }

  /** Pin or unpin an album in the sidebar list, holding the pin count to five. */
  function toggleAlbumPin(uid: string) {
    const pinned = settings.pinnedAlbums;
    if (pinned.includes(uid)) {
      updateSettings({ ...settings, pinnedAlbums: pinned.filter((u) => u !== uid) });
    } else if (pinned.length >= 5) {
      setToast(t("albums.pinLimit"));
    } else {
      updateSettings({ ...settings, pinnedAlbums: [...pinned, uid] });
    }
  }

  /** Remember an album as the most recently opened, so the sidebar can surface it below the
      pins. Kept to a modest window; the sidebar only ever shows the first ten of it. */
  function recordAlbumOpen(uid: string) {
    updateSettings({
      ...settings,
      recentAlbums: [uid, ...settings.recentAlbums.filter((u) => u !== uid)].slice(0, 24),
    });
  }

  // Tell the shell it is in the sidebar layout, so the window chrome can step aside:
  // the sidebar rises the full height of the window and owns the brand, and the title
  // bar drops its own duplicate, keeping only the window buttons in the top-right
  // corner. Cleared on sign-out (unmount) so the login screen keeps its normal bar.
  useEffect(() => {
    const root = document.documentElement;
    if (settings.sidebarLayout) {
      root.setAttribute("data-layout", "sidebar");
      root.setAttribute("data-sb-collapsed", settings.sidebarCollapsed ? "true" : "false");
    } else {
      root.removeAttribute("data-layout");
      root.removeAttribute("data-sb-collapsed");
    }
    return () => {
      root.removeAttribute("data-layout");
      root.removeAttribute("data-sb-collapsed");
    };
  }, [settings.sidebarLayout, settings.sidebarCollapsed]);

  // The grid zoom is a persisted preference rather than view state, so the grid
  // reopens at the size the user left it at. Reading and writing both go through
  // `settings`, so there is a single source of truth and it cannot drift.
  const zoom = settings.zoom;
  const setZoom = (next: number) =>
    updateSettings({ ...settings, zoom: Math.min(CELL_SIZES.length - 1, Math.max(0, next)) });
  // The album list carries its own zoom, so widening those cards never changes the photo
  // grid's density and the two are remembered apart.
  const albumZoom = settings.albumZoom;
  const setAlbumZoom = (next: number) =>
    updateSettings({ ...settings, albumZoom: Math.min(ALBUM_SIZES.length - 1, Math.max(0, next)) });

  // Album membership costs a walk over every album, so only resolve it when the
  // hide setting is actually on. Android takes the same "zero cost when off" path.
  useEffect(() => {
    if (!settings.hideAlbumPhotos) {
      setAlbumMembers(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const uids = await rpc<string[]>("getAlbumPhotoUids");
        if (!cancelled) setAlbumMembers(new Set(uids));
      } catch {
        /* nothing is hidden if membership cannot be resolved */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.hideAlbumPhotos, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setError("");
    (async () => {
      try {
        const timeline = await rpc<TimelineItem[]>("getTimeline");
        if (cancelled) return;
        setItems(timeline);
        setLoading(false);
        // Thumbnails load lazily per visible cell (see thumbStore), so a large
        // library does not pull every thumbnail into memory up front.
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-runs after an upload so new photos appear without a restart.
  }, [reloadKey]);

  // A reload re-reads the whole timeline, so a position in the old list says nothing
  // about the new one: index it again from the top, which is also how anything
  // uploaded since gets in.
  useEffect(() => {
    indexedUpTo.current = 0;
  }, [reloadKey]);

  // The SDK has no server-side search, so we build a local index of names and
  // media types. It streams in batches, the first time the search is engaged, and
  // results appear as it fills rather than blocking the grid. Leaving the search
  // pauses it and coming back carries on from there, so the index never stops partway
  // and answers "no matches" for everything past that point.
  useEffect(() => {
    if (!searchActive || indexedUpTo.current >= items.length) return;
    let cancelled = false;
    setIndexing(true);

    (async () => {
      const BATCH = 150; // the SDK batches node lookups server side
      for (let i = indexedUpTo.current; i < items.length && !cancelled; i += BATCH) {
        const uids = items.slice(i, i + BATCH).map((t) => t.uid);
        try {
          const res = await rpc<{ uid: string; name: string; mediaType: string | null }[]>(
            "getMetadata",
            { uids },
          );
          if (cancelled) return;
          setMeta((prev) => {
            const next = { ...prev };
            for (const r of res) next[r.uid] = { name: r.name, mediaType: r.mediaType };
            return next;
          });
        } catch {
          /* one bad batch must not stop the rest */
        }
        indexedUpTo.current = Math.min(i + BATCH, items.length);
      }
      if (!cancelled) setIndexing(false);
    })();

    return () => {
      cancelled = true;
      // Here rather than past the guard above: an interrupted run never reaches that
      // line, which is what left "Indexing…" on screen for the rest of the session.
      setIndexing(false);
    };
  }, [searchActive, items]);

  const toggleCategory = useCallback((key: string) => {
    setCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const resetFilter = useCallback(() => {
    setCategories(new Set());
    setMediaType("all");
  }, []);

  const activeFilterCount = categories.size + (mediaType === "all" ? 0 : 1);
  const query_ = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    // Categories are multi-select: an item matches if it carries a tag from ANY
    // selected category (OR) — the same union a single category already forms over
    // its own tag list (e.g. Live = Live + Motion photos).
    const selectedCats = CATEGORIES.filter((c) => categories.has(c.key));
    let base =
      selectedCats.length > 0
        ? items.filter((it) => selectedCats.some((cat) => it.tags?.some((tg) => cat.tags.includes(tg))))
        : items;

    // Android parity: the album-hide only applies to the unfiltered timeline. A
    // category selection (Favorites, Videos, ...) deliberately bypasses it.
    if (selectedCats.length === 0 && settings.hideAlbumPhotos && albumMembers.size > 0) {
      base = base.filter((it) => !albumMembers.has(it.uid));
    }

    // The Videos tag is taken as proof when it is there and as nothing when it is not,
    // so an untagged video is not filed under photos for good. What settles those is the
    // media type: from the search index where it has reached, and otherwise from
    // whatever the grid has already resolved for the cells scrolled past.
    if (mediaType !== "all") {
      const wantVideo = mediaType === "video";
      base = base.filter(
        (it) =>
          (isVideo(it.tags, meta[it.uid]?.mediaType ?? cachedMediaType(it.uid)) ?? false) ===
          wantVideo,
      );
    }

    if (query_) {
      base = base.filter((it) => {
        const m = meta[it.uid];
        if (!m) return false; // not indexed yet
        return m.name.toLowerCase().includes(query_) || (m.mediaType ?? "").toLowerCase().includes(query_);
      });
    }
    return base;
  }, [items, categories, mediaType, query_, meta, settings.hideAlbumPhotos, albumMembers]);

  // What the viewer's filmstrip and contents list walk: the same order the grid
  // shows, so stepping through the viewer and scrolling the grid agree. Memoised
  // because the viewer takes the array's identity as "the list changed", and a
  // fresh one built on every render would restart its thumbnail loading.
  const viewerItems = useMemo(
    () => filtered.map((it) => ({ uid: it.uid, name: meta[it.uid]?.name, video: videoKind(it) === "video" })),
    [filtered, meta],
  );

  // Un-favouriting under the Favorites filter drops the open photo out of the
  // grid. A stale index then renders no lightbox while still holding the grid's
  // keys and marquee disabled, so pull it back in range (or close).
  useEffect(() => {
    setLightboxIdx((i) =>
      i === null || i < filtered.length ? i : filtered.length > 0 ? filtered.length - 1 : null,
    );
  }, [filtered.length]);

  const sections = useMemo(() => {
    const map = new Map<string, { label: string; items: TimelineItem[] }>();
    for (const it of filtered) {
      const k = monthKey(it.captureTime);
      let s = map.get(k);
      if (!s) {
        s = { label: monthLabel(it.captureTime), items: [] };
        map.set(k, s);
      }
      s.items.push(it);
    }
    return [...map.values()];
  }, [filtered]);
  // The grid draws a deferred copy, so a filter chip answers at once and the grid follows
  // behind it, in work the next click can interrupt. Clearing a filter on a large library
  // brings thousands of tiles back at once, and drawing them in the click itself is what
  // made clearing one stall where setting it did not.
  const shownSections = useDeferredValue(sections);
  const virtualSections = useMemo(
    () => shownSections.map((s) => ({ key: s.label, items: s.items })),
    [shownSections],
  );

  // The timeline photos not already in the open album, for the "Add photos" picker.
  // `albumPhotoUids` is what Albums reported up, so this stays in step with the album.
  const albumCandidates = useMemo(() => {
    const inAlbum = new Set(albumPhotoUids);
    return items.filter((it) => !inAlbum.has(it.uid));
  }, [items, albumPhotoUids]);

  // The open album's cover for the masthead, resolved on demand: the list may not have
  // warmed it if the album was reached from the sidebar.
  const heroCoverUids = useMemo(
    () => [albumOpen?.coverUid, sharedAlbumOpen?.coverUid].filter((u): u is string => !!u),
    [albumOpen?.coverUid, sharedAlbumOpen?.coverUid],
  );
  const albumCoverThumbs = useThumbnails(heroCoverUids);

  // The masthead is a sticky header (see .g-albumhero): it pins to the top of the scroll
  // so the album's cover, title and actions stay in view while the photos scroll under it.

  /** Drop a trashed photo from the grid and keep the lightbox on a valid item. */
  function handleTrashed(uid: string) {
    setItems((prev) => prev.filter((it) => it.uid !== uid));
    setLightboxIdx((i) => {
      if (i === null) return null;
      const remaining = filtered.length - 1;
      if (remaining <= 0) return null;
      return Math.min(i, remaining - 1);
    });
  }

  function handleRenamed(uid: string, name: string) {
    setMeta((m) => ({ ...m, [uid]: { name, mediaType: m[uid]?.mediaType ?? null } }));
  }

  /** The timeline's tags are what the Favorites filter and the grid badge read. */
  function handleFavoriteChanged(uid: string, favorite: boolean) {
    setItems((prev) =>
      prev.map((it) => (it.uid === uid ? { ...it, tags: withFavorite(it.tags, favorite) } : it)),
    );
  }

  /** The timeline's favourites, for the albums' menus and viewer, which list uids alone. */
  const favoriteUids = useMemo(
    () => new Set(items.filter((it) => it.tags?.includes(TAG.Favorite)).map((it) => it.uid)),
    [items],
  );

  /**
   * Favourites the selection, for the right-click menu. The hearts flip now and
   * the ones the server refuses flip back, so the grid never keeps a heart Proton
   * does not have.
   */
  async function favoriteSelected(favorite: boolean) {
    const uids = [...selected];
    if (uids.length === 0) return;
    uids.forEach((u) => handleFavoriteChanged(u, favorite));
    try {
      const results = await rpc<{ uid: string; ok: boolean }[]>("setFavorite", { uids, favorite });
      const failed = results.filter((r) => !r.ok);
      failed.forEach((r) => handleFavoriteChanged(r.uid, !favorite));
      if (failed.length > 0) setToast(t("viewer.favoriteFailed"));
    } catch (e) {
      uids.forEach((u) => handleFavoriteChanged(u, !favorite));
      setToast(String(e));
    }
  }

  /**
   * One photo's name, which the dialogs below need and the grid does not have:
   * the timeline carries uids and tags only, and the search index is the one
   * thing that ever asks for names, so on an unsearched library it has to be
   * fetched. Null means there is no name to show, and any failure has already
   * been reported by the time it returns.
   */
  async function photoName(uid: string): Promise<string | null> {
    const known = meta[uid]?.name;
    if (known !== undefined) return known;
    try {
      const [m] = await rpc<{ uid: string; name: string; mediaType: string | null }[]>(
        "getMetadata",
        { uids: [uid] },
      );
      if (!m) return null;
      setMeta((prev) => ({ ...prev, [m.uid]: { name: m.name, mediaType: m.mediaType } }));
      return m.name;
    } catch (e) {
      setToast(String(e));
      return null;
    }
  }

  /** Opens the rename box, which is why the name is fetched: it never opens empty. */
  async function openRenamePhoto(uid: string) {
    const name = await photoName(uid);
    if (name !== null) setRenamingPhoto({ uid, name });
  }

  /**
   * Opens the share dialog. The name is only the subtitle there, so a photo
   * whose name could not be read is still shareable rather than unreachable.
   */
  async function openSharePhoto(uid: string) {
    setSharingPhoto({ uid, name: (await photoName(uid)) ?? "" });
  }

  async function renamePhoto(name: string) {
    const target = renamingPhoto;
    if (!target) return;
    setRenameBusy(true);
    try {
      const res = await rpc<{ uid: string; name: string }>("renamePhoto", {
        uid: target.uid,
        name,
      });
      handleRenamed(res.uid, res.name);
    } catch (e) {
      setToast(String(e));
    } finally {
      setRenameBusy(false);
      setRenamingPhoto(null);
    }
  }

  /**
   * A right-click acts on what is highlighted, so a photo outside the selection
   * becomes the selection first — the way a file manager does it. Right-clicking
   * inside a selection leaves it alone, so a menu can act on all of it.
   */
  function onCellContext(uid: string, e: { clientX: number; clientY: number }) {
    if (!selected.has(uid)) sel.setSelected(new Set([uid]));
    setPhotoMenu({ x: e.clientX, y: e.clientY, target: uid });
  }

  // The SDK offers no prefetch, so we warm the neighbours ourselves. The sidecar
  // serves repeats from its encrypted on-disk cache, so this is cheap. It waits for
  // the open photo's own preview to resolve first, so the warm never competes with
  // the one the user is actually waiting for on the single channel.
  useEffect(() => {
    if (lightboxIdx === null) return;
    const current = filtered[lightboxIdx];
    if (!current) return;
    const uids: string[] = [];
    for (let d = 1; d <= PREFETCH_RADIUS; d++) {
      const next = filtered[lightboxIdx + d];
      const prev = filtered[lightboxIdx - d];
      if (next) uids.push(next.uid);
      if (prev) uids.push(prev.uid);
    }
    return prefetchAfter(current.uid, uids);
  }, [lightboxIdx, filtered]);

  /**
   * Moves the selection to the trash. Only what actually went leaves the grid,
   * and the count says so: a photo the server kept is still there, and saying
   * nothing about it would leave the grid disagreeing with the trash.
   */
  async function trashSelected() {
    const uids = [...selected];
    if (uids.length === 0) return;
    setError("");
    try {
      const results = await rpc<{ uid: string; ok: boolean }[]>("trashPhotos", { uids });
      const gone = new Set(results.filter((r) => r.ok).map((r) => r.uid));
      gone.forEach(dropPreview);
      setItems((prev) => prev.filter((it) => !gone.has(it.uid)));
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

  /** Destroys the whole trash. The view below refetches once it is done. */
  async function emptyTrash() {
    try {
      await rpc("emptyTrash");
      setToast(t("trash.emptied"));
      bumpReload();
    } catch (e) {
      setToast(String(e));
    }
  }

  /**
   * Puts the selected photos in an album. The whole selection goes down in one
   * call: the SDK batches it to the server's ten-link cap itself, counting the
   * related parts a photo brings with it.
   */
  async function addSelectedToAlbum(albumUid: string) {
    const uids = [...selected];
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
      setPickAlbum(false);
      sel.clear();
      // The album now owns them, which the timeline hides if asked to.
      if (added > 0) bumpReload();
    } catch (e) {
      setToast(String(e));
      setPickAlbum(false);
    } finally {
      setAlbumBusy(false);
    }
  }

  async function createAlbum(name: string) {
    setAlbumBusy(true);
    try {
      const album = await rpc<Album>("createAlbum", { name });
      setAlbumCreating(false);
      setView("albums");
      setAlbumOpen(album);
      bumpReload();
    } catch (e) {
      setToast(String(e));
      setAlbumCreating(false);
    } finally {
      setAlbumBusy(false);
    }
  }

  async function renameAlbum(name: string) {
    const target = albumTarget;
    if (!target) return;
    setAlbumBusy(true);
    try {
      const res = await rpc<{ uid: string; name: string }>("renameAlbum", {
        uid: target.uid,
        name,
      });
      // The header follows only when the album it is showing is the one renamed;
      // renaming another from the list must not disturb it.
      setAlbumOpen((o) => (o?.uid === target.uid ? { ...o, name: res.name } : o));
      setAlbumRenaming(false);
      bumpReload();
    } catch (e) {
      setToast(String(e));
      setAlbumRenaming(false);
    } finally {
      setAlbumBusy(false);
    }
  }

  /**
   * Deletes the album the header or the list picked out. Asked plainly first,
   * with neither option: the server refuses if photos live only in there, and
   * that refusal is the one chance to ask before they are gone. Answering it is
   * `AlbumPhotoLossDialog`'s job.
   */
  async function deleteAlbum(options: { force?: boolean; saveToTimeline?: boolean } = {}) {
    const target = albumTarget;
    if (!target) return;
    setAlbumBusy(true);
    try {
      const res = await rpc<{ status: string; count?: number }>("deleteAlbum", {
        uid: target.uid,
        ...options,
      });
      if (res.status === "photosNotInTimeline") {
        setAlbumStranded(res.count ?? 0);
        return;
      }
      setAlbumStranded(null);
      // Closing the album only makes sense when it is the one that just went.
      setAlbumOpen((o) => (o?.uid === target.uid ? null : o));
      setToast(t("albums.deleted"));
      bumpReload();
    } catch (e) {
      setAlbumStranded(null);
      setToast(String(e));
    } finally {
      setAlbumBusy(false);
    }
  }

  // "Download" = fill the selected photos into the Proton Photos folder with the
  // Explorer mount on (their placeholders hydrate in place, ending as a green check),
  // or save the originals into a folder the user picks with it off. `downloadPhotos`
  // picks the mode.
  async function downloadSelected() {
    const all = [...selected];
    if (all.length === 0) return;
    // Skip photos already downloaded; re-selecting one of those is a no-op. Nothing is
    // downloaded with the mount off, so there the whole selection goes.
    const uids = all.filter((u) => !localUids.has(u));
    if (uids.length === 0) {
      setToast(t("download.alreadyDownloaded"));
      sel.clear();
      return;
    }
    try {
      const result = await downloadPhotos(uids, {
        onStart: () => setDownloading(true),
        onProgress: setSaveProgress,
      });
      if (result.mode === "cancelled") return;
      sel.clear();
      const message = downloadMessage(result);
      if (message) setToast(t(message.key, message.vars));
    } catch (e) {
      setToast(String(e));
    } finally {
      setDownloading(false);
      setSaveProgress(null);
    }
  }

  // Download an album straight from the list or the sidebar, without opening it: its
  // photo uids are not loaded, so they are fetched first, then handed to the same
  // download the rest of the app uses.
  async function downloadAlbumFromList(album: Album) {
    try {
      const rows = await rpc<{ uid: string }[]>("getAlbumPhotos", { uid: album.uid });
      const uids = rows.map((r) => r.uid).filter((u) => !localUids.has(u));
      if (uids.length === 0) {
        setToast(t("download.alreadyDownloaded"));
        return;
      }
      const result = await downloadPhotos(uids, {
        onStart: () => setDownloading(true),
        onProgress: setSaveProgress,
      });
      if (result.mode === "cancelled") return;
      const message = downloadMessage(result);
      if (message) setToast(t(message.key, message.vars));
    } catch (e) {
      setToast(String(e));
    } finally {
      setDownloading(false);
      setSaveProgress(null);
    }
  }

  // Download the whole open album, for the album top bar. Mirrors downloadSelected
  // over every photo the album holds (lifted up from Albums), minus the local ones.
  async function downloadAlbumAll(albumUids: string[] = albumPhotoUids) {
    const uids = albumUids.filter((u) => !localUids.has(u));
    if (uids.length === 0) {
      setToast(t("download.alreadyDownloaded"));
      return;
    }
    try {
      const result = await downloadPhotos(uids, {
        onStart: () => setDownloading(true),
        onProgress: setSaveProgress,
      });
      if (result.mode === "cancelled") return;
      const message = downloadMessage(result);
      if (message) setToast(t(message.key, message.vars));
    } catch (e) {
      setToast(String(e));
    } finally {
      setDownloading(false);
      setSaveProgress(null);
    }
  }

  // Add timeline photos to the open album, from the "Add photos" picker. Mirrors
  // addSelectedToAlbum, but over the picker's chosen uids and against the open album.
  async function addPhotosToOpenAlbum(uids: string[]) {
    if (!albumOpen || uids.length === 0) return;
    setAlbumBusy(true);
    try {
      const results = await rpc<{ uid: string; ok: boolean }[]>("addPhotosToAlbum", {
        albumUid: albumOpen.uid,
        uids,
      });
      const added = results.filter((r) => r.ok).length;
      const failed = results.length - added;
      setToast(
        failed > 0
          ? t("albums.addPartial", { ok: added, failed })
          : t("albums.added", { count: added }),
      );
      setAddPhotosOpen(false);
      if (added > 0) bumpReload();
    } catch (e) {
      setToast(String(e));
      setAddPhotosOpen(false);
    } finally {
      setAlbumBusy(false);
    }
  }

  // Remove the local copy of the selected photos (dehydrate back to cloud-only).
  // Reports the photos the host actually freed, not the ones asked for.
  async function freeUpSelected() {
    const uids = [...selected].filter((u) => localUids.has(u));
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

  // Keep the selection inside the app, encrypted, so it opens with no connection.
  // Nothing is written to the Proton Photos folder: that is Download's job, above.
  async function offlineAddSelected() {
    const uids = [...selected].filter((u) => !offlineUids.has(u));
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

  /** Drop the app's own copies and reclaim the space they held. */
  async function offlineRemoveSelected() {
    const uids = [...selected].filter((u) => offlineUids.has(u));
    if (uids.length === 0) {
      setToast(t("offline.noneOffline"));
      sel.clear();
      return;
    }
    try {
      const removed = await unpinOffline(uids);
      sel.clear();
      setToast(t(removed === 1 ? "offline.removed.one" : "offline.removed.other", { count: removed }));
    } catch (e) {
      setToast(String(e));
    }
  }

  // Only while the timeline is the view on screen: Albums and the trash keep their own.
  sel.order.current = view === "photos" ? filtered.map((f) => f.uid) : [];

  /**
   * A click on a tile: ignore the one a drag emits, otherwise select or open. Shift or
   * Ctrl selects even with nothing selected yet, as in File Explorer.
   */
  function onCellClick(uid: string, e?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
    if (sel.wasDragging()) return;
    if (selected.size > 0 || e?.shiftKey || e?.ctrlKey || e?.metaKey) sel.toggle(uid, e);
    else setLightboxIdx(filtered.findIndex((f) => f.uid === uid));
  }

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    // The album list zooms its own cards; the timeline and an open album share the photo zoom.
    if (view === "albums" && !albumOpen) {
      setAlbumZoom(e.deltaY > 0 ? albumZoom - 1 : albumZoom + 1);
    } else {
      setZoom(e.deltaY > 0 ? zoom - 1 : zoom + 1);
    }
  }

  const cellSize = CELL_SIZES[zoom];
  const albumCellSize = ALBUM_SIZES[albumZoom];

  // The open album's masthead is a sticky header that compresses as the grid scrolls: the
  // cover shrinks, the date/count fades and the title tightens, so it stays a thin bar
  // rather than vanishing. It loses one pixel of height for each pixel scrolled, and the
  // spacer after it gains that pixel back, so the grid below never moves. When the grid
  // moved with it, the browser's scroll anchoring corrected the scroll, which moved the
  // masthead again: the stutter while scrolling.
  const heroRef = useRef<HTMLElement>(null);
  const heroSpacerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    const hero = heroRef.current;
    const spacer = heroSpacerRef.current;
    const heroShown = (view === "albums" && albumOpen) || (view === "shared" && sharedAlbumOpen);
    if (!heroShown || !scroller || !hero || !spacer) return;
    const COLLAPSED = 96;
    let full = 0;
    const measure = () => {
      hero.style.height = "";
      hero.style.setProperty("--c", "0");
      full = hero.offsetHeight;
    };
    const apply = () => {
      const height = Math.max(full - scroller.scrollTop, Math.min(COLLAPSED, full));
      const c = full > COLLAPSED ? (full - height) / (full - COLLAPSED) : 0;
      hero.style.height = `${height}px`;
      hero.style.setProperty("--c", c.toFixed(4));
      spacer.style.height = `${full - height}px`;
    };
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    const onResize = () => {
      measure();
      apply();
    };
    onResize();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, albumOpen, sharedAlbumOpen]);


  // The opt-in left-navigation layout. When on, the bottom dock and the top-bar
  // avatar step aside: both move into the sidebar.
  const sidebar = settings.sidebarLayout;

  // What the sidebar's upload button announces: the live transfer/index/sync readout,
  // surfaced where it is easy to notice. An upload outranks a
  // download, which outranks the search index, which outranks a background sync.
  const downloadCount =
    saveProgress && saveProgress.total > 0 ? `${saveProgress.done}/${saveProgress.total}` : "";
  const activity: Activity | null = uploads.running
    ? {
        kind: "upload",
        label: uploads.progressLabel
          ? `${t("avatar.uploading")} ${uploads.progressLabel}`
          : t("avatar.uploading"),
      }
    : downloading
      ? {
          kind: "download",
          label: downloadCount
            ? `${t("sidebar.downloading")} ${downloadCount}`
            : t("sidebar.downloading"),
        }
      : indexing
        ? { kind: "index" }
        : loading || mountBusy
          ? { kind: "sync" }
          : null;

  const current = lightboxIdx !== null ? filtered[lightboxIdx] : null;

  // Rename and delete are the album header's own actions, pointed at whichever
  // album the click picked out rather than at a second copy of them.
  const albumActions: MenuAction[] = albumMenu
    ? [
        {
          key: "rename",
          label: t("albums.rename"),
          icon: <PencilIcon size={14} />,
          onSelect: () => {
            setAlbumTarget(albumMenu.target);
            setAlbumRenaming(true);
          },
        },
        {
          key: "share",
          label: t("albums.share"),
          icon: <ShareIcon size={14} />,
          onSelect: () => setAlbumShareTarget(albumMenu.target),
        },
        {
          key: "download",
          label: t("selection.download"),
          icon: <DownloadIcon size={14} />,
          onSelect: () => void downloadAlbumFromList(albumMenu.target),
        },
        {
          key: "delete",
          label: t("albums.delete"),
          icon: <TrashIcon size={14} />,
          separator: true,
          danger: true,
          onSelect: () => {
            setAlbumTarget(albumMenu.target);
            setAlbumConfirmDelete(true);
          },
        },
      ]
    : [];

  // The right-clicked photo settles what the heart says; the action then applies
  // to everything highlighted, which is that photo unless a selection was already
  // standing. Renaming is the one thing a selection cannot share, so it is offered
  // only when there is exactly one photo to name. Trashing sits last, past the
  // things that can be taken back, as it does in the selection bar.
  const photoFavorite = !!photoMenu &&
    !!items.find((it) => it.uid === photoMenu.target)?.tags?.includes(TAG.Favorite);
  // Same rule for the offline copy: the photo under the cursor decides which way the
  // one entry points, so the menu never offers both at once.
  const photoOffline = !!photoMenu && offlineUids.has(photoMenu.target);
  // The selection bar follows the same rule, over the whole selection: taking the
  // copies back is only offered once there is nothing left in it to keep. Offering
  // both at once read as a contradiction, and cost the row a button it needed.
  const allSelectedOffline = useMemo(
    () => selected.size > 0 && [...selected].every((u) => offlineUids.has(u)),
    [selected, offlineUids],
  );
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
        // Renaming and sharing both name one node, so neither is offered while
        // a selection stands: there would be no saying which one they meant.
        ...(selected.size === 1
          ? [
              {
                key: "rename",
                label: t("selection.rename"),
                icon: <PencilIcon size={14} />,
                onSelect: () => void openRenamePhoto(photoMenu.target),
              },
              {
                key: "share",
                label: t("selection.share"),
                icon: <ShareIcon size={14} />,
                onSelect: () => void openSharePhoto(photoMenu.target),
              },
            ]
          : []),
        {
          key: "offline",
          label: photoOffline ? t("selection.offlineRemove") : t("selection.offlineAdd"),
          icon: <OfflinePinIcon size={14} />,
          onSelect: () =>
            void runSelection(photoOffline ? offlineRemoveSelected : offlineAddSelected),
        },
        {
          key: "download",
          label: t("selection.download"),
          icon: <DownloadIcon size={14} />,
          onSelect: () => void runSelection(downloadSelected),
        },
        ...(selected.size === 1 && localUids.has(photoMenu.target)
          ? [
              {
                key: "reveal",
                label: t("selection.showInFolder"),
                icon: <FolderOpenIcon size={14} />,
                onSelect: () =>
                  void invoke("reveal_photo", { uid: photoMenu.target }).catch((e) =>
                    setToast(String(e)),
                  ),
              },
            ]
          : []),
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

  return (
    <div className={`gallery${sidebar ? " has-sidebar" : ""}`}>
      {sidebar && (
        <Sidebar
          view={view}
          onView={setView}
          collapsed={settings.sidebarCollapsed}
          onToggleCollapsed={() =>
            updateSettings({ ...settings, sidebarCollapsed: !settings.sidebarCollapsed })
          }
          account={account}
          email={email}
          activity={activity}
          dragging={uploads.dragging}
          onProfile={() => setMenuOpen((o) => !o)}
          onUpload={() => setUploadOpen(true)}
          onNewAlbum={() => setAlbumCreating(true)}
          reloadKey={reloadKey}
          initialAlbums={warm.albums}
          openAlbumUid={albumOpen?.uid ?? null}
          onOpenAlbum={(a) => {
            setView("albums");
            setAlbumOpen(a);
            recordAlbumOpen(a.uid);
          }}
          pinnedUids={settings.pinnedAlbums}
          recentUids={settings.recentAlbums}
          onTogglePin={toggleAlbumPin}
          onAlbumContext={(album, e) =>
            setAlbumMenu({ x: e.clientX, y: e.clientY, target: album })
          }
        />
      )}
      <div className="g-main">
      <div className="g-topbar">
        {view === "photos" && (
          <>
            <button
              className={`g-filterpill ${activeFilterCount > 0 ? "active" : ""}`}
              onClick={() => setFilterOpen((o) => !o)}
              title={t("filter.title")}
            >
              <FilterIcon size={13} />
              <span>{activeFilterCount > 0 ? t("filter.title") : t("photos.all")}</span>
              {activeFilterCount > 0 && <span className="g-filterbadge">{activeFilterCount}</span>}
              <span className="g-filtercount">{filtered.length}</span>
            </button>
            <div className="g-search">
              <SearchIcon size={15} />
              <input
                className="g-searchfield"
                placeholder={t("photos.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    e.currentTarget.blur();
                  }
                }}
              />
              {query && (
                <button
                  className="g-searchx"
                  title={t("photos.closeSearch")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setQuery("")}
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </div>
            <div className="g-spacer" data-tauri-drag-region={sidebar ? "" : undefined} />
          </>
        )}
        {/* The album LIST gets the same search field the timeline has (filtering album
            names) plus a sort control, mirrored from the phone app. */}
        {view === "albums" && !albumOpen && (
          <>
            {/* Same order as the timeline: the sort/filter control first, the search after. */}
            <button
              className="g-filterpill"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setAlbumSortAt({ x: r.left, y: r.bottom + 6 });
              }}
              title={t(ALBUM_SORTS.find((s) => s.key === albumSort)!.labelKey)}
            >
              <FilterIcon size={13} />
              <span>{t(ALBUM_SORTS.find((s) => s.key === albumSort)!.labelKey)}</span>
            </button>
            <div className="g-search">
              <SearchIcon size={15} />
              <input
                className="g-searchfield"
                placeholder={t("albums.searchHint")}
                value={albumQuery}
                onChange={(e) => setAlbumQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setAlbumQuery("");
                    e.currentTarget.blur();
                  }
                }}
              />
              {albumQuery && (
                <button
                  className="g-searchx"
                  title={t("photos.closeSearch")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setAlbumQuery("")}
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </div>
            <div className="g-spacer" data-tauri-drag-region={sidebar ? "" : undefined} />
          </>
        )}
        {/* Just the crumb back to the list plus a drag region. The album's cover, title,
            count and actions all live in the masthead at the top of the grid. */}
        {view === "albums" && albumOpen && (
          <>
            <button className="g-back" onClick={() => setAlbumOpen(null)} title={t("albums.backToAlbums")}>
              <ChevronLeftIcon />
              {t("nav.albums")}
            </button>
            <div className="g-spacer" data-tauri-drag-region={sidebar ? "" : undefined} />
          </>
        )}
        {view === "shared" && !sharedAlbumOpen && (
          <>
            {/* Android's control for the same choice: one pill that turns round,
                not two that compete. The arrow says which way the sharing goes and
                the swap mark says a click flips it. */}
            <button
              className="g-filterpill g-sharedpill"
              onClick={() => setSharedTab(sharedTab === "with" ? "by" : "with")}
              title={t("shared.flip")}
            >
              <span className="g-shareway">
                {sharedTab === "with" ? <CallReceivedIcon /> : <CallMadeIcon />}
              </span>
              <span>{t(sharedTab === "with" ? "shared.withMe" : "shared.byMe")}</span>
              <span className="g-shareswap">
                <SwapHorizIcon />
              </span>
            </button>
            {!!sharedCount && <span className="g-headpill count">{sharedCount}</span>}
          </>
        )}
        {/* The open shared album takes the row the tab pill was using. The name does
            not rename here: an album reached through sharing may not be the reader's
            to rename, and the one that is has its own screen where it can be. */}
        {view === "shared" && sharedAlbumOpen && (
          <>
            <button
              className="g-back"
              onClick={() => setSharedAlbumOpen(null)}
              title={t("shared.back")}
            >
              <ChevronLeftIcon />
              {t("nav.shared")}
            </button>
          </>
        )}
        {view === "trash" && (
          <>
            {/* No redundant "Trash" label; the nav already says which view this is. A
                count of nothing is not worth a pill, and neither is emptying an empty
                trash, so both wait until there is something in there. */}
            {!!trashCount && <span className="g-headpill count">{trashCount}</span>}
            {!!trashCount && (
              <button className="g-chip danger" onClick={() => setConfirmEmpty(true)}>
                {t("trash.emptyAction")}
              </button>
            )}
          </>
        )}
        {(view === "shared" || view === "trash") && (
          <div className="g-spacer" data-tauri-drag-region={sidebar ? "" : undefined} />
        )}
        {/* In the sidebar layout the upload button lives on the sidebar instead, and
            the avatar with it, so the top bar's right side clears for the window
            buttons that tuck into that corner. */}
        {!sidebar && (
          <button
            className={`g-uploadbtn ${uploads.running ? "busy" : ""}`}
            onClick={() => setUploadOpen(true)}
            title={
              uploads.running
                ? t("photos.uploadingProgress", { progress: uploads.progressLabel })
                : t("photos.uploadTitle")
            }
          >
            <span className="g-uparrow">
              <UploadArrowIcon size={16} />
            </span>
            {uploads.running ? uploads.progressLabel : t("upload.title")}
          </button>
        )}
        {!sidebar && (
          <Avatar
            initial={account?.initial ?? email.charAt(0).toUpperCase()}
            storageFraction={account && account.maxSpace > 0 ? account.usedSpace / account.maxSpace : 0}
            uploading={uploads.running}
            // The timeline's own first read, and whatever the host is syncing
            // behind it: the same signal the tray's status line shows. An upload
            // outranks both, and says so in its own colour.
            syncing={(loading || mountBusy) && !uploads.running}
            onClick={() => setMenuOpen((o) => !o)}
            onArrowClick={() => setUploadOpen(true)}
          />
        )}
      </div>

      {menuOpen && (
        <ProfileMenu
          placement={sidebar ? "sidebar" : "topright"}
          account={account}
          onClose={() => setMenuOpen(false)}
          onSettings={() => {
            setMenuOpen(false);
            setSettingsOpen(true);
          }}
          onSignOut={() => {
            setMenuOpen(false);
            onSignOut();
          }}
        />
      )}

      {settingsOpen && (
        <Settings
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {view === "photos" && filterOpen && (
        <FilterPanel
          categories={categories}
          onToggleCategory={toggleCategory}
          mediaType={mediaType}
          onMediaType={setMediaType}
          activeCount={activeFilterCount}
          onReset={resetFilter}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {/* The category rail stays put whether or not the search is active, and its chips
          keep the focus in the search box (mousedown preventDefault) so they can be toggled
          mid-search. The indexing readout rides along here rather than in a row of its own. */}
      {view === "photos" && (
        <div className="g-catrail">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              className={`g-chip ${categories.has(c.key) ? "sel" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleCategory(c.key)}
            >
              {t(`category.${c.key}`)}
            </button>
          ))}
          {indexing && (
            <span className="g-indexing">
              {t("photos.indexing", { done: Object.keys(meta).length, total: items.length })}
            </span>
          )}
        </div>
      )}

      {/* Albums and Shared run their own selection, so only bind ours here. */}
      <div
        className="g-scroll"
        ref={scrollRef}
        onWheel={onWheel}
        {...(view === "photos" ? sel.containerProps : {})}
      >
        {/* A gentle cross-fade on the view swap, keyed to the view, so switching tabs
            fades in rather than snapping. */}
        <div key={view} className="g-viewfade">
        {view === "albums" ? (
          <>
            {albumOpen && (
              <AlbumHero
                heroRef={heroRef}
                cover={albumOpen.coverUid ? albumCoverThumbs[albumOpen.coverUid] : null}
                title={albumOpen.name || t("albums.untitled")}
                sub={`${albumDateLabel(albumOpen.lastActivityTime)} · ${t(
                  albumOpen.photoCount === 1 ? "common.photoCount.one" : "common.photoCount.other",
                  { count: albumOpen.photoCount },
                )}`}
              >
                <button
                  className="g-heroact"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setAddPhotosAt({ x: r.left, y: r.bottom + 4 });
                  }}
                  disabled={albumBusy}
                >
                  <PlusIcon size={17} />
                  <span>{t("albums.addPhotos")}</span>
                </button>
                <button
                  className="g-heroact"
                  onClick={() => void downloadAlbumAll()}
                  disabled={downloading || albumPhotoUids.length === 0}
                >
                  <DownloadIcon size={17} />
                  <span>{t("selection.download")}</span>
                </button>
                <button
                  className="g-heroact"
                  onClick={() => setAlbumShareTarget(albumOpen)}
                  disabled={albumBusy}
                >
                  <ShareIcon size={17} />
                  <span>{t("albums.share")}</span>
                </button>
                <button
                  className="g-heroact"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setAlbumMoreAt({ x: r.right, y: r.bottom + 4 });
                  }}
                  disabled={albumBusy}
                >
                  <MoreHorizIcon size={17} />
                  <span>{t("albums.more")}</span>
                </button>
              </AlbumHero>
            )}
            {albumOpen && <div className="g-albumhero-spacer" ref={heroSpacerRef} aria-hidden />}
            <Albums
              cellSize={cellSize}
              albumCellSize={albumCellSize}
              query={albumQuery}
              sort={albumSort}
              open={albumOpen}
              onOpenChange={(a) => {
                setAlbumOpen(a);
                if (a) recordAlbumOpen(a.uid);
              }}
              localUids={localUids}
              offlineUids={offlineUids}
              reloadKey={reloadKey}
              initial={warm.albums}
              onChanged={bumpReload}
              onPhotoUids={setAlbumPhotoUids}
              onAlbumContext={(album, e) =>
                setAlbumMenu({ x: e.clientX, y: e.clientY, target: album })
              }
              favoriteUids={favoriteUids}
              onFavoriteChanged={handleFavoriteChanged}
              onData={warm.putAlbums}
            />
          </>
        ) : view === "shared" ? (
          <>
            {sharedAlbumOpen && (
              <AlbumHero
                heroRef={heroRef}
                cover={sharedAlbumOpen.coverUid ? albumCoverThumbs[sharedAlbumOpen.coverUid] : null}
                title={sharedAlbumOpen.name || t("albums.untitled")}
                sub={[
                  ...(sharedAlbumOpen.lastActivityTime
                    ? [albumDateLabel(sharedAlbumOpen.lastActivityTime)]
                    : []),
                  ...(sharedCount != null
                    ? [
                        t(sharedCount === 1 ? "common.photoCount.one" : "common.photoCount.other", {
                          count: sharedCount,
                        }),
                      ]
                    : []),
                ].join(" · ")}
              >
                <button
                  className="g-heroact"
                  onClick={() => void downloadAlbumAll(sharedAlbumPhotoUids)}
                  disabled={downloading || sharedAlbumPhotoUids.length === 0}
                >
                  <DownloadIcon size={17} />
                  <span>{t("selection.download")}</span>
                </button>
                {/* Only the owner manages who it is shared with; one shared with the reader
                    is someone else's to change. */}
                {sharedTab === "by" && (
                  <button
                    className="g-heroact"
                    onClick={() =>
                      setAlbumShareTarget({
                        uid: sharedAlbumOpen.uid,
                        name: sharedAlbumOpen.name,
                        photoCount: sharedAlbumOpen.photoCount ?? 0,
                        coverUid: sharedAlbumOpen.coverUid,
                        lastActivityTime: sharedAlbumOpen.lastActivityTime ?? 0,
                      })
                    }
                  >
                    <ShareIcon size={17} />
                    <span>{t("shared.manage")}</span>
                  </button>
                )}
              </AlbumHero>
            )}
            {sharedAlbumOpen && <div className="g-albumhero-spacer" ref={heroSpacerRef} aria-hidden />}
            <Shared
              cellSize={cellSize}
              tab={sharedTab}
              open={sharedAlbumOpen}
              onOpenChange={setSharedAlbumOpen}
              // Only the tab the warm read covers; the other one reads itself.
              initial={sharedTab === "by" ? warm.shared : null}
              onCount={setSharedCount}
              onData={(rows) => sharedTab === "by" && warm.putShared(rows)}
              onPhotoUids={setSharedAlbumPhotoUids}
            />
          </>
        ) : view === "trash" ? (
          <Trash
            cellSize={cellSize}
            reloadKey={reloadKey}
            initial={warm.trash}
            onCount={setTrashCount}
            onRestored={bumpReload}
            onData={warm.putTrash}
          />
        ) : (
          <>
            {error && <div className="g-error">{error}</div>}

            {loading && items.length === 0 && <PhotoGridSkeleton count={30} cellSize={cellSize} />}

            {!loading && filtered.length === 0 && !error && (
              <div className="g-empty">
                <p className="g-empty-title">
                  {activeFilterCount > 0 || query_ ? t("photos.noMatches") : t("photos.noPhotos")}
                </p>
                {!(activeFilterCount > 0 || query_) && (
                  <p className="g-empty-sub">{t("photos.noPhotosSub")}</p>
                )}
                {query_ && indexing && (
                  <p className="g-empty-sub">{t("photos.stillIndexing")}</p>
                )}
              </div>
            )}

            <VirtualSections
              scrollRef={scrollRef}
              sections={virtualSections}
              cellSize={cellSize}
              header={(s) => (
                <div className="g-monthhdr">
                  <span className="g-monthtitle">{s.key}</span>
                  <span className="g-monthcount">
                    {t(s.items.length === 1 ? "common.photoCount.one" : "common.photoCount.other", {
                      count: s.items.length,
                    })}
                  </span>
                </div>
              )}
              grid={(_, items) => (
                <PhotoGrid
                  items={items}
                  cellSize={cellSize}
                  selected={selected}
                  onToggle={sel.toggle}
                  onOpen={onCellClick}
                  onContext={onCellContext}
                  offlineUids={offlineUids}
                  localUids={localUids}
                />
              )}
            />
          </>
        )}
        </div>
      </div>
      </div>

      {!sidebar && (
        <div className="g-dock">
          <button className={`g-tab ${view === "photos" ? "sel" : ""}`} onClick={() => setView("photos")}>
            <NavPhotosIcon size={17} />
            <span>{t("nav.photos")}</span>
          </button>
          <button className={`g-tab ${view === "albums" ? "sel" : ""}`} onClick={() => setView("albums")}>
            <NavAlbumsIcon size={17} />
            <span>{t("nav.albums")}</span>
          </button>
          <button className={`g-tab ${view === "shared" ? "sel" : ""}`} onClick={() => setView("shared")}>
            <NavSharedIcon size={17} />
            <span>{t("nav.shared")}</span>
          </button>
          <button className={`g-tab ${view === "trash" ? "sel" : ""}`} onClick={() => setView("trash")}>
            <NavTrashIcon size={17} />
            <span>{t("nav.trash")}</span>
          </button>
        </div>
      )}

      {settings.debug && <DebugHud itemCount={items.length} />}

      {loading && items.length > 0 && view === "photos" && (
        <div className="g-loadhint">{t("photos.loadingThumbnails")}</div>
      )}

      {/* The timeline's own selection, so it cannot linger over a view that runs
          its own (the trash offers restore for the same keys). */}
      {view === "photos" && (
        <>
          <Marquee rect={sel.marquee} />
          <SelectionBar
            count={selected.size}
            busy={selectionBusy}
            onCancel={sel.clear}
            onAddToAlbum={() => setPickAlbum(true)}
            onDownload={() => void runSelection(downloadSelected)}
            onFreeUp={() => void runSelection(freeUpSelected)}
            onOfflineAdd={
              allSelectedOffline ? undefined : () => void runSelection(offlineAddSelected)
            }
            onOfflineRemove={
              allSelectedOffline ? () => void runSelection(offlineRemoveSelected) : undefined
            }
            onTrash={() => setConfirmTrash(true)}
          />
        </>
      )}

      {albumSortAt && (
        <ContextMenu
          x={albumSortAt.x}
          y={albumSortAt.y}
          onClose={() => setAlbumSortAt(null)}
          actions={ALBUM_SORTS.map((s) => ({
            key: s.key,
            label: t(s.labelKey),
            onSelect: () => setAlbumSort(s.key),
          }))}
        />
      )}

      {albumMenu && (
        <ContextMenu
          x={albumMenu.x}
          y={albumMenu.y}
          actions={albumActions}
          onClose={() => setAlbumMenu(null)}
        />
      )}

      {/* "Add photos": the library picker, or files from this computer straight into the album. */}
      {addPhotosAt && albumOpen && (
        <ContextMenu
          x={addPhotosAt.x}
          y={addPhotosAt.y}
          onClose={() => setAddPhotosAt(null)}
          actions={[
            {
              key: "library",
              label: t("albums.addFromLibrary"),
              icon: <LibraryAddIcon size={14} />,
              onSelect: () => setAddPhotosOpen(true),
            },
            {
              key: "computer",
              label: t("albums.addFromComputer"),
              icon: <UploadArrowIcon size={14} />,
              onSelect: () => void uploadIntoAlbum(albumOpen),
            },
          ]}
        />
      )}

      {/* The open album's "More" dropdown, anchored under the top-bar button. */}
      {albumMoreAt && albumOpen && (
        <ContextMenu
          x={albumMoreAt.x}
          y={albumMoreAt.y}
          onClose={() => setAlbumMoreAt(null)}
          actions={[
            {
              key: "rename",
              label: t("albums.rename"),
              icon: <PencilIcon size={14} />,
              onSelect: () => {
                setAlbumTarget(albumOpen);
                setAlbumRenaming(true);
              },
            },
            {
              key: "delete",
              label: t("albums.delete"),
              icon: <TrashIcon size={14} />,
              separator: true,
              danger: true,
              onSelect: () => {
                setAlbumTarget(albumOpen);
                setAlbumConfirmDelete(true);
              },
            },
          ]}
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

      {renamingPhoto && (
        <NameDialog
          title={t("photos.renameTitle")}
          confirmLabel={t("selection.rename")}
          initial={renamingPhoto.name}
          placeholder={t("photos.namePlaceholder")}
          busy={renameBusy}
          onConfirm={(name) => void renamePhoto(name)}
          onCancel={() => setRenamingPhoto(null)}
        />
      )}

      {(downloading || toast) && (
        <div className="g-toast">
          {downloading ? (
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

      {confirmTrash && (
        <Confirm
          title={t("confirm.trashTitle")}
          message={t(
            selected.size === 1 ? "confirm.trashCount.one" : "confirm.trashCount.other",
            { count: selected.size },
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

      {confirmEmpty && (
        <Confirm
          title={t("confirm.emptyTitle")}
          message={t("confirm.emptyMessage")}
          confirmLabel={t("confirm.emptyConfirm")}
          danger
          irreversible
          onCancel={() => setConfirmEmpty(false)}
          onConfirm={() => {
            setConfirmEmpty(false);
            void emptyTrash();
          }}
        />
      )}

      {pickAlbum && (
        <AlbumPicker
          count={selected.size}
          busy={albumBusy}
          onPick={(albumUid) => void addSelectedToAlbum(albumUid)}
          onCancel={() => setPickAlbum(false)}
        />
      )}

      {albumCreating && (
        <NameDialog
          title={t("albums.newTitle")}
          confirmLabel={t("albums.create")}
          busy={albumBusy}
          onConfirm={(name) => void createAlbum(name)}
          onCancel={() => setAlbumCreating(false)}
        />
      )}

      {albumRenaming && albumTarget && (
        <NameDialog
          title={t("albums.renameTitle")}
          confirmLabel={t("albums.rename")}
          initial={albumTarget.name}
          busy={albumBusy}
          onConfirm={(name) => void renameAlbum(name)}
          onCancel={() => setAlbumRenaming(false)}
        />
      )}

      {albumShareTarget && (
        <ShareDialog
          uid={albumShareTarget.uid}
          title={albumShareTarget.name || t("albums.untitled")}
          onClose={() => setAlbumShareTarget(null)}
        />
      )}

      {sharingPhoto && (
        <ShareDialog
          uid={sharingPhoto.uid}
          title={sharingPhoto.name}
          onClose={() => setSharingPhoto(null)}
        />
      )}

      {/* Deleting an album skips the trash, so the album itself never comes back
          even when every photo in it does. */}
      {albumConfirmDelete && albumTarget && (
        <Confirm
          title={t("confirm.deleteAlbumTitle")}
          message={t("confirm.deleteAlbumMessage")}
          confirmLabel={t("albums.delete")}
          danger
          irreversible
          onCancel={() => setAlbumConfirmDelete(false)}
          onConfirm={() => {
            setAlbumConfirmDelete(false);
            void deleteAlbum();
          }}
        />
      )}

      {albumStranded !== null && (
        <AlbumPhotoLossDialog
          count={albumStranded}
          busy={albumBusy}
          onSaveToTimeline={() => void deleteAlbum({ saveToTimeline: true })}
          onDeletePhotos={() => void deleteAlbum({ force: true })}
          onCancel={() => setAlbumStranded(null)}
        />
      )}

      {current && (
        <Lightbox
          uid={current.uid}
          isLocal={localUids.has(current.uid)}
          isOffline={offlineUids.has(current.uid)}
          // Only ever a definite answer, never a guess. A known video branches the
          // viewer straight to playback without waiting for the details; anything not
          // yet known is left undefined so the viewer falls back to the media type in
          // the details it fetches anyway. Passing "image" on a missing tag is what made
          // an untagged video unplayable: it looked definite, so the fallback that would
          // have caught it never ran.
          kind={videoKind(current)}
          fallbackUrl={cachedThumbnail(current.uid) ?? thumbUrl(current.uid)}
          hasPrev={lightboxIdx! > 0}
          hasNext={lightboxIdx! < filtered.length - 1}
          onPrev={() => setLightboxIdx((i) => (i === null ? i : Math.max(0, i - 1)))}
          onNext={() =>
            setLightboxIdx((i) => (i === null ? i : Math.min(filtered.length - 1, i + 1)))
          }
          items={viewerItems}
          index={lightboxIdx!}
          onJump={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onTrashed={handleTrashed}
          onRenamed={handleRenamed}
          onEdited={bumpReload}
          isFavorite={!!current.tags?.includes(TAG.Favorite)}
          onFavoriteChanged={handleFavoriteChanged}
        />
      )}

      {uploads.dragging && (
        <div className="g-dropveil">
          <div className="g-dropveil-inner">
            <div className="g-dropveil-icon">↑</div>
            <p className="g-dropveil-title">{t("photos.dropTitle")}</p>
            <p className="g-dropveil-sub">{t("photos.dropSub")}</p>
          </div>
        </div>
      )}

      {addPhotosOpen && albumOpen && (
        <AlbumAddPhotos
          albumName={albumOpen.name || t("albums.untitled")}
          candidates={albumCandidates}
          cellSize={cellSize}
          busy={albumBusy}
          onConfirm={(uids) => void addPhotosToOpenAlbum(uids)}
          onClose={() => setAddPhotosOpen(false)}
        />
      )}

      {uploadOpen && (
        <Upload
          status={uploads.status}
          running={uploads.running}
          error={uploads.error}
          start={uploads.start}
          startImport={uploads.startImport}
          cancel={uploads.cancel}
          clear={uploads.clear}
          onClose={() => setUploadOpen(false)}
        />
      )}

      {uploads.review && (
        <ImportReview
          items={uploads.review}
          checks={uploads.checks}
          progress={uploads.status.importing}
          onConfirm={(exclude, albums) => {
            setUploadOpen(true);
            void uploads.confirmImport(exclude, albums, true);
          }}
          onDiscard={() => void uploads.discardImport()}
        />
      )}
    </div>
  );
}
