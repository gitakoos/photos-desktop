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

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { rpc } from "../lib/rpc";
import { isNewer } from "../lib/version";
import { START_UPDATE_EVENT } from "../components/UpdateOverlay";
import { autoUpdateOn, setAutoUpdate } from "../lib/updatePrefs";
import { isWindows } from "../lib/platform";
import { cardMatches, queryWords } from "../lib/settingsSearch";
import { Confirm } from "../components/Confirm";
import { LocalPasswordDialog, useLocalLockKind } from "../components/LocalPassword";
import {
  ArrowBackIcon,
  BackupIcon,
  BrushIcon,
  CalendarIcon,
  CallMergeIcon,
  ChevronRightIcon,
  CloseIcon,
  CloudIcon,
  CloudUploadIcon,
  ComputerIcon,
  ContentCopyIcon,
  DevicesIcon,
  DownloadIcon,
  FingerprintIcon,
  FaceIcon,
  FolderOpenIcon,
  GearIcon,
  HeartIcon,
  ImageIcon,
  InfoIcon,
  LabelIcon,
  ListIcon,
  LockIcon,
  MinimizeIcon,
  NavAlbumsIcon,
  NavSharedIcon,
  OpenInNewIcon,
  OpenWindowIcon,
  PaletteIcon,
  PauseIcon,
  PencilIcon,
  PersonAddIcon,
  PlayArrowIcon,
  PlusIcon,
  PowerIcon,
  RefreshIcon,
  ScheduleIcon,
  SearchIcon,
  SignOutIcon,
  TextIcon,
  TrashIcon,
  TuneIcon,
} from "../components/icons";
import type { DriveCollections } from "../components/Library";
import { barColor, formatBytes, type Account } from "../components/ProfileMenu";
import type { CompressionTier, VideoCodecChoice } from "../lib/compression";
import type { Activity } from "../components/Sidebar";
import type { LocalLabel } from "../hooks/useLocalLabels";
import { matchingLabels, sameLabel } from "../lib/labels";
import {
  BACKUP_KINDS,
  backupBlocked,
  backupPartLine,
  backupSendingLine,
  backupSynced,
  type BackupKind,
  type BackupPartLine,
  type BackupStatus,
} from "../lib/backupStatus";
import { MyFilesPicker, type ChosenFile } from "../components/MyFilesPicker";
import { unpinAllOffline, watchOffline, type OfflineStatus } from "../lib/offline";
import { applyTheme, PICKABLE_PALETTES, resolvedMode, type PaletteKey, type ThemeMode } from "../lib/theme";
import { BROWSER_LANG, LANGS, useLang, useT, type Lang } from "../lib/i18n";
import {
  SCAN_SPEEDS,
  facesStatus,
  scanBusy,
  searchIndexing,
  shownSpeed,
  speedHeld,
  statusLine,
  type FaceScanStatus,
  type ScanSpeed,
} from "../lib/localFaces";
import "../styles/Settings.css";

export type AppSettings = {
  /** Matches Android's "Hide photos in Drive albums". Off by default. */
  hideAlbumPhotos: boolean;
  /** Lock the app when the window is hidden to the tray, so reopening needs the password. Off by default. */
  lockOnHide: boolean;
  /** Ask Windows Hello before the photos show: when the app opens without a password, and when it comes
   *  back from the tray. Never on with `lockOnHide`. Off by default. */
  helloLock: boolean;
  /** Seconds unused, or in the tray, before the lock closes the app; 0 for as soon as it goes to the tray. */
  lockAfter: number;
  /** Lock when the window is minimised too, not only when it goes to the tray. */
  lockOnMinimize: boolean;
  /** Show a live memory HUD (JS + sidecar heap, cache sizes). Off by default. */
  debug: boolean;
  theme: ThemeMode;
  /** Accent palette, mirrored from Android. "default" is the Proton purple. */
  palette: PaletteKey;
  lang: Lang;
  /**
   * Photo grid zoom step, an index into the grid's cell-size ladder (0 = smallest).
   * Persisted so the grid reopens at the size the user left it at, rather than
   * snapping back to the default on every launch.
   */
  zoom: number;
  /** Album-list zoom step, an index into the album card-size ladder (0 = smallest, the default). */
  albumZoom: number;
  /** The desktop layout: the collapsible left sidebar and the top strip. Always on; the earlier
   *  bottom dock layout is no longer offered. */
  sidebarLayout: boolean;
  /** Whether that sidebar is collapsed to an icon rail. Persisted so it reopens as it was left. */
  sidebarCollapsed: boolean;
  /** Pure black behind everything in dark mode, beside whichever palette. */
  amoled: boolean;
  /** Read the people the phone saved to Drive. */
  driveFaces: boolean;
  /** Read the labels the phone saved to Drive. */
  driveLabels: boolean;
  /** Search by what a photo shows, from the index the phone saved to Drive. Off until asked for:
   *  it downloads the text model. */
  semanticSearch: boolean;
  /** Find the faces in the photos on this computer and group them into people. Off until
   *  asked for: it downloads the face models and reads every photo once. */
  localFaces: boolean;
  /** Take the "might be the same person" matches without asking, as the phone can. */
  faceAutoMerge: boolean;
  /** Look again, closely, at the photos with no face found, by itself after every scan. */
  faceFindMore: boolean;
  /** How fast the scan for the faces and the search reads the library; null for the speed this PC starts at. */
  scanSpeed: ScanSpeed | null;
  /** The shared backup on Proton Drive: the faces, the labels and this PC's search index, each
   *  device's copy taken in before this one is saved. */
  sharedBackup: boolean;
  /** Index the photos for the search by what they show on this computer, with the phone's model. */
  localSearch: boolean;
  /** Let the app read the folders of My files, to bring their photos in. Off until asked for. */
  myFilesAccess: boolean;
  /** Note the time of every photo and file step in the diagnostics, not only the slow ones. */
  diagDetailed: boolean;
  /** Read the text in a photo in the viewer, with models downloaded to this computer. */
  copyText: boolean;
  /** Which "what's new" this reader has closed, so it shows once per version that has one. */
  whatsNewSeen: string;
  /** Upload photos as lighter JPEGs, the file on this PC left as it is. */
  compressPhotos: boolean;
  /** Compress an HDR photo too, its gain map kept. */
  compressHdr: boolean;
  compressTier: CompressionTier;
  /** Upload videos transcoded smaller with Windows' own encoders. */
  compressVideos: boolean;
  compressVideoTier: CompressionTier;
  compressCodec: VideoCodecChoice;
};

export const DEFAULT_SETTINGS: AppSettings = {
  hideAlbumPhotos: false,
  lockOnHide: false,
  helloLock: false,
  lockAfter: 0,
  lockOnMinimize: false,
  debug: false,
  theme: "dark",
  palette: "default",
  lang: BROWSER_LANG,
  zoom: 1,
  albumZoom: 0,
  sidebarLayout: true,
  sidebarCollapsed: false,
  amoled: false,
  driveFaces: false,
  driveLabels: true,
  semanticSearch: false,
  localFaces: false,
  faceAutoMerge: false,
  faceFindMore: false,
  scanSpeed: null,
  sharedBackup: false,
  localSearch: false,
  myFilesAccess: false,
  diagDetailed: false,
  copyText: false,
  whatsNewSeen: "",
  compressPhotos: false,
  compressHdr: false,
  compressTier: "balanced",
  compressVideos: false,
  compressVideoTier: "balanced",
  compressCodec: "avc",
};

const THEMES: { value: ThemeMode; labelKey: string }[] = [
  { value: "dark", labelKey: "settings.theme.dark" },
  { value: "light", labelKey: "settings.theme.light" },
  { value: "system", labelKey: "settings.theme.system" },
];

/** The waits the lock offers, in seconds: right away, half a minute, then minutes. */
const LOCK_AFTER = [0, 30, 60, 300, 600, 900] as const;

export type Category =
  | "upload"
  | "general"
  | "phone"
  | "labels"
  | "backup"
  | "myFiles"
  | "appearance"
  | "storage"
  | "explorer"
  | "fileTypes"
  | "security"
  | "about";

/**
 * The left rail, in reading order. Each pane titles itself with the same label. The
 * file-type associations are Windows-only, and the file-manager pane is a different one
 * on each system: the Explorer mount on Windows, the Files drive on Linux.
 */
const CATEGORIES: { key: Category; labelKey: string }[] = [
  { key: "general", labelKey: "settings.general" },
  { key: "upload", labelKey: "settings.uploadQuality" },
  { key: "phone", labelKey: "settings.ml" },
  { key: "labels", labelKey: "library.labels" },
  { key: "backup", labelKey: "settings.backup" },
  { key: "myFiles", labelKey: "settings.myFiles" },
  { key: "appearance", labelKey: "settings.appearance" },
  { key: "storage", labelKey: "settings.storage" },
  ...(isWindows
    ? ([{ key: "fileTypes", labelKey: "settings.fileTypes" }] as { key: Category; labelKey: string }[])
    : ([{ key: "explorer", labelKey: "settings.filesDrive" }] as {
        key: Category;
        labelKey: string;
      }[])),
  { key: "security", labelKey: "settings.security" },
  { key: "about", labelKey: "settings.about" },
];

/** Each category's mark in the rail, drawn like the sidebar's destinations. */
const CATEGORY_ICONS: Record<Category, ReactNode> = {
  upload: <CloudUploadIcon size={17} />,
  general: <GearIcon size={17} />,
  phone: <FaceIcon size={17} />,
  labels: <LabelIcon size={17} />,
  backup: <BackupIcon size={17} />,
  myFiles: <FolderOpenIcon size={17} />,
  appearance: <PaletteIcon size={17} />,
  storage: <CloudIcon size={17} />,
  explorer: <FolderOpenIcon size={17} />,
  fileTypes: <ImageIcon size={17} />,
  security: <LockIcon size={17} />,
  about: <InfoIcon size={17} />,
};

/** The first page's groups, in reading order, as the Android app groups its settings. */
const HOME_GROUPS: Category[][] = [
  ["upload", "myFiles", "storage", "explorer", "fileTypes"],
  ["phone", "labels", "backup"],
  ["general", "appearance"],
  ["security"],
  ["about"],
];

/** What each part holds, under its name on the first page. */
const CATEGORY_DESCS: Record<Category, string> = {
  upload: "settings.uploadQualityNav",
  general: "settings.generalNav",
  phone: "settings.mlNav",
  labels: "settings.labelsNav",
  backup: "settings.backupNav",
  myFiles: "settings.myFilesNav",
  appearance: "settings.appearanceNav",
  storage: "settings.storageNav",
  explorer: "settings.explorerNav",
  fileTypes: "settings.fileTypesNav",
  security: "settings.securityNav",
  about: "settings.aboutNav",
};
const CATEGORY_DESCS_LINUX: Partial<Record<Category, string>> = {
  general: "settings.generalNavLinux",
  explorer: "settings.explorerNavLinux",
};

/** What is running now, in one line; the same readout the upload button gives. */
function activityLine(activity: Activity | null, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (!activity) return t("settings.statusIdle");
  if (activity.kind === "index") return t("sidebar.indexing");
  if (activity.kind === "sync") return activity.label ?? t("avatar.syncing");
  return activity.label;
}

/**
 * Leaves only the settings that match `query` among all the parts drawn under `root`: a setting
 * matches when its text holds every word of the query, accents aside; a part whose name matches
 * keeps all of its own. It follows the parts as they change, so a row that appears later is
 * matched too. Answers whether nothing matched.
 */
function useSearchFilter(root: RefObject<HTMLDivElement | null>, query: string): boolean {
  const [none, setNone] = useState(false);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !query) {
      setNone(false);
      return;
    }
    const words = queryWords(query);
    const hit = (text: string | null | undefined) => cardMatches(text, words);
    const run = () => {
      let any = false;
      el.querySelectorAll<HTMLElement>(":scope > .st-section").forEach((section) => {
        const whole = hit(section.querySelector(".st-section-title")?.textContent);
        let shown = 0;
        section.querySelectorAll<HTMLElement>(".st-row, .st-usage").forEach((row) => {
          const on = !row.hasAttribute("data-search-repeat") && (whole || hit(row.textContent));
          row.toggleAttribute("data-miss", !on);
          if (on) shown++;
        });
        section.querySelectorAll<HTMLElement>(".st-intro, .st-subhead, .st-about, .st-note").forEach((extra) => {
          extra.toggleAttribute("data-miss", !whole);
        });
        section.toggleAttribute("data-miss", shown === 0);
        if (shown > 0) any = true;
      });
      setNone(!any);
    };
    run();
    const watch = new MutationObserver(run);
    watch.observe(el, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, [root, query]);
  return none;
}

type Usage = { bytes: number; photos: number };

/**
 * One kind of local storage: what it costs, and the button that reclaims it.
 *
 * The panel shows two of these because a photo can be kept in two unrelated places:
 * encrypted inside the app (available offline), or downloaded as an ordinary file under
 * the Explorer mount. Either can hold a photo the other does not, and adding the two
 * figures together would describe neither, so each is measured, named and reclaimed on
 * its own.
 *
 * Everything here arrives already resolved: the caller does its own counting and
 * translating, which is what lets one component serve both without a flag saying which
 * of the two it is this time.
 */
function UsageBlock({
  heading,
  size,
  detail,
  action,
  actionDisabled,
  onAction,
  progressPct,
  note,
  error,
}: {
  /** The block's name above it, or null when the page already names it. */
  heading: string | null;
  /** The formatted size, or null while the measurement is still out. */
  size: string | null;
  detail: string;
  action: string;
  actionDisabled: boolean;
  onAction: () => void;
  /** 0-100 while a pass is running, or null when none is. */
  progressPct: number | null;
  note: string;
  /** A refusal from the last pass, which takes the note's place while it stands. */
  error?: string;
}) {
  const t = useT();
  return (
    <>
      {heading && <div className="st-subhead">{heading}</div>}
      <div className="st-usage">
        {size === null ? (
          <div className="st-usage-sub">{t("common.loading")}</div>
        ) : (
          <>
            <div className="st-usage-main">
              <div className="st-usage-text">
                <div className="st-usage-size">{size}</div>
                <div className="st-usage-sub">{detail}</div>
              </div>
              <button className="st-free-btn" disabled={actionDisabled} onClick={onAction}>
                {action}
              </button>
            </div>
            {progressPct !== null && (
              <div
                className="st-progress"
                role="progressbar"
                aria-valuenow={Math.round(progressPct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="st-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
            )}
          </>
        )}
      </div>
      <p className={`st-note${error ? " bad" : ""}`}>{error || note}</p>
    </>
  );
}

/**
 * Storage: what is kept on this machine, and the buttons that reclaim it.
 * Mounted with its pane, so the Explorer measuring pass (a directory-entry read per
 * placeholder) only runs when the user actually opens it.
 */
function StoragePane({
  explorer,
  explorerEdits,
  onExplorer,
  onExplorerEdits,
  restartNeeded,
}: {
  explorer: boolean;
  explorerEdits: boolean;
  onExplorer: (on: boolean) => void;
  onExplorerEdits: (on: boolean) => void;
  restartNeeded: boolean;
}) {
  const t = useT();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Whichever block last refused, so it can say so. The host logs the reason, which is
  // no help at all to the person watching the button go back to how it was.
  const [failed, setFailed] = useState<"explorer" | "offline" | null>(null);

  // The app's own copies. Watched rather than measured: the sidecar owns them, and a
  // batch still landing must show its count climbing here too.
  const [offline, setOffline] = useState<OfflineStatus | null>(null);
  const [confirmingOffline, setConfirmingOffline] = useState(false);
  const [removingOffline, setRemovingOffline] = useState(false);
  useEffect(() => watchOffline(setOffline), []);

  const measure = useCallback(async () => {
    setUsage(await invoke<Usage>("local_usage").catch(() => null));
  }, []);
  useEffect(() => {
    void measure();
  }, [measure]);

  // How far the pass has got, so a large library shows movement instead of a
  // button that just sits there.
  useEffect(() => {
    const un = listen<{ done: number; total: number }>("freeup-progress", (e) =>
      setProgress(e.payload),
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // What the folder keeps on this PC by itself, and how the download of it stands.
  const [keep, setKeep] = useState<KeepStatus | null>(null);
  const [askAll, setAskAll] = useState<KeepEstimate | null>(null);
  const [answeringHeld, setAnsweringHeld] = useState(false);
  const readKeep = useCallback(() => {
    void invoke<KeepStatus>("keep_status").then(setKeep).catch(() => {});
  }, []);
  useEffect(() => {
    readKeep();
    // The downloaded total above follows the download: measured again at most every ten
    // seconds while it runs, and once more when it stops.
    let measuredAt = 0;
    const un = listen<KeepStatus>("keep-progress", (e) => {
      setKeep(e.payload);
      const now = Date.now();
      if (!e.payload.running || now - measuredAt > 10_000) {
        measuredAt = now;
        void measure();
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [readKeep, measure]);

  function setMode(mode: KeepMode) {
    setKeep((k) => (k ? { ...k, mode } : k));
    void invoke("set_download_mode", { mode }).then(readKeep).catch(readKeep);
  }

  function pickMode(mode: KeepMode) {
    if (mode === keep?.mode) return;
    // Every photo is a download of the whole library: it is said what that means first.
    if (mode === "all") {
      void invoke<KeepEstimate>("keep_estimate")
        .then(setAskAll)
        .catch(() => setAskAll({ photos: 0, bytes: 0, free: null }));
      return;
    }
    setMode(mode);
  }

  async function answerHeld(remove: boolean) {
    setAnsweringHeld(true);
    await invoke("keep_held_answer", { remove }).catch(() => {});
    setAnsweringHeld(false);
    readKeep();
    await measure();
  }

  async function freeUpAll() {
    setConfirming(false);
    setProgress(null);
    setFailed(null);
    setBusy(true);
    try {
      await invoke("free_up_all");
    } catch {
      setFailed("explorer");
    }
    setBusy(false);
    setProgress(null);
    // Freeing everything also stops keeping every photo, so the choice reads again.
    readKeep();
    // The refreshed size is the rest of the answer: a pass that freed some of it and
    // then gave up still says how much is left.
    await measure();
  }

  async function removeAllOffline() {
    setConfirmingOffline(false);
    setFailed(null);
    setRemovingOffline(true);
    // The sidecar answers with the state it is left in, and the watcher publishes it,
    // so the figures above refresh without a second read.
    try {
      await unpinAllOffline();
    } catch {
      setFailed("offline");
    }
    setRemovingOffline(false);
  }

  const bytes = usage?.bytes ?? 0;
  const pct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  const offlineBytes = offline?.bytes ?? 0;
  const offlineCount = offline?.ready ?? 0;
  // A batch still saving is the one thing that moves on its own here, so it takes the
  // bar and the button's label; removing is quick enough to just say so.
  const saving = !!offline?.running && offline.total > 0;

  return (
    <div className="st-storage">
      <UsageBlock
        heading={t("settings.storageOffline")}
        size={offline === null ? null : formatBytes(offlineBytes)}
        detail={
          offlineCount === 0
            ? t("settings.offlineNone")
            : t(
                offlineCount === 1 ? "settings.offlineCount.one" : "settings.offlineCount.other",
                { count: offlineCount },
              )
        }
        action={
          saving
            ? t("settings.offlineSaving", { done: offline.done, total: offline.total })
            : removingOffline
              ? t("settings.offlineRemoving")
              : offlineBytes === 0
                ? t("settings.offlineRemoveNothing")
                : t("settings.offlineRemoveAll", { size: formatBytes(offlineBytes) })
        }
        actionDisabled={removingOffline || saving || offlineBytes === 0}
        onAction={() => setConfirmingOffline(true)}
        progressPct={saving ? (offline.done / offline.total) * 100 : null}
        note={t("settings.offlineDesc")}
        error={failed === "offline" ? t("settings.freeUpFailed") : undefined}
      />

      {/* The File Explorer folder in one place: whether it is there, what it may change, what
          it holds and what it keeps by itself. Windows-only; the offline block above is not. */}
      {isWindows && (
        <>
          <h4 className="st-subhead st-subhead-gap">{t("settings.storageExplorer")}</h4>
          <div className="st-rows">
            <label className="st-row">
              <span className="st-row-ico" aria-hidden>
                <FolderOpenIcon size={18} />
              </span>
              <div className="st-text">
                <div className="st-label">{t("settings.showInExplorer")}</div>
                <div className="st-desc">{t("settings.showInExplorerDesc")}</div>
              </div>
              <input
                className="st-switch"
                type="checkbox"
                checked={explorer}
                onChange={(e) => onExplorer(e.currentTarget.checked)}
              />
            </label>
            {explorer && (
              <label className="st-row">
                <span className="st-row-ico" aria-hidden>
                  <PencilIcon size={18} />
                </span>
                <div className="st-text">
                  <div className="st-label">{t("settings.filesDriveEdits")}</div>
                  <div className="st-desc">{t("settings.explorerEditsDesc")}</div>
                </div>
                <input
                  className="st-switch"
                  type="checkbox"
                  checked={explorerEdits}
                  onChange={(e) => onExplorerEdits(e.currentTarget.checked)}
                />
              </label>
            )}
            {restartNeeded && (
              <div className="st-restart">
                <span>{t("settings.restartNeeded")}</span>
                <button className="st-restart-btn" onClick={() => void invoke("restart_app")}>
                  {t("settings.restartNow")}
                </button>
              </div>
            )}
          </div>
          <UsageBlock
            heading={null}
            size={usage === null ? null : formatBytes(bytes)}
            detail={
              usage === null || usage.photos === 0
                ? t("settings.downloadedNone")
                : t(
                    usage.photos === 1
                      ? "settings.downloadedCount.one"
                      : "settings.downloadedCount.other",
                    { count: usage.photos },
                  )
            }
            action={
              busy
                ? t("settings.freeingUp")
                : bytes === 0
                  ? t("settings.freeUpNothing")
                  : t("settings.freeUpAll", { size: formatBytes(bytes) })
            }
            actionDisabled={busy || bytes === 0}
            onAction={() => setConfirming(true)}
            progressPct={busy ? pct : null}
            note={t("settings.downloadedDesc")}
            error={failed === "explorer" ? t("settings.freeUpFailed") : undefined}
          />

          {/* What the folder keeps on this PC by itself. It runs through the Explorer
              mount, so with the mount off the row says why instead of doing nothing. */}
          <div className={`st-row${explorer ? "" : " off"}`}>
            <span className="st-row-ico" aria-hidden>
              <DownloadIcon size={18} />
            </span>
            <div className="st-text">
              <div className="st-label">{t("settings.keepOnPc")}</div>
              <div className="st-desc">
                {explorer
                  ? t(`settings.keepOnPcDesc.${keep?.mode ?? "off"}`)
                  : t("settings.autoDownloadNeedsExplorer")}
              </div>
              {explorer && keep?.mode === "all" && !explorerEdits && (
                <div className="st-desc bad">{t("settings.keepAllNeedsEdits")}</div>
              )}
              {explorer && keep && keep.mode !== "off" && <KeepLine keep={keep} />}
              {explorer && keep && keep.held > 0 && (
                <>
                  <div className="st-desc">
                    {t(keep.held === 1 ? "settings.keepHeld.one" : "settings.keepHeld.other", { count: keep.held })}
                  </div>
                  <div className="st-keep-line">
                    <button className="st-row-btn" disabled={answeringHeld} onClick={() => void answerHeld(true)}>
                      {t("settings.keepHeldRemove")}
                    </button>
                    <button className="st-row-btn" disabled={answeringHeld} onClick={() => void answerHeld(false)}>
                      {t("settings.keepHeldKeep")}
                    </button>
                  </div>
                </>
              )}
              <div className="st-seg st-seg-under" role="group" aria-label={t("settings.keepOnPc")}>
                {KEEP_MODES.map((mode) => (
                  <button
                    key={mode}
                    className={`st-seg-btn${(keep?.mode ?? "off") === mode ? " on" : ""}`}
                    aria-pressed={(keep?.mode ?? "off") === mode}
                    disabled={!explorer || keep === null}
                    onClick={() => pickMode(mode)}
                  >
                    {t(`settings.keepMode.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {confirming && (
        <Confirm
          title={t("confirm.freeUpAllTitle")}
          message={t("confirm.freeUpAllMessage", { size: formatBytes(bytes) })}
          confirmLabel={t("confirm.freeUpAllConfirm")}
          onConfirm={() => void freeUpAll()}
          onCancel={() => setConfirming(false)}
        />
      )}

      {askAll && (
        <Confirm
          title={t("confirm.keepAllTitle")}
          message={[
            t(askAll.photos === 1 ? "confirm.keepAllMessage.one" : "confirm.keepAllMessage.other", {
              count: askAll.photos,
              size: formatBytes(askAll.bytes),
            }),
            askAll.free !== null ? t("confirm.keepAllFree", { free: formatBytes(askAll.free) }) : "",
            t("confirm.keepAllDeletes"),
          ]
            .filter(Boolean)
            .join(" ")}
          confirmLabel={t("confirm.keepAllConfirm")}
          onConfirm={() => {
            setAskAll(null);
            setMode("all");
          }}
          onCancel={() => setAskAll(null)}
        />
      )}

      {confirmingOffline && (
        <Confirm
          title={t("confirm.removeOfflineAllTitle")}
          message={t("confirm.removeOfflineAllMessage", { size: formatBytes(offlineBytes) })}
          confirmLabel={t("confirm.removeOfflineAllConfirm")}
          onConfirm={() => void removeAllOffline()}
          onCancel={() => setConfirmingOffline(false)}
        />
      )}
    </div>
  );
}

type KeepMode = "off" | "new" | "all";
const KEEP_MODES: KeepMode[] = ["off", "new", "all"];

/** How the pass that keeps photos on this PC stands, as the host reports it. */
type KeepStatus = {
  mode: KeepMode;
  running: boolean;
  paused: boolean;
  done: number;
  total: number;
  waiting: "space" | "metered" | "battery" | "hidden" | null;
  held: number;
};

/** What keeping every photo would still download, and the room the drive has. */
type KeepEstimate = { photos: number; bytes: number; free: number | null };

/** The download's progress line, with its pause and resume. */
function KeepLine({ keep }: { keep: KeepStatus }) {
  const t = useT();
  const toggle = (paused: boolean) => void invoke("keep_pause", { paused }).catch(() => {});
  if (keep.paused) {
    return (
      <div className="st-keep-line">
        <span className="st-desc">{t("settings.keepPaused")}</span>
        <button className="st-row-btn" onClick={() => toggle(false)}>
          {t("settings.keepResume")}
        </button>
      </div>
    );
  }
  if (keep.waiting) return <div className="st-desc">{t(`settings.keepWaiting.${keep.waiting}`)}</div>;
  if (!keep.running || keep.total === 0) return null;
  return (
    <div className="st-keep-line">
      <span className="st-desc">{t("settings.keepProgress", { done: keep.done, total: keep.total })}</span>
      <button className="st-row-btn" onClick={() => toggle(true)}>
        {t("settings.keepPause")}
      </button>
    </div>
  );
}

/**
 * File types: the "Open with" entries this app may add and take back out, and a way
 * to the one choice it may not make. Mounted with its pane, so the registry is read
 * when the pane opens and the switch shows what is actually registered on this
 * machine, including a change made outside the app since it was last looked at.
 */
function FileTypesPane() {
  const t = useT();
  // Null until the registry answers, so the switch never shows a guess.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // Whichever of the two last refused. The host logs the reason, which is no help at
  // all to the person watching the switch go back to how it was.
  const [failed, setFailed] = useState<"toggle" | "open" | null>(null);

  useEffect(() => {
    void invoke<boolean>("file_association_enabled")
      .then(setEnabled)
      .catch(() => setEnabled(false));
  }, []);

  async function toggle(on: boolean) {
    const before = enabled;
    setEnabled(on); // answer the click; writing the entries takes a moment
    setFailed(null);
    setBusy(true);
    try {
      await invoke("set_file_association", { enabled: on });
    } catch {
      // Nothing was written, so the switch cannot be left claiming otherwise.
      setEnabled(before);
      setFailed("toggle");
    }
    setBusy(false);
  }

  async function openDefaults() {
    setFailed(null);
    try {
      await invoke("open_default_apps");
    } catch {
      setFailed("open");
    }
  }

  return (
    <div className="st-rows">
      <label className="st-row">
        <span className="st-row-ico" aria-hidden>
          <OpenWindowIcon size={18} />
        </span>
        <div className="st-text">
          <div className="st-label">{t("settings.openWith")}</div>
          <div className="st-desc">{t("settings.openWithDesc")}</div>
        </div>
        <input
          className="st-switch"
          type="checkbox"
          checked={enabled === true}
          disabled={enabled === null || busy}
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />
      </label>
      {failed === "toggle" && <p className="st-note bad">{t("settings.fileTypesFailed")}</p>}

      {/* Windows keeps the default handler behind a hash of its own and takes the
          choice from the user alone, so this is a way to the page that owns it
          rather than a control that could make it. */}
      <div className="st-row">
        <span className="st-row-ico" aria-hidden>
          <ImageIcon size={18} />
        </span>
        <div className="st-text">
          <div className="st-label">{t("settings.defaultApp")}</div>
          <div className="st-desc">{t("settings.defaultAppDesc")}</div>
        </div>
        <button className="st-row-btn" onClick={() => void openDefaults()}>
          {t("settings.defaultAppOpen")}
        </button>
      </div>
      {failed === "open" && <p className="st-note bad">{t("settings.defaultAppFailed")}</p>}
    </div>
  );
}

type DriveStatus = {
  enabled: boolean;
  edits: boolean;
  byDate: boolean;
  host: string;
  /** The port chosen here, or null when any free one does. */
  port: number | null;
  /** The chosen port was taken when the app started, so another is in use. */
  portTaken: boolean;
  address: string | null;
};

/**
 * Linux: "Proton Photos" in the file manager, served by the host as a drive on this
 * machine alone. It applies at once, so there is no restart to ask for. The address is
 * shown for the file managers that do not read the GTK sidebar bookmarks, Dolphin first.
 */
function FilesDrivePane() {
  const t = useT();
  // Null until the host answers, so the switch never shows a guess.
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // The address fields, as typed; applied only by the button.
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<DriveStatus>("files_drive_status")
      .then((d) => {
        setDrive(d);
        setHost(d.host);
        setPort(d.port ? String(d.port) : "");
      })
      .catch(() =>
        setDrive({
          enabled: false,
          edits: false,
          byDate: false,
          host: "127.0.0.1",
          port: null,
          portTaken: false,
          address: null,
        }),
      );
  }, []);

  async function applyAddress() {
    setAddressError(null);
    setBusy(true);
    try {
      const next = await invoke<DriveStatus>("set_files_drive_address", { host, port });
      setDrive(next);
      setHost(next.host);
      setPort(next.port ? String(next.port) : "");
    } catch (e) {
      // The host answers with a code: "address", "port" or "in-use".
      setAddressError(String(e));
    }
    setBusy(false);
  }

  const addressChanged =
    drive !== null && (host.trim() !== drive.host || port.trim() !== (drive.port ? String(drive.port) : ""));

  /** One of the drive's two options: answered at once, put back if the host refuses. */
  async function toggleOption(command: string, patch: Partial<DriveStatus>, on: boolean) {
    const before = drive;
    setDrive((d) => (d ? { ...d, ...patch } : d));
    try {
      setDrive(await invoke<DriveStatus>(command, { enabled: on }));
    } catch {
      setDrive(before);
    }
  }

  async function toggle(on: boolean) {
    const before = drive;
    setDrive((d) => (d ? { ...d, enabled: on } : d));
    setBusy(true);
    try {
      setDrive(await invoke<DriveStatus>("set_files_drive", { enabled: on }));
    } catch {
      setDrive(before);
    }
    setBusy(false);
  }

  function copyAddress(address: string) {
    void navigator.clipboard
      .writeText(address)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <div className="st-rows">
      <label className="st-row">
        <span className="st-row-ico" aria-hidden>
          <FolderOpenIcon size={18} />
        </span>
        <div className="st-text">
          <div className="st-label">{t("settings.filesDriveShow")}</div>
          <div className="st-desc">{t("settings.filesDriveShowDesc")}</div>
        </div>
        <input
          className="st-switch"
          type="checkbox"
          checked={drive?.enabled === true}
          disabled={drive === null || busy}
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />
      </label>
      {drive?.enabled && (
        <label className="st-row">
          <span className="st-row-ico" aria-hidden>
            <PencilIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.filesDriveEdits")}</div>
            <div className="st-desc">{t("settings.filesDriveEditsDesc")}</div>
          </div>
          <input
            className="st-switch"
            type="checkbox"
            checked={drive.edits}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              void toggleOption("set_files_drive_edits", { edits: on }, on);
            }}
          />
        </label>
      )}
      {drive?.enabled && (
        <label className="st-row">
          <span className="st-row-ico" aria-hidden>
            <CalendarIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.filesDriveByDate")}</div>
            <div className="st-desc">{t("settings.filesDriveByDateDesc")}</div>
          </div>
          <input
            className="st-switch"
            type="checkbox"
            checked={drive.byDate}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              void toggleOption("set_files_drive_by_date", { byDate: on }, on);
            }}
          />
        </label>
      )}
      {drive?.enabled && (
        <div className="st-row">
          <span className="st-row-ico" aria-hidden>
            <CloudIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.filesDriveServer")}</div>
            <div className="st-desc">{t("settings.filesDriveServerDesc")}</div>
            <div className="st-server">
              <input
                className="st-field"
                value={host}
                placeholder="127.0.0.1"
                spellCheck={false}
                aria-label={t("settings.filesDriveServer")}
                onChange={(e) => setHost(e.currentTarget.value)}
              />
              <span>:</span>
              <input
                className="st-field st-port"
                value={port}
                inputMode="numeric"
                placeholder={t("settings.filesDriveAutoPort")}
                aria-label={t("settings.filesDriveAutoPort")}
                onChange={(e) => setPort(e.currentTarget.value.replace(/[^0-9]/g, ""))}
              />
              <button
                className="st-row-btn"
                disabled={busy || !addressChanged}
                onClick={() => void applyAddress()}
              >
                {t("settings.filesDriveApply")}
              </button>
            </div>
          </div>
        </div>
      )}
      {addressError && (
        <p className="st-note bad">
          {t(
            addressError === "in-use"
              ? "settings.filesDriveErrInUse"
              : addressError === "port"
                ? "settings.filesDriveErrPort"
                : "settings.filesDriveErrAddress",
          )}
        </p>
      )}
      {drive?.enabled && drive.portTaken && (
        <p className="st-note bad">{t("settings.filesDrivePortTaken")}</p>
      )}
      {drive?.enabled && drive.address && (
        <div className="st-row">
          <span className="st-row-ico" aria-hidden>
            <FolderOpenIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.filesDriveAddress")}</div>
            <div className="st-desc">{t("settings.filesDriveAddressDesc")}</div>
            <div className="st-desc st-address">{drive.address}</div>
          </div>
          <button className="st-row-btn" onClick={() => copyAddress(drive.address!)}>
            {copied ? t("settings.filesDriveCopied") : t("settings.filesDriveCopy")}
          </button>
        </div>
      )}
    </div>
  );
}

export function Settings({
  settings,
  onChange,
  onClose,
  drive,
  onDriveRefresh,
  faces,
  labels,
  account,
  onSignOut,
  activity,
  onOpenActivity,
  onOpenDuplicates,
  startPage,
  onMyFilesImport,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
  /** What was last read from the phone's copies on Drive, and when. */
  drive?: { state: "loading" | "failed" | "ready"; data: DriveCollections | null; at: number } | null;
  onDriveRefresh?: () => void;
  /** Face recognition on this computer: what it is doing, and a way to ask it something. */
  faces?: { status: FaceScanStatus | null; act: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
  /** The labels kept on this computer, and the way to change them. */
  labels?: { labels: LocalLabel[]; loaded: boolean; act: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
  /** The signed-in account, for its own card. */
  account?: Account | null;
  onSignOut?: () => void;
  /** What is running now, the same readout the upload button gives. */
  activity?: Activity | null;
  onOpenActivity?: () => void;
  onOpenDuplicates?: () => void;
  /** The part to open on, for a message that leads straight to its switch. */
  startPage?: Category;
  /** Starts bringing in the photos of folders and files in My files. */
  onMyFilesImport?: (folders: { uid: string; name: string }[], files: ChosenFile[], move: boolean) => void;
}) {
  const t = useT();
  const { setLang } = useLang();
  // The first page lists the parts; each opens on its own, the way the Android app's settings do.
  const [page, setPage] = useState<Category | "home">(startPage ?? "home");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const noHits = useSearchFilter(resultsRef, query.trim());
  const [langOpen, setLangOpen] = useState(false);
  const [version, setVersion] = useState("");
  // A vault this Windows account opens has no password, so there is nothing to lock behind.
  const [vaultMode, setVaultMode] = useState<"password" | "device" | null>(null);
  useEffect(() => {
    rpc<{ mode: "password" | "device" | null }>("lockStatus")
      .then((s) => setVaultMode(s.mode))
      .catch(() => {});
  }, []);
  // On Linux the app lock and Hidden ask for the local lock's password (`LocalPassword`).
  const [lockKind, refreshLockKind] = useLocalLockKind();
  const [passwordAsk, setPasswordAsk] = useState<{ change: boolean; resolve: (ok: boolean) => void } | null>(null);
  function askLocalPassword(change = false): Promise<boolean> {
    return new Promise((resolve) => setPasswordAsk({ change, resolve }));
  }
  // Whether Windows Hello can answer here, so the app lock is offered only where it can.
  const [helloReady, setHelloReady] = useState(false);
  useEffect(() => {
    if (!isWindows) return;
    invoke<boolean>("hello_available")
      .then(setHelloReady)
      .catch(() => {});
  }, []);
  /**
   * Windows Hello's yes, asked before the lock is turned on (so nobody locks themselves out) and
   * before it is made weaker (so nobody else can quietly turn it down). Where Hello can no longer
   * answer, it guards nothing, and a weaker lock is not stopped by it.
   */
  async function helloSays(needed: boolean, turningOn = false): Promise<boolean> {
    if (!needed) return true;
    // Linux has no Windows Hello: the local lock's password guards the same changes.
    if (!isWindows) return askLocalPassword();
    const answer = await invoke<string>("hello_verify", { message: t("appLock.prompt") }).catch(() => "failed");
    return answer === "verified" || (answer === "unavailable" && !turningOn);
  }
  async function pickReopenLock(next: "off" | "password" | "hello") {
    const now = settings.helloLock ? "hello" : settings.lockOnHide ? "password" : "off";
    if (next === now) return;
    const weaker = now === "hello" || (now === "password" && next === "off");
    if (!(await helloSays(next === "hello" || (weaker && (helloReady || settings.helloLock)), next === "hello"))) return;
    onChange({ ...settings, lockOnHide: next === "password", helloLock: next === "hello" });
  }
  async function pickLockAfter(next: number) {
    if (next === settings.lockAfter) return;
    const longer = next === 0 ? false : settings.lockAfter === 0 || next > settings.lockAfter;
    if (!(await helloSays(longer && (helloReady || settings.helloLock)))) return;
    onChange({ ...settings, lockAfter: next });
  }
  async function pickLockOnMinimize(on: boolean) {
    if (!(await helloSays(!on && (helloReady || settings.helloLock)))) return;
    onChange({ ...settings, lockOnMinimize: on });
  }
  const lockMinimizedRow = (
    <label className="st-row">
      <span className="st-row-ico" aria-hidden>
        <MinimizeIcon size={18} />
      </span>
      <div className="st-text">
        <div className="st-label">{t("settings.lockOnMinimize")}</div>
        <div className="st-desc">{t("settings.lockOnMinimizeDesc")}</div>
      </div>
      <input
        className="st-switch"
        type="checkbox"
        checked={settings.lockOnMinimize}
        onChange={(e) => void pickLockOnMinimize(e.currentTarget.checked)}
      />
    </label>
  );
  const lockAfterRow = (
    <div className="st-row">
      <span className="st-row-ico" aria-hidden>
        <ScheduleIcon size={18} />
      </span>
      <div className="st-text">
        <div className="st-label">{t("settings.lockAfter")}</div>
        <div className="st-desc">{t("settings.lockAfterDesc")}</div>
      </div>
      <div className="st-seg" role="group" aria-label={t("settings.lockAfter")}>
        {LOCK_AFTER.map((secs) => (
          <button
            key={secs}
            className={`st-seg-btn${settings.lockAfter === secs ? " on" : ""}`}
            aria-pressed={settings.lockAfter === secs}
            onClick={() => void pickLockAfter(secs)}
          >
            {secs === 0
              ? t("settings.lockAfterNow")
              : secs < 60
                ? t("settings.lockAfterSeconds", { n: secs })
                : t("settings.lockAfterMinutes", { n: secs / 60 })}
          </button>
        ))}
      </div>
    </div>
  );
  const [updateInfo, setUpdateInfo] = useState<{ version: string } | null>(null);
  const [autoUpdate, setAutoUpdateState] = useState(autoUpdateOn);
  const [checkState, setCheckState] = useState<
    "idle" | "checking" | "uptodate" | "found" | "installing" | "error"
  >("idle");
  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
  }, []);

  async function checkForUpdates() {
    setCheckState("checking");
    try {
      const latest = await rpc<{ version: string } | null>("checkUpdate");
      const current = await getVersion();
      if (latest && isNewer(latest.version, current)) {
        setUpdateInfo(latest);
        setCheckState("found");
      } else {
        setUpdateInfo(null);
        setCheckState("uptodate");
      }
    } catch {
      setCheckState("error");
    }
  }

  // The update itself runs on the window's own card, the same one a start shows.
  function installUpdate() {
    window.dispatchEvent(new Event(START_UPDATE_EVENT));
    onClose();
  }

  // The "show in File Explorer" preference lives outside the (vault-encrypted)
  // settings so it can be read before sign-in; toggle it via its own commands.
  // Both prefs are read once here rather than per pane, so a pane never renders
  // its switch at the default and then flips it.
  const [showExplorer, setShowExplorer] = useState(true);
  const [explorerEdits, setExplorerEdits] = useState(true);
  // Starting with Windows is a registry entry rather than a stored setting, for the
  // same reason: Windows has to be able to read it with nobody signed in.
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  // Linux: whether closing the window leaves the app running for the Files drive.
  const [keepRunning, setKeepRunning] = useState(true);
  const [restartNeeded, setRestartNeeded] = useState(false);
  useEffect(() => {
    void invoke<boolean>("show_in_explorer").then(setShowExplorer).catch(() => {});
    void invoke<boolean>("explorer_edits").then(setExplorerEdits).catch(() => {});
    void invoke<boolean>("launch_at_login").then(setLaunchAtLogin).catch(() => {});
    void invoke<boolean>("keep_running").then(setKeepRunning).catch(() => {});
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key !== "Escape" || document.querySelector(".cf-backdrop")) return;
      // A label being renamed takes its own Escape back.
      if ((e.target as HTMLElement | null)?.classList?.contains("st-label-edit")) return;
      if (query) setQuery("");
      else if (page !== "home") setPage("home");
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, query, page]);

  function pickTheme(theme: ThemeMode) {
    applyTheme(theme, settings.palette, settings.amoled); // repaint immediately, before the write round-trips
    onChange({ ...settings, theme });
  }

  function pickPalette(palette: PaletteKey) {
    applyTheme(settings.theme, palette, settings.amoled); // repaint immediately, before the write round-trips
    onChange({ ...settings, palette });
  }

  function pickAmoled(on: boolean) {
    applyTheme(settings.theme, settings.palette, on);
    onChange({ ...settings, amoled: on });
  }

  // Swatch fill reflects what the palette looks like in the active mode; AMOLED
  // shows its true-black identity rather than its (unchanged) purple accent.
  const light = resolvedMode(settings.theme) === "light";

  function pickLang(lang: Lang) {
    setLang(lang); // switch the live UI and persist into the settings object
    onChange({ ...settings, lang });
  }

  /** One part's settings, the same on its own page and among a search's results. */
  const paneOf = (category: Category) => (
    <>
            {category === "appearance" && (
              <div className="st-rows">
                <div className="st-row">
                  <span className="st-row-ico" aria-hidden>
                    <BrushIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.theme")}</div>
                    <div className="st-desc">{t(isWindows ? "settings.themeDesc" : "settings.themeDescLinux")}</div>
                  </div>
                  <div className="st-seg" role="group" aria-label={t("settings.theme")}>
                    {THEMES.map((th) => (
                      <button
                        key={th.value}
                        className={`st-seg-btn${settings.theme === th.value ? " on" : ""}`}
                        aria-pressed={settings.theme === th.value}
                        onClick={() => pickTheme(th.value)}
                      >
                        {t(th.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="st-row">
                  <span className="st-row-ico" aria-hidden>
                    <PaletteIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.palette")}</div>
                    <div className="st-desc">{t("settings.paletteDesc")}</div>
                  </div>
                  <div className="st-swatches" role="group" aria-label={t("settings.palette")}>
                    {PICKABLE_PALETTES.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        className={`st-swatch${settings.palette === p.key ? " on" : ""}`}
                        style={{ "--sw": light ? p.light.accent : p.dark.accent } as CSSProperties}
                        aria-pressed={settings.palette === p.key}
                        aria-label={t(p.labelKey)}
                        title={t(p.labelKey)}
                        onClick={() => pickPalette(p.key)}
                      />
                    ))}
                  </div>
                </div>

                <label className={`st-row${light ? " off" : ""}`}>
                  <span className="st-row-ico" aria-hidden>
                    <TuneIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.palette.amoled")}</div>
                    <div className="st-desc">{t("settings.amoledDesc")}</div>
                  </div>
                  <input
                    className="st-switch"
                    type="checkbox"
                    checked={settings.amoled}
                    disabled={light}
                    onChange={(e) => pickAmoled(e.currentTarget.checked)}
                  />
                </label>

                <div className="st-row">
                  <span className="st-row-ico" aria-hidden>
                    <TextIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.language")}</div>
                    <div className="st-desc">{t("settings.languageDesc")}</div>
                  </div>
                  <div className="st-dropdown">
                    <button
                      className="st-dropdown-btn"
                      aria-haspopup="listbox"
                      aria-expanded={langOpen}
                      onClick={() => setLangOpen((o) => !o)}
                    >
                      <span>
                        {LANGS.find((l) => l.value === settings.lang)?.label ?? settings.lang}
                      </span>
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <path
                          d="M3 4.5 L6 7.5 L9 4.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    {langOpen && (
                      <>
                        <div className="st-dropdown-scrim" onClick={() => setLangOpen(false)} />
                        <ul className="st-dropdown-menu" role="listbox">
                          {LANGS.map((l) => (
                            <li key={l.value}>
                              <button
                                className={`st-dropdown-item${settings.lang === l.value ? " on" : ""}`}
                                role="option"
                                aria-selected={settings.lang === l.value}
                                onClick={() => {
                                  pickLang(l.value);
                                  setLangOpen(false);
                                }}
                              >
                                {l.label}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {category === "labels" && <LabelsPane settings={settings} onChange={onChange} labels={labels} />}

            {category === "upload" && <UploadQualityPane settings={settings} onChange={onChange} />}

            {category === "backup" && (
              <BackupPane settings={settings} onChange={onChange} onRefresh={onDriveRefresh} />
            )}

            {category === "myFiles" && (
              <MyFilesPane settings={settings} onChange={onChange} onStart={onMyFilesImport} />
            )}

            {category === "storage" && (
              <StoragePane
                explorer={showExplorer}
                explorerEdits={explorerEdits}
                restartNeeded={restartNeeded}
                onExplorer={(on) => {
                  setShowExplorer(on);
                  setRestartNeeded(true);
                  void invoke("set_show_in_explorer", { enabled: on }).catch(() => {});
                }}
                onExplorerEdits={(on) => {
                  setExplorerEdits(on);
                  void invoke("set_explorer_edits", { enabled: on }).catch(() => {});
                }}
              />
            )}

            {category === "phone" && (
              <MlPane
                settings={settings}
                onChange={onChange}
                faces={faces}
                drive={drive ?? null}
              />
            )}

            {category === "general" && (
              <div className="st-rows">
                {/* Starting at sign-in. Windows starts in the tray; Linux has no tray,
                    so there it opens the window, and the text says which. */}
                <label className="st-row">
                  <span className="st-row-ico" aria-hidden>
                    <PowerIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">
                      {t(isWindows ? "settings.launchAtLogin" : "settings.launchAtLoginLinux")}
                    </div>
                    <div className="st-desc">
                      {t(isWindows ? "settings.launchAtLoginDesc" : "settings.launchAtLoginLinuxDesc")}
                    </div>
                  </div>
                  <input
                    className="st-switch"
                    type="checkbox"
                    checked={launchAtLogin}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      // Shown as set only once it is set: this one writes outside the
                      // app, so a refused write has to move the switch back rather
                      // than leave it saying something that is not true.
                      setLaunchAtLogin(on);
                      void invoke("set_launch_at_login", { enabled: on }).catch(() =>
                        setLaunchAtLogin(!on),
                      );
                    }}
                  />
                </label>
                {/* Linux only: Windows always keeps running in the tray. */}
                {!isWindows && (
                  <label className="st-row">
                    <span className="st-row-ico" aria-hidden>
                      <PowerIcon size={18} />
                    </span>
                    <div className="st-text">
                      <div className="st-label">{t("settings.keepRunning")}</div>
                      <div className="st-desc">{t("settings.keepRunningDesc")}</div>
                    </div>
                    <input
                      className="st-switch"
                      type="checkbox"
                      checked={keepRunning}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setKeepRunning(on);
                        void invoke("set_keep_running", { enabled: on }).catch(() =>
                          setKeepRunning(!on),
                        );
                      }}
                    />
                  </label>
                )}
                <label className="st-row">
                  <span className="st-row-ico" aria-hidden>
                    <NavAlbumsIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.hideAlbum")}</div>
                    <div className="st-desc">{t("settings.hideAlbumDesc")}</div>
                  </div>
                  <input
                    className="st-switch"
                    type="checkbox"
                    checked={settings.hideAlbumPhotos}
                    onChange={(e) =>
                      onChange({ ...settings, hideAlbumPhotos: e.currentTarget.checked })
                    }
                  />
                </label>
              </div>
            )}

            {category === "explorer" && !isWindows && <FilesDrivePane />}

            {category === "fileTypes" && <FileTypesPane />}

            {category === "security" && vaultMode === "device" && (
              <div className="st-rows">
                <div className="st-row">
                  <span className="st-row-ico" aria-hidden>
                    <LockIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t(isWindows ? "settings.deviceProtected" : "settings.deviceProtectedLinux")}</div>
                    <div className="st-desc">{t(isWindows ? "settings.deviceProtectedDesc" : "settings.deviceProtectedDescLinux")}</div>
                  </div>
                </div>
                {isWindows && (
                  <label className={`st-row${!helloReady && !settings.helloLock ? " off" : ""}`}>
                    <span className="st-row-ico" aria-hidden>
                      <FingerprintIcon size={18} />
                    </span>
                    <div className="st-text">
                      <div className="st-label">{t("settings.helloLock")}</div>
                      <div className="st-desc">
                        {t(helloReady || settings.helloLock ? "settings.helloLockDesc" : "settings.helloLockUnavailable")}
                      </div>
                    </div>
                    <input
                      className="st-switch"
                      type="checkbox"
                      checked={settings.helloLock}
                      disabled={!helloReady && !settings.helloLock}
                      onChange={(e) => void pickReopenLock(e.currentTarget.checked ? "hello" : "off")}
                    />
                  </label>
                )}
                {!isWindows && (
                  <label className="st-row">
                    <span className="st-row-ico" aria-hidden>
                      <LockIcon size={18} />
                    </span>
                    <div className="st-text">
                      <div className="st-label">{t("settings.passwordLock")}</div>
                      <div className="st-desc">{t("settings.passwordLockDesc")}</div>
                    </div>
                    <input
                      className="st-switch"
                      type="checkbox"
                      checked={settings.helloLock}
                      onChange={(e) => void pickReopenLock(e.currentTarget.checked ? "hello" : "off")}
                    />
                  </label>
                )}
                {!isWindows && (
                  <div className="st-row">
                    <span className="st-row-ico" aria-hidden>
                      <FingerprintIcon size={18} />
                    </span>
                    <div className="st-text">
                      <div className="st-label">{t("settings.localPassword")}</div>
                      <div className="st-desc">{t("settings.localPasswordDesc")}</div>
                    </div>
                    <button className="st-btn" onClick={() => void askLocalPassword(lockKind === "own")}>
                      {t(lockKind === "own" ? "settings.localPasswordChange" : "settings.localPasswordSet")}
                    </button>
                  </div>
                )}
                {settings.helloLock && lockAfterRow}
                {settings.helloLock && lockMinimizedRow}
              </div>
            )}

            {category === "security" && vaultMode !== "device" && isWindows && (
              <div className="st-rows">
                <div className="st-row">
                  <span className="st-row-ico" aria-hidden>
                    <LockIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.reopenLock")}</div>
                    <div className="st-desc">
                      {t(helloReady || settings.helloLock ? "settings.reopenLockDesc" : "settings.helloLockUnavailable")}
                    </div>
                  </div>
                  <div className="st-seg" role="group" aria-label={t("settings.reopenLock")}>
                    {(
                      [
                        ["off", "settings.reopenOff"],
                        ["password", "settings.reopenPassword"],
                        ["hello", "settings.reopenHello"],
                      ] as const
                    ).map(([key, label]) => {
                      const on = key === "hello" ? settings.helloLock : key === "password" ? settings.lockOnHide && !settings.helloLock : !settings.lockOnHide && !settings.helloLock;
                      return (
                        <button
                          key={key}
                          className={`st-seg-btn${on ? " on" : ""}`}
                          aria-pressed={on}
                          disabled={key === "hello" && !helloReady && !settings.helloLock}
                          onClick={() => void pickReopenLock(key)}
                        >
                          {t(label)}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {(settings.helloLock || settings.lockOnHide) && lockAfterRow}
                {(settings.helloLock || settings.lockOnHide) && lockMinimizedRow}
              </div>
            )}

            {category === "security" && vaultMode !== "device" && !isWindows && (
              <div className="st-rows">
                <label className="st-row">
                  <span className="st-row-ico" aria-hidden>
                    <LockIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.lockOnHide")}</div>
                    <div className="st-desc">{t("settings.lockOnHideDesc")}</div>
                  </div>
                  <input
                    className="st-switch"
                    type="checkbox"
                    checked={settings.lockOnHide}
                    onChange={(e) => onChange({ ...settings, lockOnHide: e.currentTarget.checked })}
                  />
                </label>
              </div>
            )}

            {category === "about" && (
              <>
                <div className="st-about">
                  <div className="st-about-name">Photos for Proton</div>
                  <div className="st-about-ver">{version ? `v${version}` : ""}</div>
                </div>

                <div className="st-rows">
                  {/* The self-updater downloads and runs a Windows installer; the Linux
                      build updates through Flatpak, so it offers no in-app update. */}
                  {isWindows && (
                    <label className="st-row">
                      <span className="st-row-ico" aria-hidden>
                        <DownloadIcon size={18} />
                      </span>
                      <div className="st-text">
                        <div className="st-label">{t("settings.autoUpdate")}</div>
                        <div className="st-desc">{t("settings.autoUpdateDesc")}</div>
                      </div>
                      <input
                        className="st-switch"
                        type="checkbox"
                        checked={autoUpdate}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          setAutoUpdate(on);
                          setAutoUpdateState(on);
                        }}
                      />
                    </label>
                  )}
                  {isWindows && (
                    <div className="st-row">
                      <span className="st-row-ico" aria-hidden>
                        <RefreshIcon size={18} />
                      </span>
                      <div className="st-text">
                        <div className="st-label">{t("settings.checkUpdates")}</div>
                        <div className="st-desc">
                          {checkState === "uptodate"
                            ? t("settings.upToDate")
                            : checkState === "found" && updateInfo
                              ? t("update.available", { version: updateInfo.version })
                              : checkState === "error"
                                ? t("update.failed")
                                : ""}
                        </div>
                      </div>
                      {checkState === "found" ? (
                        <button className="st-btn" onClick={() => void installUpdate()}>
                          {t("update.now")}
                        </button>
                      ) : (
                        <button
                          className="st-btn"
                          disabled={checkState === "checking" || checkState === "installing"}
                          onClick={() => void checkForUpdates()}
                        >
                          {checkState === "checking"
                            ? t("common.loading")
                            : checkState === "installing"
                              ? t("update.updating")
                              : t("settings.checkUpdates")}
                        </button>
                      )}
                    </div>
                  )}

                <button
                  className="st-row st-row-link"
                  onClick={() => void openUrl("https://akoos.eu")}
                >
                  <span className="st-row-ico" aria-hidden>
                    <PersonAddIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">Akoos</div>
                    <div className="st-desc">{t("settings.authorRole")}</div>
                  </div>
                  <OpenInNewIcon size={15} />
                </button>

                <button
                  className="st-row st-row-link"
                  onClick={() => void openUrl("https://www.buymeacoffee.com/akoos")}
                >
                  <span className="st-row-ico" aria-hidden>
                    <HeartIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.support")}</div>
                    <div className="st-desc">{t("settings.supportDesc")}</div>
                  </div>
                  <OpenInNewIcon size={15} />
                </button>

                <button
                  className="st-row st-row-link"
                  onClick={() => void openUrl("https://www.photosforproton.eu")}
                >
                  <span className="st-row-ico" aria-hidden>
                    <NavSharedIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.website")}</div>
                    <div className="st-desc st-mono">www.photosforproton.eu</div>
                  </div>
                  <OpenInNewIcon size={15} />
                </button>

                <button
                  className="st-row st-row-link"
                  onClick={() => void openUrl("https://github.com/gitakoos/photos-desktop")}
                >
                  <span className="st-row-ico" aria-hidden>
                    <ListIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.sourceCode")}</div>
                    <div className="st-desc st-mono">github.com/gitakoos/photos-desktop</div>
                  </div>
                  <OpenInNewIcon size={15} />
                </button>

                <DiagnosticsRows settings={settings} onChange={onChange} version={version} />

                <label className="st-row">
                  <span className="st-row-ico" aria-hidden>
                    <InfoIcon size={18} />
                  </span>
                  <div className="st-text">
                    <div className="st-label">{t("settings.debug")}</div>
                    <div className="st-desc">{t("settings.debugDesc")}</div>
                  </div>
                  <input
                    className="st-switch"
                    type="checkbox"
                    checked={settings.debug}
                    onChange={(e) => onChange({ ...settings, debug: e.currentTarget.checked })}
                  />
                </label>
                </div>
              </>
            )}
    </>
  );

  const q = query.trim();
  const status = activityLine(activity ?? null, t);
  const fraction = account && account.maxSpace > 0 ? account.usedSpace / account.maxSpace : 0;
  const titleOf = (category: Category) => t(CATEGORIES.find((c) => c.key === category)!.labelKey);

  return (
    <section className="st-page" aria-label={t("settings.title")}>
      <header className="st-page-head">
        <span className="st-page-ico" aria-hidden>
          <GearIcon size={22} />
        </span>
        <h2 className="st-page-title">{t("settings.title")}</h2>
        <label className="st-search">
          <SearchIcon size={16} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={t("settings.search")}
            aria-label={t("settings.search")}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {query && (
            <button className="st-search-clear" onClick={() => setQuery("")} title={t("common.close")} aria-label={t("common.close")}>
              <CloseIcon size={14} />
            </button>
          )}
        </label>
      </header>

      <div className="st-page-body">
        {q ? (
          // A search shows every part at once and leaves only what matches, each setting working in place.
          <div className="st-results" ref={resultsRef}>
            {CATEGORIES.map(({ key: category, labelKey }) => (
              <section className="st-section" key={category}>
                <h3 className="st-section-title">
                  <span className="st-section-ico" aria-hidden>
                    {CATEGORY_ICONS[category]}
                  </span>
                  {t(labelKey)}
                </h3>
                {category === "phone" ? (
                  <MlPane
                    settings={settings}
                    onChange={onChange}
                    faces={faces}
                    drive={drive ?? null}
                    flat
                  />
                ) : (
                  paneOf(category)
                )}
              </section>
            ))}
            {noHits && <p className="st-intro">{t("settings.searchNone")}</p>}
          </div>
        ) : page !== "home" ? (
          <section className="st-section">
            <SubPageHead title={titleOf(page)} onBack={() => setPage("home")} />
            {paneOf(page)}
          </section>
        ) : (
          <>
            {account && (
              <section className="st-section">
                <h3 className="st-section-title">{t("settings.account")}</h3>
                <div className="st-rows">
                  <div className="st-row st-account">
                    <div className="st-avatar" aria-hidden>
                      {account.initial}
                    </div>
                    <div className="st-text">
                      <div className="st-label">{account.displayName}</div>
                      <div className="st-desc">{account.email}</div>
                      {account.maxSpace > 0 && (
                        <>
                          <div className="st-progress st-storage-bar">
                            <div style={{ width: `${Math.min(100, Math.round(fraction * 100))}%`, background: barColor(fraction) }} />
                          </div>
                          <div className="st-desc">
                            {t("settings.accountStorage", {
                              used: formatBytes(account.usedSpace),
                              total: formatBytes(account.maxSpace),
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <button className="st-row st-row-link" onClick={() => onSignOut?.()}>
                    <span className="st-row-ico" aria-hidden>
                      <SignOutIcon size={18} />
                    </span>
                    <div className="st-text">
                      <div className="st-label">{t("profile.signOut")}</div>
                      <div className="st-desc">{t("settings.signOutDesc")}</div>
                    </div>
                  </button>
                </div>
              </section>
            )}

            <section className="st-section">
              <h3 className="st-section-title">{t("settings.status")}</h3>
              <div className="st-rows">
                <NavRow
                  icon={<CloudUploadIcon size={18} />}
                  label={t("settings.activity")}
                  desc={status}
                  onOpen={() => onOpenActivity?.()}
                />
                {onOpenDuplicates && (
                  <NavRow
                    icon={<ContentCopyIcon size={18} />}
                    label={t("duplicates.title")}
                    desc={t("duplicates.desc")}
                    onOpen={onOpenDuplicates}
                  />
                )}
              </div>
            </section>

            {HOME_GROUPS.map((group, i) => (
              <div className="st-rows" key={i}>
                {group
                  .filter((key) => CATEGORIES.some((c) => c.key === key))
                  .map((key) => (
                    <NavRow
                      key={key}
                      icon={CATEGORY_ICONS[key]}
                      label={titleOf(key)}
                      desc={t(isWindows || !CATEGORY_DESCS_LINUX[key] ? CATEGORY_DESCS[key] : CATEGORY_DESCS_LINUX[key]!)}
                      onOpen={() => setPage(key)}
                    />
                  ))}
              </div>
            ))}
          </>
        )}
      </div>
      {passwordAsk && lockKind && (
        <LocalPasswordDialog
          title={t(passwordAsk.change ? "settings.localPasswordChange" : lockKind === "none" ? "localLock.setTitle" : "localLock.enterTitle")}
          kind={lockKind}
          change={passwordAsk.change}
          onDone={() => {
            passwordAsk.resolve(true);
            setPasswordAsk(null);
            refreshLockKind();
          }}
          onCancel={() => {
            passwordAsk.resolve(false);
            setPasswordAsk(null);
          }}
        />
      )}
    </section>
  );
}

type FacesAct = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type DriveState = { state: "loading" | "failed" | "ready"; data: DriveCollections | null; at: number } | null;

/** The top of a page under Machine learning: the way back, and the page's name. */
function SubPageHead({ title, onBack }: { title: string; onBack: () => void }) {
  const t = useT();
  return (
    <button className="st-back" onClick={onBack} title={t("common.back")} aria-label={t("common.back")}>
      <ArrowBackIcon size={18} />
      <span>{title}</span>
    </button>
  );
}

/** A row that opens one of the pages under Machine learning. */
function NavRow({ icon, label, desc, onOpen }: { icon: ReactNode; label: string; desc: string; onOpen: () => void }) {
  return (
    <button className="st-row st-row-link" onClick={onOpen}>
      <span className="st-row-ico" aria-hidden>
        {icon}
      </span>
      <div className="st-text">
        <div className="st-label">{label}</div>
        <div className="st-desc">{desc}</div>
      </div>
      <ChevronRightIcon size={20} />
    </button>
  );
}

/** Pausing the scan on this PC, which reads the photos for the faces and the search index alike. */
function PauseRow({ paused, act }: { paused: boolean; act?: FacesAct }) {
  const t = useT();
  return (
    <div className="st-row off">
      <span className="st-row-ico" aria-hidden>
        {paused ? <PlayArrowIcon size={18} /> : <PauseIcon size={18} />}
      </span>
      <div className="st-text">
        <div className="st-label">{t(paused ? "faces.resume" : "faces.pause")}</div>
        <div className="st-desc">{t("faces.pauseDesc")}</div>
      </div>
      <button className="st-row-btn" onClick={() => void act?.("faceScanSetPaused", { paused: !paused }).catch(() => {})}>
        {t(paused ? "faces.resume" : "faces.pause")}
      </button>
    </div>
  );
}

/**
 * How fast the scan reads the library, the same speed for the faces and the search. Shows the speed
 * this PC starts at until one is picked, and says so while the battery or a metered connection
 * holds it to Gentle.
 */
function ScanSpeedRow({
  settings,
  onChange,
  status,
  repeat = false,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  status: FaceScanStatus | null;
  /** The same row already shows on another page: searching the settings lists it once. */
  repeat?: boolean;
}) {
  const t = useT();
  const shown = shownSpeed(settings.scanSpeed, status);
  return (
    <div className="st-row" data-search-repeat={repeat ? "" : undefined}>
      <span className="st-row-ico" aria-hidden>
        <TuneIcon size={18} />
      </span>
      <div className="st-text">
        <div className="st-label">{t("settings.scanSpeed")}</div>
        <div className="st-desc">{t("settings.scanSpeedDesc")}</div>
        {speedHeld(shown, status) && <div className="st-desc st-status">{t("settings.scanSpeedHeld")}</div>}
      </div>
      <div className="st-seg" role="group" aria-label={t("settings.scanSpeed")}>
        {SCAN_SPEEDS.map((speed) => (
          <button
            key={speed}
            className={`st-seg-btn${shown === speed ? " on" : ""}`}
            aria-pressed={shown === speed}
            onClick={() => onChange({ ...settings, scanSpeed: speed })}
          >
            {t(`settings.scanSpeed.${speed}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A long look through the library gets a bar; a few new photos do not. */
const BAR_FROM = 50;

/**
 * Machine learning, laid out as the Android app lays it out: a row for face recognition and one
 * for the search by what a photo shows, each saying only how its own work stands and opening its
 * own page. Saving to and loading from Proton Drive has its own part, Backup to Proton Drive.
 */
function MlPane({
  settings,
  onChange,
  faces,
  drive,
  flat,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  faces?: { status: FaceScanStatus | null; act: FacesAct };
  drive: DriveState;
  /** Every setting on one page, for a search to pick from. */
  flat?: boolean;
}) {
  const t = useT();
  const { lang } = useLang();
  const [page, setPage] = useState<"main" | "faces" | "search">("main");
  const scan = faces?.status ?? null;

  if (flat) {
    return (
      <>
        <h4 className="st-subhead">{t("settings.faceRecognition")}</h4>
        <FacesPane settings={settings} onChange={onChange} faces={faces} />
        <h4 className="st-subhead st-subhead-gap">{t("settings.semantic")}</h4>
        <SearchPane settings={settings} onChange={onChange} drive={drive} scan={scan} act={faces?.act} />
        <CopyTextRows settings={settings} onChange={onChange} />
      </>
    );
  }

  if (page === "faces") {
    return (
      <>
        <SubPageHead title={t("settings.faceRecognition")} onBack={() => setPage("main")} />
        <FacesPane settings={settings} onChange={onChange} faces={faces} />
      </>
    );
  }
  if (page === "search") {
    return (
      <>
        <SubPageHead title={t("settings.semantic")} onBack={() => setPage("main")} />
        <SearchPane settings={settings} onChange={onChange} drive={drive} scan={scan} act={faces?.act} />
      </>
    );
  }

  const facesScan = settings.localFaces ? facesStatus(scan) : null;
  const facesLeft = !!facesScan && facesScan.done < facesScan.total;
  const facesDesc = !settings.localFaces
    ? t(settings.driveFaces ? "settings.drivePeopleDesc" : "settings.faceRecognitionShort")
    : facesScan?.state === "paused" && facesLeft
      ? t("settings.mlPaused")
      : scanBusy(facesScan)
        ? t("settings.mlScanning")
        : facesScan?.state === "done"
          ? t("faces.state.done", { total: facesScan.total.toLocaleString(lang), faces: facesScan.faces.toLocaleString(lang) })
          : t("settings.faceRecognitionShort");

  const index = settings.semanticSearch && settings.localSearch ? (scan?.search ?? null) : null;
  const indexLeft = !!index && index.indexed + index.unreadable < index.total;
  const searchDesc = !index
    ? t("settings.semanticShort")
    : scan?.state === "paused" && indexLeft
      ? t("settings.mlPaused")
      : searchIndexing(scan)
        ? t("settings.mlScanning")
        : t("settings.localSearchCount", { count: index.indexed.toLocaleString(lang) });

  return (
    <>
      <div className="st-rows">
        <NavRow
          icon={<FaceIcon size={18} />}
          label={t("settings.faceRecognition")}
          desc={facesDesc}
          onOpen={() => setPage("faces")}
        />
        <NavRow
          icon={<SearchIcon size={18} />}
          label={t("settings.semantic")}
          desc={searchDesc}
          onOpen={() => setPage("search")}
        />
      </div>
      <CopyTextRows settings={settings} onChange={onChange} />
    </>
  );
}

/**
 * Face recognition: where the people come from, how far the scan on this PC has got, its pause,
 * and a way to delete everything it found.
 */
function FacesPane({
  settings,
  onChange,
  faces,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  faces?: { status: FaceScanStatus | null; act: FacesAct };
}) {
  const t = useT();
  const { lang } = useLang();
  const [confirmClear, setConfirmClear] = useState(false);
  // Only the faces' own work: a pass that only builds the search index is the search page's.
  const status = settings.localFaces ? facesStatus(faces?.status ?? null) : null;
  const left = !!status && status.done < status.total;
  const paused = status?.state === "paused" && left;
  const line = status?.state === "paused" && !left ? null : statusLine(status);
  const values = line?.values
    ? Object.fromEntries(
        Object.entries(line.values).map(([k, v]) => [k, typeof v === "number" ? v.toLocaleString(lang) : v]),
      )
    : undefined;
  // A bar only while a long look through the library runs, never one that stands still.
  const progress =
    status?.state === "models" && status.download
      ? status.download.done / Math.max(1, status.download.total)
      : status?.state === "scanning" && status.total >= BAR_FROM
        ? status.done / status.total
        : null;

  // On, the faces are found here and, with the shared backup, put together with every other
  // device's, each photo looked at by one of them only.
  const source: "pc" | "off" = settings.localFaces ? "pc" : "off";
  const pickSource = (next: "pc" | "off") => onChange({ ...settings, localFaces: next === "pc", driveFaces: false });

  return (
    <>
      <div className="st-rows">
        <div className="st-row">
          <span className="st-row-ico" aria-hidden>
            <FaceIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.drivePeople")}</div>
            <div className="st-desc">
              {t(source === "pc" ? "settings.facesIntro" : "settings.peopleOffDesc")}
            </div>
            {line && <div className="st-desc st-status">{t(line.key, values)}</div>}
            {status?.accel && scanBusy(status) && (
              <div className="st-desc">{t(status.accel === "gpu" ? "faces.accel.gpu" : "faces.accel.cpu")}</div>
            )}
            {progress !== null && (
              <div className="st-progress">
                <div style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
          </div>
          <input
            className="st-switch"
            type="checkbox"
            aria-label={t("settings.drivePeople")}
            checked={source === "pc"}
            onChange={(e) => pickSource(e.currentTarget.checked ? "pc" : "off")}
          />
        </div>
        {(scanBusy(status) || paused) && <PauseRow paused={paused} act={faces?.act} />}
        {settings.localFaces && <ScanSpeedRow settings={settings} onChange={onChange} status={faces?.status ?? null} />}
        {settings.localFaces && (
          <label className="st-row">
            <span className="st-row-ico" aria-hidden>
              <CallMergeIcon size={18} />
            </span>
            <div className="st-text">
              <div className="st-label">{t("settings.faceAutoMerge")}</div>
              <div className="st-desc">{t("settings.faceAutoMergeDesc")}</div>
            </div>
            <input
              className="st-switch"
              type="checkbox"
              checked={settings.faceAutoMerge}
              onChange={(e) => onChange({ ...settings, faceAutoMerge: e.currentTarget.checked })}
            />
          </label>
        )}
        {settings.localFaces && (
          <label className="st-row">
            <span className="st-row-ico" aria-hidden>
              <SearchIcon size={18} />
            </span>
            <div className="st-text">
              <div className="st-label">{t("settings.faceFindMore")}</div>
              <div className="st-desc">{t("settings.faceFindMoreDesc")}</div>
            </div>
            <input
              className="st-switch"
              type="checkbox"
              checked={settings.faceFindMore}
              onChange={(e) => onChange({ ...settings, faceFindMore: e.currentTarget.checked })}
            />
          </label>
        )}
        <div className="st-row off">
          <span className="st-row-ico" aria-hidden>
            <TrashIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("faces.clear")}</div>
            <div className="st-desc">{t("faces.clearDesc")}</div>
          </div>
          <button className="st-row-btn" onClick={() => setConfirmClear(true)}>
            {t("faces.clearAction")}
          </button>
        </div>
      </div>
      {confirmClear && settings.sharedBackup && (
        // With the backup on, the face data is on Drive and the other devices too: only here, where
        // it comes back from Drive, or everywhere, where face recognition goes off on each.
        <Confirm
          title={t("faces.clearWhereTitle")}
          message={t("faces.clearWhereMessage")}
          altLabel={t("faces.clearHere")}
          onAlt={() => {
            setConfirmClear(false);
            void faces?.act("faceClearHere").catch(() => {});
          }}
          confirmLabel={t("faces.clearEverywhere")}
          danger
          irreversible
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            onChange({ ...settings, localFaces: false });
            void faces?.act("faceClearEverywhere").catch(() => {});
          }}
        />
      )}
      {confirmClear && !settings.sharedBackup && (
        <Confirm
          title={t("faces.clearConfirmTitle")}
          message={t("faces.clearConfirmMessage")}
          confirmLabel={t("faces.clearAction")}
          danger
          irreversible
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            onChange({ ...settings, localFaces: false });
            void faces?.act("faceScanClear").catch(() => {});
          }}
        />
      )}
    </>
  );
}

type ModelStatus =
  | { state: "absent" }
  | { state: "downloading"; done: number; total: number }
  | { state: "ready" }
  | { state: "failed"; error: string };

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** The copy-text models' size, quoted before they are fetched. */
const OCR_DOWNLOAD_BYTES = 4_748_769 + 582_663 + 8_064_539 + 2_616;

/**
 * Copy text, as on the phone: switched on, it asks before fetching its models; switched off, it
 * offers to delete them or keep them for later.
 */
function CopyTextRows({ settings, onChange }: { settings: AppSettings; onChange: (next: AppSettings) => void }) {
  const t = useT();
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [ask, setAsk] = useState<"download" | "remove" | null>(null);

  useEffect(() => {
    let live = true;
    let timer = 0;
    const poll = async () => {
      try {
        const status = await rpc<ModelStatus>("ocrModelStatus");
        if (!live) return;
        setModel(status);
        if (status.state === "downloading") timer = window.setTimeout(poll, 600);
      } catch {
        /* the row shows nothing about the models */
      }
    };
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [model?.state === "downloading"]);

  async function call(method: "ocrModelDownload" | "ocrModelRemove") {
    try {
      setModel(await rpc<ModelStatus>(method));
    } catch (e) {
      setModel({ state: "failed", error: String(e) });
    }
  }

  function toggle(on: boolean) {
    if (on) {
      if (model?.state === "ready" || model?.state === "downloading") onChange({ ...settings, copyText: true });
      else setAsk("download");
      return;
    }
    onChange({ ...settings, copyText: false });
    if (model?.state === "ready") setAsk("remove");
  }

  const desc =
    settings.copyText && model?.state === "downloading"
      ? t("settings.copyTextDownloading", { done: megabytes(model.done), total: megabytes(model.total) })
      : settings.copyText && model?.state === "failed"
        ? t("settings.copyTextFailed")
        : t("settings.copyTextDesc");

  return (
    <>
      <div className="st-rows">
        <label className="st-row">
          <span className="st-row-ico" aria-hidden>
            <TextIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.copyText")}</div>
            <div className="st-desc">{desc}</div>
            {settings.copyText && model?.state === "downloading" && (
              <div className="st-progress">
                <div style={{ width: `${Math.round((model.done / Math.max(1, model.total)) * 100)}%` }} />
              </div>
            )}
          </div>
          <input
            className="st-switch"
            type="checkbox"
            checked={settings.copyText}
            onChange={(e) => toggle(e.currentTarget.checked)}
          />
        </label>
      </div>
      {ask === "download" && (
        <Confirm
          title={t("settings.copyTextDownloadTitle")}
          message={t("settings.copyTextDownloadMessage", { size: megabytes(OCR_DOWNLOAD_BYTES) })}
          confirmLabel={t("settings.copyTextDownload")}
          onConfirm={() => {
            setAsk(null);
            onChange({ ...settings, copyText: true });
            void call("ocrModelDownload");
          }}
          onCancel={() => setAsk(null)}
        />
      )}
      {ask === "remove" && (
        <Confirm
          title={t("settings.copyTextRemoveTitle")}
          message={t("settings.copyTextRemoveMessage", { size: megabytes(OCR_DOWNLOAD_BYTES) })}
          confirmLabel={t("settings.copyTextRemove")}
          cancelLabel={t("settings.copyTextKeep")}
          onConfirm={() => {
            setAsk(null);
            void call("ocrModelRemove");
          }}
          onCancel={() => setAsk(null)}
        />
      )}
    </>
  );
}

/**
 * The search by what a photo shows: whether it reads the index made on this PC or the one the
 * phone saved to Proton Drive, how far this PC's index has got, and the text model the search
 * needs, fetched when the search is turned on.
 */
function SearchPane({
  settings,
  onChange,
  drive,
  scan,
  act,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  drive: DriveState;
  /** The scan on this computer, for how far its own search index has got. */
  scan: FaceScanStatus | null;
  act?: FacesAct;
}) {
  const t = useT();
  const { lang } = useLang();
  const [model, setModel] = useState<ModelStatus | null>(null);

  // Read now, and every moment while it downloads.
  useEffect(() => {
    let live = true;
    let timer = 0;
    const poll = async () => {
      try {
        const status = await rpc<ModelStatus>("semanticModelStatus");
        if (!live) return;
        setModel(status);
        if (status.state === "downloading") timer = window.setTimeout(poll, 600);
      } catch {
        /* the pane shows nothing about the model */
      }
    };
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [model?.state === "downloading"]);

  async function startDownload() {
    try {
      setModel(await rpc<ModelStatus>("semanticModelDownload"));
    } catch (e) {
      setModel({ state: "failed", error: String(e) });
    }
  }

  // On, the photos are indexed here and, with the shared backup, every other device's index fills
  // what it already read.
  const searchSource: "pc" | "off" = settings.semanticSearch && settings.localSearch ? "pc" : "off";
  // Leaving the index made here: whether to keep it, ready at once on the way back, or delete it.
  const [askDeleteIndex, setAskDeleteIndex] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  function pickSearchSource(next: "pc" | "off") {
    if (searchSource === "pc" && next !== "pc" && scan?.search && scan.search.indexed + scan.search.unreadable > 0) {
      setAskDeleteIndex(true);
    }
    onChange({ ...settings, semanticSearch: next !== "off", localSearch: next === "pc" });
    if (next !== "off" && model?.state !== "ready" && model?.state !== "downloading") void startDownload();
  }

  async function removeModel() {
    try {
      setModel(await rpc<ModelStatus>("semanticModelRemove"));
    } catch {
      /* stays as it was */
    }
  }

  const data = drive?.data ?? null;
  let searchLine = "";
  if (settings.semanticSearch) {
    if (model?.state === "downloading") {
      searchLine = t("settings.semanticDownloading", { done: megabytes(model.done), total: megabytes(model.total) });
    } else if (model?.state === "failed") {
      searchLine = t("settings.semanticFailed");
    } else if (model?.state === "ready" && data) {
      searchLine = data.searchPhotos
        ? t("settings.semanticReady", { count: data.searchPhotos.toLocaleString(lang) })
        : data.searchOtherModel
          ? t("settings.semanticOtherModel")
          : t("settings.semanticNoIndex");
    }
  }

  const index = searchSource === "pc" ? (scan?.search ?? null) : null;
  const read = index ? index.indexed + index.unreadable : 0;
  const indexLeft = !!index && read < index.total;
  const paused = scan?.state === "paused" && indexLeft;
  const indexing = searchIndexing(scan);

  return (
    <>
      <div className="st-rows">
        <div className="st-row">
          <span className="st-row-ico" aria-hidden>
            <SearchIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.semantic")}</div>
            <div className="st-desc">
              {t(searchSource === "pc" ? "settings.localSearchDesc" : "settings.semanticOffDesc")}
            </div>
            {index && (
              <div className="st-desc st-status">
                {indexLeft
                  ? t("settings.localSearchProgress", { done: read.toLocaleString(lang), total: index.total.toLocaleString(lang) })
                  : t("settings.localSearchCount", { count: index.indexed.toLocaleString(lang) })}
              </div>
            )}
            {indexing && index && index.total >= BAR_FROM && (
              <div className="st-progress">
                <div style={{ width: `${Math.round((read / index.total) * 100)}%` }} />
              </div>
            )}
            {searchSource === "pc" && scan && !index && scan.state === "failed" && (
              <div className="st-desc st-status">{t("faces.state.failed")}</div>
            )}
            {searchSource === "pc" && scan && !index && scan.state === "models" && scan.download && (
              <div className="st-desc st-status">
                {t("settings.localSearchModels", {
                  done: Math.round(scan.download.done / 1_000_000),
                  total: Math.round(scan.download.total / 1_000_000),
                })}
              </div>
            )}
            {settings.semanticSearch && model?.state === "downloading" && (
              <>
                <div className="st-desc st-status">{searchLine}</div>
                <div className="st-progress">
                  <div style={{ width: `${Math.round((model.done / Math.max(1, model.total)) * 100)}%` }} />
                </div>
              </>
            )}
          </div>
          <input
            className="st-switch"
            type="checkbox"
            aria-label={t("settings.semantic")}
            checked={searchSource === "pc"}
            onChange={(e) => pickSearchSource(e.currentTarget.checked ? "pc" : "off")}
          />
        </div>
        {(indexing || paused) && <PauseRow paused={paused} act={act} />}
        {searchSource === "pc" && (
          <ScanSpeedRow settings={settings} onChange={onChange} status={scan} repeat={settings.localFaces} />
        )}
        {searchSource === "pc" && (
          <div className="st-row off">
            <span className="st-row-ico" aria-hidden>
              <RefreshIcon size={18} />
            </span>
            <div className="st-text">
              <div className="st-label">{t("settings.localSearchReset")}</div>
              <div className="st-desc">{t("settings.localSearchResetDesc")}</div>
            </div>
            <button className="st-row-btn" onClick={() => setConfirmRestart(true)}>
              {t("settings.localSearchResetAction")}
            </button>
          </div>
        )}
        {settings.semanticSearch && model?.state === "failed" && (
          <div className="st-row off">
            <div className="st-text">
              <div className="st-desc">{t("settings.semanticFailed")}</div>
            </div>
            <button className="st-row-btn" onClick={() => void startDownload()}>
              {t("settings.semanticRetry")}
            </button>
          </div>
        )}
        {!settings.semanticSearch && model?.state === "ready" && (
          <div className="st-row off">
            <span className="st-row-ico" aria-hidden>
              <TrashIcon size={18} />
            </span>
            <div className="st-text">
              <div className="st-label">{t("settings.semanticRemove")}</div>
              <div className="st-desc">{t("settings.semanticRemoveDesc")}</div>
            </div>
            <button className="st-row-btn" onClick={() => void removeModel()}>
              {t("settings.semanticRemoveAction")}
            </button>
          </div>
        )}
      </div>
      {confirmRestart && (
        <Confirm
          title={t("settings.localSearchReset")}
          message={t("settings.localSearchResetDesc")}
          confirmLabel={t("settings.localSearchResetAction")}
          onCancel={() => setConfirmRestart(false)}
          onConfirm={() => {
            setConfirmRestart(false);
            void act?.("faceSearchClear").catch(() => {});
          }}
        />
      )}
      {askDeleteIndex && (
        <Confirm
          title={t("settings.localSearchDeleteTitle")}
          message={t("settings.localSearchDeleteMessage")}
          confirmLabel={t("settings.localSearchDeleteAction")}
          danger
          onCancel={() => setAskDeleteIndex(false)}
          onConfirm={() => {
            setAskDeleteIndex(false);
            void act?.("faceSearchClear").catch(() => {});
          }}
        />
      )}
    </>
  );
}

/**
 * Backup to Proton Drive, as the phone has it: one switch for the automatic backup, "Back up now"
 * and "Load from Drive", and what the other devices last saved there. Each round reads every other
 * device's copy first, puts what is new together with what is here, and only then saves this
 * computer's own.
 */
function BackupPane({
  settings,
  onChange,
  onRefresh,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onRefresh?: () => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const [loading, setLoading] = useState(false);
  // What a phone needs to take part, behind the info button rather than on the row itself.
  const [phoneNote, setPhoneNote] = useState(false);
  // Turning it on first says which version a phone needs, so an older one is not taken for broken.
  const [askTurnOn, setAskTurnOn] = useState(false);
  const date = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const backup = useBackupStatus();
  const [trashAsk, setTrashAsk] = useState<DriveBackup | null>(null);
  const copies = useDriveBackups(backup?.lastAt ?? null);
  const backupLine = !backup
    ? null
    : backup.running
      ? t("settings.sharedBackupRunning")
      : backup.failed
        ? t("settings.sharedBackupFailed")
        : backup.lastAt
          ? backupSynced(backup.parts)
            ? t("settings.sharedBackupSynced", { date: date.format(new Date(backup.lastAt)) })
            : t("backup.nothingSaved")
          : null;
  const partText = (kind: BackupKind, { key, values }: BackupPartLine) => t(key, { ...values, part: t(`backup.part.${kind}`) });
  const sending = backup?.progress ?? null;
  const deviceName = (b: DriveBackup) => (b.own ? t("settings.driveCopiesThis") : (b.name ?? t("settings.driveCopiesOther")));
  const copiesLine =
    copies.state === "loading" && copies.list.length === 0
      ? t("settings.driveCopiesLoading")
      : copies.state === "failed"
        ? t("settings.driveCopiesFailed")
        : copies.state === "trashFailed"
          ? t("settings.driveCopiesTrashFailed")
          : copies.list.length === 0 && copies.state === "ready"
            ? t("settings.driveCopiesEmpty")
            : null;

  async function load() {
    setLoading(true);
    try {
      await rpc("sharedBackupLoad");
    } catch {
      /* the lines below keep what was last read */
    } finally {
      setLoading(false);
      onRefresh?.();
    }
  }

  return (
    <>
      <div className="st-rows">
        <label className="st-row">
          <span className="st-row-ico" aria-hidden>
            <BackupIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">
              {t("settings.sharedBackup")}
              <button
                type="button"
                className="st-info"
                aria-expanded={phoneNote}
                aria-label={t("settings.sharedBackupPhoneInfo")}
                title={t("settings.sharedBackupPhoneInfo")}
                onClick={(e) => {
                  // Inside the switch's label: the note opens, the switch stays as it is.
                  e.preventDefault();
                  e.stopPropagation();
                  setPhoneNote((open) => !open);
                }}
              >
                <InfoIcon size={14} />
              </button>
            </div>
            <div className="st-desc">{t("settings.sharedBackupDesc")}</div>
            {phoneNote && <div className="st-desc st-status">{t("settings.sharedBackupPhoneNote")}</div>}
            {backupLine && <div className="st-desc st-status">{backupLine}</div>}
          </div>
          <input
            className="st-switch"
            type="checkbox"
            checked={settings.sharedBackup}
            onChange={(e) => {
              if (e.currentTarget.checked) setAskTurnOn(true);
              else onChange({ ...settings, sharedBackup: false });
            }}
          />
        </label>
        {askTurnOn && (
          <Confirm
            title={t("settings.sharedBackupTurnOnTitle")}
            message={t("settings.sharedBackupPhoneNote")}
            confirmLabel={t("settings.sharedBackupTurnOn")}
            onConfirm={() => {
              setAskTurnOn(false);
              onChange({ ...settings, sharedBackup: true });
            }}
            onCancel={() => setAskTurnOn(false)}
          />
        )}
        <div className="st-row">
          <span className="st-row-ico" aria-hidden>
            <RefreshIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.sharedBackupNow")}</div>
            <div className="st-desc">{t("settings.sharedBackupNowDesc")}</div>
            {BACKUP_KINDS.map((kind) => {
              const part = backup?.parts[kind];
              if (!part) return null;
              return (
                <div key={kind} className={`st-desc${part.result === "failed" || part.result === "blocked" ? " bad" : " st-status"}`}>
                  {partText(kind, backupPartLine(kind, part, (at) => date.format(new Date(at))))}
                </div>
              );
            })}
            {/* One button under all the lines: it overrides every copy held back, so all their numbers show first. */}
            {backup && backupBlocked(backup.parts) && (
              <div className="st-keep-line">
                <button
                  className="st-row-btn"
                  disabled={backup.running || loading}
                  onClick={() => void rpc("sharedBackupNow", { force: true }).catch(() => {})}
                >
                  {t("backup.saveAnyway")}
                </button>
              </div>
            )}
            {sending && (
              <>
                <div className="st-desc st-status">{partText(sending.kind, backupSendingLine(sending))}</div>
                <div className="st-progress">
                  <div style={{ width: `${sending.total > 0 ? Math.round((sending.sent / sending.total) * 100) : 0}%` }} />
                </div>
              </>
            )}
          </div>
          <button
            className="st-row-btn"
            disabled={!!backup?.running || loading}
            onClick={() => void rpc("sharedBackupNow").catch(() => {})}
          >
            {t("settings.sharedBackupNow")}
          </button>
        </div>
        <div className="st-row">
          <span className="st-row-ico" aria-hidden>
            <DownloadIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.loadFromDrive")}</div>
            <div className="st-desc">{t("settings.loadFromDriveDesc")}</div>
          </div>
          <button className="st-row-btn" disabled={loading || !!backup?.running} onClick={() => void load()}>
            {loading ? t("common.loading") : t("settings.loadFromDrive")}
          </button>
        </div>
      </div>

      {/* The devices that saved, a list of their own under a heading, apart from the actions above. */}
      <h4 className="st-subhead st-subhead-gap">{t("settings.driveCopies")}</h4>
      <p className="st-note">{t("settings.driveCopiesDesc")}</p>
      {copiesLine && <p className={`st-note${copies.state.endsWith("ailed") ? " bad" : ""}`}>{copiesLine}</p>}
      <div className="st-rows st-copies">
        {copies.list.map((b) => (
          <div className="st-row st-copy" key={b.device}>
            <span className="st-row-ico" aria-hidden>
              {b.own ? <ComputerIcon size={18} /> : <DevicesIcon size={18} />}
            </span>
            <div className="st-text">
              <div className="st-label">{deviceName(b)}</div>
              <div className="st-desc">{t("settings.driveCopiesSaved", { date: date.format(new Date(b.savedAt)) })}</div>
              {Date.now() - b.savedAt > STALE_BACKUP_MS && <div className="st-desc bad">{t("settings.driveCopiesStale")}</div>}
            </div>
            {!b.own && (
              <button className="st-row-btn" onClick={() => setTrashAsk(b)}>
                {t("settings.driveCopiesTrash")}
              </button>
            )}
          </div>
        ))}
      </div>
        {trashAsk && (
          <Confirm
            title={t("settings.driveCopiesTrashTitle")}
            message={t("settings.driveCopiesTrashMessage", { device: deviceName(trashAsk) })}
            confirmLabel={t("settings.driveCopiesTrash")}
            danger
            onCancel={() => setTrashAsk(null)}
            onConfirm={() => {
              const device = trashAsk.device;
              setTrashAsk(null);
              void copies.trash(device);
            }}
          />
        )}
    </>
  );
}

const TIER_KEYS: CompressionTier[] = ["high", "balanced", "small"];
const CODEC_KEYS: VideoCodecChoice[] = ["auto", "avc", "hevc", "av1", "keep"];
const CODEC_LABELS: Record<VideoCodecChoice, string> = { auto: "", avc: "H.264", hevc: "H.265", av1: "AV1", keep: "" };

/**
 * Compression on upload, as the phone's "Quality and size": a switch for photos and one for
 * videos, each with its quality, and for videos the codec, offered as far as this PC can write it.
 */
function UploadQualityPane({ settings, onChange }: { settings: AppSettings; onChange: (next: AppSettings) => void }) {
  const t = useT();
  const [encoders, setEncoders] = useState<VideoEncoders | null>(null);
  useEffect(() => {
    void invoke<VideoEncoders>("video_encoders").then(setEncoders, () => {});
  }, []);
  const can = (codec: VideoCodecChoice) =>
    codec === "auto" || codec === "keep" || (encoders ? encoders[codec] : codec === "avc");
  const codecName = (codec: VideoCodecChoice) =>
    codec === "auto" ? t("upload.codecAuto") : codec === "keep" ? t("upload.codecKeep") : CODEC_LABELS[codec];
  const resolved = resolveCodecShown(settings.compressCodec, encoders);
  const fallback =
    encoders && settings.compressCodec !== "auto" && settings.compressCodec !== "keep" && !can(settings.compressCodec)
      ? t("upload.codecFallback", { codec: codecName(settings.compressCodec), used: CODEC_LABELS[resolved] })
      : null;
  const reference = settings.compressVideoTier === "small" ? 720 : 1080;
  const perMinute = formatBytes(estimatePerMinute(resolved, settings.compressVideoTier));
  const tierSeg = (value: CompressionTier, pick: (next: CompressionTier) => void, label: string) => (
    <div className="st-seg" role="group" aria-label={label}>
      {TIER_KEYS.map((tier) => (
        <button
          key={tier}
          className={`st-seg-btn${value === tier ? " on" : ""}`}
          aria-pressed={value === tier}
          onClick={() => pick(tier)}
        >
          {t(`upload.tier.${tier}`)}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <p className="st-intro">{t("upload.compressIntro")}</p>
      <div className="st-rows">
        <label className="st-row">
          <span className="st-row-ico" aria-hidden>
            <ImageIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("upload.compressPhotos")}</div>
            <div className="st-desc">{t("upload.compressPhotosDesc")}</div>
          </div>
          <input
            className="st-switch"
            type="checkbox"
            checked={settings.compressPhotos}
            onChange={(e) => onChange({ ...settings, compressPhotos: e.currentTarget.checked })}
          />
        </label>
        {settings.compressPhotos && (
          <>
            <div className="st-row">
              <span className="st-row-ico" aria-hidden>
                <TuneIcon size={18} />
              </span>
              <div className="st-text">
                <div className="st-label">{t("upload.quality")}</div>
                <div className="st-desc">{t(`upload.tierPhotoDesc.${settings.compressTier}`)}</div>
              </div>
              {tierSeg(settings.compressTier, (next) => onChange({ ...settings, compressTier: next }), t("upload.quality"))}
            </div>
            <label className="st-row">
              <span className="st-row-ico" aria-hidden>
                <BrushIcon size={18} />
              </span>
              <div className="st-text">
                <div className="st-label">{t("upload.compressHdr")}</div>
                <div className="st-desc">{t("upload.compressHdrDesc")}</div>
              </div>
              <input
                className="st-switch"
                type="checkbox"
                checked={settings.compressHdr}
                onChange={(e) => onChange({ ...settings, compressHdr: e.currentTarget.checked })}
              />
            </label>
          </>
        )}
      </div>
      <div className="st-rows st-rows-gap">
        <label className="st-row">
          <span className="st-row-ico" aria-hidden>
            <PlayArrowIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("upload.compressVideos")}</div>
            <div className="st-desc">{t("upload.compressVideosDesc")}</div>
          </div>
          <input
            className="st-switch"
            type="checkbox"
            checked={settings.compressVideos}
            onChange={(e) => onChange({ ...settings, compressVideos: e.currentTarget.checked })}
          />
        </label>
        {settings.compressVideos && (
          <>
            <div className="st-row">
              <span className="st-row-ico" aria-hidden>
                <TuneIcon size={18} />
              </span>
              <div className="st-text">
                <div className="st-label">{t("upload.quality")}</div>
                <div className="st-desc">{t(`upload.tierVideoDesc.${settings.compressVideoTier}`)}</div>
                <div className="st-desc st-status">{t("upload.estimate", { size: perMinute, p: reference })}</div>
              </div>
              {tierSeg(settings.compressVideoTier, (next) => onChange({ ...settings, compressVideoTier: next }), t("upload.quality"))}
            </div>
            <div className="st-row">
              <span className="st-row-ico" aria-hidden>
                <ListIcon size={18} />
              </span>
              <div className="st-text">
                <div className="st-label">{t("upload.codec")}</div>
                <div className="st-desc">{t(`upload.codecHint.${settings.compressCodec}`)}</div>
                {fallback && <div className="st-desc bad">{fallback}</div>}
                <div className="st-seg st-seg-under" role="group" aria-label={t("upload.codec")}>
                  {CODEC_KEYS.map((codec) => (
                    <button
                      key={codec}
                      className={`st-seg-btn${settings.compressCodec === codec ? " on" : ""}`}
                      aria-pressed={settings.compressCodec === codec}
                      disabled={!can(codec)}
                      title={can(codec) ? undefined : t("upload.codecNotHere")}
                      onClick={() => onChange({ ...settings, compressCodec: codec })}
                    >
                      {codecName(codec)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      <p className="st-note">{t("upload.compressWhere")}</p>
    </>
  );
}

/** The encoders this PC has, as the host answers `video_encoders`. */
type VideoEncoders = { avc: boolean; hevc: boolean; av1: boolean };

/** The codec a choice comes to on this PC, as the sidecar resolves it: the next one down without an encoder. */
function resolveCodecShown(choice: VideoCodecChoice, encoders: VideoEncoders | null): "avc" | "hevc" | "av1" {
  const has = (c: "hevc" | "av1") => !!encoders?.[c];
  if (choice === "av1") return has("av1") ? "av1" : has("hevc") ? "hevc" : "avc";
  if (choice === "hevc" || choice === "auto") return has("hevc") ? "hevc" : "avc";
  return "avc";
}

/** About how much a minute of video takes at a level, at its reference size and 30 frames a second. */
function estimatePerMinute(codec: "avc" | "hevc" | "av1", tier: CompressionTier): number {
  const bpp = { high: { avc: 0.13, hevc: 0.088, av1: 0.072 }, balanced: { avc: 0.08, hevc: 0.056, av1: 0.048 }, small: { avc: 0.09, hevc: 0.065, av1: 0.054 } }[tier][codec];
  const pixels = tier === "small" ? 1280 * 720 : 1920 * 1080;
  return ((bpp * pixels * 30 + 128_000) * 60) / 8;
}

/** A backup on Drive not saved for this long is marked as left behind. */
const STALE_BACKUP_MS = 30 * 24 * 60 * 60 * 1000;

/** One device's files on Drive, as `driveBackups` lists them. */
type DriveBackup = { device: string; own: boolean; name: string | null; savedAt: number; files: string[] };

/**
 * The backups on Drive, device by device, read when the pane opens and again after each round of
 * the shared backup. A device moved to the trash leaves the list at once: Drive's listing can show
 * its files for a while after.
 */
function useDriveBackups(roundAt: number | null) {
  const [list, setList] = useState<DriveBackup[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed" | "trashFailed">("loading");
  const gone = useRef(new Set<string>());
  const read = useCallback(async () => {
    setState((s) => (s === "trashFailed" ? s : "loading"));
    try {
      const next = await rpc<DriveBackup[]>("driveBackups");
      setList(next.filter((b) => !gone.current.has(b.device)));
      setState((s) => (s === "trashFailed" ? s : "ready"));
    } catch {
      setState("failed");
    }
  }, []);
  useEffect(() => {
    void read();
  }, [read, roundAt]);
  const trash = useCallback(
    async (device: string) => {
      gone.current.add(device);
      setList((l) => l.filter((b) => b.device !== device));
      try {
        await rpc("driveBackupTrash", { device });
        setState("ready");
      } catch {
        gone.current.delete(device);
        setState("trashFailed");
        void read();
      }
    },
    [read],
  );
  return { list, state, trash };
}

/** The shared backup's status, read every few seconds while the pane is open. */
function useBackupStatus(): BackupStatus | null {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  useEffect(() => {
    let live = true;
    let timer = 0;
    const look = async () => {
      try {
        const next = await rpc<BackupStatus>("sharedBackupStatus");
        if (live) setStatus(next);
      } catch {
        /* shown as it last was */
      }
      if (live) timer = window.setTimeout(look, 2000);
    };
    void look();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);
  return status;
}

/**
 * The labels, as the phone's Labels page has them: one card with a field that searches the labels
 * and offers to make the one typed, and the list under it, each label with how many photos carry
 * it, a rename and a delete.
 */
function LabelsPane({
  settings,
  onChange,
  labels,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  labels?: { labels: LocalLabel[]; loaded: boolean; act: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const list = labels?.labels ?? [];
  const shown = matchingLabels(list, query);
  const typed = query.trim();
  const offerCreate = !!typed && !list.some((l) => sameLabel(l.name, typed));

  const create = () => {
    if (!typed) return;
    void labels?.act("labelCreate", { name: typed }).then(() => setQuery("")).catch(() => {});
  };
  const rename = () => {
    if (!renaming) return;
    const to = renaming.to.trim();
    const from = renaming.from;
    setRenaming(null);
    if (to && to !== from) void labels?.act("labelRename", { from, to }).catch(() => {});
  };

  return (
    <>
      <div className="st-rows">
        <label className="st-row">
          <span className="st-row-ico" aria-hidden>
            <LabelIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.driveLabels")}</div>
            <div className="st-desc">{t("settings.driveLabelsDesc")}</div>
          </div>
          <input
            className="st-switch"
            type="checkbox"
            checked={settings.driveLabels}
            onChange={(e) => onChange({ ...settings, driveLabels: e.currentTarget.checked })}
          />
        </label>
      </div>
      {settings.driveLabels && (
        <div className="st-labels">
          <div className="st-labels-field">
            <SearchIcon size={16} />
            <input
              value={query}
              maxLength={24}
              placeholder={t("labels.searchHint")}
              aria-label={t("labels.searchHint")}
              onChange={(e) => setQuery(e.currentTarget.value.replace(/,/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && offerCreate) create();
              }}
            />
          </div>
          <div className="st-labels-list">
            {offerCreate && (
              <button className="st-label-row st-label-new" onClick={create}>
                <PlusIcon size={16} />
                <span className="st-label-name">{t("labels.create", { name: typed })}</span>
              </button>
            )}
            {shown.map((label) =>
              renaming?.from === label.name ? (
                <div className="st-label-row" key={label.name}>
                  <LabelIcon size={16} />
                  <input
                    className="st-label-edit"
                    autoFocus
                    maxLength={24}
                    value={renaming.to}
                    aria-label={t("labels.rename")}
                    onChange={(e) => setRenaming({ ...renaming, to: e.currentTarget.value.replace(/,/g, "") })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") rename();
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                    onBlur={rename}
                  />
                </div>
              ) : (
                <div className="st-label-row" key={label.name}>
                  <LabelIcon size={16} />
                  <span className="st-label-name">{label.name}</span>
                  <span className="st-label-count">
                    {t(label.keys.length === 1 ? "common.photoCount.one" : "common.photoCount.other", {
                      count: label.keys.length,
                    })}
                  </span>
                  <button
                    className="st-label-act"
                    title={t("labels.rename")}
                    aria-label={t("labels.rename")}
                    onClick={() => setRenaming({ from: label.name, to: label.name })}
                  >
                    <PencilIcon size={15} />
                  </button>
                  <button
                    className="st-label-act"
                    title={t("labels.delete")}
                    aria-label={t("labels.delete")}
                    onClick={() => setDeleting(label.name)}
                  >
                    <TrashIcon size={15} />
                  </button>
                </div>
              ),
            )}
            {labels?.loaded && list.length === 0 && !offerCreate && <div className="st-labels-empty">{t("labels.none")}</div>}
            {list.length > 0 && typed && shown.length === 0 && !offerCreate && (
              <div className="st-labels-empty">{t("labels.searchEmpty")}</div>
            )}
          </div>
        </div>
      )}
      {deleting && (
        <Confirm
          title={t("labels.deleteTitle", { name: deleting })}
          message={t(settings.sharedBackup ? "labels.deleteMessageShared" : "labels.deleteMessage")}
          confirmLabel={t("labels.delete")}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const name = deleting;
            setDeleting(null);
            void labels?.act("labelDelete", { name }).catch(() => {});
          }}
        />
      )}
    </>
  );
}

/**
 * My files: whether the app may read its folders at all, and the way to bring the photos and
 * videos of chosen folders into Photos.
 */
function MyFilesPane({
  settings,
  onChange,
  onStart,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onStart?: (folders: { uid: string; name: string }[], files: ChosenFile[], move: boolean) => void;
}) {
  const t = useT();
  const [picking, setPicking] = useState(false);
  return (
    <>
      <div className="st-rows">
        <label className="st-row">
          <span className="st-row-ico" aria-hidden>
            <FolderOpenIcon size={18} />
          </span>
          <div className="st-text">
            <div className="st-label">{t("settings.myFilesAccess")}</div>
            <div className="st-desc">{t("settings.myFilesAccessDesc")}</div>
          </div>
          <input
            className="st-switch"
            type="checkbox"
            checked={settings.myFilesAccess}
            onChange={(e) => onChange({ ...settings, myFilesAccess: e.currentTarget.checked })}
          />
        </label>
        {settings.myFilesAccess && (
          <div className="st-row off">
            <span className="st-row-ico" aria-hidden>
              <CloudUploadIcon size={18} />
            </span>
            <div className="st-text">
              <div className="st-label">{t("settings.myFilesPick")}</div>
              <div className="st-desc">{t("settings.myFilesPickDesc")}</div>
            </div>
            <button className="st-row-btn" onClick={() => setPicking(true)}>
              {t("settings.myFilesPickAction")}
            </button>
          </div>
        )}
      </div>
      {picking && (
        <MyFilesPicker
          onClose={() => setPicking(false)}
          onStart={(folders, files, move) => {
            setPicking(false);
            onStart?.(folders, files, move);
          }}
        />
      )}
    </>
  );
}

/** What the report's header says about this app: its version and which features are on. */
function diagnosticsHeader(settings: AppSettings, version: string): string[] {
  const source = (pc: boolean, phone: boolean) => (pc ? "pc" : phone ? "phone" : "off");
  const on = (v: boolean) => (v ? "on" : "off");
  return [
    `App ${version || "-"}, language ${settings.lang}, theme ${settings.theme}`,
    `Settings: faces=${source(settings.localFaces, settings.driveFaces)}, search=${source(settings.semanticSearch && settings.localSearch, settings.semanticSearch)}, ` +
      `labels=${on(settings.driveLabels)}, shared backup=${on(settings.sharedBackup)}, my files=${on(settings.myFilesAccess)}, ` +
      `auto merge=${on(settings.faceAutoMerge)}, find more=${on(settings.faceFindMore)}, scan speed=${settings.scanSpeed ?? "auto"}, ` +
      `detailed logging=${on(settings.diagDetailed)}`,
  ];
}

/**
 * The diagnostics: copied, or saved as a text file, to send when something is wrong; and the
 * switch that has them note every step, not only the slow ones.
 */
function DiagnosticsRows({
  settings,
  onChange,
  version,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  version: string;
}) {
  const t = useT();
  const [state, setState] = useState<"" | "copied" | "saved" | "failed">("");
  const header = diagnosticsHeader(settings, version);

  async function copy() {
    try {
      const { text } = await rpc<{ text: string }>("diagReport", { header });
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  async function saveFile() {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `photos-for-proton-diagnostics-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    try {
      // Picked by the host, which is the only place a report may then be written to.
      const path = await invoke<string | null>("pick_diag_file", { defaultName: name, filterName: t("settings.diagnosticsFile") });
      if (!path) return;
      await rpc("diagSave", { path, header });
      setState("saved");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <div className="st-row">
        <span className="st-row-ico" aria-hidden>
          <ListIcon size={18} />
        </span>
        <div className="st-text">
          <div className="st-label">{t("settings.diagnostics")}</div>
          <div className="st-desc">{t("settings.diagnosticsDesc")}</div>
          {state && (
            <div className="st-desc st-status">
              {t(state === "copied" ? "settings.diagnosticsCopied" : state === "saved" ? "settings.diagnosticsSaved" : "settings.diagnosticsFailed")}
            </div>
          )}
        </div>
        <button className="st-row-btn" onClick={() => void copy()}>
          {t("settings.diagnosticsCopy")}
        </button>
        <button className="st-row-btn" onClick={() => void saveFile()}>
          {t("settings.diagnosticsSave")}
        </button>
      </div>
      <label className="st-row">
        <span className="st-row-ico" aria-hidden>
          <TuneIcon size={18} />
        </span>
        <div className="st-text">
          <div className="st-label">{t("settings.diagDetailed")}</div>
          <div className="st-desc">{t("settings.diagDetailedDesc")}</div>
        </div>
        <input
          className="st-switch"
          type="checkbox"
          checked={settings.diagDetailed}
          onChange={(e) => onChange({ ...settings, diagDetailed: e.currentTarget.checked })}
        />
      </label>
    </>
  );
}
