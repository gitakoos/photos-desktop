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
  useLayoutEffect,
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
import { Sidebar, type Activity, type SidebarEntry, type SidebarSection } from "../components/Sidebar";
import { WHATS_NEW_ID, WhatsNew } from "../components/WhatsNew";
import { describeMount, useMountActivity, type SyncInfo } from "../lib/mountActivity";
import { SearchField, TopStrip, type SearchPill, type SearchSuggestion } from "../components/TopStrip";
import { foldPhrase, termAtEnd, termsStartedAtEnd, wordForms, type SearchTerm } from "../lib/searchTerms";
import { Settings, DEFAULT_SETTINGS, type AppSettings, type Category as SettingsCategory } from "./Settings";
import { applyTheme } from "../lib/theme";
import { Albums, type Album, type AlbumSort } from "./Albums";
import { Shared, type Invitation, type SharedItem, type Tab } from "./Shared";
import { Trash } from "./Trash";
import { Duplicates } from "./Duplicates";
import { FixDates } from "./FixDates";
import { Hidden, type HiddenAccess } from "./Hidden";
import { useHidden } from "../hooks/useHidden";
import {
  CallMadeIcon,
  CallMergeIcon,
  CallReceivedIcon,
  ChevronLeftIcon,
  CloseIcon,
  CollectionsIcon,
  ContentCopyIcon,
  DownloadIcon,
  FaceIcon,
  FolderOpenIcon,
  UploadArrowIcon,
  FilterIcon,
  HeartIcon,
  LabelIcon,
  ListIcon,
  LibraryAddIcon,
  LockIcon,
  MapIcon,
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
  VisibilityIcon,
  VisibilityOffIcon,
} from "../components/icons";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  ChevronDownIcon,
  DeleteForeverIcon,
  ImageIcon,
  MotionPhotoIcon,
  PanoramaIcon,
  PlayArrowIcon,
  RawIcon,
  SortIcon,
  TextIcon,
} from "../components/icons";
import { dateLabel, inDate, parseDateQuery, type DateQuery } from "../lib/dateQuery";
import { MEDIA_EXTENSIONS, Upload } from "../components/Upload";
import {
  CollectionPage,
  EntryGrid,
  LibraryPage,
  LibraryTiles,
  LocalPeoplePage,
  type CollectionSection,
  type DriveCollection,
  type DriveCollections,
  type LibraryEntry,
  type LibraryPageKind,
  type Tile,
} from "../components/Library";
import { MapView, type MapPoint } from "../components/MapView";
import { ImportReview } from "../components/ImportReview";
import { AlbumAddPhotos } from "../components/AlbumAddPhotos";
import { LabelPicker } from "../components/LabelPicker";
import { useLocalLabels } from "../hooks/useLocalLabels";
import { Lightbox } from "../components/Lightbox";
import { Confirm } from "../components/Confirm";
import { ContextMenu, type MenuAction, type MenuAt } from "../components/ContextMenu";
import { AlbumPicker, AlbumPhotoLossDialog, NameDialog } from "../components/AlbumDialogs";
import { ShareDialog } from "../components/ShareDialog";
import { FilterPanel, type MediaType } from "../components/FilterPanel";
import { PhotoGrid, PhotoGridSkeleton } from "../components/PhotoGrid";
import { VirtualSections } from "../components/VirtualSections";
import { CanvasSections } from "../components/CanvasSections";
import {
  cachedThumbnail,
  connectThumbServer,
  disconnectThumbServer,
  thumbUrl,
  useThumbServerBase,
} from "../lib/thumbStore";
import { useThumbnails } from "../hooks/useThumbnails";
import { DebugHud } from "../components/DebugHud";
import { Marquee, SelectionBar, useSelection } from "../hooks/useSelection";
import { useLocalFaces } from "../hooks/useLocalFaces";
import { inTimelineOrder, isScanSpeed, scanBusy, statusLine, type PersonView } from "../lib/localFaces";
import { PersonActions, PersonPicker } from "../components/PersonActions";
import { PersonSplit } from "../components/PersonSplit";
import { PersonFindPanel } from "../components/PersonFindPanel";
import { DateEditPanel } from "../components/DateEditPanel";
import { photoSpanLabel } from "../lib/albumSpan";
import type { DateEditMode, DateEditStatus } from "../lib/dateEdit";
import { PhotoFaces } from "../components/PhotoFaces";
import { useWarmViews } from "../hooks/useWarmViews";
import { CATEGORIES, isVideo, TAG, withFavorite } from "../lib/tags";
import { cachedMediaType } from "../lib/mediaTypes";
import { useUploads } from "../hooks/useUploads";
import { useLang, useT } from "../lib/i18n";
import { isWindows } from "../lib/platform";
import { onThisDay, seasons } from "../lib/memories";
import { dropPreview, prefetchAfter } from "../lib/previewStore";
import { unwarmedBatches, warmWholeBatch } from "../lib/warmBatches";
import { bench, benchCount, benchSpan } from "../lib/benchProbe";
import { maybeRunScrollBench } from "../lib/scrollBench";
import "../styles/Photos.css";

/** Each category's mark in the filter menu, where there is one to draw. */
const CATEGORY_ICONS: Record<string, ReactNode> = {
  fav: <HeartIcon size={17} />,
  video: <PlayArrowIcon size={17} />,
  live: <MotionPhotoIcon size={17} />,
  selfie: <FaceIcon size={17} />,
  pano: <PanoramaIcon size={17} />,
  raw: <RawIcon size={17} />,
};

/** How many neighbours on each side of the open photo to warm in advance. */
const PREFETCH_RADIUS = 2;

type TimelineItem = { uid: string; captureTime: number; tags: number[] };

/** Photos asked about per call while the map gathers places. */
const PLACES_BATCH = 2000;
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
/** The wheel travel one zoom step takes (a mouse notch is 100), and the least time between steps. */
const WHEEL_STEP = 60;
/** How long the typing pauses before a typed date becomes a pill: Android's 700 ms. */
const DATE_PILL_MS = 700;
/** How often the phone's copies on Drive are looked at again, and how stale they may be when
 *  the window comes back before they are. */
const DRIVE_REFRESH_MS = 15 * 60 * 1000;
const DRIVE_REFRESH_ON_FOCUS_MS = 5 * 60 * 1000;
/** A search by what a photo shows waits for this much typed, and for the typing to settle. */
const SEMANTIC_MIN_CHARS = 3;
const SEMANTIC_SETTLE_MS = 350;
const WHEEL_STEP_MS = 140;

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

/** The most timeline items one page carries, and the wait before asking again when none had arrived. */
const TIMELINE_PAGE = 20_000;
const TIMELINE_POLL_MS = 250;

export function Photos({
  email,
  offline = false,
  onSignOut,
}: {
  email: string;
  /** Open on the photos kept offline while Proton cannot be reached. */
  offline?: boolean;
  onSignOut: () => void;
}) {
  // For the scroll measurement only (see `scrollBench`): when this draw of the view began.
  const benchFrom = bench.on ? performance.now() : 0;
  const t = useT();
  const [allItems, setItems] = useState<TimelineItem[]>([]);
  // What is hidden stays out of every list below; only the Hidden page reads `allItems`.
  const hidden = useHidden(true);
  const items = useMemo(
    () => (hidden.photoCount + hidden.albumCount > 0 ? allItems.filter((it) => !hidden.isPhoto(it.uid)) : allItems),
    [allItems, hidden],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Timeline content filter (view state, not persisted): multi-select categories
  // combined OR, plus a single media type. Both drive the grid in real time.
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [mediaType, setMediaType] = useState<MediaType>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  // The timeline's order, from the toolbar's sort menu: by when a photo was taken (in
  // months) or by its name (one grid), newest or A first unless turned round.
  const [timelineSort, setTimelineSort] = useState<{ by: "taken" | "name"; asc: boolean }>({
    by: "taken",
    asc: false,
  });
  // The toolbar menu dropped from its button: the sort, the filter, or the albums' sort.
  const [toolMenu, setToolMenu] = useState<{ kind: "sort" | "filter" | "albumSort"; x: number; y: number } | null>(
    null,
  );
  const [view, setView] = useState<View>("photos");
  // Lifted so the open album's header can share the top bar row.
  const [albumOpen, setAlbumOpen] = useState<Album | null>(null);
  // Lifted so the Shared by-me / with-me toggle can live in the top bar row too.
  const [sharedTab, setSharedTab] = useState<Tab>("by");
  const [sharedCount, setSharedCount] = useState<number | null>(null);
  // Invitations to someone else's photos waiting for an answer: a dot on the Shared tile, and
  // a list over what is shared with the reader. Read again whenever Albums or Shared is shown.
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  // The album list's own search query (transient) and sort order, plus where the sort menu opens.
  const [albumQuery, setAlbumQuery] = useState("");
  const [albumSort, setAlbumSort] = useState<AlbumSort>("activity");
  const [albumSortAt, setAlbumSortAt] = useState<{ x: number; y: number } | null>(null);
  // A shared album looked into, lifted for the same reason as the one above: the
  // header its back button lives in belongs to this row.
  const [sharedAlbumOpen, setSharedAlbumOpen] = useState<SharedItem | null>(null);
  // The people or the labels the phone saved to Drive, opened from the Albums tab's tiles.
  const [libraryPage, setLibraryPage] = useState<LibraryPageKind | null>(null);
  // One of the Collection's sections opened in full. Kept while its photos are looked at, so
  // the way back from them returns to it.
  const [collectionSection, setCollectionSection] = useState<"onthisday" | "seasons" | null>(null);
  // The timeline narrowed to one person, one label or the offline set, and where it was
  // opened from, which its back button returns to.
  const [uidFilter, setUidFilter] = useState<{
    name: string;
    uids: Set<string>;
    back: LibraryPageKind | "albums";
    /** A person found on this computer, whose name and photos the page can change. */
    personId?: string;
    /** Hidden photos shown too: a look into the Hidden page. */
    includeHidden?: boolean;
    /** The Offline page, which also shows the photos of albums kept offline. */
    offline?: boolean;
    /** The Favorites page: whatever carries the heart now, so un-favouriting takes it off. */
    favorites?: boolean;
  } | null>(null);
  // The photos that carry a place, read in batches the first time the map is opened.
  const [places, setPlaces] = useState<{
    points: MapPoint[];
    done: number;
    total: number;
    finished: boolean;
    /** Places are being read from Drive in this round, not only from this computer's cache. */
    reading: boolean;
  } | null>(
    null,
  );
  // Those Drive copies, read when the Albums tab is first shown and again on request.
  const [drive, setDrive] = useState<{
    state: "loading" | "failed" | "ready";
    data: DriveCollections | null;
    at: number;
  } | null>(
    null,
  );
  // A view's own tab or sidebar row takes it back to where it starts: from inside an
  // album to the albums, from inside a shared album to everything shared.
  // Settings and Upload are pages over the current view; opening one closes the other.
  const openSettings = (page?: SettingsCategory) => {
    setUploadOpen(false);
    setSettingsPage(page);
    setSettingsOpen(true);
  };
  const openUpload = () => {
    setSettingsOpen(false);
    setUploadOpen(true);
  };
  const goToView = (next: View) => {
    setUploadOpen(false);
    setSettingsOpen(false);
    setLibraryPage(null);
    setUidFilter(null);
    if (next === "albums") setAlbumOpen(null);
    if (next === "shared") setSharedAlbumOpen(null);
    setView(next);
  };
  // Hidden, as on the phone: open only after Windows Hello, and locked again on leaving it or
  // when the window goes away, which also closes whatever was opened from it.
  const [hiddenAccess, setHiddenAccess] = useState<HiddenAccess>("locked");
  const inHidden =
    libraryPage === "hidden" || uidFilter?.back === "hidden" || (!!albumOpen && hidden.isAlbum(albumOpen.uid));
  useEffect(() => {
    if (!inHidden) setHiddenAccess("locked");
  }, [inHidden]);
  useEffect(() => {
    let live = true;
    let off: (() => void) | null = null;
    void listen("window-hidden", () => setHiddenAccess("locked")).then((unlisten) => {
      if (live) off = unlisten;
      else unlisten();
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);
  useEffect(() => {
    if (hiddenAccess !== "locked" || !inHidden || libraryPage === "hidden") return;
    setLightboxIdx(null);
    setUidFilter(null);
    setAlbumOpen(null);
    setView("albums");
    setLibraryPage("hidden");
  }, [hiddenAccess, inHidden, libraryPage]);
  const [confirmHide, setConfirmHide] = useState<string[] | null>(null);
  const [confirmHideAlbum, setConfirmHideAlbum] = useState<Album | null>(null);
  /** Moves photos into Hidden or out of it, and says so. */
  async function hidePhotos(uids: string[], hide: boolean) {
    try {
      await hidden.set("photos", uids, hide);
      setToast(
        t(hide ? (uids.length === 1 ? "hidden.hiddenToast.one" : "hidden.hiddenToast.other") : "hidden.shownToast", {
          count: uids.length,
        }),
      );
    } catch (e) {
      setToast(String(e));
    }
  }
  async function hideAlbum(album: Album, hide: boolean) {
    try {
      await hidden.set("albums", [album.uid], hide);
      if (hide && albumOpen?.uid === album.uid) setAlbumOpen(null);
      setToast(t(hide ? "hidden.albumHiddenToast" : "hidden.albumShownToast"));
    } catch (e) {
      setToast(String(e));
    }
  }

  /** The timeline narrowed to a set of photos, with a way back to where they were picked. */
  const openFiltered = (filter: {
    name: string;
    uids: Set<string>;
    back: LibraryPageKind | "albums";
    personId?: string;
    includeHidden?: boolean;
    offline?: boolean;
    favorites?: boolean;
  }) => {
    goToView("photos");
    setUidFilter(filter);
  };
  const loadInvitations = useCallback(() => {
    rpc<Invitation[]>("listInvitations").then(setInvitations, () => {});
  }, []);
  useEffect(() => {
    if (view === "albums" || view === "shared") loadInvitations();
  }, [view, loadInvitations]);
  // Lifted so the trash's count and its empty button can share the top bar row.
  const [trashCount, setTrashCount] = useState<number | null>(null);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const [confirmTrash, setConfirmTrash] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [saveProgress, setSaveProgress] = useState<SaveProgress | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The scroll measurement, in a run of the app started for one and in no other: the
  // timeline scrolls itself and the log says what each second cost (see `scrollBench`).
  useEffect(() => {
    void maybeRunScrollBench(() => scrollRef.current);
  }, []);
  // And, while one runs, what each draw of this whole view costs: from its start to its
  // changes being in the page. A draw of the view takes every list under it along.
  useLayoutEffect(() => {
    if (bench.on && benchFrom) {
      benchCount("photos");
      benchSpan("photos_ms", benchFrom);
    }
  });
  // Escape belongs to the lightbox while it is open.
  const sel = useSelection(scrollRef, lightboxIdx === null);
  // Where the canvas timeline fetches its thumbnails; until it is known, the DOM grid shows.
  const thumbBase = useThumbServerBase();
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

  // The timeline is read and the Explorer fill started: the host may suspend the page now
  // if the window is in the tray, which it held off while this was under way.
  useEffect(() => {
    if (!loading) void invoke("page_settled").catch(() => {});
  }, [loading]);

  // Which photos are downloaded (hydrated placeholders) so the grid can badge them.
  // Polled, because Explorer can hydrate/free them independently of the app. The host
  // answers from its own background scan with a version, and sends the list only when
  // it moved, so an unchanged library costs neither a copy nor a re-render.
  const [localUids, setLocalUids] = useState<Set<string>>(new Set());
  useEffect(() => {
    let active = true;
    let version: number | null = null;
    const poll = async () => {
      const answer = await invoke<{ version: number; uids: string[] | null }>("hydrated_uids", {
        since: version,
      }).catch(() => null);
      if (!active || !answer) return;
      version = answer.version;
      if (answer.uids) setLocalUids(new Set(answer.uids));
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
  // The photos of the albums kept offline, read when the Offline page opens: an album can hold
  // photos that are on no timeline, and they belong on that page too.
  const [offlineAlbumItems, setOfflineAlbumItems] = useState<TimelineItem[]>([]);
  const offlinePage = !!uidFilter?.offline;
  useEffect(() => {
    if (!offlinePage) return;
    let live = true;
    void (async () => {
      const albums = await rpc<string[]>("offlineAlbums").catch(() => [] as string[]);
      const found: TimelineItem[] = [];
      for (const uid of albums) {
        const rows = await rpc<{ uid: string; captureTime: number }[]>("getAlbumPhotos", { uid }).catch(() => []);
        for (const row of rows) found.push({ uid: row.uid, captureTime: row.captureTime, tags: [] });
      }
      if (live) setOfflineAlbumItems(found);
    })();
    return () => {
      live = false;
    };
  }, [offlinePage]);

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

  const mountActivity = useMountActivity();

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
  //
  // The timeline arrives a page at a time, and each page starts this again. What was
  // warmed is remembered across those restarts, so a new page carries on where the last
  // pass stopped rather than going back through the whole library from the top, and the
  // pass a new page replaces lets go of its request, so it is dropped from the host's
  // queue instead of waiting there behind the mount listing for its turn.
  const warmedRef = useRef(new Set<string>());
  useEffect(() => {
    if (items.length === 0) return;
    const stop = new AbortController();
    const uids = items.map((it) => it.uid);
    (async () => {
      // Kept small so one uninterruptible warm request is only ever a few
      // thumbnails: an interactive call waits at most one short batch, not twelve.
      const BATCH = 4;
      for (const batch of unwarmedBatches(uids, warmedRef.current, BATCH)) {
        if (stop.signal.aborted) break;
        // Stand aside while a photo is open, the mount is hydrating, or another
        // view is on screen and wants the channel for its own data.
        while (
          !stop.signal.aborted &&
          (lightboxOpenRef.current || mountBusyRef.current || offTimelineRef.current)
        ) {
          await new Promise((r) => setTimeout(r, 300));
        }
        if (stop.signal.aborted) break;
        // The sidecar fetches only a couple of missing thumbnails per call and counts
        // what the batch now has cached, so a batch is asked for again until all of it is
        // ready, and remembered only then. One that stops getting further (a photo with
        // no thumbnail, a stalled fetch) is left for a later pass to try again.
        try {
          const whole = await warmWholeBatch(batch, (uids) =>
            rpc<{ ready: number }>("warmThumbnails", { uids }, { signal: stop.signal }),
          );
          if (whole) for (const uid of batch) warmedRef.current.add(uid);
        } catch {
          /* keep warming the rest; a batch let go of is warmed by the next pass */
        }
        await new Promise((r) => setTimeout(r, 400)); // yield to on-screen requests
      }
    })();
    return () => {
      stop.abort();
    };
  }, [items.length]);

  const [account, setAccount] = useState<Account | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsCategory | undefined>(undefined);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  // The photos filed in an album, hidden from the timeline when the setting asks: null
  // while not yet known. Read from the last start's copy at once, then fresh.
  const [albumMembers, setAlbumMembers] = useState<Set<string> | null>(null);
  // Whether the saved settings have been read; until then the defaults stand in, and the
  // hide setting is not known either.
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);

  // The open album's header actions, raised into the top bar in the album view.
  // `albumPhotoUids` is lifted from Albums so the top bar's Download can act on the
  // whole album; `albumMoreAt` anchors the More dropdown.
  const [albumPhotoUids, setAlbumPhotoUids] = useState<string[]>([]);
  /** The open shared album's photo uids, for its masthead's Download. */
  const [sharedAlbumPhotoUids, setSharedAlbumPhotoUids] = useState<string[]>([]);
  const [albumMoreAt, setAlbumMoreAt] = useState<{ x: number; y: number } | null>(null);
  // The open album's photos' first and last date, which its header shows, and a counter the
  // More menu's "Contents" raises to open the viewer on that list.
  const [albumSpan, setAlbumSpan] = useState<[number, number] | null>(null);
  const [sharedSpan, setSharedSpan] = useState<[number, number] | null>(null);
  const [albumContents, setAlbumContents] = useState(0);
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
  /** The photos the label picker is open for, by their Drive link ids. */
  const [pickLabels, setPickLabels] = useState<string[] | null>(null);
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
  // F5 and Ctrl+R read the page again where it is, instead of reloading the window back to the
  // timeline; the shell's Reload asks for the same. Ctrl+Shift+R still reloads the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const refresh = (e.key === "F5" && !e.ctrlKey && !e.shiftKey) || (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "r");
      if (!refresh) return;
      e.preventDefault();
      bumpReload();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pfp-refresh", bumpReload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pfp-refresh", bumpReload);
    };
  }, [bumpReload]);
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
    openUpload();
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
  useEffect(() => {
    if (uploads.nothingFound) setToast(t("upload.nothingFound"));
  }, [uploads.nothingFound, t]);

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
        if (raw) {
          const saved = JSON.parse(raw);
          // The faces' share with the phone became the shared backup of everything.
          if (saved.sharedBackup === undefined && typeof saved.faceSync === "boolean") saved.sharedBackup = saved.faceSync;
          delete saved.faceSync;
          const merged: AppSettings = { ...DEFAULT_SETTINGS, ...saved };
          // Faces and the search are on or off now: what showed the phone's alone is on, here
          // and put together with the phone's through the shared backup.
          if (merged.driveFaces && !merged.localFaces) merged.localFaces = true;
          merged.driveFaces = false;
          if (merged.semanticSearch && !merged.localSearch) merged.localSearch = true;
          if (!isScanSpeed(merged.scanSpeed)) merged.scanSpeed = null;
          // The sidebar layout is the app's only layout now; one saved off from before still opens it.
          merged.sidebarLayout = true;
          // AMOLED was a palette before it became a switch beside them.
          if (merged.palette === "amoled") {
            merged.palette = "default";
            merged.amoled = true;
          }
          setSettings(merged);
          applyTheme(merged.theme, merged.palette, merged.amoled);
          if (merged.whatsNewSeen !== WHATS_NEW_ID) setWhatsNewOpen(true);
        } else {
          // A first start has nothing new to compare against.
          const fresh = { ...DEFAULT_SETTINGS, whatsNewSeen: WHATS_NEW_ID };
          setSettings(fresh);
          void invoke("store_set", { name: "settings", value: JSON.stringify(fresh) }).catch(() => {});
        }
      } catch {
        /* fall back to defaults */
      }
      setSettingsLoaded(true);
    })();
  }, []);

  function updateSettings(next: AppSettings) {
    setSettings(next);
    void invoke("store_set", { name: "settings", value: JSON.stringify(next) }).catch(() => {});
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
  //
  // The timeline waits for it rather than showing album photos that then vanish: the copy
  // from the last start answers at once, and only a first start waits for the walk.
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!settings.hideAlbumPhotos) {
      setAlbumMembers(new Set());
      return;
    }
    let cancelled = false;
    let fresh = false;
    (async () => {
      try {
        const cached = await rpc<string[] | null>("cachedAlbumPhotoUids");
        if (!cancelled && !fresh && cached) setAlbumMembers(new Set(cached));
      } catch {
        /* the walk below answers instead */
      }
    })();
    (async () => {
      try {
        const uids = await rpc<string[]>("getAlbumPhotoUids");
        fresh = true;
        if (!cancelled) setAlbumMembers(new Set(uids));
      } catch {
        // Nothing is hidden if membership cannot be resolved, rather than nothing shown.
        if (!cancelled) setAlbumMembers((known) => known ?? new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsLoaded, settings.hideAlbumPhotos, reloadKey]);
  /** The timeline can be drawn: what it hides is known. */
  const hidingKnown = settingsLoaded && (!settings.hideAlbumPhotos || albumMembers !== null);

  // Whether the grid has shown a timeline yet. The first read paints page by page; a
  // reload keeps the grid it has until the new timeline is complete, so it never
  // shrinks and grows back.
  const timelineShown = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setError("");
    const progressive = !timelineShown.current;
    (async () => {
      try {
        // Read in pages as the sidecar receives them, so a large library paints its
        // first screen at once and no single answer carries the whole timeline.
        const { run } = await rpc<{ run: number }>("startTimeline");
        const all: TimelineItem[] = [];
        let shown = 0;
        let shownAt = 0;
        for (;;) {
          const page = await rpc<{ items: TimelineItem[]; done: boolean; error: string | null }>(
            "timelinePage",
            { run, offset: all.length, limit: TIMELINE_PAGE },
          );
          if (cancelled) return;
          for (const item of page.items) all.push(item);
          if (page.done) {
            if (page.error && all.length === 0) throw new Error(page.error);
            break;
          }
          // Each paint recounts the months and the filters over everything so far, so
          // the grid is refreshed when the timeline has doubled or every two seconds,
          // not on every page.
          const now = performance.now();
          if (progressive && all.length > shown && (all.length >= shown * 2 || now - shownAt > 2000)) {
            shown = all.length;
            shownAt = now;
            timelineShown.current = true;
            setItems(all.slice());
          }
          if (page.items.length === 0) await new Promise((r) => setTimeout(r, TIMELINE_POLL_MS));
        }
        timelineShown.current = true;
        setItems(all);
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
  // The Drive copies name photos by link id; the timeline knows them as `volume~link`.
  const byLinkId = useMemo(() => {
    const m = new Map<string, TimelineItem>();
    for (const it of items) m.set(it.uid.slice(it.uid.indexOf("~") + 1), it);
    return m;
  }, [items]);
  const toEntries = useCallback(
    (list: DriveCollection[] | undefined): LibraryEntry[] =>
      (list ?? [])
        .map((c) => {
          const found = c.keys
            .map((k) => byLinkId.get(k))
            .filter((it): it is TimelineItem => !!it)
            .sort((a, b) => b.captureTime - a.captureTime);
          const cover = c.cover ? (byLinkId.get(c.cover)?.uid ?? null) : null;
          return { name: c.name, uids: found.map((it) => it.uid), cover: cover ?? found[0]?.uid ?? null, box: cover ? c.box : null };
        })
        // A person or label whose photos are all gone from the library has nothing to show.
        .filter((e) => e.uids.length > 0),
    [byLinkId],
  );
  // Another device deleted the face data everywhere: face recognition is off here too, as there.
  const facesOffElsewhere = useCallback(() => {
    setSettings((s) => {
      if (!s.localFaces) return s;
      const next = { ...s, localFaces: false };
      void invoke("store_set", { name: "settings", value: JSON.stringify(next) }).catch(() => {});
      return next;
    });
  }, []);
  // Face recognition on this computer, when it is on, stands in for the people the phone saved.
  const localFaces = useLocalFaces(
    settings.localFaces,
    settingsLoaded,
    settings.faceAutoMerge,
    settings.faceFindMore,
    settings.sharedBackup,
    settings.semanticSearch && settings.localSearch,
    facesOffElsewhere,
    settings.scanSpeed,
  );
  // The labels kept on this computer: the phone's copies are put together with them on every read.
  const localLabels = useLocalLabels(settingsLoaded && settings.driveLabels);
  const timelineOrder = useMemo(() => new Map(items.map((it, i) => [it.uid, i])), [items]);
  const localEntries = useMemo(() => {
    const toEntry = (person: PersonView): LibraryEntry => {
      const uids = inTimelineOrder(person.uids, timelineOrder);
      const cover = person.cover && timelineOrder.has(person.cover.uid) ? person.cover : null;
      return {
        name: person.name ?? t("faces.unnamed"),
        uids,
        cover: cover?.uid ?? uids[0] ?? null,
        box: cover?.box ?? null,
        personId: person.id,
      };
    };
    const people = localFaces.people;
    const named = (people?.named ?? []).map(toEntry).filter((e) => e.uids.length > 0);
    const unnamed = (people?.unnamed ?? []).map(toEntry).filter((e) => e.uids.length > 0);
    const byId = new Map([...named, ...unnamed].map((e) => [e.personId!, e]));
    const suggestions = (people?.suggestions ?? [])
      .map((s) => ({ unnamed: byId.get(s.unnamed), named: byId.get(s.named) }))
      .filter((s): s is { unnamed: LibraryEntry; named: LibraryEntry } => !!s.unnamed && !!s.named);
    return { loaded: people !== null, named, unnamed, suggestions };
  }, [localFaces.people, timelineOrder, t]);
  const drivePeople = useMemo(() => toEntries(drive?.data?.people), [toEntries, drive]);
  const peopleEntries = settings.localFaces ? localEntries.named : drivePeople;
  const scanLine = useMemo(() => {
    if (!settings.localFaces || !scanBusy(localFaces.status)) return null;
    const line = statusLine(localFaces.status);
    return line ? t(line.key, line.values) : null;
  }, [settings.localFaces, localFaces.status, t]);
  // A person's page follows the person: new photos join it, a rename retitles it, and when the
  // person is gone (put with another, or left out) the page goes back to the people.
  useEffect(() => {
    const id = uidFilter?.personId;
    if (!id || !localEntries.loaded) return;
    const entry = [...localEntries.named, ...localEntries.unnamed].find((e) => e.personId === id);
    if (!entry) {
      goToView("albums");
      setLibraryPage("people");
      return;
    }
    const same =
      entry.name === uidFilter.name &&
      entry.uids.length === uidFilter.uids.size &&
      entry.uids.every((u) => uidFilter.uids.has(u));
    if (!same) setUidFilter({ ...uidFilter, name: entry.name, uids: new Set(entry.uids) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localEntries]);

  // People picked on the People page, the right-click menu over one, and what it asked for.
  const [peopleSel, setPeopleSel] = useState<Set<string>>(new Set());
  const peopleAnchor = useRef<string | null>(null);
  const [peopleMenu, setPeopleMenu] = useState<{ x: number; y: number; entry: LibraryEntry } | null>(null);
  const [mergeFor, setMergeFor] = useState<LibraryEntry | null>(null);
  const [rejectPeople, setRejectPeople] = useState<string[] | null>(null);
  // Set once after another account signed out: its File Explorer folder was turned off, and
  // this many files it downloaded are still in the folder.
  const [explorerOff, setExplorerOff] = useState<number | null>(null);
  useEffect(() => {
    void invoke<number | null>("take_explorer_notice")
      .then((left) => {
        if (left !== null && left !== undefined) setExplorerOff(left);
      })
      .catch(() => {});
  }, []);
  const [peopleBusy, setPeopleBusy] = useState(false);
  // The side panel of photos that might be the person open on screen.
  const [findOpen, setFindOpen] = useState(false);
  // The split of the person open on the page into two people (see PersonSplit).
  const [splitOpen, setSplitOpen] = useState(false);
  // A split belongs to the person it was opened on: another person's page starts without one.
  useEffect(() => setSplitOpen(false), [uidFilter?.personId]);
  // The photos the date editor is open for, and the run it started, followed while it lasts.
  const [dateEditUids, setDateEditUids] = useState<string[] | null>(null);
  const [dateStatus, setDateStatus] = useState<DateEditStatus | null>(null);
  const [dateRun, setDateRun] = useState(false);
  const [dateEditMode, setDateEditMode] = useState<DateEditMode>("set");
  /** Opens the date editor beside the grid for `uids`; the viewer opens its own beside the photo. */
  const openDateEdit = (uids: string[], mode: DateEditMode = "set") => {
    if (uids.length === 0) return;
    setDateEditMode(mode);
    setDateEditUids(uids);
  };
  // A run a restart cut short carries on by itself in the sidecar: followed here too.
  useEffect(() => {
    void rpc<DateEditStatus>("dateEditStatus")
      .then((s) => s.running && setDateRun(true))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!dateRun) return;
    let stopped = false;
    let seen = 0;
    const ask = async () => {
      try {
        const s = await rpc<DateEditStatus>("dateEditStatus");
        if (stopped) return;
        setDateStatus(s);
        // The grid shows each replaced photo at its new place, a few at a time rather than on every one.
        if (s.changed >= seen + 10 || (!s.running && s.changed > seen)) {
          seen = s.changed;
          bumpReload();
        }
        if (!s.running) {
          setDateRun(false);
          setToast(t("dateEdit.toast", { changed: s.changed, failed: s.failed }));
          return;
        }
      } catch {
        /* asked again below */
      }
      if (!stopped) window.setTimeout(ask, 1000);
    };
    void ask();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRun]);
  const allPeople = useMemo(() => [...localEntries.named, ...localEntries.unnamed], [localEntries]);
  useEffect(() => {
    if (view !== "albums" || libraryPage !== "people") setPeopleSel(new Set());
  }, [view, libraryPage]);
  useEffect(() => {
    if (!uidFilter?.personId) setFindOpen(false);
  }, [uidFilter?.personId]);
  // Only people still there stay picked.
  useEffect(() => {
    setPeopleSel((sel) => {
      const ids = new Set(allPeople.map((e) => e.personId!));
      const kept = [...sel].filter((id) => ids.has(id));
      return kept.length === sel.size ? sel : new Set(kept);
    });
  }, [allPeople]);
  const togglePerson = (entry: LibraryEntry, range: boolean) => {
    const id = entry.personId!;
    setPeopleSel((sel) => {
      const next = new Set(sel);
      const order = allPeople.map((e) => e.personId!);
      const from = peopleAnchor.current ? order.indexOf(peopleAnchor.current) : -1;
      if (range && from >= 0) {
        const to = order.indexOf(id);
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(order[i]);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    peopleAnchor.current = id;
  };
  /** Puts people together under the named one among them (the one in most photos first). */
  const mergeIntoOne = async (ids: string[]) => {
    const picked = allPeople.filter((e) => ids.includes(e.personId!));
    if (picked.length < 2) return;
    const named = localEntries.named.filter((e) => ids.includes(e.personId!));
    const into = (named[0] ?? [...picked].sort((a, b) => b.uids.length - a.uids.length)[0]).personId!;
    const rest = picked.map((e) => e.personId!).filter((id) => id !== into);
    for (let i = 0; i < rest.length; i++) {
      const params = { from: rest[i], into };
      if (i < rest.length - 1) await rpc("facePersonMerge", params);
      else await localFaces.act("facePersonMerge", params);
    }
  };
  const runPeople = async (action: () => Promise<void>) => {
    if (peopleBusy) return;
    setPeopleBusy(true);
    try {
      await action();
    } catch {
      /* the people stay as they were */
    } finally {
      setPeopleBusy(false);
    }
  };
  const { lang } = useLang();
  const memoryEntries = useMemo(() => {
    const plural = new Intl.PluralRules(lang);
    const entry = (name: string, uids: string[]): LibraryEntry => ({ name, uids, cover: uids[0] ?? null, box: null });
    return {
      onThisDay: onThisDay(items).map(({ yearsAgo, uids }) => {
        const key = `library.yearsAgo.${plural.select(yearsAgo)}`;
        const label = t(key, { count: yearsAgo });
        return entry(label === key ? t("library.yearsAgo.other", { count: yearsAgo }) : label, uids);
      }),
      seasons: seasons(items).map(({ season, year, uids }) => entry(`${t(`library.season.${season}`)} ${year}`, uids)),
    };
  }, [items, lang, t]);
  const labelEntries = useMemo(
    () => toEntries(localLabels.labels.map((l) => ({ name: l.name, keys: l.keys, cover: null, box: null }))),
    [toEntries, localLabels.labels],
  );
  const openLabelPicker = () => setPickLabels([...selected].map((uid) => uid.slice(uid.indexOf("~") + 1)));

  // A name or a label typed into the search finds that person's or label's photos, matched
  // as the names are folded elsewhere: case and accents aside, anywhere in the name.
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
  // A month and a year at the end of the strip's search ("2026 january", "jan 2026") are a
  // date, as on Android: the photos of that month, year, or month of every year.
  const dateQ = useMemo(
    () => parseDateQuery(query, lang),
    [query, lang],
  );
  const textQuery = dateQ ? dateQ.rest : query;
  // The date a pause in the typing turned into a pill. A date typed after it takes over.
  const [datePin, setDatePin] = useState<DateQuery | null>(null);
  // People and labels picked into the search as pills: their photos only, every pill at once.
  const [namePins, setNamePins] = useState<{ kind: "people" | "labels"; name: string; uids: Set<string> }[]>([]);
  useEffect(() => {
    if (!dateQ) return;
    const id = setTimeout(() => {
      setDatePin({ year: dateQ.year, month: dateQ.month, rest: "" });
      setQuery(dateQ.rest);
    }, DATE_PILL_MS);
    return () => clearTimeout(id);
  }, [dateQ]);
  const activeDate = dateQ ?? datePin;
  const searching = query.trim() !== "" || datePin !== null || namePins.length > 0;
  const namedMatches = useMemo(() => {
    const q = fold(textQuery);
    if (q.length < 2) return [];
    return [
      ...peopleEntries.map((entry) => ({ kind: "people" as const, entry })),
      ...labelEntries.map((entry) => ({ kind: "labels" as const, entry })),
    ].filter(({ entry }) => fold(entry.name).includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textQuery, peopleEntries, labelEntries]);
  const namedUids = useMemo(() => new Set(namedMatches.flatMap(({ entry }) => entry.uids)), [namedMatches]);
  const query_ = textQuery.trim().toLowerCase();

  const filtered = useMemo(() => {
    // A person, a label or the offline set is the whole question: no category, search or
    // album hiding narrows it further, as none of their controls is shown with it.
    const ordered = (list: TimelineItem[]) => {
      if (timelineSort.by === "name") {
        const dir = timelineSort.asc ? 1 : -1;
        const nameOf = (it: TimelineItem) => meta[it.uid]?.name ?? "";
        return [...list].sort((a, b) => dir * nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }));
      }
      return timelineSort.asc ? [...list].reverse() : list;
    };
    if (uidFilter?.favorites) return ordered(items.filter((it) => it.tags?.includes(TAG.Favorite)));
    if (uidFilter) {
      const base = uidFilter.includeHidden ? allItems : items;
      // An album kept offline can hold photos that are in no timeline: they come from the album.
      const inBase = new Set(base.map((it) => it.uid));
      const extra = uidFilter.offline ? offlineAlbumItems.filter((it) => !inBase.has(it.uid) && !hidden.isPhoto(it.uid)) : [];
      return ordered([...base, ...extra].filter((it) => uidFilter.uids.has(it.uid)));
    }
    // Categories are multi-select: an item matches if it carries a tag from ANY
    // selected category (OR) — the same union a single category already forms over
    // its own tag list (e.g. Live = Live + Motion photos).
    const selectedCats = CATEGORIES.filter((c) => categories.has(c.key));
    let base =
      selectedCats.length > 0
        ? items.filter((it) => selectedCats.some((cat) => it.tags?.some((tg) => cat.tags.includes(tg))))
        : items;

    // Android parity: the album-hide only applies to the unfiltered timeline. A
    // category selection (Favorites, Videos, ...) deliberately bypasses it, and so does a
    // search, which looks for photos wherever they are filed.
    if (selectedCats.length === 0 && !searching && settings.hideAlbumPhotos && albumMembers && albumMembers.size > 0) {
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

    if (activeDate) base = base.filter((it) => inDate(it.captureTime, activeDate));
    for (const pin of namePins) base = base.filter((it) => pin.uids.has(it.uid));
    if (query_) {
      base = base.filter((it) => {
        if (namedUids.has(it.uid)) return true;
        const m = meta[it.uid];
        if (!m) return false; // not indexed yet
        return m.name.toLowerCase().includes(query_) || (m.mediaType ?? "").toLowerCase().includes(query_);
      });
    }
    return ordered(base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, allItems, categories, mediaType, query_, activeDate, namePins, searching, timelineSort, meta, settings.hideAlbumPhotos, albumMembers, uidFilter, namedUids, offlineAlbumItems, hidden]);


  // What the phone's copies are read for, from the settings: each kind on its own switch.
  const driveKinds = `${settings.driveFaces}:${settings.driveLabels}:${settings.semanticSearch}:${settings.localFaces || settings.sharedBackup}`;
  // Detailed diagnostics: every photo and file step noted, not only the slow ones.
  useEffect(() => {
    if (settingsLoaded) void rpc("diagSetDetailed", { on: settings.diagDetailed }).catch(() => {});
  }, [settingsLoaded, settings.diagDetailed]);

  // Compression on upload, as Settings has it: the sidecar decides each file by it.
  useEffect(() => {
    if (!settingsLoaded) return;
    void rpc("uploadCompressionSet", {
      photos: settings.compressPhotos,
      hdr: settings.compressHdr,
      tier: settings.compressTier,
      videos: settings.compressVideos,
      videoTier: settings.compressVideoTier,
      codec: settings.compressCodec,
    }).catch(() => {});
  }, [
    settingsLoaded,
    settings.compressPhotos,
    settings.compressHdr,
    settings.compressTier,
    settings.compressVideos,
    settings.compressVideoTier,
    settings.compressCodec,
  ]);

  // The shared backup reads the same kinds each round before it saves this computer's copies.
  useEffect(() => {
    if (!settingsLoaded) return;
    void rpc("sharedBackupSet", {
      on: settings.sharedBackup,
      faces: settings.driveFaces,
      labels: settings.driveLabels,
      search: settings.semanticSearch,
      // With the backup on, the face copies are read with face recognition off too: a delete of
      // the face data everywhere made on another device reaches this PC through them.
      faceData: settings.localFaces || settings.sharedBackup,
    }).catch(() => {});
  }, [settingsLoaded, settings.sharedBackup, driveKinds]);
  const loadDrive = useCallback(
    (refresh: boolean) => {
      // A read over data already shown keeps showing it, and a failed one leaves it be.
      setDrive((d) => ({ state: "loading", data: d?.data ?? null, at: d?.at ?? 0 }));
      rpc<DriveCollections>("getDriveCollections", {
        refresh,
        faces: settings.driveFaces,
        labels: settings.driveLabels,
        search: settings.semanticSearch,
        // Faces found on this PC are set beside the phone's, so its copy is read for them too.
        faceData: settings.localFaces || settings.sharedBackup,
      })
        .then((data) => setDrive({ state: "ready", data, at: Date.now() }))
        .catch(() =>
          setDrive((d) => (d?.data ? { ...d, state: "ready" } : { state: "failed", data: null, at: d?.at ?? 0 })),
        );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [driveKinds],
  );
  // Read once the library is in, and again whenever the switches change what is read.
  const driveKindsRead = useRef<string | null>(null);
  useEffect(() => {
    if (!settingsLoaded || items.length === 0) return;
    if (driveKindsRead.current === driveKinds) return;
    driveKindsRead.current = driveKinds;
    loadDrive(false);
  }, [settingsLoaded, items.length, driveKinds, loadDrive]);
  // Kept fresh: the phone may save new copies at any time. A look costs a folder listing; only
  // a copy whose revision changed is downloaded again.
  const driveAt = useRef(0);
  driveAt.current = drive?.at ?? 0;
  useEffect(() => {
    if (!settingsLoaded) return;
    const every = window.setInterval(() => loadDrive(true), DRIVE_REFRESH_MS);
    const onFocus = () => {
      if (driveAt.current > 0 && Date.now() - driveAt.current > DRIVE_REFRESH_ON_FOCUS_MS) loadDrive(true);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(every);
      window.removeEventListener("focus", onFocus);
    };
  }, [settingsLoaded, loadDrive]);

  // Search by what a photo shows: the phone's index on Drive, asked once the typing settles.
  const semanticOn =
    settings.semanticSearch &&
    (settings.localSearch
      ? (localFaces.status?.search?.indexed ?? 0) > 0
      : (drive?.data?.searchPhotos ?? 0) > 0);
  const [semanticHits, setSemanticHits] = useState<TimelineItem[]>([]);
  useEffect(() => {
    const q = textQuery.trim();
    if (!semanticOn || q.length < SEMANTIC_MIN_CHARS) {
      setSemanticHits([]);
      return;
    }
    let live = true;
    const id = window.setTimeout(() => {
      rpc<{ key: string; score: number }[]>("semanticSearch", { query: q }).then(
        (hits) => {
          if (!live) return;
          setSemanticHits(hits.map((h) => byLinkId.get(h.key)).filter((it): it is TimelineItem => !!it));
        },
        () => live && setSemanticHits([]),
      );
    }, SEMANTIC_SETTLE_MS);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [semanticOn, textQuery, byLinkId]);
  /** The photos found by what they show and not already by their words, narrowed as the rest. */
  const semanticItems = useMemo(() => {
    if (semanticHits.length === 0 || !searching || uidFilter) return [];
    const shownAlready = new Set(filtered.map((it) => it.uid));
    const selectedCats = CATEGORIES.filter((c) => categories.has(c.key));
    return semanticHits.filter(
      (it) =>
        !shownAlready.has(it.uid) &&
        (!activeDate || inDate(it.captureTime, activeDate)) &&
        namePins.every((pin) => pin.uids.has(it.uid)) &&
        (selectedCats.length === 0 || selectedCats.some((cat) => it.tags?.some((tg) => cat.tags.includes(tg)))) &&
        (mediaType === "all" ||
          (isVideo(it.tags, meta[it.uid]?.mediaType ?? cachedMediaType(it.uid)) ?? false) === (mediaType === "video")),
    );
  }, [semanticHits, searching, uidFilter, filtered, activeDate, namePins, categories, mediaType, meta]);
  /** What the grid shows, in its order: the photos found by their words, then by what they show.
   *  The viewer and the selection walk this. */
  const shown = useMemo(
    () => (semanticItems.length > 0 ? [...filtered, ...semanticItems] : filtered),
    [filtered, semanticItems],
  );
  // A photo to open in the viewer as soon as the list it was opened into is on screen.
  const [openOnShow, setOpenOnShow] = useState<string | null>(null);
  useEffect(() => {
    if (!openOnShow || view !== "photos") return;
    const at = shown.findIndex((f) => f.uid === openOnShow);
    if (at < 0) return;
    setOpenOnShow(null);
    setLightboxIdx(at);
  }, [openOnShow, view, shown]);

  // The places, newest photos first and a batch at a time, so the map fills as they come. Once
  // the map has been opened, photos that arrive later are looked up too, and only they are.
  // The progress line shows only while places are read from Drive: the ones this computer has
  // read before come from its cache in a moment, and counting through them read as a search
  // starting over on every launch.
  const placesAsked = useRef(new Set<string>());
  const placesFound = useRef(new Map<string, { lat: number; lon: number }>());
  const placesBusy = useRef(false);
  const [placesRound, setPlacesRound] = useState(0);
  useEffect(() => {
    if ((libraryPage !== "map" && placesAsked.current.size === 0) || placesBusy.current || items.length === 0) return;
    const fresh = items.map((it) => it.uid).filter((uid) => !placesAsked.current.has(uid));
    if (fresh.length === 0) return;
    placesBusy.current = true;
    fresh.forEach((uid) => placesAsked.current.add(uid));
    const takenAt = new Map(items.map((it) => [it.uid, it.captureTime]));
    const publish = (done: number, finished: boolean, reading: boolean) => {
      const points: MapPoint[] = [];
      for (const [uid, at] of placesFound.current) points.push({ uid, ...at, captureTime: takenAt.get(uid) ?? 0 });
      setPlaces({ points, done, total: fresh.length, finished, reading });
    };
    void (async () => {
      let reading = false;
      for (let at = 0; at < fresh.length; at += PLACES_BATCH) {
        const found = await rpc<{ points: { uid: string; lat: number; lon: number }[]; read: number }>("getLocations", {
          uids: fresh.slice(at, at + PLACES_BATCH),
        }).catch(() => ({ points: [], read: 0 }));
        for (const f of found.points) placesFound.current.set(f.uid, { lat: f.lat, lon: f.lon });
        if (found.read > 0) reading = true;
        const done = Math.min(fresh.length, at + PLACES_BATCH);
        publish(done, done >= fresh.length, reading);
      }
      placesBusy.current = false;
      // Photos that arrived while this round ran are taken in the next.
      setPlacesRound((n) => n + 1);
    })();
  }, [libraryPage, items, placesRound]);
  // A photo moved to the trash or hidden leaves the map with the timeline.
  const mapPoints = useMemo(() => {
    if (!places) return [];
    const present = new Set(items.map((it) => it.uid));
    return places.points.filter((p) => present.has(p.uid));
  }, [places, items]);

  // The shortcut row over the album list, in the Android app's order where they overlap.
  const collectionSections: CollectionSection[] = [
    { key: "people", title: t("library.people"), entries: peopleEntries, onSeeAll: () => setLibraryPage("people") },
    {
      key: "onthisday",
      title: t("library.onThisDay"),
      entries: memoryEntries.onThisDay,
      onSeeAll: () => setCollectionSection("onthisday"),
    },
    {
      key: "seasons",
      title: t("library.seasons"),
      entries: memoryEntries.seasons,
      onSeeAll: () => setCollectionSection("seasons"),
    },
  ];
  const librarySelected: string | null =
    view === "shared"
      ? "shared"
      : view === "albums" && libraryPage
        ? libraryPage
        : view === "albums" && albumOpen && hidden.isAlbum(albumOpen.uid)
          ? "hidden"
        : view === "photos" && uidFilter
          ? uidFilter.favorites
            ? "favorites"
            : uidFilter.back === "albums"
              ? "offline"
              : uidFilter.back
          : null;
  /** A library page, opened from any view: the sidebar's shortcuts sit beside every page,
   *  not only on the Albums tab the tiles live on. */
  const openLibrary = (page: LibraryPageKind) => {
    goToView("albums");
    setCollectionSection(null);
    setLibraryPage(page);
  };
  const libraryTilesAll: Tile[] = [
    {
      key: "collection",
      label: t("library.collection"),
      icon: <CollectionsIcon size={18} />,
      onClick: () => openLibrary("collection"),
    },
    {
      key: "shared",
      label: t("nav.shared"),
      icon: <NavSharedIcon size={18} />,
      badge: invitations.length > 0,
      // The invitations are listed with what is shared with the reader, so that side opens.
      onClick: () => {
        if (invitations.length > 0) setSharedTab("with");
        goToView("shared");
      },
    },
    { key: "map", label: t("library.map"), icon: <MapIcon size={18} />, onClick: () => openLibrary("map") },
    {
      key: "people",
      label: t("library.people"),
      icon: <FaceIcon size={18} />,
      onClick: () => openLibrary("people"),
    },
    {
      key: "labels",
      label: t("library.labels"),
      icon: <LabelIcon size={18} />,
      onClick: () => openLibrary("labels"),
    },
    {
      key: "offline",
      label: t("library.offline"),
      icon: <OfflinePinIcon size={18} />,
      onClick: () => openFiltered({ name: t("library.offline"), uids: new Set(offlineUids), back: "albums", offline: true }),
    },
    { key: "hidden", label: t("library.hidden"), icon: <LockIcon size={18} />, onClick: () => openLibrary("hidden") },
  ];
  const libraryTiles = libraryTilesAll.filter(
    (tile) =>
      (tile.key !== "people" || settings.driveFaces || settings.localFaces) &&
      (tile.key !== "labels" || settings.driveLabels),
  );
  /** The sidebar's groups: the photos themselves, the ways into them, and the tools. */
  const fromTiles = (keys: string[]): SidebarEntry[] =>
    keys.flatMap((key) => {
      const tile = libraryTiles.find((x) => x.key === key);
      return tile
        ? [{ key, label: tile.label, icon: tile.icon, badge: tile.badge, selected: librarySelected === key, onClick: tile.onClick }]
        : [];
    });
  const sidebarSections: SidebarSection[] = [
    {
      key: "photos",
      title: t("nav.photos"),
      entries: [
        {
          key: "library",
          label: t("nav.library"),
          icon: <NavPhotosIcon size={19} />,
          selected: view === "photos" && !uidFilter,
          onClick: () => goToView("photos"),
        },
        {
          key: "favorites",
          label: t("library.favorites"),
          icon: <HeartIcon size={18} />,
          selected: librarySelected === "favorites",
          onClick: () => openFiltered({ name: t("library.favorites"), uids: new Set(), back: "albums", favorites: true }),
        },
      ],
    },
    {
      key: "collections",
      title: t("sidebar.collections"),
      entries: [
        {
          key: "albums",
          label: t("nav.albums"),
          icon: <NavAlbumsIcon size={19} />,
          selected: view === "albums" && !librarySelected,
          onClick: () => goToView("albums"),
        },
        ...fromTiles(["shared", "people", "labels", "map", "collection", "offline"]),
      ],
    },
    {
      key: "utilities",
      title: t("sidebar.utilities"),
      entries: [
        {
          key: "duplicates",
          label: t("sidebar.duplicates"),
          icon: <ContentCopyIcon size={18} />,
          selected: librarySelected === "duplicates",
          onClick: () => openLibrary("duplicates"),
        },
        {
          key: "fixdates",
          label: t("fixDates.title"),
          icon: <CalendarIcon size={18} />,
          selected: librarySelected === "fixdates",
          onClick: () => openLibrary("fixdates"),
        },
        ...fromTiles(["hidden"]),
        {
          key: "trash",
          label: t("nav.trash"),
          icon: <NavTrashIcon size={19} />,
          selected: view === "trash",
          onClick: () => goToView("trash"),
        },
      ],
    },
  ];

  // What the viewer's filmstrip and contents list walk: the same order the grid
  // shows, so stepping through the viewer and scrolling the grid agree. Memoised
  // because the viewer takes the array's identity as "the list changed", and a
  // fresh one built on every render would restart its thumbnail loading.
  const viewerItems = useMemo(
    () => shown.map((it) => ({ uid: it.uid, name: meta[it.uid]?.name, video: videoKind(it) === "video" })),
    [shown, meta],
  );

  // Un-favouriting under the Favorites filter drops the open photo out of the
  // grid. A stale index then renders no lightbox while still holding the grid's
  // keys and marquee disabled, so pull it back in range (or close).
  useEffect(() => {
    setLightboxIdx((i) =>
      i === null || i < shown.length ? i : shown.length > 0 ? shown.length - 1 : null,
    );
  }, [shown.length]);

  const sections = useMemo(() => {
    if (timelineSort.by === "name") return [{ label: "name", items: filtered }];
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
  }, [filtered, timelineSort.by]);
  // The grid draws a deferred copy, so a filter chip answers at once and the grid follows
  // behind it, in work the next click can interrupt. Clearing a filter on a large library
  // brings thousands of tiles back at once, and drawing them in the click itself is what
  // made clearing one stall where setting it did not.
  const shownSections = useDeferredValue(sections);
  const virtualSections = useMemo(() => {
    const base = shownSections.map((s) => ({ key: s.label, items: s.items }));
    return semanticItems.length > 0 ? [...base, { key: t("search.byContent"), items: semanticItems }] : base;
  }, [shownSections, semanticItems, t]);

  const hiddenPhotos = useMemo(
    () => allItems.filter((it) => hidden.photos.has(it.uid.slice(it.uid.lastIndexOf("~") + 1))),
    [allItems, hidden],
  );
  // The hidden albums are asked for only once the page is open: no other list carries them.
  const [hiddenAlbums, setHiddenAlbums] = useState<Album[]>([]);
  const hiddenOpen = libraryPage === "hidden" && hiddenAccess !== "locked";
  useEffect(() => {
    if (!hiddenOpen) {
      setHiddenAlbums([]);
      return;
    }
    let live = true;
    void rpc<Album[]>("getAlbums", { includeHidden: true }).then(
      (list) => live && setHiddenAlbums(list.filter((a) => hidden.isAlbum(a.uid))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [hiddenOpen, hidden]);

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

  // The top strip's search also finds albums by name, shown in a row over the photos it
  // finds. Only in the sidebar layout, where that one search stands for the whole library.
  const albumMatches = useMemo(() => {
    const q = fold(textQuery);
    if (!q) return [];
    return (warm.albums ?? []).filter((a) => !hidden.isAlbum(a.uid) && fold(a.name ?? "").includes(q)).slice(0, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textQuery, warm.albums, hidden]);
  const albumMatchCovers = useThumbnails(
    useMemo(() => albumMatches.map((a) => a.coverUid).filter((u): u is string => !!u), [albumMatches]),
  );
  const albumsWanted = query.trim() !== "" && warm.albums === null;
  useEffect(() => {
    if (!albumsWanted) return;
    void rpc<Album[]>("getAlbums").then(warm.putAlbums, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumsWanted]);
  const stripSearch = useRef<HTMLInputElement>(null);
  /**
   * The names the search turns into pills, in the app's language and in English: the
   * categories, the two types, and the people and labels the phone saved. Videos are the
   * type rather than the category of the same name, as in the filter menu.
   */
  const searchTerms = useMemo(() => {
    const terms: (SearchTerm & { kind: string; icon: ReactNode; apply: () => void })[] = [];
    for (const c of CATEGORIES) {
      if (c.key === "video") continue;
      const label = t(`category.${c.key}`);
      terms.push({
        key: `cat:${c.key}`,
        label,
        forms: [...new Set([...wordForms(label, lang), ...wordForms(c.label, "en")])],
        kind: t("filter.categories"),
        icon: CATEGORY_ICONS[c.key] ?? <ImageIcon size={17} />,
        apply: () => setCategories((cur) => new Set(cur).add(c.key)),
      });
    }
    const photos = t("filter.mediaPhotos");
    terms.push({
      key: "type:photo",
      label: photos,
      forms: [...new Set([...wordForms(photos, lang), "photos", "photo", "pictures", "picture", "images", "image"])],
      kind: t("filter.type"),
      icon: <ImageIcon size={17} />,
      apply: () => setMediaType("photo"),
    });
    const videos = t("filter.videos");
    terms.push({
      key: "type:video",
      label: videos,
      forms: [...new Set([...wordForms(videos, lang), "videos", "video", "movies", "movie"])],
      kind: t("filter.type"),
      icon: <PlayArrowIcon size={17} />,
      apply: () => setMediaType("video"),
    });
    const named = (kind: "people" | "labels", entry: LibraryEntry) => ({
      key: `${kind}:${entry.name}`,
      label: entry.name,
      forms: [foldPhrase(entry.name)],
      kind: t(kind === "people" ? "library.people" : "library.labels"),
      icon: kind === "people" ? <FaceIcon size={17} /> : <LabelIcon size={17} />,
      apply: () =>
        setNamePins((pins) =>
          pins.some((p) => p.kind === kind && p.name === entry.name)
            ? pins
            : [...pins, { kind, name: entry.name, uids: new Set(entry.uids) }],
        ),
    });
    for (const entry of peopleEntries) terms.push(named("people", entry));
    for (const entry of labelEntries) terms.push(named("labels", entry));
    return terms;
  }, [t, lang, peopleEntries, labelEntries]);
  /** Picks a term: its pill goes in, and the words that named it leave the text. */
  const pickTerm = (term: (typeof searchTerms)[number], rest: string) => {
    term.apply();
    const datePart = dateQ ? query.trim().slice(dateQ.rest.length).trim() : "";
    setQuery([rest, datePart].filter(Boolean).join(" "));
  };
  // A whole name at the end of the text becomes its pill once the typing pauses, as on Android.
  useEffect(() => {
    const found = termAtEnd(textQuery, searchTerms);
    if (!found) return;
    const id = window.setTimeout(() => pickTerm(found.term as (typeof searchTerms)[number], found.rest), DATE_PILL_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textQuery, searchTerms]);
  /** Empties the search: the text and every pill it holds. */
  const clearSearch = () => {
    setQuery("");
    setDatePin(null);
    setNamePins([]);
    resetFilter();
  };
  const searchSuggestions: SearchSuggestion[] = termsStartedAtEnd(textQuery, searchTerms).map(({ term, rest }) => {
    const full = term as (typeof searchTerms)[number];
    return { key: full.key, label: full.label, kind: full.kind, icon: full.icon, onPick: () => pickTerm(full, rest) };
  });
  /** What narrows the photos besides the text, shown in the strip's search: the date a
   *  pause turned into a pill, the type, the categories. */
  const searchPills: SearchPill[] = [
    ...(datePin
      ? [{ key: "date", label: dateLabel(datePin, lang), icon: <CalendarIcon size={15} />, onRemove: () => setDatePin(null) }]
      : []),
    ...(mediaType !== "all"
      ? [
          {
            key: "type",
            label: t(mediaType === "video" ? "filter.videos" : "filter.mediaPhotos"),
            icon: mediaType === "video" ? <PlayArrowIcon size={15} /> : <ImageIcon size={15} />,
            onRemove: () => setMediaType("all"),
          },
        ]
      : []),
    // The dock layout keeps its rail of category chips, which already shows them.
    ...CATEGORIES.filter((c) => settings.sidebarLayout && categories.has(c.key)).map((c) => ({
      key: `cat:${c.key}`,
      label: t(`category.${c.key}`),
      onRemove: () => toggleCategory(c.key),
    })),
    ...namePins.map((pin) => ({
      key: `${pin.kind}:${pin.name}`,
      label: pin.name,
      icon: pin.kind === "people" ? <FaceIcon size={15} /> : <LabelIcon size={15} />,
      onRemove: () => setNamePins((pins) => pins.filter((p) => p !== pin)),
    })),
  ];
  /** The strip's search reaches the whole library, so a query takes the page to its results. */
  const onGlobalQuery = (q: string) => {
    setQuery(q);
    if (q.trim() && (view !== "photos" || uidFilter || uploadOpen)) goToView("photos");
  };
  // Ctrl + F goes to that search, as it does in the system's own Photos app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        stripSearch.current?.focus();
        stripSearch.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The masthead is a sticky header (see .g-albumhero): it pins to the top of the scroll
  // so the album's cover, title and actions stay in view while the photos scroll under it.

  /** Drop a trashed photo from the grid and keep the lightbox on a valid item. */
  function handleTrashed(uid: string) {
    setItems((prev) => prev.filter((it) => it.uid !== uid));
    setLightboxIdx((i) => {
      if (i === null) return null;
      const remaining = shown.length - 1;
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
    const current = shown[lightboxIdx];
    if (!current) return;
    const uids: string[] = [];
    for (let d = 1; d <= PREFETCH_RADIUS; d++) {
      const next = shown[lightboxIdx + d];
      const prev = shown[lightboxIdx - d];
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
  sel.order.current = view === "photos" ? shown.map((f) => f.uid) : [];

  /**
   * A click on a tile: ignore the one a drag emits, otherwise select or open. Shift or
   * Ctrl selects even with nothing selected yet, as in File Explorer.
   */
  function onCellClick(uid: string, e?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
    if (sel.wasDragging()) return;
    if (selected.size > 0 || e?.shiftKey || e?.ctrlKey || e?.metaKey) sel.toggle(uid, e);
    else setLightboxIdx(shown.findIndex((f) => f.uid === uid));
  }

  // A wheel notch is one step, but a touchpad pinch sends a stream of small deltas that
  // stepped the zoom on every one of them. They are added up, and a step waits for a whole
  // notch's worth and for the last step's glide to be under way.
  const wheelZoom = useRef({ sum: 0, at: 0 });
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    // The map zooms itself under the wheel.
    if (view === "albums" && libraryPage === "map") return;
    e.preventDefault();
    const acc = wheelZoom.current;
    acc.sum += e.deltaY;
    const now = performance.now();
    if (Math.abs(acc.sum) < WHEEL_STEP || now - acc.at < WHEEL_STEP_MS) return;
    const out = acc.sum > 0;
    acc.sum = 0;
    acc.at = now;
    // The album list zooms its own cards; the timeline and an open album share the photo zoom.
    if (view === "albums" && !albumOpen) {
      setAlbumZoom(out ? albumZoom - 1 : albumZoom + 1);
    } else {
      setZoom(out ? zoom - 1 : zoom + 1);
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
  // What a "syncing" is, said where it shows: the folder's own work first, then the
  // library's first read. The folder's quiet checks name nothing, so they show nothing.
  const syncInfo: SyncInfo | null = mountActivity
    ? describeMount(mountActivity, t)
    : loading
      ? { title: t("sync.library"), why: t("sync.libraryWhy"), done: 0, total: 0 }
      : null;

  const activity: Activity | null = offline
    ? { kind: "sync", label: t("offlineMode.label"), why: t("offlineMode.why") }
    : uploads.running
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
        : syncInfo
          ? { kind: "sync", label: syncInfo.title, why: syncInfo.why }
          : null;

  const current = lightboxIdx !== null ? shown[lightboxIdx] : null;

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
          key: "hide",
          label: t("hidden.hideAlbum"),
          icon: <VisibilityOffIcon size={14} />,
          onSelect: () => setConfirmHideAlbum(albumMenu.target),
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
        ...(settings.driveLabels
          ? [{ key: "labels", label: t("selection.labels"), icon: <LabelIcon size={14} />, onSelect: openLabelPicker }]
          : []),
        {
          key: "editDate",
          label: t("selection.editDate"),
          icon: <CalendarIcon size={14} />,
          onSelect: () => setDateEditUids([...selected]),
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
        uidFilter?.back === "hidden"
          ? {
              key: "unhide",
              label: t("selection.unhide"),
              icon: <VisibilityIcon size={14} />,
              onSelect: () => void runSelection(async () => {
                await hidePhotos([...selected], false);
                sel.clear();
              }),
            }
          : {
              key: "hide",
              label: t("selection.hide"),
              icon: <VisibilityOffIcon size={14} />,
              onSelect: () => setConfirmHide([...selected]),
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

  return (
    <div className={`gallery${sidebar ? " has-sidebar" : ""}`}>
      {sidebar && (
        <TopStrip
          ref={stripSearch}
          query={query}
          onQuery={onGlobalQuery}
          pills={searchPills}
          onClearAll={clearSearch}
          suggestions={searchSuggestions}
          activity={activity}
          dragging={uploads.dragging}
          onUpload={() => openUpload()}
          onSettings={() => openSettings()}
        />
      )}
      <div className="g-frame">
      {sidebar && (
        <Sidebar
          sections={sidebarSections}
          onSettings={() => openSettings()}
          onSignOut={onSignOut}
          collapsed={settings.sidebarCollapsed}
          onToggleCollapsed={() =>
            updateSettings({ ...settings, sidebarCollapsed: !settings.sidebarCollapsed })
          }
          account={account}
          email={email}
        />
      )}
      <div className={`g-main${sidebar && view === "albums" && libraryPage === "map" ? " map-full" : ""}`}>
      <div className="g-topbar">
        {view === "photos" && uidFilter && sidebar && uidFilter.back === "albums" && (
          <>
            <div className="g-pagehead">
              <h1 className="g-pagetitle">{uidFilter.name}</h1>
              <span className="g-pagesub">
                {t(filtered.length === 1 ? "common.photoCount.one" : "common.photoCount.other", { count: filtered.length })}
              </span>
            </div>
            <div className="g-spacer" data-tauri-drag-region="" />
          </>
        )}
        {view === "photos" && uidFilter && !(sidebar && uidFilter.back === "albums") && (
          <>
            <button
              className="g-back"
              title={
                uidFilter.back === "people"
                  ? t("library.people")
                  : uidFilter.back === "labels"
                    ? t("library.labels")
                    : uidFilter.back === "map"
                      ? t("library.map")
                      : uidFilter.back === "collection"
                        ? t("library.collection")
                        : uidFilter.back === "duplicates"
                          ? t("duplicates.title")
                          : uidFilter.back === "fixdates"
                            ? t("fixDates.title")
                          : uidFilter.back === "hidden"
                            ? t("hidden.title")
                            : t("nav.albums")
              }
              onClick={() => {
                const back = uidFilter.back;
                goToView("albums");
                if (back !== "albums") setLibraryPage(back);
              }}
            >
              <ChevronLeftIcon />
            </button>
            <span className="g-crumbtitle">{uidFilter.name}</span>
            <span className="g-crumbcount">
              {t(filtered.length === 1 ? "common.photoCount.one" : "common.photoCount.other", { count: filtered.length })}
            </span>
            <div className="g-spacer" data-tauri-drag-region={sidebar ? "" : undefined} />
            {uidFilter.personId && settings.localFaces && (
              <PersonActions
                key={uidFilter.personId}
                name={localEntries.named.some((e) => e.personId === uidFilter.personId) ? uidFilter.name : null}
                names={localEntries.named.filter((e) => e.personId !== uidFilter.personId).map((e) => e.name)}
                others={[...localEntries.named, ...localEntries.unnamed].filter((e) => e.personId !== uidFilter.personId)}
                onMerge={async (other) => {
                  const here = uidFilter.personId!;
                  const hereNamed = localEntries.named.some((e) => e.personId === here);
                  const otherNamed = localEntries.named.some((e) => e.personId === other.personId);
                  // The name stays: a named person takes in an unnamed one, whichever page this is.
                  const [from, into] = hereNamed && !otherNamed ? [other.personId!, here] : [here, other.personId!];
                  await localFaces.act("facePersonMerge", { from, into }, () =>
                    setUidFilter((f) => (f && f.personId !== into ? { ...f, personId: into } : f)),
                  );
                }}
                onRename={async (name) => {
                  await localFaces.act<{ id: string }>(
                    "facePersonRename",
                    { id: uidFilter.personId, name },
                    ({ id }) => setUidFilter((f) => (f && f.personId !== id ? { ...f, personId: id } : f)),
                  );
                }}
                onReject={async () => {
                  await localFaces.act("facePersonReject", { id: uidFilter.personId });
                }}
                onSplit={() => setSplitOpen(true)}
                findOpen={findOpen}
                onFind={
                  localEntries.named.some((e) => e.personId === uidFilter.personId)
                    ? () => setFindOpen((o) => !o)
                    : undefined
                }
              />
            )}
          </>
        )}
        {view === "photos" && !uidFilter && sidebar && (
          <>
            <div className="g-pagehead">
              <h1 className="g-pagetitle">
                {searching
                  ? t("search.resultsTitle", {
                      query: [query.trim(), datePin ? dateLabel(datePin, lang) : "", ...namePins.map((p) => p.name)]
                        .filter(Boolean)
                        .join(" "),
                    })
                  : t("nav.photos")}
              </h1>
              <span className="g-pagesub">
                {hidingKnown && !(loading && items.length === 0)
                  ? t(shown.length === 1 ? "common.photoCount.one" : "common.photoCount.other", { count: shown.length })
                  : " "}
              </span>
            </div>
            <div className="g-spacer" data-tauri-drag-region="" />
            <div className="g-tools">
              <button className="g-tool" onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setToolMenu({ kind: "sort", x: r.right, y: r.bottom + 6 });
              }} title={t("sort.title")}>
                <SortIcon size={18} />
                <ChevronDownIcon size={15} />
              </button>
              <button
                className={`g-tool${activeFilterCount > 0 ? " on" : ""}`}
                onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setToolMenu({ kind: "filter", x: r.right, y: r.bottom + 6 });
              }}
                title={t("filter.title")}
              >
                <FilterIcon size={16} />
                {activeFilterCount > 0 && <span className="g-toolbadge">{activeFilterCount}</span>}
                <ChevronDownIcon size={15} />
              </button>
            </div>
          </>
        )}
        {view === "photos" && !uidFilter && !sidebar && (
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
            <button
              className="g-tool"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setToolMenu({ kind: "sort", x: r.right, y: r.bottom + 6 });
              }}
              title={t("sort.title")}
            >
              <SortIcon size={18} />
              <ChevronDownIcon size={15} />
            </button>
            <SearchField
              ref={stripSearch}
              className="g-docksearch"
              query={query}
              onQuery={setQuery}
              pills={searchPills}
              onClearAll={clearSearch}
              suggestions={searchSuggestions}
              onFocusChange={setSearchFocused}
            />
            <div className="g-spacer" />
          </>
        )}
        {/* The album LIST gets the same search field the timeline has (filtering album
            names) plus a sort control, mirrored from the phone app. */}
        {view === "albums" && libraryPage && sidebar && !(libraryPage === "collection" && collectionSection) && (
          <>
            <div className="g-pagehead">
              <h1 className="g-pagetitle">
                {t(
                  libraryPage === "collection"
                    ? "library.collection"
                    : libraryPage === "people"
                      ? "library.people"
                      : libraryPage === "labels"
                        ? "library.labels"
                        : libraryPage === "duplicates"
                          ? "duplicates.title"
                          : libraryPage === "fixdates"
                            ? "fixDates.title"
                          : libraryPage === "hidden"
                            ? "hidden.title"
                            : "library.map",
                )}
              </h1>
            </div>
            <div className="g-spacer" data-tauri-drag-region="" />
          </>
        )}
        {view === "albums" && libraryPage && !(sidebar && !(libraryPage === "collection" && collectionSection)) && (
          <>
            <button
              className="g-back"
              onClick={() =>
                libraryPage === "collection" && collectionSection
                  ? setCollectionSection(null)
                  : setLibraryPage(null)
              }
              title={libraryPage === "collection" && collectionSection ? t("library.collection") : t("albums.backToAlbums")}
            >
              <ChevronLeftIcon />
            </button>
            <span className="g-crumbtitle">
              {libraryPage === "collection"
                ? collectionSection === "onthisday"
                  ? t("library.onThisDay")
                  : collectionSection === "seasons"
                    ? t("library.seasons")
                    : t("library.collection")
                : t(
                    libraryPage === "people"
                      ? "library.people"
                      : libraryPage === "labels"
                        ? "library.labels"
                        : libraryPage === "duplicates"
                          ? "duplicates.title"
                          : libraryPage === "fixdates"
                            ? "fixDates.title"
                          : libraryPage === "hidden"
                            ? "hidden.title"
                            : "library.map",
                  )}
            </span>
            <div className="g-spacer" data-tauri-drag-region={sidebar ? "" : undefined} />
          </>
        )}
        {view === "albums" && !albumOpen && !libraryPage && sidebar && (
          <>
            <div className="g-pagehead">
              <h1 className="g-pagetitle">{t("nav.albums")}</h1>
              <span className="g-pagesub">{warm.albums ? t(warm.albums.length === 1 ? "albums.countLabel.one" : "albums.countLabel.other", { count: warm.albums.length }) : "\u00a0"}</span>
            </div>
            <div className="g-spacer" data-tauri-drag-region="" />
            <div className="g-tools">
              <button className="g-tool" onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setToolMenu({ kind: "albumSort", x: r.right, y: r.bottom + 6 });
              }} title={t("sort.title")}>
                <SortIcon size={18} />
                <ChevronDownIcon size={15} />
              </button>
            </div>
          </>
        )}
        {view === "albums" && !albumOpen && !libraryPage && !sidebar && (
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
            <button
              className="g-back"
              onClick={() => {
                // A hidden album was opened from Hidden, and goes back there.
                if (hidden.isAlbum(albumOpen.uid)) setLibraryPage("hidden");
                setAlbumOpen(null);
              }}
              title={hidden.isAlbum(albumOpen.uid) ? t("hidden.title") : t("albums.backToAlbums")}
            >
              <ChevronLeftIcon />
            </button>
            <div className="g-spacer" data-tauri-drag-region={sidebar ? "" : undefined} />
          </>
        )}
        {view === "shared" && !sharedAlbumOpen && (
          <>
            {sidebar ? (
              <div className="g-pagehead">
                <h1 className="g-pagetitle">{t("nav.shared")}</h1>
                {sharedCount != null && <span className="g-pagesub">{sharedCount}</span>}
              </div>
            ) : (
              <>
                <button className="g-back" onClick={() => goToView("albums")} title={t("albums.backToAlbums")}>
                  <ChevronLeftIcon />
                </button>
                <span className="g-crumbtitle">{t("nav.shared")}</span>
                {!!sharedCount && <span className="g-crumbcount">{sharedCount}</span>}
              </>
            )}
            <div className="g-spacer" data-tauri-drag-region={sidebar ? "" : undefined} />
            {/* Android's control for the same choice: one pill that turns round,
                not two that compete. The arrow says which way the sharing goes and
                the swap mark says a click flips it. It sits at the row's end, apart
                from the title it would otherwise read as part of. */}
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
            </button>
          </>
        )}
        {view === "trash" && sidebar && (
          <>
            <div className="g-pagehead">
              <div className="g-pagetitlerow">
                <h1 className="g-pagetitle">{t("nav.trash")}</h1>
                {!!trashCount && (
                  <button
                    className="g-titleact danger"
                    onClick={() => setConfirmEmpty(true)}
                    title={t("trash.emptyAction")}
                    aria-label={t("trash.emptyAction")}
                  >
                    <DeleteForeverIcon size={19} />
                  </button>
                )}
              </div>
              <span className="g-pagesub">{t(trashCount === 1 ? "common.photoCount.one" : "common.photoCount.other", { count: trashCount ?? 0 })}</span>
            </div>
            <div className="g-spacer" data-tauri-drag-region="" />
          </>
        )}
        {view === "trash" && !sidebar && (
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
        {((view === "trash" && !sidebar) || (view === "shared" && sharedAlbumOpen)) && (
          <div className="g-spacer" data-tauri-drag-region={sidebar ? "" : undefined} />
        )}
        {/* In the sidebar layout the upload button lives on the sidebar instead, and
            the avatar with it, so the top bar's right side clears for the window
            buttons that tuck into that corner. */}
        {!sidebar && (
          <button
            className={`g-uploadbtn ${uploads.running ? "busy" : ""}`}
            onClick={() => openUpload()}
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
            onArrowClick={() => openUpload()}
          />
        )}
      </div>

      {menuOpen && !sidebar && (
        <ProfileMenu
          placement={sidebar ? "sidebar" : "topright"}
          account={account}
          onClose={() => setMenuOpen(false)}
          onSettings={() => {
            setMenuOpen(false);
            openSettings();
          }}
          onSignOut={() => {
            setMenuOpen(false);
            onSignOut();
          }}
        />
      )}

      {whatsNewOpen && (
        <WhatsNew
          onClose={() => {
            setWhatsNewOpen(false);
            updateSettings({ ...settings, whatsNewSeen: WHATS_NEW_ID });
          }}
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
      {view === "photos" &&
        !uidFilter &&
        (!sidebar || indexing) && (
        <div className="g-catrail">
          {!sidebar &&
            CATEGORIES.map((c) => (
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
        className={`g-scroll${view === "albums" && libraryPage === "map" ? " map-mode" : ""}${
          (findOpen && view === "photos" && uidFilter?.personId) ||
          (dateEditUids && (view === "photos" || view === "albums"))
            ? " with-panel"
            : ""
        }`}
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
                sub={`${albumSpan ? photoSpanLabel(albumSpan, locale) : albumDateLabel(albumOpen.lastActivityTime)} · ${t(
                  albumOpen.photoCount === 1 ? "common.photoCount.one" : "common.photoCount.other",
                  { count: albumOpen.photoCount },
                )}`}
              >
                <button
                  className="g-heroact"
                  title={t("albums.addPhotos")}
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
                  title={t("selection.download")}
                  onClick={() => void downloadAlbumAll()}
                  disabled={downloading || albumPhotoUids.length === 0}
                >
                  <DownloadIcon size={17} />
                  <span>{t("selection.download")}</span>
                </button>
                <button
                  className="g-heroact"
                  title={t("albums.share")}
                  onClick={() => setAlbumShareTarget(albumOpen)}
                  disabled={albumBusy}
                >
                  <ShareIcon size={17} />
                  <span>{t("albums.share")}</span>
                </button>
                <button
                  className="g-heroact"
                  title={t("albums.more")}
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
            {libraryPage === "map" ? (
              <MapView
                points={mapPoints}
                progress={places && !places.finished && places.reading ? { done: places.done, total: places.total } : null}
                settled={places?.finished ?? false}
                onOpen={(uids) => openFiltered({ name: t("library.map"), uids: new Set(uids), back: "map" })}
                title={sidebar ? t("library.map") : undefined}
                onOpenPlace={(name, uids) => openFiltered({ name, uids: new Set(uids), back: "map" })}
              />
            ) : libraryPage === "collection" ? (
              collectionSection ? (
                <EntryGrid
                  entries={memoryEntries[collectionSection === "onthisday" ? "onThisDay" : "seasons"]}
                  cardSize={Math.round((albumCellSize * 140) / 190)}
                  onOpen={(entry) => openFiltered({ name: entry.name, uids: new Set(entry.uids), back: "collection" })}
                />
              ) : (
                <CollectionPage
                  sections={collectionSections}
                  cardSize={Math.round((albumCellSize * 140) / 190)}
                  onOpen={(entry) => openFiltered({ name: entry.name, uids: new Set(entry.uids), back: "collection" })}
                />
              )
            ) : libraryPage === "people" && settings.localFaces ? (
              <LocalPeoplePage
                named={localEntries.named}
                unnamed={localEntries.unnamed}
                suggestions={localEntries.suggestions}
                onMerge={async (unnamed, named) => {
                  await localFaces.act("facePersonMerge", { from: unnamed.personId, into: named.personId });
                }}
                onDismiss={async (unnamed, named) => {
                  await localFaces.act("faceSuggestionDismiss", { unnamed: unnamed.personId, named: named.personId });
                }}
                loose={localFaces.people?.loose ?? { faces: [], total: 0 }}
                names={localEntries.named.map((e) => e.name)}
                onNameFaces={async (faceIds, name) => {
                  await localFaces.act("faceNameFaces", { faceIds, name });
                }}
                onRejectFaces={async (faceIds) => {
                  await localFaces.act("faceRejectFaces", { faceIds });
                }}
                selected={peopleSel}
                onToggle={togglePerson}
                onContext={(entry, e) => setPeopleMenu({ x: e.clientX, y: e.clientY, entry })}
                loaded={localEntries.loaded}
                scanning={scanLine}
                cardSize={Math.round((albumCellSize * 140) / 190)}
                onOpen={(entry) =>
                  openFiltered({ name: entry.name, uids: new Set(entry.uids), back: "people", personId: entry.personId })
                }
              />
            ) : libraryPage === "hidden" ? (
              <Hidden
                access={hiddenAccess}
                onAccess={setHiddenAccess}
                photos={hiddenPhotos}
                albums={hiddenAlbums}
                cellSize={cellSize}
                cardSize={Math.round((albumCellSize * 140) / 190)}
                onOpenPhoto={(uid) => {
                  openFiltered({ name: t("hidden.title"), uids: new Set(hiddenPhotos.map((p) => p.uid)), back: "hidden", includeHidden: true });
                  setOpenOnShow(uid);
                }}
                onOpenAlbum={(album) => {
                  setLibraryPage(null);
                  setAlbumOpen(album);
                }}
                onEditDate={openDateEdit}
                onUnhidePhotos={(uids) => void hidePhotos(uids, false)}
                onUnhideAlbum={(album) => void hideAlbum(album, false)}
              />
            ) : libraryPage === "fixdates" ? (
              <FixDates
                items={items}
                onEditDate={(uids, byName) => openDateEdit(uids, byName ? "name" : "set")}
                onView={(uids, at) => {
                  openFiltered({ name: t("fixDates.title"), uids: new Set(uids), back: "fixdates" });
                  setOpenOnShow(at);
                }}
              />
            ) : libraryPage === "duplicates" ? (
              <Duplicates
                onView={(uids, at) => {
                  openFiltered({ name: t("duplicates.title"), uids: new Set(uids), back: "duplicates" });
                  setOpenOnShow(at);
                }}
                onTrashed={(uids) => {
                  const gone = new Set(uids);
                  gone.forEach(dropPreview);
                  setItems((prev) => prev.filter((it) => !gone.has(it.uid)));
                }}
              />
            ) : libraryPage ? (
              <LibraryPage
                kind={libraryPage}
                state={libraryPage === "labels" ? (localLabels.loaded ? "ready" : "loading") : (drive?.state ?? "loading")}
                data={drive?.data ?? null}
                local={libraryPage === "labels"}
                entries={libraryPage === "people" ? peopleEntries : labelEntries}
                // The person card's own width at the album list's default size, and in step with it after.
                cardSize={Math.round((albumCellSize * 140) / 190)}
                onOpen={(entry) => openFiltered({ name: entry.name, uids: new Set(entry.uids), back: libraryPage })}
                onRetry={() => loadDrive(true)}
              />
            ) : (
              <>
                {!albumOpen && !albumQuery && !sidebar && <LibraryTiles tiles={libraryTiles} />}
                <Albums
                  cellSize={cellSize}
                  albumCellSize={albumCellSize}
                  query={albumQuery}
                  sort={albumSort}
                  open={albumOpen}
                  onOpenChange={(a) => {
                    setAlbumOpen(a);
                  }}
                  localUids={localUids}
                  offlineUids={offlineUids}
                  reloadKey={reloadKey}
                  initial={warm.albums}
                  onChanged={bumpReload}
                  onPhotoUids={setAlbumPhotoUids}
                  onSpan={setAlbumSpan}
                  onEditDate={openDateEdit}
                  onDateEditStarted={() => setDateRun(true)}
                  contentsRequest={albumContents}
                  onAlbumContext={(album, e) =>
                    setAlbumMenu({ x: e.clientX, y: e.clientY, target: album })
                  }
                  favoriteUids={favoriteUids}
                  onFavoriteChanged={handleFavoriteChanged}
                  onData={warm.putAlbums}
                  hidden={hidden}
                />
              </>
            )}
          </>
        ) : view === "shared" ? (
          <>
            {sharedAlbumOpen && (
              <AlbumHero
                heroRef={heroRef}
                cover={sharedAlbumOpen.coverUid ? albumCoverThumbs[sharedAlbumOpen.coverUid] : null}
                title={sharedAlbumOpen.name || t("albums.untitled")}
                sub={[
                  ...(sharedSpan
                    ? [photoSpanLabel(sharedSpan, locale)]
                    : sharedAlbumOpen.lastActivityTime
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
                  title={t("selection.download")}
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
                    title={t("shared.manage")}
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
              onSpan={setSharedSpan}
              invitations={invitations}
              onInvitationAnswered={(uid) => {
                setInvitations((list) => list.filter((i) => i.uid !== uid));
                loadInvitations();
              }}
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

            {((loading && items.length === 0) || !hidingKnown) && <PhotoGridSkeleton count={30} cellSize={cellSize} />}

            {albumMatches.length > 0 && (
              <section className="g-sres">
                <h3 className="g-sres-title">{t("nav.albums")}</h3>
                <div className="g-sres-row">
                  {albumMatches.map((a) => (
                    <button
                      key={a.uid}
                      className="g-sres-album"
                      onClick={() => {
                        setQuery("");
                        goToView("albums");
                        setAlbumOpen(a);
                      }}
                    >
                      <span className="g-sres-cover">
                        {a.coverUid && albumMatchCovers[a.coverUid] ? (
                          <img src={albumMatchCovers[a.coverUid]!} alt="" draggable={false} />
                        ) : null}
                      </span>
                      <span className="g-sres-name">{a.name || t("albums.untitled")}</span>
                      <span className="g-sres-count">
                        {t(a.photoCount === 1 ? "common.photoCount.one" : "common.photoCount.other", {
                          count: a.photoCount,
                        })}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {!loading && hidingKnown && shown.length === 0 && albumMatches.length === 0 && !error && (
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

            {hidingKnown && (thumbBase ? (
              // The timeline drawn on a canvas: the DOM grid could not keep up with a wide
              // window's hundreds of tiles (see CanvasSections). It needs the thumbnail server.
              <CanvasSections
                scrollRef={scrollRef}
                sections={virtualSections}
                cellSize={cellSize}
                base={thumbBase}
                header={timelineSort.by === "name" ? undefined : (s) => (
                  <div className="g-monthhdr">
                    <span className="g-monthtitle">{s.key}</span>
                    <span className="g-monthcount">
                      {t(s.items.length === 1 ? "common.photoCount.one" : "common.photoCount.other", {
                        count: s.items.length,
                      })}
                    </span>
                  </div>
                )}
                selected={selected}
                onToggle={sel.toggle}
                onOpen={onCellClick}
                onContext={onCellContext}
                offlineUids={offlineUids}
                localUids={localUids}
                covered={settingsOpen || uploadOpen}
              />
            ) : <VirtualSections
              scrollRef={scrollRef}
              sections={virtualSections}
              cellSize={cellSize}
              header={timelineSort.by === "name" ? undefined : (s) => (
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
            />)}
          </>
        )}
        </div>
      </div>
      {dateEditUids && (view === "photos" || view === "albums") && (
        <DateEditPanel
          key={dateEditMode}
          initialMode={dateEditMode}
          uids={dateEditUids}
          status={dateStatus}
          onStarted={() => {
            setDateRun(true);
            sel.clear();
          }}
          onClose={() => setDateEditUids(null)}
          top={scrollRef.current?.offsetTop ?? 0}
        />
      )}
      {splitOpen && view === "photos" && uidFilter?.personId && settings.localFaces && (
        <PersonSplit
          key={uidFilter.personId}
          personId={uidFilter.personId}
          name={localEntries.named.some((e) => e.personId === uidFilter.personId) ? uidFilter.name : null}
          names={localEntries.named.filter((e) => e.personId !== uidFilter.personId).map((e) => e.name)}
          act={(method, params) => localFaces.act(method, params)}
          onClose={() => setSplitOpen(false)}
        />
      )}
      {findOpen && view === "photos" && uidFilter?.personId && settings.localFaces && (
        <PersonFindPanel
          personId={uidFilter.personId}
          name={uidFilter.name}
          version={localFaces.status?.version ?? 0}
          act={localFaces.act}
          onClose={() => setFindOpen(false)}
          top={scrollRef.current?.offsetTop ?? 0}
        />
      )}
      {view === "albums" && libraryPage === "people" && settings.localFaces && (
        <SelectionBar
          count={peopleSel.size}
          busy={peopleBusy}
          countKey="common.peopleCount"
          onCancel={() => setPeopleSel(new Set())}
          onMergePeople={
            peopleSel.size >= 2
              ? () =>
                  void runPeople(async () => {
                    await mergeIntoOne([...peopleSel]);
                    setPeopleSel(new Set());
                  })
              : undefined
          }
          onRejectPeople={() => setRejectPeople([...peopleSel])}
        />
      )}
      {peopleMenu && (
        <ContextMenu
          x={peopleMenu.x}
          y={peopleMenu.y}
          onClose={() => setPeopleMenu(null)}
          actions={[
            {
              key: "open",
              label: t("faces.open"),
              onSelect: () =>
                openFiltered({
                  name: peopleMenu.entry.name,
                  uids: new Set(peopleMenu.entry.uids),
                  back: "people",
                  personId: peopleMenu.entry.personId,
                }),
            },
            {
              key: "select",
              label: t(peopleSel.has(peopleMenu.entry.personId!) ? "faces.deselect" : "faces.select"),
              onSelect: () => togglePerson(peopleMenu.entry, false),
            },
            {
              key: "merge",
              label: t("faces.mergeWith"),
              icon: <CallMergeIcon size={17} />,
              separator: true,
              onSelect: () => setMergeFor(peopleMenu.entry),
            },
            {
              key: "reject",
              label: t("faces.notPerson"),
              danger: true,
              onSelect: () => setRejectPeople([peopleMenu.entry.personId!]),
            },
          ]}
        />
      )}
      {mergeFor && (
        <PersonPicker
          people={allPeople.filter((e) => e.personId !== mergeFor.personId)}
          onCancel={() => setMergeFor(null)}
          onPick={async (other) => {
            await mergeIntoOne([mergeFor.personId!, other.personId!]);
            setMergeFor(null);
          }}
        />
      )}
      {explorerOff !== null && (
        <Confirm
          title={t("explorerOff.title")}
          message={explorerOff > 0 ? t("explorerOff.messageLeft", { count: explorerOff.toLocaleString() }) : t("explorerOff.message")}
          confirmLabel={t("explorerOff.openSettings")}
          cancelLabel={t("common.close")}
          onCancel={() => setExplorerOff(null)}
          onConfirm={() => {
            setExplorerOff(null);
            // The File Explorer switch sits on the Storage page on Windows, the one place this shows.
            openSettings("storage");
          }}
        />
      )}
      {rejectPeople && (
        <Confirm
          title={t("faces.notPersonTitle")}
          message={t("faces.notPersonMessage")}
          confirmLabel={t("faces.notPersonAction")}
          danger
          onCancel={() => setRejectPeople(null)}
          onConfirm={() => {
            const ids = rejectPeople;
            setRejectPeople(null);
            void runPeople(async () => {
              for (let i = 0; i < ids.length; i++) {
                if (i < ids.length - 1) await rpc("facePersonReject", { id: ids[i] });
                else await localFaces.act("facePersonReject", { id: ids[i] });
              }
              setPeopleSel(new Set());
            });
          }}
        />
      )}
      {settingsOpen && (
        <Settings
          startPage={settingsPage}
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          drive={drive}
          onDriveRefresh={() => loadDrive(true)}
          faces={localFaces}
          labels={localLabels}
          account={account}
          onSignOut={onSignOut}
          activity={activity}
          onOpenActivity={openUpload}
          onMyFilesImport={(folders, files, move) => {
            void uploads.startMyFilesImport(folders, files, move);
            openUpload();
          }}
          onOpenDuplicates={sidebar ? undefined : () => openLibrary("duplicates")}
        />
      )}
      {uploadOpen && (
        <Upload
          status={uploads.status}
          running={uploads.running}
          error={uploads.error}
          nothingFound={uploads.nothingFound}
          start={uploads.start}
          startImport={uploads.startImport}
          cancel={uploads.cancel}
          clear={uploads.clear}
          sync={syncInfo}
          onClose={() => setUploadOpen(false)}
        />
      )}
      </div>
      </div>

      {!sidebar && (
        <div className="g-dock">
          <button className={`g-tab ${view === "photos" ? "sel" : ""}`} onClick={() => goToView("photos")}>
            <NavPhotosIcon size={17} />
            <span>{t("nav.photos")}</span>
          </button>
          <button
            className={`g-tab ${view === "albums" || view === "shared" ? "sel" : ""}`}
            onClick={() => goToView("albums")}
          >
            <NavAlbumsIcon size={17} />
            <span>{t("nav.albums")}</span>
          </button>
          <button className={`g-tab ${view === "trash" ? "sel" : ""}`} onClick={() => goToView("trash")}>
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
            onLabels={settings.driveLabels ? openLabelPicker : undefined}
            onEditDate={() => setDateEditUids([...selected])}
            onDownload={() => void runSelection(downloadSelected)}
            // Local copies to free exist only in the File Explorer folder, on Windows.
            onFreeUp={isWindows ? () => void runSelection(freeUpSelected) : undefined}
            onOfflineAdd={
              allSelectedOffline ? undefined : () => void runSelection(offlineAddSelected)
            }
            onOfflineRemove={
              allSelectedOffline ? () => void runSelection(offlineRemoveSelected) : undefined
            }
            onTrash={() => setConfirmTrash(true)}
            onHide={uidFilter?.back === "hidden" ? undefined : () => setConfirmHide([...selected])}
            onUnhide={
              uidFilter?.back === "hidden"
                ? () =>
                    void runSelection(async () => {
                      await hidePhotos([...selected], false);
                      sel.clear();
                    })
                : undefined
            }
            onRemoveFromPerson={
              uidFilter?.personId && settings.localFaces
                ? () =>
                    void runSelection(async () => {
                      await localFaces.act("facePersonRemovePhotos", { id: uidFilter.personId, uids: [...selected] });
                      sel.clear();
                    })
                : undefined
            }
            onSetCover={
              uidFilter?.personId &&
              settings.localFaces &&
              selected.size === 1 &&
              localEntries.named.some((e) => e.personId === uidFilter.personId)
                ? () =>
                    void runSelection(async () => {
                      await localFaces.act("facePersonCover", { id: uidFilter.personId, uid: [...selected][0] });
                      sel.clear();
                    })
                : undefined
            }
          />
        </>
      )}

      {toolMenu && (
        <ContextMenu
          x={toolMenu.x}
          y={toolMenu.y}
          align="end"
          onClose={() => setToolMenu(null)}
          actions={
            toolMenu.kind === "sort"
              ? [
                  {
                    key: "taken",
                    label: t("sort.taken"),
                    icon: <CalendarIcon size={17} />,
                    checked: timelineSort.by === "taken",
                    onSelect: () => setTimelineSort((s) => ({ ...s, by: "taken" })),
                  },
                  {
                    key: "name",
                    label: t("sort.name"),
                    icon: <TextIcon size={17} />,
                    checked: timelineSort.by === "name",
                    onSelect: () => setTimelineSort((s) => ({ ...s, by: "name" })),
                  },
                  {
                    key: "asc",
                    label: t("sort.ascending"),
                    icon: <ArrowUpIcon size={17} />,
                    checked: timelineSort.asc,
                    separator: true,
                    onSelect: () => setTimelineSort((s) => ({ ...s, asc: true })),
                  },
                  {
                    key: "desc",
                    label: t("sort.descending"),
                    icon: <ArrowDownIcon size={17} />,
                    checked: !timelineSort.asc,
                    onSelect: () => setTimelineSort((s) => ({ ...s, asc: false })),
                  },
                ]
              : toolMenu.kind === "albumSort"
                ? ALBUM_SORTS.map((s) => ({
                    key: s.key,
                    label: t(s.labelKey),
                    checked: albumSort === s.key,
                    onSelect: () => setAlbumSort(s.key),
                  }))
                : [
                    ...(
                      [
                        ["all", "filter.mediaAll", <CollectionsIcon size={17} />],
                        ["photo", "filter.mediaPhotos", <ImageIcon size={17} />],
                        ["video", "filter.videos", <PlayArrowIcon size={17} />],
                      ] as [MediaType, string, ReactNode][]
                    ).map(([value, labelKey, icon]) => ({
                      key: `type:${value}`,
                      label: t(labelKey),
                      icon,
                      checked: mediaType === value,
                      keepOpen: true,
                      onSelect: () => setMediaType(value),
                    })),
                    // Videos are the type above already, so the category of the same name stays out.
                    ...CATEGORIES.filter((c) => c.key !== "video").map((c, i) => ({
                      key: `cat:${c.key}`,
                      label: t(`category.${c.key}`),
                      icon: CATEGORY_ICONS[c.key] ?? <ImageIcon size={17} />,
                      checked: categories.has(c.key),
                      keepOpen: true,
                      separator: i === 0,
                      onSelect: () => toggleCategory(c.key),
                    })),
                    ...(activeFilterCount > 0
                      ? [{ key: "reset", label: t("filter.reset"), separator: true, onSelect: resetFilter }]
                      : []),
                  ]
          }
        />
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
              key: "contents",
              label: t("viewer.contents"),
              icon: <ListIcon size={14} />,
              onSelect: () => setAlbumContents((n) => n + 1),
            },
            {
              key: "rename",
              label: t("albums.rename"),
              icon: <PencilIcon size={14} />,
              onSelect: () => {
                setAlbumTarget(albumOpen);
                setAlbumRenaming(true);
              },
            },
            hidden.isAlbum(albumOpen.uid)
              ? {
                  key: "unhide",
                  label: t("hidden.unhideAlbum"),
                  icon: <VisibilityIcon size={14} />,
                  onSelect: () => void hideAlbum(albumOpen, false),
                }
              : {
                  key: "hide",
                  label: t("hidden.hideAlbum"),
                  icon: <VisibilityOffIcon size={14} />,
                  onSelect: () => setConfirmHideAlbum(albumOpen),
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

      {confirmHide && (
        <Confirm
          title={t("hidden.confirmTitle")}
          message={t("hidden.confirmMessage")}
          confirmLabel={t("selection.hide")}
          onCancel={() => setConfirmHide(null)}
          onConfirm={() => {
            const uids = confirmHide;
            setConfirmHide(null);
            void runSelection(async () => {
              await hidePhotos(uids, true);
              sel.clear();
            });
          }}
        />
      )}

      {confirmHideAlbum && (
        <Confirm
          title={t("hidden.confirmAlbumTitle")}
          message={t("hidden.confirmAlbumMessage")}
          confirmLabel={t("hidden.hideAlbum")}
          onCancel={() => setConfirmHideAlbum(null)}
          onConfirm={() => {
            const album = confirmHideAlbum;
            setConfirmHideAlbum(null);
            void hideAlbum(album, true);
          }}
        />
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

      {pickLabels && (
        <LabelPicker
          keys={pickLabels}
          labels={localLabels.labels}
          act={localLabels.act}
          onClose={() => setPickLabels(null)}
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
          onDateEditStarted={() => setDateRun(true)}
          detailsExtra={
            settings.localFaces ? (
              <PhotoFaces
                uid={current.uid}
                names={localEntries.named.map((e) => e.name)}
                version={localFaces.status?.version ?? 0}
                act={localFaces.act}
              />
            ) : undefined
          }
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
          hasNext={lightboxIdx! < shown.length - 1}
          onPrev={() => setLightboxIdx((i) => (i === null ? i : Math.max(0, i - 1)))}
          onNext={() =>
            setLightboxIdx((i) => (i === null ? i : Math.min(shown.length - 1, i + 1)))
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
          hiding={
            hidden.photos.has(current.uid.slice(current.uid.lastIndexOf("~") + 1))
              ? { hidden: true, toggle: () => void hidePhotos([current.uid], false) }
              : hidden.isPhoto(current.uid)
                ? undefined
                : { hidden: false, toggle: () => setConfirmHide([current.uid]) }
          }
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

      {uploads.review && (
        <ImportReview
          items={uploads.review}
          checks={uploads.checks}
          progress={uploads.status.importing}
          onConfirm={(exclude, albums) => {
            openUpload();
            void uploads.confirmImport(exclude, albums, true);
          }}
          onDiscard={() => void uploads.discardImport()}
        />
      )}
    </div>
  );
}
