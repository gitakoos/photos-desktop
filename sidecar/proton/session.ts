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

// The authenticated Proton session: the browser sign-in, key unlock, and the
// Photos client.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { PhotoTag, ProtonDriveClient, ThumbnailType } from "@protontech/drive-sdk";
import sharp from "sharp";
import { ProtonDrivePhotosClient } from "@protontech/drive-sdk/dist/protonDrivePhotosClient.js";

import {
  CryptoProxy,
  computeKeyPassword,
  initCrypto,
  makeOpenPGPCryptoModule,
  makeSrpModule,
} from "./crypto.ts";
import {
  ProtonApi,
  makeSdkHttpClient,
  randomModulus,
  refreshSession,
  type Session,
} from "./api.ts";
import {
  ALBUM_MEMBERS_FILE,
  BACKUP_STATE_FILE,
  DRIVE_COPIES_DIR,
  SESSION_FILE,
  coverGet,
  coverPut,
  isReady,
  originalGet,
  originalSize,
  metaGet,
  metaPut,
  readSealedOrSetAside,
  rethrowLocked,
  setAsideVault,
  StoreLockedError,
  storeDir,
  thumbGet,
  thumbPut,
  wipeCache,
  writeSealedAtomic,
} from "./store.ts";
import {
  checkLocalLock,
  clearLocalLock,
  createDeviceVault,
  createVault,
  convertToDeviceVault,
  LOCAL_LOCK_FILE,
  localLockKind,
  lockVault,
  setLocalLock,
  unlockDeviceVault,
  unlockVault,
  vaultExists,
  vaultMode,
  type VaultMode,
} from "./vault.ts";
import { BrowserSignIn, type ForkApi, type ForkedSession } from "./browserLogin.ts";
import { BoundedCache } from "./boundedCache.ts";
import {
  ALBUM_ORDER_FOLDER,
  HIDDEN_FOLDER,
  LABELS_FOLDER,
  ML_FOLDER,
  SETTINGS_FOLDER,
  albumOrderFileName,
  facesFileName,
  hiddenFileName,
  labelsFileName,
  listDriveBackups,
  listOtherCopies,
  loadDriveData,
  otherFaceCopies,
  saveCopy,
  saveFaceCopy,
  searchFileName,
  sealEnvelope,
  settingsFileName,
  trashDriveFiles,
  writeAlbumOrderCopy,
  writeFaceCopy,
  writeHiddenCopy,
  writeLabelCopy,
  writeSearchCopy,
  writeSettingsCopy,
  type AlbumOrderCopy,
  type AlbumPhotoMode,
  type CopyCache,
  type DriveBackup,
  type DriveCollections,
  type DriveKinds,
  type HiddenCopy,
  type SearchSnapshot,
  type SettingsCopy,
} from "./driveData.ts";
import { encodeText, rank, SEARCH_MODEL_ID } from "./semantic.ts";
import { themeIndex, type ThemeSnapshot } from "./themes.ts";
import { deviceLabel, faceScanner } from "./faceScan.ts";
import { installDeviceId } from "./deviceId.ts";
import { keepDeviceNames, keepSeenRevisions, newerThanSeen, readBackupFlags, settingsReadBackDone, writeBackupFlags } from "./backupFlags.ts";
import { labelStore, labelsForDrive, rekeyLabels, takeInLabels } from "./labelStore.ts";
import { rekeyPeople } from "./facePeople.ts";
import { cloudCompressor, type CompressStatus } from "./cloudCompress.ts";
import { sweepCompressionTemp } from "./compression.ts";
import { gifBegin, gifCancel, gifFinish, gifFrame } from "./gif.ts";
import {
  dateEditInfo as readDateEditInfo,
  dateEditor,
  metaInfo as readMetaInfo,
  type DateEditInfo,
  type DateEditItem,
  type DateEditStatus,
  type MetaInfo,
} from "./dateEdit.ts";
import {
  editDownloadDir,
  EditorDownloads,
  saveEditedMedia as runSaveEditedMedia,
  videoEditSourceInfo,
  type SaveEditInput,
  type VideoEditSource,
} from "./videoEdit.ts";
import { clearSignOutHold, readSignOutHold, writeSignOutHold } from "./signOutHold.ts";
import { SavedCopies, SharedBackup, type BackupKind, type BackupStatus, type SignOutSave } from "./sharedBackup.ts";
import { checkMyFolders, listMyFolder, type MyFolderListing } from "./myFilesImport.ts";
import { diag } from "./diag.ts";
import { tokenTag, withSessionLock } from "./sessionLock.ts";
import { duplicateFinder, listingSettled, withListingTap, type DuplicateStatus, type ShownGroups } from "./duplicates.ts";
import { LibraryIndex, photoRootHashKey } from "./importMatch.ts";
import { ocrModelStatus, readText, type OcrResult, type OcrStage } from "./ocr.ts";
import { hiddenStore, type HiddenKind, type HiddenState } from "./hidden.ts";
import { settingsSyncStore } from "./settingsSync.ts";
import { albumOrderStore, linkOf as albumLinkOf, type AlbumOrderView } from "./albumOrder.ts";
import { isTransient, withRetry } from "./transient.ts";
import { activeRevisionOf, nodeDurationMs, nodeLocation, nodeName, toMillis } from "./nodes.ts";
import { isStall, SDK_STALL_MS, withStallGuard } from "./stallGuard.ts";
import { startThumbServer, stopThumbServer } from "./thumbServer.ts";
import { FaceCovers } from "./faceCover.ts";
import { MAX_STREAMED_VIDEO, NOT_STREAMABLE, OpenVideos, startVideo, videoFromBytes, type VideoAnswer } from "./videoStream.ts";
import { accountMatch, recordAccountKeys, recordedAccountKeys } from "./accountSwitch.ts";
import { hostNotice } from "./hostCall.ts";
import { NotReadyError, PhotoEvents, sealedAnchorStore, type FeedEvent } from "./photoEvents.ts";
import { openDownloader } from "./downloadSlots.ts";
import { failureOf, missFor, onTheWay, type ScanMiss } from "./scanMisses.ts";
import {
  cancelHydrate as stopHydrate,
  getOriginal as readOriginal,
  getSaveStatus as readSaveStatus,
  getVideo as readVideo,
  hydrateFile as runHydrateFile,
  hydrateProgress as readHydrateProgress,
  listForMount as readMountPage,
  mountFates as readMountFates,
  mountDigests as readMountDigests,
  type MountFate,
  readOriginalBytes as takeOriginalBytes,
  releaseOriginal as dropOriginal,
  resetDownloadState,
  resolveDurationsBatch,
  resolveMediaTypesBatch,
  resolveMountMetaBatch,
  startHydrate as beginHydrate,
  startSaveOriginals as runSaveOriginals,
  viewedOriginal,
  withMediaExtension,
  type HydratedFile,
  type MountPage,
  type OriginalStatus,
  type SaveStatus,
  type VideoBytes,
  MAX_INMEMORY_VIDEO,
} from "./download.ts";
import { CameraFactsJobs, downloadWhole, localMotionClip, motionClipOf, type CameraFactsReply, type ClipBytes } from "./viewerMeta.ts";
import {
  cloudEditorSource as runCloudEditorSource,
  joinSourceAlbum,
  saveCloudEdit as runSaveCloudEdit,
  type CloudEditMeta,
  type CloudEditorSource,
} from "./editor.ts";
import {
  addToOfflineAlbum,
  isOfflineReady,
  isPinned,
  noteOfflineTimes,
  offlineLibrary,
  offlineAlbums as readOfflineAlbums,
  offlineStatus as readOfflineStatus,
  setAlbumOffline,
  pinOffline as runPinOffline,
  resetOfflineState,
  unpinAllOffline as runUnpinAllOffline,
  unpinOffline as runUnpinOffline,
  type OfflineStatus,
} from "./offline.ts";
import {
  cancelUpload as abortUpload,
  clearFinishedUploads as clearUploads,
  getUploadStatusView as readUploadStatus,
  startUpload as runUpload,
  startImport as runImport,
  startMyFilesImport as runMyFilesImport,
  isMediaName,
  prepareImport as runPrepareImport,
  getImportReview as readImportReview,
  getImportChecks as readImportChecks,
  importThumbnails as readImportThumbnails,
  confirmImport as runConfirmImport,
  discardImport as runDiscardImport,
  startDropUpload as runDropUpload,
  takeDropReplaced,
  type ShellMediaInfo,
  type UploadStatus,
} from "./upload.ts";
import {
  countTrashed,
  deletePhotosForever as runDeleteForever,
  emptyTrash as runEmptyTrash,
  listTrashed as readTrash,
  TrashListing,
  restorePhotos as runRestore,
  type TrashItem,
  type TrashResult,
} from "./trash.ts";
import {
  acceptInvitation as runAcceptInvitation,
  declineInvitation as runDeclineInvitation,
  getSharingInfo as readSharingInfo,
  invitePeople as runInvitePeople,
  listInvitations as runListInvitations,
  removePerson as runRemovePerson,
  removePublicLink as runRemovePublicLink,
  setPublicLink as runSetPublicLink,
  stopSharing as runStopSharing,
  type Invitation,
  type PublicLinkOptions,
  type SharingInfo,
} from "./sharing.ts";
import {
  addPhotosToAlbum as runAddToAlbum,
  createAlbum as runCreateAlbum,
  deleteAlbum as runDeleteAlbum,
  listAlbumPhotoUids as readAlbumPhotoUids,
  listAlbumPhotos as readAlbumPhotos,
  listAlbums as readAlbums,
  listAlbumsForMount as readAlbumsForMount,
  removePhotosFromAlbum as runRemoveFromAlbum,
  renameAlbum as runRenameAlbum,
  setAlbumCover as runSetAlbumCover,
  type AlbumMount,
  type AlbumPhoto,
  type AlbumResult,
  type AlbumSummary,
  type DeleteAlbumOutcome,
} from "./albums.ts";

/** One photo in the Linux drive's extra folders, named and sized as its main listing is. */
type MountPhoto = { uid: string; name: string; size: number; captureTime: number };

/** The drive's folders beside the library: the trash, and what others shared. */
export type MountExtras = {
  trash: MountPhoto[];
  shared: MountPhoto[];
  sharedAlbums: { uid: string; name: string; photos: MountPhoto[] }[];
};

// The signed-in Proton session is sealed with the vault key, so it is named by the
// store: `wipeCache` has to take it along when that key changes.
//
// The vault verifier/salt file (must match vault.ts META_FILE). Removed on
// sign-out so the account is fully forgotten.
const VAULT_META_FILE = "vault.json";
// Mount state the Rust host keeps in this same directory (names must match
// cloud_mount.rs). Sealed there under the host's own key, but still per-account,
// so sign-out takes it with the rest: left behind, one account's uid list makes
// every photo in the next one look new, which is a whole-library download.
const HOST_STATE_FILES = [
  "mount_seen.txt",
  "synced_albums.txt",
  "mount_mode.txt",
  "mount_kept.txt",
  "mount_freed.txt",
  "mount_pending.txt",
  "mount_held.txt",
  "mount_untrashed.txt",
];
// What an internal-only key lookup answers for an address with no Proton account.
const NO_SUCH_PROTON_ADDRESS = 33102;

const toDataUrl = (bytes: Buffer): string => `data:image/jpeg;base64,${bytes.toString("base64")}`;

/**
 * How long a thumbnail walk may produce NOTHING before it is given up on.
 *
 * Generous against the work it guards and tight against the failure: a healthy
 * batch of eight is milliseconds (the slowest in a full production trace was 216ms),
 * while the hang this exists for ran until the host killed the sidecar at 300s.
 * Anything in between is comfortably covered.
 *
 * It stays well under the frontend's own 3-minute ceiling for this call
 * (app/src/lib/rpc.ts) and the host's 5-minute one (deadline_for in lib.rs), so the
 * graceful inner bound is always what fires -- the outer two recover by abandoning
 * the call and killing the sidecar respectively, which costs the user their whole
 * session state to fix a handful of missing thumbnails.
 */
const THUMBNAIL_STALL_MS = 30_000;

/** Originals downloading at once for the scan, unless its speed asks for another number. */
const SCAN_DOWNLOADS_AHEAD = 4;
const SCAN_DOWNLOADS_MAX = 8;

/** How long the picker's knowledge of which folders hold photos is kept. */
const MY_FOLDERS_FRESH_MS = 10 * 60_000;

/** The largest original the scan reads into memory; a larger one is read from its preview. */
const SCAN_ORIGINAL_MAX_BYTES = 200 * 1024 * 1024;

/** An original that grew past `SCAN_ORIGINAL_MAX_BYTES` while it downloaded. */
class ScanTooLarge extends Error {}

/** One photo as the scan gets it: its bytes, or why there are none. */
type ScanPicture = { uid: string; bytes: Buffer | null; miss?: ScanMiss };

/** Photo types this side cannot decode, read from their large preview instead. */
const PREVIEW_ONLY_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);

/** Whether the decoder can read these bytes at all; a RAW file and the like cannot. */
async function decodable(bytes: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(bytes, { failOn: "none" }).metadata();
    return !!meta.width && !!meta.height && meta.format !== "heif";
  } catch {
    return false;
  }
}
/** How many uncached grid thumbnails one call fetches; the rest are asked for again. */
const THUMBNAIL_FETCH_PER_CALL = 8;
/** The background warmer's share of one call: it must never hold the channel long
 *  enough for a thumbnail on screen, or a page being opened, to wait on it. */
const THUMBNAIL_WARM_PER_CALL = 2;

/**
 * How many entries the SDK may keep before its cache starts over: nodes as serialised
 * text, and decrypted keys, which weigh more. Enough for the albums and the folders a
 * session works in to stay warm; a walk over a whole large library starts the cache over
 * now and then instead of holding every photo's key at once.
 */
const ENTITY_CACHE_LIMIT = 50_000;
/** The pauses between asking again to resume a saved session over a network not yet up. */
const RESUME_RETRY_MS = [2_000, 5_000];
/** Proton's answer to a refresh token it has already swapped for a new one. */
const INVALID_REFRESH_TOKEN = 10013;

/**
 * How often an open app asks Proton whether its session still stands, with the smallest request
 * there is. Ended elsewhere (a stolen laptop's session removed from the account, a password
 * change), the window then goes to the sign-in within this long, even while nobody uses it.
 */
const SESSION_CHECK_MS = 60_000;
const SESSION_CHECK_URL = "https://drive-api.proton.me/core/v4/events/latest";
/** Nodes read per request while the map gathers places, so no one request grows unbounded. */
const LOCATION_BATCH = 500;
/** The most timeline items one answer carries. */
const TIMELINE_CEILING = 1_000_000;
const CRYPTO_CACHE_LIMIT = 20_000;
/** How many photos' read text is kept, for going back to one of them. */
const OCR_KEPT = 40;
/** A read ahead waits this long for a newer one to start before it fetches its photo. */
const OCR_SETTLE_MS = 250;
/** Photo fetches for reads at once: the newest never waits on a single stale one. */
const OCR_FETCHES_AT_ONCE = 2;
/** A read's fetch that has not answered in this long is given up. */
const OCR_FETCH_GIVE_UP_MS = 3 * 60 * 1000;
/** How long a face scan waits for the window's read of the timeline before reading its own. */
const SCAN_WAITS_FOR_TIMELINE_MS = 3 * 60_000;
/** How long a session's first scan waits for the window's read to begin. */
const SCAN_WAITS_FOR_RUN_TO_START_MS = 15_000;
/** How old a window's read may be (from its start) for a scan to take it. */
const SCAN_REUSES_TIMELINE_FOR_MS = 10 * 60_000;
/** Albums shared with this account listed at once for the drive's folder. */
const MOUNT_ALBUMS_AT_ONCE = 3;
/** A copy's save that fails on the network is tried again after these pauses. */
const UPLOAD_RETRY_MS = [2_000, 5_000];

/** The shortest password of the user's own that a browser sign-in may be sealed with. */
const MIN_APP_PASSWORD = 8;

/** Proton's session-fork endpoints, as the browser sign-in sees them. */
const forkApi: ForkApi = {
  async init() {
    const r: any = await ProtonApi.forkInit();
    if (!r.Selector || !r.UserCode) throw new Error("Proton returned no sign-in code");
    return { selector: String(r.Selector), userCode: String(r.UserCode) };
  },
  async status(selector) {
    let r: any;
    try {
      r = await ProtonApi.forkStatus(selector);
    } catch (e: any) {
      // 422 is the fork's "not signed in yet".
      if (e?.status === 422) return null;
      throw e;
    }
    if (!r.UID || !r.AccessToken || !r.Payload) throw new Error("Proton's sign-in answer is incomplete");
    return {
      payload: String(r.Payload),
      uid: String(r.UID),
      accessToken: String(r.AccessToken),
      refreshToken: String(r.RefreshToken ?? ""),
    };
  },
  async discard(selector) {
    await ProtonApi.forkDiscard(selector);
  },
};

type SharedSummary = {
  uid: string;
  name: string;
  type: string;
  mediaType: string | null;
  isShared: boolean;
  isSharedPublicly: boolean;
  captureTime: number | null;
  /**
   * The album fields, null on a photo. A shared album is an album first and a
   * shared thing second, so it gets the same three facts the albums screen shows:
   * without them it can only be drawn as a bare tile.
   *
   * The cover uid is stamped with the owner's volume, not the reader's, which is
   * what makes it resolvable at all from here.
   */
  coverUid: string | null;
  photoCount: number | null;
  lastActivityTime: number | null;
};

type NodeMeta = { uid: string; name: string; mediaType: string | null; size?: number | null };

type TimelineItem = { uid: string; captureTime: number; tags: number[] };
/** One copy-text read: `unavailable` when the models are not on this computer. */
type OcrJob = { state: "working" | "done" | "failed" | "unavailable"; stage: OcrStage | null; result: OcrResult | null };

/** The picture formats a file on this computer is read for text from. */
const OCR_FILE_TYPES = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif)$/i;
/** The largest picture file read for text. */
const OCR_FILE_MAX_BYTES = 200 * 1024 * 1024;

async function readPictureFile(path: string): Promise<Buffer | null> {
  if (!OCR_FILE_TYPES.test(path)) return null;
  try {
    const { stat, readFile } = await import("node:fs/promises");
    const info = await stat(path);
    if (!info.isFile() || info.size > OCR_FILE_MAX_BYTES) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}
/** `offline`: only the photos kept on this computer, read while Proton could not be reached. */
type TimelineRun = {
  id: number;
  items: TimelineItem[];
  done: boolean;
  error: string | null;
  offline?: boolean;
  /** When it began reading (ms): a photo added later may be missing from it. */
  startedAt?: number;
  /** Settles once the read stops, finished or replaced. */
  ended?: Promise<void>;
};
type TimelinePage = { items: TimelineItem[]; done: boolean; error: string | null };

type LoginResult =
  | { status: "ok"; email: string }
  /** Signed in through the browser; the user still picks how this machine keeps it. */
  | { status: "protect"; email: string; switched?: boolean }
  /** The vault opened, but its session is gone: a new sign-in, into the same vault. */
  | { status: "relogin" }
  /** The saved session could not be checked because Proton could not be reached. With `email`, the
   *  account is open on the photos kept offline (`kept` of them) until Proton answers again. */
  | { status: "offline"; email?: string; kept?: number }
  | { status: "error"; error: string };

type BrowserLoginStatus = LoginResult | { status: "waiting" } | { status: "cancelled" };

type AccountAddress = {
  email: string;
  addressId: string;
  primaryKeyIndex: number;
  keys: { id: string; key: any }[];
};

/**
 * What we persist (encrypted) so a cold start can resume without a full re-login.
 * It carries the derived key passphrases, mirroring the SDK's own session-secret
 * cache. The account password itself is never part of this.
 */
type PersistableSession = {
  uid: string;
  accessToken: string;
  refreshToken: string;
  username: string;
  userKeyPassphrases: Record<string, string>;
  /** How it was signed in; absent from a session saved before the browser sign-in. */
  method?: "password" | "browser";
  /** The account's address, shown while Proton cannot be reached; absent from older sessions. */
  email?: string;
};

/**
 * Whether the app has a saved account, and (only while unlocked) whose. `mode` is how
 * the vault opens; `protect` that a browser sign-in waits for the user to pick one.
 */
type LockStatus = {
  hasVault: boolean;
  unlocked: boolean;
  email: string | null;
  mode: VaultMode | null;
  protect: boolean;
};

export class ProtonSession {
  private session: Session | null = null;
  private username = "";
  private email = "";
  private password = "";
  /** Derived key passphrases by user key id. Persisted in place of the password. */
  private userKeyPassphrases: Record<string, string> = {};
  /** The key password a browser sign-in delivers, in place of the account password. */
  private keyPassword = "";
  private method: "password" | "browser" = "password";
  /**
   * Opened from a session that was signed in with the Proton password, which this app no
   * longer asks for: the user picks once how the app opens from now on (`keepSignIn`).
   */
  private legacySignIn = false;
  /** The user keys of the account whose session lapsed, while its sign-in again is awaited. */
  private reloginKeys: string[] | null = null;
  /** Set when a sign-in again turned out to be another account, whose leftovers then went. */
  private switchedAccount = false;
  /** The minute-by-minute session check, started with the first signed-in account. */
  private sessionWatch: ReturnType<typeof setInterval> | null = null;
  /** The signed-in account's http client, which the session check asks through. */
  private sessionClient: ReturnType<typeof makeSdkHttpClient> | null = null;
  private browser: BrowserSignIn | null = null;
  private browserFinish: Promise<LoginResult> | null = null;
  /** A browser sign-in is open but not yet saved: the user has not picked a protection. */
  private awaitingProtection = false;
  /**
   * The vault is open but its session could not be resumed for want of a network: the
   * password that opened it, kept until `retryResume` gets through or the app locks.
   */
  private offlineResume: string | null = null;
  /**
   * The resume under way, if any. A second one would spend the same refresh token while
   * the first is still using it, and Proton answers one of the two with a sign-in.
   */
  private resuming: Promise<LoginResult> | null = null;
  /**
   * The refresh token the saved session held when this process last read or wrote it. A
   * saved token that is neither this nor the one in memory was written by another process
   * since, and is the newer one; a saved token equal to it only missed our last save.
   */
  private savedRefresh: string | null = null;
  /** How a retry run in the background came out, kept for the window's next ask. */
  private retried: LoginResult | null = null;
  /** What both Drive clients are built from, kept for the My files one built on first use. */
  private sdkBase: Record<string, unknown> | null = null;
  /** The client for My files, where the Android app keeps its copies of people and labels. */
  private myFiles: any = null;
  /** Its decrypted keys, shared with the client each shared-backup round opens. */
  private myFilesKeys: BoundedCache<any> | null = null;
  /** Those copies, read once a session and again only when asked, with the kinds they cover. */
  private driveCollections: { kinds: string; run: Promise<DriveReply> } | null = null;
  /** The search copies the last read brought, in the text encoder's space. */
  private searchCopies: SearchSnapshot[] = [];
  /** Which folders of My files hold photos, as the picker found, and since when. */
  private myFoldersKnown = new Map<string, boolean>();
  private myFoldersAt = 0;
  /** What the shared backup reads from Drive each round: the kinds the window shows. */
  private backupKinds: DriveKinds | null = null;
  /** The kinds a read takes in: the window's, or before it named them, the faces and the labels. */
  private get readKinds(): DriveKinds {
    return this.backupKinds ?? { faces: true, labels: true, search: false, faceData: false };
  }
  /** The labels' version their copy on Drive was made from. */
  private savedLabelsVersion = -1;
  /** The hidden list's version its copy on Drive was made from. */
  private savedHiddenVersion = -1;
  /** The settings' version their copy on Drive was made from. */
  private savedSettingsVersion = -1;
  /** The last read took in every settings copy there was, so this computer's may be written over theirs. */
  private settingsReadOk = false;
  /** The album orders' version their copy on Drive was made from. */
  private savedAlbumOrderVersion = -1;
  /** The last read took in every album-order copy there was, as `settingsReadOk` for the settings. */
  private albumOrderReadOk = false;
  private readonly savedCopies = new SavedCopies(
    () => {
      try {
        return JSON.parse(readSealedOrSetAside(join(storeDir(), BACKUP_STATE_FILE))?.toString("utf8") ?? "{}");
      } catch (e) {
        rethrowLocked(e);
        return {};
      }
    },
    (saved) => writeSealedAtomic(join(storeDir(), BACKUP_STATE_FILE), Buffer.from(JSON.stringify(saved), "utf8")),
  );
  /** The Drive data files moved to the trash from here, which a listing can still show for a while. */
  private readonly trashedCopies = new Set<string>();
  /** The app's folder in My files, as the last look at the listings found it. */
  private backupAppUid: string | null = null;
  readonly backup = new SharedBackup(
    // Read every round, so nothing is written over this computer's copies before they were read.
    async () => {
      const read = await this.getDriveCollections(true, this.readKinds);
      return { unreadable: read.unreadable, held: read.ownUnreadable };
    },
    () => [
      {
        kind: "faces",
        // This install's own copy is not written over before it was taken in: after a sign-out it
        // holds the names this computer gave, which an empty store here would wipe from Drive. A
        // delete everywhere made here is written whatever it holds.
        dirty: (all) => {
          const flags = readBackupFlags();
          return flags.trashPending || ((flags.ownTaken || faceScanner.takesCopies()) && faceScanner.facesDirty(all));
        },
        save: async (all) => {
          const wrote = await faceScanner.saveFaces(all);
          await this.trashOtherFaceCopies();
          return wrote;
        },
      },
      { kind: "search", dirty: (all) => faceScanner.searchDirty(all), save: (all) => faceScanner.saveSearch(all) },
      { kind: "labels", dirty: (all) => this.labelsDirty(all), save: (all) => this.saveLabels(all) },
      { kind: "hidden", dirty: (all) => this.hiddenDirty(all), save: (all) => this.saveHidden(all) },
      {
        kind: "settings",
        dirty: (all) => this.settingsDirty(all),
        save: (all) => this.saveSettings(all),
        // A choice made here is not on Drive also while a failed read keeps it from being written.
        unsaved: () => settingsSyncStore.version !== this.savedSettingsVersion && settingsSyncStore.hasStamps(),
      },
      {
        kind: "albumOrder",
        dirty: (all) => this.albumOrderDirty(all),
        save: (all) => this.saveAlbumOrder(all),
        unsaved: () => albumOrderStore.version !== this.savedAlbumOrderVersion && !albumOrderStore.isEmpty(),
      },
    ],
    undefined,
    () => this.anythingNewOnDrive(),
  );
  private photos: any = null;
  /** Which sign-in a pending-step timer belongs to; a newer attempt disarms older ones. */
  private attempt = 0;

  /** Opens a sign-in on Proton's own page; the link for the browser comes back. */
  async startBrowserLogin(): Promise<{ url: string }> {
    initCrypto();
    this.attempt++;
    this.browser?.cancel();
    this.browserFinish = null;
    const signIn = new BrowserSignIn(forkApi);
    this.browser = signIn;
    return { url: await signIn.start() };
  }

  /**
   * Where the browser sign-in stands. Once Proton answers, the account opens here, the
   * same way a password sign-in finishes; asked again meanwhile, the same answer comes.
   */
  async browserLoginStatus(nudge = false): Promise<BrowserLoginStatus> {
    const signIn = this.browser;
    if (nudge) signIn?.checkNow();
    if (!signIn) return this.browserFinish ?? { status: "cancelled" };
    const s = signIn.state();
    if (s.state === "waiting") return { status: "waiting" };
    if (s.state === "cancelled") return { status: "cancelled" };
    if (s.state === "failed") {
      this.browser = null;
      return { status: "error", error: s.error };
    }
    this.browserFinish ??= this.openForked(s.session);
    const result = await this.browserFinish;
    // The switch is told once: the host empties the previous account's folder on hearing it, and
    // a second ask arriving after the new account's fill must not empty that one.
    if (result.status === "protect" && result.switched) {
      this.browserFinish = Promise.resolve({ status: "protect", email: result.email });
    }
    return result;
  }

  cancelBrowserLogin(): { ok: boolean } {
    this.browser?.cancel();
    this.browser = null;
    this.browserFinish = null;
    return { ok: true };
  }

  private async openForked(forked: ForkedSession): Promise<LoginResult> {
    this.session = { uid: forked.uid, accessToken: forked.accessToken, refreshToken: forked.refreshToken };
    this.username = "";
    this.password = "";
    this.keyPassword = forked.keyPassword;
    this.method = "browser";
    this.userKeyPassphrases = {};
    const result = await this.finishFreshLogin();
    this.browser = null;
    if (result.status !== "ok") {
      this.session = null;
      return result;
    }
    // A vault already open (a sign-in again after the session lapsed) keeps it; a
    // first one waits for the user to choose how it is sealed.
    if (isReady()) return result;
    this.awaitingProtection = true;
    const switched = this.switchedAccount;
    this.switchedAccount = false;
    return switched ? { status: "protect", email: result.email, switched } : { status: "protect", email: result.email };
  }

  /**
   * Seals a browser sign-in on this machine: under a password of the user's own,
   * asked at every start, or under none, so this Windows account alone opens it.
   */
  protectSession(password: string | null): LoginResult {
    if (!this.awaitingProtection || !this.photos) return { status: "error", error: "No sign-in is waiting" };
    if (password !== null && password.length < MIN_APP_PASSWORD) {
      return { status: "error", error: "too short" };
    }
    const earlier = vaultExists() ? this.reopenOwnVault(password) : null;
    if (earlier === "kept") {
      // The earlier vault opened with what was chosen and belongs to this account, or nothing says
      // it does not: it is kept, with all it holds.
      diag.log("session", "vault_kept");
    } else {
      if (earlier === "different") {
        // Another account's: it goes, as at sign-out.
        wipeCache();
      } else if (earlier === "closed") {
        // It did not open with what was chosen (a keyring that lost its key, a password not given
        // again): set aside whole rather than deleted, for the one that opens it.
        setAsideVault([VAULT_META_FILE]);
      }
      diag.log("session", "vault_new", { earlier: earlier ?? "none" });
      if (password !== null) createVault(password);
      else createDeviceVault();
    }
    this.awaitingProtection = false;
    this.browserFinish = null;
    this.persistSession();
    this.attachFaceScan();
    this.photoEvents.start();
    return { status: "ok", email: this.email };
  }

  /**
   * Opens the vault already on this PC with the protection just chosen (its password, or this
   * Windows account for one that needs none), and keeps it open when it is this account's or
   * nothing says it is another's ("kept"). "different" for another account's, "closed" when it
   * did not open; the vault is locked again in both.
   */
  private reopenOwnVault(password: string | null): "kept" | "different" | "closed" {
    const mode = vaultMode();
    const opened = password === null ? mode === "device" && unlockDeviceVault() : mode === "password" && unlockVault(password);
    if (!opened) return "closed";
    let match: ReturnType<typeof accountMatch>;
    try {
      match = accountMatch(recordedAccountKeys(), Object.keys(this.userKeyPassphrases));
    } catch {
      match = "unknown";
    }
    if (match === "different") {
      lockVault();
      return "different";
    }
    return "kept";
  }

  /** The key ids recorded beside the session, or none when they cannot be read. */
  private recordedKeys(): string[] {
    try {
      return recordedAccountKeys();
    } catch {
      return [];
    }
  }

  /**
   * Whether this session was signed in with the Proton password, and so still waits for the
   * user to pick how the app opens from now on. Only while the account is open.
   */
  signInChoice(): { legacy: boolean; mode: VaultMode | null } {
    const open = !!this.photos && isReady();
    return { legacy: open && this.legacySignIn, mode: vaultMode() };
  }

  /**
   * The pick of a user signed in with the Proton password, which this app no longer asks for:
   * `device` opens the app with this Windows account from now on (Windows Hello is a setting
   * on top), `password` keeps the password that opens it now. Either way the vault keeps its
   * key, so nothing is downloaded or indexed again, and the session counts as a browser
   * sign-in from here on: a lapsed one is signed in again on Proton's page.
   */
  keepSignIn(choice: "device" | "password"): { ok: boolean; mode: VaultMode | null } {
    if (!this.photos || !isReady() || !this.legacySignIn) return { ok: false, mode: vaultMode() };
    if (choice === "device" && vaultMode() === "password" && !convertToDeviceVault()) {
      return { ok: false, mode: vaultMode() };
    }
    this.method = "browser";
    this.keyPassword = Object.values(this.userKeyPassphrases)[0] ?? "";
    this.legacySignIn = false;
    this.persistSession();
    return { ok: true, mode: vaultMode() };
  }

  /**
   * The live session inside this sidecar process. A WebView reload throws away
   * the UI but not this process, so the app can pick the session back up without
   * spending the stored refresh token.
   */
  whoami(): { email: string } | null {
    return this.photos && this.email && !this.awaitingProtection ? { email: this.email } : null;
  }

  /**
   * Account identity and Drive storage use, for the avatar and profile menu.
   * Proton reports Drive-specific space separately on newer plans, so prefer it
   * and fall back to the account-wide figures.
   */
  async getAccountInfo(): Promise<{
    email: string;
    displayName: string;
    initial: string;
    usedSpace: number;
    maxSpace: number;
  }> {
    if (!this.session) throw new Error("Not signed in");
    const res: any = await ProtonApi.getUser(this.session);
    const user = res.User ?? {};

    const used = Number(user.UsedDriveSpace) || Number(user.UsedSpace) || 0;
    const max = Number(user.MaxDriveSpace) || Number(user.MaxSpace) || 0;
    const displayName: string = user.DisplayName || user.Name || this.email || this.username;

    return {
      email: this.email || user.Email || "",
      displayName,
      initial: (displayName.trim()[0] ?? "?").toUpperCase(),
      usedSpace: used,
      maxSpace: max,
    };
  }

  /**
   * Whether a saved account exists and whether it is unlocked in this process.
   * A cold start reports `hasVault: true, unlocked: false`; the UI then shows the
   * lock screen. The email is only known once unlocked, so it stays null before.
   */
  lockStatus(): LockStatus {
    const unlocked = isReady();
    return {
      hasVault: vaultExists(),
      unlocked,
      email: unlocked && this.email ? this.email : null,
      mode: vaultMode(),
      protect: this.awaitingProtection,
    };
  }

  /**
   * Cold-start unlock: derive the vault key from the password, decrypt the saved
   * session, resume it, and unlock the Proton keys with the same password. A
   * wrong password sets no key and reveals nothing (see `unlockVault`).
   */
  /** What Hidden and the app lock ask for where no Windows Hello answers (see `vault.ts`). */
  localLockState(): { kind: "vault" | "own" | "none" } {
    return { kind: localLockKind() };
  }

  localLockCheck(password: string): { ok: boolean } {
    return { ok: typeof password === "string" && password.length > 0 && checkLocalLock(password) };
  }

  localLockSet(password: string, current?: string): { ok: boolean } {
    return { ok: typeof password === "string" && setLocalLock(password, typeof current === "string" ? current : undefined) };
  }

  localLockClear(current: string): { ok: boolean } {
    return { ok: typeof current === "string" && clearLocalLock(current) };
  }

  async unlock(password: string): Promise<LoginResult> {
    if (!vaultExists()) return { status: "error", error: "No saved account" };
    if (!unlockVault(password)) return { status: "error", error: "wrong password" };
    return this.resumeSaved(password);
  }

  /**
   * The people, labels and search index the Android app saved to Drive, as far as `kinds`
   * asks: people and labels as one list each, with photos named by their link id, and how
   * many photos the search can reach. Read once a session; `refresh` looks again, and only a
   * copy whose revision changed on Drive is downloaded again.
   */
  getDriveCollections(refresh: boolean, kinds: DriveKinds): Promise<DriveReply> {
    if (!this.sdkBase) return Promise.reject(new Error("Not signed in"));
    const key = `${kinds.faces}:${kinds.labels}:${kinds.search}:${!!kinds.faceData}`;
    if (refresh || !this.driveCollections || this.driveCollections.kinds !== key) {
      const client = this.backupClient();
      const own = installDeviceId();
      // After a fresh install or a sign-out, the files under this install's id hold what an
      // earlier install on this PC saved: read like another device's until a round has read them all.
      const readBack = !readBackupFlags().ownTaken;
      // The other devices' hidden lists are always read: what is hidden on one is hidden on all.
      // The settings only while the shared backup is on: off, they are neither read nor written.
      const settings = this.backup.getStatus().on;
      // This install's own settings copy is read back by its own flag, set once it was taken in.
      const settingsReadBack = settings && !readBackupFlags().settingsOwnTaken;
      // The album orders ride the same switch, with their own read-back flag.
      const albumOrderReadBack = settings && !readBackupFlags().albumOrderOwnTaken;
      const reading = {
        ...kinds,
        hidden: true,
        settings,
        albumOrder: settings,
        ownDeviceId: own,
        readBack,
        settingsReadBack,
        albumOrderReadBack,
        trashed: this.trashedCopies,
      };
      this.settingsReadOk = false;
      this.albumOrderReadOk = false;
      const run = diag
        .time("drive", "read_copies", () => loadDriveData(client, this.sdkBase!.account, reading, driveCopyCache(), SEARCH_MODEL_ID))
        .then(
        (data) => {
          this.searchCopies = data.search;
          keepDeviceNames(data.deviceNames);
          keepSeenRevisions(data.revisions);
          if (kinds.faceData) faceScanner.setPhoneCopies(data.faceCopies, readBack);
          faceScanner.setPhoneSearch(data.search);
          // The other devices' labels are put together with the ones kept here.
          if (kinds.labels && data.labelCopies.length > 0) {
            const before = labelStore.version;
            labelStore.change(
              (state) => data.labelCopies.map((copy) => takeInLabels(state, copy, readBack ? "" : own)).some(Boolean),
              (changed) => changed,
            );
            if (labelStore.version !== before) this.backup.changed();
          }
          this.takeInHidden(data.hiddenCopies);
          const settingsTaken = settings && this.takeInSettings(data.settingsCopies, data.settingsUnreadable);
          if (settings) this.takeInAlbumOrder(data.albumOrderCopies, data.albumOrderUnreadable, albumOrderReadBack);
          // A photo put into a hidden album since, from any app, is hidden with it, and one put
          // into an album kept offline is fetched.
          void this.hiddenRefresh().catch(() => undefined);
          void this.refreshOfflineAlbums();
          // This install's face copy read back while face recognition is off is held, not taken in:
          // the read-back stays open until it is, or the names it carries would be written over.
          if (readBack && data.ownRead && (!kinds.faceData || faceScanner.takesCopies())) writeBackupFlags({ ownTaken: true });
          if (settingsReadBackDone(settingsReadBack, settingsTaken, data.settingsUnreadable)) writeBackupFlags({ settingsOwnTaken: true });
          if (settingsReadBackDone(albumOrderReadBack, true, data.albumOrderUnreadable)) writeBackupFlags({ albumOrderOwnTaken: true });
          const {
            search,
            searchOtherModel,
            faceCopies,
            labelCopies,
            hiddenCopies,
            settingsCopies,
            settingsUnreadable,
            albumOrderCopies,
            albumOrderUnreadable,
            ownRead,
            ownUnreadable,
            deviceNames,
            ...collections
          } = data;
          return {
            ...collections,
            ownUnreadable,
            searchPhotos: new Set(search.flatMap((copy) => copy.keys)).size,
            searchOtherModel,
          };
        },
      );
      const entry = { kinds: key, run };
      // A failed read is not kept, so the next ask tries again.
      run.catch(() => {
        if (this.driveCollections === entry) this.driveCollections = null;
      });
      this.driveCollections = entry;
    }
    return this.driveCollections.run;
  }

  /**
   * The photos that look most like `query` describes, best first, by the search index the
   * phone saved to Drive: their link ids and scores. Empty without the text model or an index.
   */
  async semanticSearch(query: string, limit?: number): Promise<{ key: string; score: number }[]> {
    // One source at a time, as chosen in Settings: the index made on this computer when it is
    // being made, else the phone's.
    const local = faceScanner.localSearch();
    const copies = local ? [local] : this.searchCopies;
    if (!query.trim() || copies.length === 0) return [];
    const vector = await encodeText(query);
    if (!vector) return [];
    return rank(copies, vector, limit);
  }

  /**
   * The themes of the library (Food, Beach, ...) from the same vectors the search ranks: the photos
   * of each, best first, and whether the classification is still catching up. Without the text
   * model or an index it is empty.
   */
  themes(): ThemeSnapshot {
    const local = faceScanner.localSearch();
    const copies = local ? [local] : this.searchCopies;
    if (copies.length === 0) return { syncing: false, themes: [] };
    return themeIndex.request(copies);
  }

  /**
   * Turns the shared backup on or off, with the kinds the window shows, which each round reads
   * from Drive before it saves.
   */
  setSharedBackup(on: boolean, kinds: DriveKinds): BackupStatus {
    this.backupKinds = kinds;
    // Kept where the lock screen can read it, so a sign-out from there still knows what it would lose.
    this.backup.setUnsavedListener((unsaved) => writeSignOutHold(unsaved));
    return this.backup.setOn(on && !!this.sdkBase);
  }

  /**
   * Whether another device saved a copy since this computer last read the copies, from the folder
   * listings of the kinds a round reads, nothing downloaded.
   */
  private async anythingNewOnDrive(): Promise<boolean> {
    if (!this.sdkBase || !this.backupKinds) return false;
    const on = this.backup.getStatus().on;
    const { appUid, copies } = await listOtherCopies(
      this.backupClient(),
      { ...this.backupKinds, hidden: true, settings: on, albumOrder: on, ownDeviceId: installDeviceId(), trashed: this.trashedCopies },
      this.backupAppUid,
    );
    this.backupAppUid = appUid;
    // A copy no longer listed is forgotten.
    keepSeenRevisions([], new Set(copies.map((c) => c.uid)));
    const fresh = newerThanSeen(copies);
    if (fresh > 0) diag.log("backup", "look_found_new", { listed: copies.length, newer: fresh });
    return fresh > 0;
  }

  /** The window came back: the shared backup asks Drive whether another device saved something, at most once a minute. */
  sharedBackupCheck(): BackupStatus {
    void this.backup.check();
    return this.backup.getStatus();
  }

  /** The window went to the tray or came back: the shared backup's quick look runs only while it is shown. */
  sharedBackupShown(shown: boolean): { ok: true } {
    this.backup.setShown(shown);
    this.photoEvents.setShown(shown);
    return { ok: true };
  }

  /**
   * The window came back into focus: the photos feed looks now, and the answer says whether it is
   * to be trusted. Untrusted (not running, or its last look failed or is overdue), the window reads
   * the timeline again itself.
   */
  checkPhotoEvents(): { healthy: boolean } {
    return this.photoEvents.check();
  }

  /**
   * The user refreshed the library: a change waiting for the shared backup goes out now, then Drive
   * is asked whether another device saved something. Answers at once; the work runs on its own.
   */
  sharedBackupRefresh(): BackupStatus {
    void this.backup.refresh().catch(() => undefined);
    return this.backup.getStatus();
  }

  /**
   * For a quit or a close to the tray: a change still waiting is saved now, waited for at most
   * `waitMs` (0 starts it without waiting). `done` says whether it finished in that time.
   */
  async sharedBackupFlush(waitMs: number): Promise<{ done: boolean }> {
    return { done: await this.backup.flushWithin(waitMs) };
  }

  /**
   * Before a sign-out, which deletes the labels, the hidden list, the faces and the synced settings
   * here: with `start`, what is not on Drive yet goes out now; the round is waited for at most
   * `waitMs`, and the window asks again until `done`. Nothing to save while locked or with the
   * backup off.
   */
  async signOutSave(waitMs: number, start: boolean): Promise<SignOutSave> {
    if (!isReady()) return { done: true, unsaved: [] };
    return this.backup.saveForSignOut(waitMs, start);
  }

  /** How the shared backup stands, with when this computer's labels were last saved. */
  sharedBackupStatus(): BackupStatus {
    return this.backup.getStatus();
  }

  /**
   * "Back up now": one round of the shared backup whether its automatic rounds are on or not, every
   * copy of this computer's written, after the other devices' were read.
   */
  async backUpNow(): Promise<BackupStatus> {
    if (!this.sdkBase) throw new Error("Not signed in");
    await faceScanner.shareOnce(() => this.backup.backUpNow());
    return this.backup.getStatus();
  }

  /**
   * "Load from Drive": brings in every other device's newest copies again, also the ones taken in
   * before. It puts them together with what is here, deletes nothing and writes nothing itself.
   */
  async loadFromDrive(): Promise<DriveReply> {
    if (!this.sdkBase) throw new Error("Not signed in");
    const kinds = this.readKinds;
    faceScanner.forgetTakenIn();
    const labels = labelStore.get();
    if (Object.keys(labels.applied).length > 0) {
      labels.applied = {};
      labelStore.write();
    }
    return faceScanner.shareOnce(() => this.getDriveCollections(true, kinds));
  }

  /**
   * "Delete face data", only on this PC, while the shared backup is on: the face data here goes,
   * and the copies on Drive are read back in at once, this install's own too, so the faces and
   * names saved there return.
   */
  async clearFacesHere(): Promise<void> {
    if (!this.sdkBase) throw new Error("Not signed in");
    await faceScanner.clearHere();
    void this.loadFromDrive().catch(() => undefined);
  }

  /**
   * "Delete face data" everywhere: face recognition turns off and the face data here goes, then a
   * round reads the other devices' copies (those from before the delete are turned away) and saves
   * this computer's empty copy carrying the delete, after which their face copies go to the trash.
   */
  async clearFacesEverywhere(): Promise<void> {
    if (!this.sdkBase) throw new Error("Not signed in");
    await faceScanner.clearEverywhere();
    void this.backUpNow().catch(() => undefined);
  }

  /**
   * After a delete everywhere made here, once this computer's copy on Drive carries it: the other
   * devices' face copies go to the Drive trash. Kept pending until that went through.
   */
  private async trashOtherFaceCopies(): Promise<void> {
    if (!readBackupFlags().trashPending || !faceScanner.wipeSaved()) return;
    const client = this.backupClient();
    const uids = await otherFaceCopies(client, installDeviceId(), this.trashedCopies);
    const moved = uids.length > 0 ? await trashDriveFiles(client, uids) : [];
    for (const uid of moved) this.trashedCopies.add(uid);
    if (moved.length < uids.length) throw new Error("the other devices' face copies did not all go to the trash");
    writeBackupFlags({ trashPending: false });
    process.stderr.write(`[backup] moved ${moved.length} face copies of other devices to the trash\n`);
  }

  /** The backups on Drive, device by device, newest first, for the backup settings. */
  async driveBackups(): Promise<DriveBackup[]> {
    if (!this.sdkBase) throw new Error("Not signed in");
    const own = installDeviceId();
    const { backups, names } = await listDriveBackups(
      this.backupClient(),
      this.sdkBase.account,
      driveCopyCache(),
      own,
      readBackupFlags().names,
      this.trashedCopies,
    );
    keepDeviceNames(names);
    return backups;
  }

  /** Moves another device's backup, every file of it, to the Drive trash. */
  async trashDriveBackup(device: string): Promise<{ moved: number }> {
    if (!this.sdkBase) throw new Error("Not signed in");
    const own = installDeviceId();
    if (device === own) throw new Error("This PC's own backup is not trashed from here");
    const backup = (await this.driveBackups()).find((b) => b.device === device);
    if (!backup) return { moved: 0 };
    const moved = await trashDriveFiles(this.backupClient(), backup.files);
    for (const uid of moved) this.trashedCopies.add(uid);
    diag.log("backup", "trash_device", { files: backup.files.length, moved: moved.length });
    if (moved.length < backup.files.length) throw new Error("Some of the files did not go to the trash");
    return { moved: moved.length };
  }

  private labelsDirty(all = false): boolean {
    if (!this.backupKinds?.labels || (!all && labelStore.version === this.savedLabelsVersion)) return false;
    const state = labelStore.get();
    return Object.keys(state.photos).length + Object.keys(state.names).length + Object.keys(state.deleted).length > 0;
  }

  /** Puts the other devices' hidden lists together with this one, the later change winning. */
  private takeInHidden(copies: HiddenCopy[]): void {
    const newAlbums: string[] = [];
    let changed = false;
    for (const copy of copies) {
      const result = hiddenStore.takeIn(copy);
      if (!result) continue;
      changed = true;
      newAlbums.push(...result);
    }
    if (!changed) return;
    this.backup.changed();
    if (newAlbums.length > 0) void this.readHiddenAlbums(newAlbums);
  }

  /** Reads the photos of albums another device hid, known here by their link ids only. */
  private async readHiddenAlbums(links: string[]): Promise<void> {
    if (!this.photos) return;
    try {
      const root = await this.photos.getMyPhotosRootFolder();
      const rootUid: string = root?.uid ?? root?.value?.uid ?? "";
      const volume = rootUid.slice(0, rootUid.lastIndexOf("~"));
      if (!volume) return;
      for (const link of links) {
        const uid = `${volume}~${link}`;
        hiddenStore.setAlbumUid(uid);
        hiddenStore.setMembers(uid, await this.albumMemberUids(uid));
      }
    } catch (e) {
      if (!isTransient(e)) process.stderr.write(`[hidden] a hidden album could not be read: ${(e as Error)?.name ?? "error"}\n`);
    }
  }

  /**
   * Puts the other devices' settings together with this one's, the later choice winning. Until the
   * choices made before the feature are stamped, or when a copy would not read, this computer's
   * copy is left unwritten.
   */
  private takeInSettings(copies: SettingsCopy[], unreadable: number): boolean {
    if (!settingsSyncStore.isSeeded()) return false;
    this.settingsReadOk = unreadable === 0;
    const before = settingsSyncStore.version;
    const own = installDeviceId();
    for (const copy of copies) settingsSyncStore.takeIn(copy, own);
    if (settingsSyncStore.version !== before) this.backup.changed();
    return true;
  }

  private settingsDirty(all = false): boolean {
    return (
      this.settingsReadOk &&
      this.backup.getStatus().on &&
      (all || settingsSyncStore.version !== this.savedSettingsVersion) &&
      settingsSyncStore.hasStamps()
    );
  }

  /** Writes this computer's settings to Drive, sealed as the hidden list is. */
  private async saveSettings(all = false): Promise<boolean> {
    const version = settingsSyncStore.version;
    const id = installDeviceId();
    const at = Date.now();
    const copy = settingsSyncStore.forDrive(id, deviceLabel(), at);
    const wrote = await this.upload("settings", writeSettingsCopy({ ...copy, createdAt: 0 }), writeSettingsCopy(copy), SETTINGS_FOLDER, settingsFileName(id), at, all);
    this.savedSettingsVersion = version;
    if (wrote) process.stderr.write(`[settings] saved the settings to Drive: ${copy.scalars.length} settings
`);
    return wrote;
  }

  /**
   * What the window chose: `values` are stamped as chosen now. With `seed`, the choices that were
   * there before the feature are stamped once at time 0 instead, so they fill a gap and beat nothing.
   */
  settingsSyncReport(values: { id: string; x: unknown }[], seed: boolean): { ok: boolean } {
    if (!isReady()) return { ok: false };
    const own = installDeviceId();
    if (seed ? settingsSyncStore.seed(values, own) : settingsSyncStore.stamp(values, own)) this.backup.changed();
    return { ok: true };
  }

  /**
   * The settings taken in from Drive that the window has not shown yet. `done` are the ones it has
   * shown since it last asked, by id and time.
   */
  settingsSyncPull(done: { id: string; t: number }[]): { applied: { id: string; x: unknown; t: number }[] } {
    if (!isReady()) return { applied: [] };
    settingsSyncStore.acknowledge(done);
    return { applied: settingsSyncStore.pending() };
  }

  /**
   * Puts the other devices' album orders together with this computer's, the later change to each
   * album's mode and order winning. On a read-back this install's own copy is taken too. A copy
   * that would not read leaves this computer's copy unwritten this round.
   */
  private takeInAlbumOrder(copies: AlbumOrderCopy[], unreadable: number, readBack: boolean): void {
    this.albumOrderReadOk = unreadable === 0;
    const own = installDeviceId();
    let changed = false;
    for (const copy of copies) changed = albumOrderStore.takeIn(copy, readBack ? "" : own, own) || changed;
    if (changed) this.backup.changed();
  }

  private albumOrderDirty(all = false): boolean {
    return (
      this.albumOrderReadOk &&
      this.backup.getStatus().on &&
      (all || albumOrderStore.version !== this.savedAlbumOrderVersion) &&
      !albumOrderStore.isEmpty()
    );
  }

  /**
   * The link ids of every album there is, own and shared with this account, so a deleted album's
   * order is left out of the copy; null when either listing did not complete, and then every
   * order held is written.
   */
  private async albumLinksForOrder(): Promise<Set<string> | null> {
    if (!this.photos) return null;
    try {
      const links = new Set((await readAlbums(this.photos)).map((a) => albumLinkOf(a.uid)));
      for await (const node of withStallGuard(this.photos.iterateSharedNodesWithMe(), SDK_STALL_MS, "iterateSharedNodes")) {
        const n = node as any;
        if (n?.type === "album" && typeof n.uid === "string") links.add(albumLinkOf(n.uid));
      }
      return links.size > 0 ? links : null;
    } catch {
      return null;
    }
  }

  /** Writes this computer's album orders to Drive, sealed as the hidden list is. */
  private async saveAlbumOrder(all = false): Promise<boolean> {
    const version = albumOrderStore.version;
    const id = installDeviceId();
    const albums = await this.albumLinksForOrder();
    const at = Date.now();
    const copy = albumOrderStore.forDrive(id, deviceLabel(), at, albums ?? undefined);
    if (copy.albums.length === 0) {
      this.savedAlbumOrderVersion = version;
      return false;
    }
    const wrote = await this.upload(
      "albumOrder",
      writeAlbumOrderCopy({ ...copy, createdAt: 0 }),
      writeAlbumOrderCopy(copy),
      ALBUM_ORDER_FOLDER,
      albumOrderFileName(id),
      at,
      all,
    );
    this.savedAlbumOrderVersion = version;
    if (wrote) process.stderr.write(`[album-order] saved the album orders to Drive: ${copy.albums.length} albums\n`);
    return wrote;
  }

  // ---- The photo order inside each album (albumOrder.ts) ----

  albumOrderGet(uid: string): AlbumOrderView {
    if (!isReady()) return { mode: null, order: [], version: -1 };
    return albumOrderStore.view(uid);
  }

  albumOrderSetMode(uid: string, mode: AlbumPhotoMode): AlbumOrderView {
    if (!isReady()) throw new Error("Not signed in");
    albumOrderStore.setMode(uid, mode);
    diag.log("backup", "album_order_mode", { mode });
    this.backup.changed();
    return albumOrderStore.view(uid);
  }

  /** Saves an album's hand-made order (photo link ids, in the order shown) and switches the album to it. */
  albumOrderSave(uid: string, order: string[]): AlbumOrderView {
    if (!isReady()) throw new Error("Not signed in");
    albumOrderStore.saveCustom(uid, order.filter((x): x is string => typeof x === "string"));
    diag.log("backup", "album_order_save", { count: order.length });
    this.backup.changed();
    return albumOrderStore.view(uid);
  }

  /** Takes over the per-album Newest / Oldest choices the window's settings held before, once. */
  albumOrderSeed(modes: Record<string, unknown>): { ok: boolean } {
    if (!isReady()) return { ok: false };
    if (albumOrderStore.seed(modes)) this.backup.changed();
    return { ok: true };
  }

  private hiddenDirty(all = false): boolean {
    return (all || hiddenStore.version !== this.savedHiddenVersion) && !hiddenStore.isEmpty();
  }

  /** Writes this computer's hidden list to Drive, sealed as the labels are. */
  private async saveHidden(all = false): Promise<boolean> {
    const version = hiddenStore.version;
    const id = installDeviceId();
    const at = Date.now();
    const copy = hiddenStore.forDrive(id, deviceLabel(), at);
    const wrote = await this.upload("hidden", writeHiddenCopy({ ...copy, createdAt: 0 }), writeHiddenCopy(copy), HIDDEN_FOLDER, hiddenFileName(id), at, all);
    this.savedHiddenVersion = version;
    if (wrote) process.stderr.write(`[hidden] saved the hidden list to Drive: ${copy.photos.length} photos, ${copy.albums.length} albums\n`);
    return wrote;
  }

  /** Writes this computer's labels to Drive, sealed as the phone seals its own. */
  private async saveLabels(all = false): Promise<boolean> {
    const version = labelStore.version;
    const id = installDeviceId();
    const at = Date.now();
    const copy = labelsForDrive(labelStore.get(), id, deviceLabel(), at);
    const wrote = await this.upload("labels", writeLabelCopy({ ...copy, createdAt: 0 }), writeLabelCopy(copy), LABELS_FOLDER, labelsFileName(id), at, all);
    this.savedLabelsVersion = version;
    if (wrote) process.stderr.write(`[labels] saved the labels to Drive: ${copy.photos.length} photos\n`);
    return wrote;
  }

  /**
   * Writes one of this computer's copies to Drive unless it holds what the copy there already
   * does (`all` writes it anyway): `same` is the copy with its time left out, which is what is
   * compared. A save that fails on the network is tried again twice, after 2 and 5 seconds. Answers
   * whether it was written.
   */
  private async upload(
    kind: BackupKind,
    same: Buffer,
    plain: Buffer,
    folder: string,
    name: string,
    at: number,
    all = false,
  ): Promise<boolean> {
    if (!all && this.savedCopies.unchanged(kind, same)) return false;
    const sealed = await this.sealForDrive(plain);
    await withRetry(() => saveCopy(this.backupClient(), folder, name, sealed, new Date(at)), UPLOAD_RETRY_MS);
    this.savedCopies.record(kind, same);
    return true;
  }

  /** Seals `plain` to the account's primary address key and signs it with it, as the phone does. */
  private async sealForDrive(plain: Buffer): Promise<Buffer> {
    if (!this.sdkBase) throw new Error("Not signed in");
    const address = await (this.sdkBase.account as any).getOwnPrimaryAddress();
    const key = (address.keys ?? [])[address.primaryKeyIndex ?? 0]?.key;
    if (!key) throw new Error("no address key");
    return sealEnvelope(plain, key, key);
  }

  /**
   * Tries again to resume a session that `offline` left waiting for the network. The try runs
   * in the background and this answers at once: with no network a refresh can take most of a
   * minute, and the photos kept offline are open meanwhile on the same channel. The outcome
   * is the answer to the next call.
   */
  retryResume(): LoginResult {
    if (this.retried) {
      const result = this.retried;
      this.retried = null;
      return result;
    }
    if (this.resuming) return { status: "offline" };
    if (!isReady() || this.offlineResume === null) {
      return { status: "error", error: "Nothing is waiting to be resumed" };
    }
    void this.resumeSaved(this.offlineResume).then((result) => {
      if (result.status !== "offline") this.retried = result;
    });
    return { status: "offline" };
  }

  /** Cold start of a vault that needs no password: this Windows account opens it. */
  async unlockDevice(): Promise<LoginResult> {
    if (this.resuming) return this.resuming;
    if (vaultMode() !== "device" || !unlockDeviceVault()) {
      return { status: "error", error: "No saved account" };
    }
    return this.resumeSaved("");
  }

  /**
   * The saved session, resumed in a vault that has just opened. `password` is the one
   * that opened it, which is the account password only for a password sign-in.
   */
  private resumeSaved(password: string): Promise<LoginResult> {
    if (!this.resuming) {
      this.resuming = this.resumeOnce(password).finally(() => {
        this.resuming = null;
      });
    }
    return this.resuming;
  }

  private async resumeOnce(password: string): Promise<LoginResult> {
    // Left as it is until this try is decided: the photos kept offline stay open meanwhile.
    try {
      // A blob that will not open is no more recoverable than one that is not there, so
      // it is answered the same way: the password has just been proved correct, and this
      // must not look like a wrong one. `readSealedOrSetAside` sets it aside, leaving the vault
      // and every cached photo intact and asking only for a sign-in. Surfacing the crypto
      // error instead fails identically on every retry, and the one way out of that is
      // the one that wipes every original the user pinned.
      const blob = this.readSavedSession();
      if (!blob) {
        // The vault opened but holds no session: it is signed in again into the open vault, as a
        // lapsed session is, and the account it belongs to is told by the keys recorded beside it.
        this.offlineResume = null;
        this.reloginKeys = this.recordedKeys();
        diag.log("session", "saved_missing", { known: this.reloginKeys.length > 0 });
        return { status: "relogin" };
      }
      this.savedRefresh = blob.refreshToken;
      const result = await this.resumeSession(blob, password);
      if (result.status !== "offline") this.offlineResume = null;
      if (result.status === "offline") {
        // Nothing says the session is gone, only that it could not be asked about: the
        // vault stays open and the window tries again, instead of a full sign-in that
        // would ask for the password and the second factor all over.
        this.offlineResume = password;
        // The photos kept offline open as they are until Proton answers again.
        const kept = offlineLibrary().length;
        diag.log("session", "offline_library", { kept });
        return kept > 0 ? { status: "offline", email: blob.email || blob.username || undefined, kept } : result;
      }
      // A session first signed in with the Proton password, which the app no longer asks for.
      if ((blob.method ?? "password") === "password") this.legacySignIn = true;
      if (result.status !== "ok") {
        // Proton's page signs in again, and the vault stays open so the new session lands
        // in it with the cache intact. The password that opened the vault is not used for
        // that, even where it is the account's own.
        this.session = null;
        this.reloginKeys = Object.keys(blob.userKeyPassphrases ?? {});
        return { status: "relogin" };
      }
      return result;
    } catch (e) {
      this.lock();
      return { status: "error", error: (e as Error).message };
    }
  }

  /**
   * The saved session as it is on disk now, or null. A blob that will not open, or opens to
   * something other than what `persistSession` writes, is set aside or dropped (`readSealedOrSetAside`).
   * Logged with the file's modified time and the tag of its refresh token unless `quiet`, so
   * the log shows which save a start went on with.
   */
  private readSavedSession(quiet = false): PersistableSession | null {
    // Without the key every blob fails to open, and would be dropped as torn.
    if (!isReady()) return null;
    const path = join(storeDir(), SESSION_FILE);
    let modified: number;
    try {
      modified = statSync(path).mtimeMs;
    } catch {
      return null;
    }
    const raw = readSealedOrSetAside(path);
    let blob: PersistableSession | null = null;
    if (raw) {
      try {
        blob = JSON.parse(raw.toString("utf8")) as PersistableSession;
      } catch {
        rmSync(path, { force: true }); // opened, but is not the shape we wrote
      }
    }
    if (!quiet) {
      diag.log("session", "saved_read", {
        pid: process.pid,
        modified: new Date(modified).toISOString(),
        token: tokenTag(blob?.refreshToken),
      });
    }
    return blob;
  }

  /**
   * Runs `work` holding the saved session's lock, which keeps another process on the same
   * store folder from spending the same refresh token meanwhile (sessionLock.ts).
   */
  private underSessionLock<T>(work: () => Promise<T>): Promise<T> {
    let dir: string;
    try {
      dir = storeDir();
    } catch {
      return work();
    }
    return withSessionLock(dir, work);
  }

  /**
   * The saved session when another process saved it since this one last read or wrote it, or
   * null when the saved token is ours: the one in memory, or one only our last save missed.
   */
  private newerSaved(saved: PersistableSession | null, uid: string, inMemory: string | undefined): PersistableSession | null {
    if (!saved || saved.uid !== uid || !saved.refreshToken) return null;
    if (saved.refreshToken === inMemory || saved.refreshToken === this.savedRefresh) return null;
    return saved;
  }

  /** Drop the in-memory session and forget the vault key; the next use needs an unlock. */
  lock(): { ok: boolean } {
    // First, so no thumbnail is served from a session that is going away, and the faces are
    // written while the key that seals them is still here.
    void stopThumbServer();
    this.photoEvents.stop();
    dateEditor.detach();
    cloudCompressor.detach();
    // What is not on Drive yet, read while the stores are still open: a sign-out from the lock
    // screen asks before it deletes it.
    if (isReady() && this.backup.getStatus().on) writeSignOutHold(this.backup.unsaved());
    this.backup.stop();
    this.backupKinds = null;
    this.backupAppUid = null;
    this.trashedCopies.clear();
    this.savedLabelsVersion = -1;
    this.savedHiddenVersion = -1;
    this.savedSettingsVersion = -1;
    this.settingsReadOk = false;
    this.savedAlbumOrderVersion = -1;
    this.albumOrderReadOk = false;
    faceScanner.setDriveWriter(null);
    faceScanner.setSource(null);
    duplicateFinder.setSource(null);
    labelStore.unload();
    hiddenStore.unload();
    settingsSyncStore.unload();
    albumOrderStore.unload();
    this.thumbWaiting.clear();
    this.faceCovers.clear();
    this.videos.clear();
    this.trash.changed();
    lockVault();
    this.offlineResume = null;
    this.retried = null;
    this.savedRefresh = null;
    this.recordedAccount = "";
    this.timelineRun = null;
    this.browser?.cancel();
    this.browser = null;
    this.browserFinish = null;
    this.awaitingProtection = false;
    this.reloginKeys = null;
    this.session = null;
    this.photos = null;
    this.sdkBase = null;
    this.myFiles = null;
    this.myFilesKeys = null;
    this.ocrRead.clear();
    this.cameraJobs.clear();
    this.driveCollections = null;
    this.searchCopies = [];
    themeIndex.reset();
    this.email = "";
    this.password = "";
    this.keyPassword = "";
    this.userKeyPassphrases = {};
    // The mount listing is this account's photo uids and capture times. Drop it
    // with everything else: leaving it would let a listing for the NEXT account
    // be served from the previous one's snapshot.
    resetDownloadState();
    // Nor a decrypted original or a lighter copy left in the temporary folder.
    void sweepCompressionTemp();
    // Same for the offline list: it is sealed with the key we just forgot, so the
    // in-memory copy must go too. The stored originals stay for this account to
    // come back to; sign-out is what removes those, through wipeCache.
    resetOfflineState();
    return { ok: true };
  }

  /**
   * Forget the account entirely: relock, then delete the saved session, the vault, and the cache.
   * While the shared backup holds a change that is not on Drive, nothing is deleted unless
   * `discard` says the user chose to lose it: the answer names the kinds instead.
   */
  signOut(discard = false): { ok: boolean; unsaved?: BackupKind[] } {
    if (!discard) {
      // Locked, the backup that knows is closed: the record it left says what is not on Drive.
      const unsaved = isReady() ? this.backup.unsaved() : readSignOutHold();
      if (unsaved.length > 0) {
        diag.log("session", "sign_out_held", { unsaved: unsaved.join(","), locked: !isReady() });
        return { ok: false, unsaved };
      }
    }
    // The tokens go on the server too, so a copy of them taken from this machine, or
    // from its memory, is worth nothing afterwards; and the session disappears from the
    // account's security log. Best effort and not waited on: signing out never depends
    // on the network, and a locked app holds no tokens to revoke.
    const live = this.session;
    if (live) void ProtonApi.revoke(live).catch(() => {});
    this.lock();
    this.removeStoredAccount();
    return { ok: true };
  }

  /** What sign-out deletes on disk: the saved session, the vault, the host's mount state, the cache. */
  private removeStoredAccount(): void {
    try {
      rmSync(join(storeDir(), SESSION_FILE), { force: true });
      rmSync(join(storeDir(), VAULT_META_FILE), { force: true });
      rmSync(join(storeDir(), LOCAL_LOCK_FILE), { force: true });
      clearSignOutHold();
      // The host's mount state lives in this same directory and is plaintext:
      // the auto-download baseline is a list of this account's photo uids, and
      // the album list is what it chose to keep offline. Neither survives the
      // account it belongs to.
      for (const f of HOST_STATE_FILES) {
        rmSync(join(storeDir(), f), { force: true });
      }
    } catch (e) {
      // Code only: a Node fs error message embeds the full path, and these paths
      // carry the Windows account name.
      process.stderr.write(
        `[sidecar] signOut cleanup failed: ${(e as NodeJS.ErrnoException).code ?? "unknown"}\n`,
      );
    }
    wipeCache();
  }

  /**
   * Asks Proton now and then whether the session stands. A refusal reaches `sessionLost` through
   * the http client's refresh; a network that is down is only waited out.
   */
  private watchSession(): void {
    if (this.sessionWatch) return;
    this.sessionWatch = setInterval(() => {
      const client = this.sessionClient;
      if (!this.session || !client) return;
      void client
        .fetchJson({ url: SESSION_CHECK_URL, method: "GET", headers: new Headers(), timeoutMs: 15_000 })
        .catch(() => {});
    }, SESSION_CHECK_MS);
    this.sessionWatch.unref?.();
  }

  /**
   * Proton refused the session while the app was open: it was ended elsewhere. Nothing more is
   * shown or fetched from it, and the window goes to the sign-in at once. The vault stays, as when
   * a lapsed session is found at start: the same account signing in again finds everything, and
   * another account clears it first (`forgetPreviousAccount`).
   */
  private sessionLost(): void {
    if (!this.session) return;
    diag.log("session", "lost");
    this.reloginKeys = Object.keys(this.userKeyPassphrases);
    void stopThumbServer();
    this.photoEvents.stop();
    dateEditor.detach();
    cloudCompressor.detach();
    this.backup.stop();
    faceScanner.setDriveWriter(null);
    faceScanner.setSource(null);
    duplicateFinder.setSource(null);
    this.thumbWaiting.clear();
    this.faceCovers.clear();
    this.videos.clear();
    this.trash.changed();
    this.timelineRun = null;
    this.session = null;
    this.photos = null;
    this.sdkBase = null;
    this.myFiles = null;
    this.myFilesKeys = null;
    this.email = "";
    resetDownloadState();
    process.stderr.write("[sidecar] the session was ended on Proton's side\n");
    hostNotice("sessionEnded");
  }

  /**
   * Lets go of everything the previous account kept on this PC while the session of the
   * account now signing in stays: what sign-out unloads and deletes, minus the session.
   */
  private forgetPreviousAccount(): void {
    void stopThumbServer();
    this.photoEvents.stop();
    dateEditor.detach();
    cloudCompressor.detach();
    this.backup.stop();
    this.backupKinds = null;
    this.backupAppUid = null;
    this.trashedCopies.clear();
    this.savedLabelsVersion = -1;
    this.savedHiddenVersion = -1;
    this.savedSettingsVersion = -1;
    this.settingsReadOk = false;
    this.savedAlbumOrderVersion = -1;
    this.albumOrderReadOk = false;
    faceScanner.setDriveWriter(null);
    faceScanner.setSource(null);
    duplicateFinder.setSource(null);
    labelStore.unload();
    hiddenStore.unload();
    settingsSyncStore.unload();
    albumOrderStore.unload();
    this.thumbWaiting.clear();
    this.faceCovers.clear();
    this.videos.clear();
    this.trash.changed();
    this.legacySignIn = false;
    this.recordedAccount = "";
    lockVault();
    this.removeStoredAccount();
    resetDownloadState();
    void sweepCompressionTemp();
    resetOfflineState();
  }

  /**
   * Write the current session to disk, encrypted with the vault key. Called on a
   * fresh sign-in and again on every token refresh, so a rotated refresh token is
   * never lost. A no-op while the vault is locked (nothing to seal with).
   */
  private persistSession(): void {
    if (!isReady()) {
      diag.log("session", "persist_skipped", { reason: "locked" });
      return;
    }
    const blob = this.getPersistable();
    if (!blob) return;
    // Another process on this store folder renewed the session since we last saw it: its
    // token is the live one and ours is spent, so ours must not be written over it. The
    // next refresh here takes that token up instead (`renewLive`).
    if (this.newerSaved(this.readSavedSession(true), blob.uid, blob.refreshToken)) {
      diag.log("session", "persist_skipped", { reason: "newer_saved", pid: process.pid });
      return;
    }
    diag.log("session", "persist", { pid: process.pid, token: tokenTag(blob.refreshToken) });
    try {
      // Written aside and renamed rather than in place: this runs on every token
      // refresh, so a write torn by a crash would leave an unreadable session behind
      // on an ordinary day of use.
      writeSealedAtomic(join(storeDir(), SESSION_FILE), Buffer.from(JSON.stringify(blob)));
      this.savedRefresh = blob.refreshToken;
      this.recordAccount(Object.keys(blob.userKeyPassphrases ?? {}));
    } catch (e) {
      // The renewed token lives on in memory: the next save (the one at the end of the
      // sign-in, the next refresh) writes it, and until then a start finds the spent one.
      const code = (e as NodeJS.ErrnoException).code ?? "unknown";
      diag.log("session", "persist_failed", { pid: process.pid, code });
      process.stderr.write(`[sidecar] could not persist session: ${code}\n`);
    }
  }

  /** The key ids last written to the account record, so a token refresh does not write it again. */
  private recordedAccount = "";

  private recordAccount(keyIds: string[]): void {
    const key = [...keyIds].sort().join(",");
    if (!key || key === this.recordedAccount) return;
    try {
      recordAccountKeys(keyIds);
      this.recordedAccount = key;
    } catch {
      /* written with the next save of the session */
    }
  }

  /**
   * Shared resume path. `password`, when supplied by `unlock`, lets `buildAccount`
   * re-derive the Proton key passphrases the same way a fresh sign-in does, so the
   * keys unlock even if the cached passphrases are absent. It is never persisted.
   */
  private async resumeSession(blob: PersistableSession, password: string): Promise<LoginResult> {
    initCrypto();
    try {
      // Read, renewed and saved under the session lock, so another process on this store
      // folder cannot spend the same refresh token in between.
      await this.underSessionLock(async () => {
        let saved = blob;
        // Read again now that the lock is ours: another process may have renewed the
        // session since the read before it. Its tokens are fresh, so they are taken up
        // as they are; spending ours would only be refused.
        const newer = this.newerSaved(this.readSavedSession(), blob.uid, blob.refreshToken);
        if (newer) {
          diag.log("session", "resume_adopted", { pid: process.pid, token: tokenTag(newer.refreshToken) });
          this.savedRefresh = newer.refreshToken;
          this.takeResumed({ uid: newer.uid, accessToken: newer.accessToken, refreshToken: newer.refreshToken }, blob, password);
          return;
        }
        // A network that is still coming up (the app starts with Windows, a VPN is
        // connecting) is asked again a few times before the session is given up on.
        diag.log("session", "resume_refresh", { pid: process.pid, token: tokenTag(saved.refreshToken) });
        let attempts = 0;
        let fresh: Session;
        try {
          fresh = await withRetry(() => {
            attempts++;
            return refreshSession(saved.uid, saved.refreshToken);
          }, RESUME_RETRY_MS);
        } catch (e) {
          if ((e as { protonCode?: number }).protonCode !== INVALID_REFRESH_TOKEN) throw e;
          // Refused on a second try: the first one may have reached Proton and spent the
          // token before its answer was lost, which no read of the disk can bring back.
          if (attempts > 1) {
            diag.log("session", "resume_reused", { pid: process.pid, token: tokenTag(saved.refreshToken), attempts });
          }
          // Something that did not take the lock (an older build) may have saved a renewal
          // meanwhile: the disk is asked once more, and its token tried once.
          const again = this.readSavedSession();
          if (!again || again.uid !== saved.uid || !again.refreshToken || again.refreshToken === saved.refreshToken) throw e;
          saved = again;
          this.savedRefresh = again.refreshToken;
          diag.log("session", "resume_refresh", { pid: process.pid, token: tokenTag(saved.refreshToken), from: "saved" });
          fresh = await refreshSession(saved.uid, saved.refreshToken);
        }
        diag.log("session", "token_refreshed", { pid: process.pid, token: tokenTag(fresh.refreshToken) });
        this.takeResumed(fresh, saved, password);
        // The refresh has just spent the saved refresh token. Saved straight away: an app
        // stopped while the account is being built would otherwise leave only the spent
        // one on disk, and the next start would have to sign in again.
        this.persistSession();
      });
      return this.finishLogin();
    } catch (e) {
      const err = e as { status?: number; protonCode?: number; name?: string };
      diag.log("session", "resume_failed", {
        pid: process.pid,
        transient: isTransient(e),
        status: typeof err.status === "number" ? err.status : null,
        code: typeof err.protonCode === "number" ? err.protonCode : null,
        kind: err.name ?? null,
      });
      if (isTransient(e)) return { status: "offline" };
      return { status: "error", error: `resume failed: ${(e as Error).message}` };
    }
  }

  /** Makes a resumed session the live one, with what its saved blob remembers. */
  private takeResumed(fresh: Session, blob: PersistableSession, password: string): void {
    this.session = fresh;
    this.username = blob.username;
    this.method = blob.method ?? "password";
    this.userKeyPassphrases = blob.userKeyPassphrases ?? {};
    // A browser sign-in's vault password is not the account's; its key password is
    // what every remembered passphrase holds.
    if (this.method === "browser") {
      this.password = "";
      this.keyPassword = Object.values(this.userKeyPassphrases)[0] ?? "";
    } else {
      this.password = password;
    }
  }

  /**
   * The blob `persistSession` seals into the encrypted app store. It carries the
   * derived key passphrases, mirroring the SDK's own session-secret cache. The
   * account password itself is never written anywhere. Private on purpose: these
   * are the tokens and the passphrases that unlock the Proton private keys, so
   * they must never be reachable over the RPC channel.
   */
  private getPersistable(): PersistableSession | null {
    if (!this.session) return null;
    return {
      uid: this.session.uid,
      accessToken: this.session.accessToken,
      refreshToken: this.session.refreshToken ?? "",
      username: this.username,
      userKeyPassphrases: this.userKeyPassphrases,
      method: this.method,
      ...(this.email ? { email: this.email } : {}),
    };
  }

  /**
   * A new sign-in has no saved session to come back to, so a network that drops at its
   * last step is reported as an error to try again, not as a session left waiting.
   */
  private async finishFreshLogin(): Promise<LoginResult> {
    const result = await this.finishLogin();
    if (result.status !== "offline") return result;
    return { status: "error", error: "Proton could not be reached. Please try again." };
  }

  /**
   * The http client's refresh of `live`, run under the session lock. When another process on
   * this store folder renewed the session since we last saw it, its tokens are taken up
   * instead: spending ours would only be refused, and end the session here.
   */
  private renewLive(live: Session, refresh: () => Promise<void>): Promise<void> {
    return this.underSessionLock(async () => {
      const newer = this.newerSaved(this.readSavedSession(), live.uid, live.refreshToken);
      if (newer) {
        diag.log("session", "token_adopted", { pid: process.pid, token: tokenTag(newer.refreshToken) });
        live.accessToken = newer.accessToken;
        live.refreshToken = newer.refreshToken;
        this.savedRefresh = newer.refreshToken;
        return;
      }
      await refresh();
    });
  }

  private async finishLogin(): Promise<LoginResult> {
    const live = this.session!;
    try {
      const account = await this.buildAccount();
      const sdkBase = {
        httpClient: withListingTap(
          makeSdkHttpClient(
            live,
            () => this.persistSession(),
            () => {
              if (this.session === live) this.sessionLost();
            },
            // A call still running after a lock or a sign-out must not swap the saved refresh token.
            () => this.session === live && isReady(),
            (refresh) => this.renewLive(live, refresh),
          ),
        ),
        account,
        openPGPCryptoModule: makeOpenPGPCryptoModule(),
        // Read per call, so a token refresh (which rewrites the session in
        // place) is picked up without rebuilding the client.
        srpModule: makeSrpModule(async () => {
          if (!this.session) throw new Error("Not signed in");
          return randomModulus(this.session);
        }),
        // Silent telemetry. The SDK otherwise logs every API path and node UID
        // through `getLogger`, and could hand metrics (which carry node UIDs) to
        // `recordMetric`. No-ops keep all of that off disk and off the network.
        telemetry: {
          getLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
          recordMetric: () => {},
        },
      };
      this.photos = new ProtonDrivePhotosClient({
        ...sdkBase,
        entitiesCache: new BoundedCache(ENTITY_CACHE_LIMIT),
        cryptoCache: new BoundedCache(CRYPTO_CACHE_LIMIT),
      } as any);
      this.sdkBase = sdkBase;
      this.sessionClient = sdkBase.httpClient;
      const primary = await account.getOwnPrimaryAddress();
      this.email = primary.email;
      // Another account signing in where a lapsed one left its vault open inherits nothing:
      // the vault goes as at sign-out, and this sign-in is sealed afresh like a first one.
      // Only keys that share nothing are another account; with nothing to compare, the vault stays.
      if (this.reloginKeys && isReady() && accountMatch(this.reloginKeys, Object.keys(this.userKeyPassphrases)) === "different") {
        this.forgetPreviousAccount();
        this.switchedAccount = true;
      }
      this.reloginKeys = null;
      this.watchSession();
      // Persist the session (rotated refresh token included) whenever the vault is
      // open, so a cold start can resume without a full re-login.
      if (isReady()) this.persistSession();
      if (isReady()) this.attachFaceScan();
      if (isReady()) this.photoEvents.start();
      return { status: "ok", email: primary.email };
    } catch (e) {
      if (isTransient(e)) return { status: "offline" };
      return { status: "error", error: (e as Error).message };
    }
  }

  private async buildAccount() {
    const s = this.session!;
    const password = this.password;

    // The salts turn the account password into the key password. A browser sign-in
    // is handed the key password itself, and its session may not read them: Proton
    // grants that only for a while after a password sign-in.
    const [userRes, addrRes, saltRes] = await Promise.all([
      ProtonApi.getUser(s),
      ProtonApi.getAddresses(s),
      this.method === "browser" ? Promise.resolve({ KeySalts: [] }) : ProtonApi.getKeySalts(s),
    ]);

    const user: any = (userRes as any).User ?? {};
    const addresses: any[] = ((addrRes as any).Addresses ?? []).slice().sort((a: any, b: any) => a.Order - b.Order);
    const salts: any[] = (saltRes as any).KeySalts ?? [];
    const saltById = new Map<string, string>(salts.map((x: any) => [x.ID, x.KeySalt]));

    // Unlock the user's private keys, either from a remembered passphrase (resume)
    // or by deriving it from the mailbox password (fresh sign-in).
    const userKeys: any[] = [];
    for (const uk of user.Keys ?? []) {
      let passphrase = this.userKeyPassphrases[uk.ID] || this.keyPassword;
      if (!passphrase) {
        const salt = saltById.get(uk.ID);
        if (!salt || !password) continue;
        passphrase = await computeKeyPassword(password, salt);
      }
      try {
        userKeys.push(await CryptoProxy.importPrivateKey({ armoredKey: uk.PrivateKey, passphrase } as any));
        this.userKeyPassphrases[uk.ID] = passphrase;
      } catch {
        delete this.userKeyPassphrases[uk.ID];
      }
    }
    if (userKeys.length === 0) {
      throw new Error("Could not unlock your account keys (wrong password, or two-password mode?)");
    }
    // The password has served its purpose; only the derived passphrases are kept.
    this.password = "";
    const keyPassword = this.keyPassword;
    this.keyPassword = "";

    // Unlock each address key: its Token is a message encrypted to the user key.
    const accountAddresses: AccountAddress[] = [];
    for (const addr of addresses) {
      if (addr.Status !== 1) continue;
      const keys: { id: string; key: any }[] = [];
      let primaryKeyIndex = 0;
      for (const ak of addr.Keys ?? []) {
        try {
          let passphrase: string;
          if (ak.Token) {
            const dec: any = await CryptoProxy.decryptMessage({
              armoredMessage: ak.Token,
              decryptionKeys: userKeys,
              format: "utf8",
            } as any);
            passphrase = dec.data;
          } else {
            const salt = saltById.get(ak.ID);
            passphrase = keyPassword || (salt ? await computeKeyPassword(password, salt) : password);
          }
          const key = await CryptoProxy.importPrivateKey({ armoredKey: ak.PrivateKey, passphrase } as any);
          keys.push({ id: ak.ID, key });
          if (ak.Primary === 1) primaryKeyIndex = keys.length - 1;
        } catch {
          /* skip this key */
        }
      }
      if (keys.length > 0) {
        accountAddresses.push({ email: addr.Email, addressId: addr.ID, primaryKeyIndex, keys });
      }
    }
    if (accountAddresses.length === 0) {
      throw new Error("Could not unlock any address keys");
    }

    // Verification keys are looked up per address and cached for the session.
    const publicKeyCache = new Map<string, any[]>();

    const fetchPublicKeys = async (email: string): Promise<any[]> => {
      // `InternalOnly=1` keeps the lookup inside Proton's own directory, which is
      // what makes an empty answer mean "no Proton account" rather than "no keys
      // published anywhere".
      const res: any = await ProtonApi.getAddressPublicKeys(s, email);
      const armored = [...(res?.Address?.Keys ?? []), ...(res?.CatchAll?.Keys ?? [])]
        .map((k: any) => k?.PublicKey)
        .filter((k: unknown): k is string => typeof k === "string" && k.length > 0);
      return Promise.all(
        armored.map((armoredKey) => CryptoProxy.importPublicKey({ armoredKey } as any)),
      );
    };

    /**
     * An address's Proton keys, cached for the session. Two callers depend on it:
     * signature verification, where a lookup failure degrades to "cannot verify"
     * rather than blocking a photo from rendering, and `hasProtonAccount`, where
     * an empty list is the answer itself.
     */
    const getPublicKeys = async (email: string, forceRefresh = false): Promise<any[]> => {
      const key = email.toLowerCase();
      if (!forceRefresh && publicKeyCache.has(key)) return publicKeyCache.get(key)!;
      try {
        const keys = await fetchPublicKeys(email);
        publicKeyCache.set(key, keys);
        return keys;
      } catch (e) {
        // An address with no Proton account answers 33102, which is an answer and
        // not a fault, so it is not worth a line. Anything else is, but only its
        // status: the API's wording quotes the address, and that never goes to
        // the log.
        const err = e as { status?: number; code?: number };
        if (err.code !== NO_SUCH_PROTON_ADDRESS) {
          process.stderr.write(
            `[sidecar] getPublicKeys failed (status ${err.status ?? "?"}, code ${err.code ?? "?"})\n`,
          );
        }
        return [];
      }
    };

    // The ProtonDriveAccount contract the SDK consumes.
    return {
      getOwnPrimaryAddress: async () => accountAddresses[0],
      getOwnAddresses: async () => accountAddresses,
      getOwnAddress: async (emailOrId: string) => {
        const a = accountAddresses.find((x) => x.email === emailOrId || x.addressId === emailOrId);
        if (!a) throw new Error(`No address for ${emailOrId}`);
        return a;
      },
      /**
       * Whether an address can be invited as a Proton user. The SDK asks before
       * sharing and sends one of two invitations on the answer: an encrypted one
       * to a Proton account's keys, or a signed external one to an address
       * without them. Answering a blanket "yes" would send every non-Proton
       * invitee down the encrypted path, which has no key to encrypt to.
       */
      hasProtonAccount: async (email: string) => (await getPublicKeys(email)).length > 0,
      getPublicKeys: (email: string, forceRefresh = false) => getPublicKeys(email, forceRefresh),
    };
  }

  /** When the face scan's last listing of the library began, the window's read or its own (ms). */
  private scanListedAt = 0;

  /**
   * The library for a face scan pass: the window's own read of the timeline when it is newer
   * than the scan's last listing (waited for if still under way), else read afresh. After an
   * unlock both would read it at once; but a read older than the scan's last would hide photos
   * added since, whose faces the pass would then forget, so a later pass lists again.
   */
  private async timelineForScan(): Promise<TimelineItem[]> {
    const deadline = Date.now() + SCAN_WAITS_FOR_TIMELINE_MS;
    // The first listing of a session: the window starts its read as it opens, perhaps a
    // moment after the scan is handed the library, so a little while is given for it to begin.
    if (!this.timelineRun && this.scanListedAt === 0) {
      const appears = Date.now() + SCAN_WAITS_FOR_RUN_TO_START_MS;
      while (!this.timelineRun && Date.now() < appears) await new Promise((r) => setTimeout(r, 250));
    }
    // The run under way is followed to its end, the one replacing it as well.
    for (let run = this.timelineRun; run && !run.offline; run = this.timelineRun) {
      if (!run.done && run.ended) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          run.ended,
          new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now())))),
        ]).finally(() => clearTimeout(timer));
      }
      if (this.timelineRun !== run) {
        if (Date.now() < deadline) continue;
        break;
      }
      // Begun after the scan's last listing began, and lately: it holds everything that one
      // did, and is not so old that photos added since would be missing from it.
      if (
        run.done &&
        !run.error &&
        (run.startedAt ?? 0) > this.scanListedAt &&
        Date.now() - (run.startedAt ?? 0) < SCAN_REUSES_TIMELINE_FOR_MS
      ) {
        this.scanListedAt = run.startedAt!;
        return run.items;
      }
      break;
    }
    const started = Date.now();
    const items = await this.getTimeline();
    this.scanListedAt = started;
    return items;
  }

  /** Hands the face scan this account's library to read, and the way to its copy on Drive. */
  private attachFaceScan(): void {
    // A new session's library: whatever the scan listed before is not of it.
    this.scanListedAt = 0;
    const photos = this.photos;
    const base = this.sdkBase;
    if (!photos || !base) return;
    faceScanner.setSource({
      listUids: async () => (await this.timelineForScan()).map((item) => item.uid),
      pictures: (uids, ahead) => this.scanPictures(photos, uids, ahead),
      listTrashed: async () => {
        const links = new Set<string>();
        for await (const uid of withStallGuard(photos.iterateTrashedNodeUids(), SDK_STALL_MS, "iterateTrashedNodeUids")) {
          const text = String(uid);
          links.add(text.slice(text.indexOf("~") + 1));
        }
        return links;
      },
      stamps: async (uids) => {
        // Nodes fresh from the server: the long-lived client's cache would not see a revision written elsewhere.
        const fresh = new ProtonDrivePhotosClient({
          ...base,
          entitiesCache: new BoundedCache(ENTITY_CACHE_LIMIT),
          cryptoCache: new BoundedCache(CRYPTO_CACHE_LIMIT),
        } as any);
        const out = new Map<string, string>();
        for await (const node of withStallGuard(fresh.iterateNodes(uids), SDK_STALL_MS, "iterateNodes(stamps)")) {
          const revision = activeRevisionOf(node)?.uid;
          if (!(node as any).missingUid && revision) out.set((node as any).uid, String(revision));
        }
        return out;
      },
      // As on the phone, a hidden photo's faces are neither looked for nor shared.
      hiddenTest: () => hiddenStore.hiddenPhotoTest(),
    });
    duplicateFinder.setSource({
      // As on the phone, a hidden photo is in no group.
      list: async () => {
        const hidden = hiddenStore.hiddenPhotoTest();
        return (await this.getTimeline()).filter((item) => !hidden(item.uid)).map((item) => ({ uid: item.uid, captureTime: item.captureTime }));
      },
      thumbnails: (uids) => this.duplicateThumbnails(photos, uids),
      // Also a photo hidden after the scan, here or on another device.
      hiddenTest: () => hiddenStore.hiddenPhotoTest(),
      hiddenVersion: () => hiddenStore.version,
    });
    faceScanner.setDriveWriter(
      (copy, all) =>
        this.upload(
          "faces",
          writeFaceCopy({ ...copy, createdAt: 0 }),
          writeFaceCopy(copy),
          ML_FOLDER,
          facesFileName(copy.deviceId),
          copy.createdAt,
          all,
        ),
      (copy, all) =>
        this.upload(
          "search",
          writeSearchCopy({ ...copy, createdAt: 0 }),
          writeSearchCopy(copy),
          ML_FOLDER,
          searchFileName(copy.deviceId),
          copy.createdAt,
          all,
        ),
      () => this.backup.changed(),
    );
    dateEditor.attach({
      photos,
      addToAlbum: (albumUid, uids) => this.addPhotosToAlbum(albumUid, uids),
      trash: (uids) => this.trashPhotos(uids),
      carry: (oldUid, newUid) => this.carryToCopy(oldUid, newUid),
    });
    cloudCompressor.attach({
      photos,
      addToAlbum: (albumUid, uids) => this.addPhotosToAlbum(albumUid, uids),
      trash: (uids) => this.trashPhotos(uids),
      carry: (oldUid, newUid) => this.carryToCopy(oldUid, newUid),
      isHidden: (uid) => hiddenStore.hiddenPhotoTest()(uid),
    });
  }

  // ---- Compress on Drive (cloudCompress.ts) ----

  /** Queues photos to be replaced by lighter copies; answers at once, the window follows `cloudCompressStatus`. */
  startCloudCompress(uids: string[]): CompressStatus {
    if (!this.photos) throw new Error("Not signed in");
    return cloudCompressor.start(uids);
  }

  cloudCompressStatus(): CompressStatus {
    return cloudCompressor.getStatus();
  }

  stopCloudCompress(): CompressStatus {
    return cloudCompressor.stop();
  }

  // ---- The GIF maker (gif.ts) ----

  gifBegin(width: number, height: number): { job: string } {
    if (!this.photos) throw new Error("Not signed in");
    return gifBegin(width, height);
  }

  gifFrame(job: string, index: number, base64: string): { count: number } {
    return gifFrame(job, index, base64);
  }

  gifCancel(job: string): void {
    gifCancel(job);
  }

  /** Joins the frames and uploads the GIF as a new photo with the video's date. */
  async gifFinish(job: string, sourceUid: string): Promise<{ uid: string; size: number }> {
    if (!this.photos) throw new Error("Not signed in");
    return gifFinish(this.photos, job, sourceUid);
  }

  // ---- Changing photos' dates (dateEdit.ts) ----

  /** What the date editor shows of each photo: its name, date, the date its name records, whether it can change. */
  async dateEditInfo(uids: string[]): Promise<DateEditInfo[]> {
    if (!this.photos) throw new Error("Not signed in");
    return readDateEditInfo(this.photos, uids);
  }

  /** What the description and strip panels show of each photo; `read` also reads the text of one photo's file. */
  async metaInfo(uids: string[], read: boolean): Promise<MetaInfo[]> {
    if (!this.photos) throw new Error("Not signed in");
    return readMetaInfo(this.photos, uids, read && uids.length === 1);
  }

  /** Queues photos for a new capture date or place; answers at once, the window follows `dateEditStatus`. */
  startDateEdit(items: DateEditItem[]): DateEditStatus {
    if (!this.photos) throw new Error("Not signed in");
    return dateEditor.start(items);
  }

  dateEditStatus(): DateEditStatus {
    return dateEditor.getStatus();
  }

  stopDateEdit(): DateEditStatus {
    return dateEditor.stop();
  }

  /**
   * Moves what this computer keeps by a photo to the copy that replaced it: hidden, labels, faces,
   * the search index, kept offline, and an album cover. Each part on its own, so one that fails
   * costs that part and never the date change, as on the phone.
   */
  private async carryToCopy(oldUid: string, newUid: string): Promise<void> {
    const step = async (what: string, run: () => unknown) => {
      try {
        await run();
      } catch (e) {
        process.stderr.write(`[dateedit] carrying the ${what} over failed: ${(e as Error)?.message ?? e}\n`);
      }
    };
    const link = (uid: string) => uid.slice(uid.indexOf("~") + 1);
    await step("hidden mark", () => hiddenStore.rekeyPhoto(oldUid, newUid));
    await step("labels", () =>
      labelStore.change((state) => rekeyLabels(state, link(oldUid), link(newUid), Date.now()), (moved) => moved),
    );
    await step("faces", () => {
      const store = faceScanner.store;
      const moved = store.movePhoto(oldUid, newUid);
      if (!moved) return;
      rekeyPeople(store.people, oldUid, newUid, moved.ids, moved.merged);
      store.markPeople();
      store.edits++;
      faceScanner.changed();
    });
    await step("search index", () => {
      if (faceScanner.search.move(oldUid, newUid)) faceScanner.search.flush();
    });
    await step("scan record", () => {
      if (!faceScanner.misses.isLoaded()) faceScanner.misses.load();
      faceScanner.misses.move(oldUid, newUid);
      faceScanner.misses.flush();
    });
    await step("offline copy", () => {
      if (!isPinned(oldUid) || !this.photos) return;
      runPinOffline(this.photos, [newUid]);
      runUnpinOffline([oldUid]);
    });
    await step("album cover", async () => {
      if (!this.photos) return;
      for (const album of await readAlbums(this.photos)) {
        if (album.coverUid === oldUid) await runSetAlbumCover(this.photos, album.uid, newUid);
      }
    });
    this.backup.changed();
  }

  /** The Drive client for My files, made the first time it is needed. */
  private myFilesClient(): any {
    if (!this.sdkBase) throw new Error("Not signed in");
    if (!this.myFiles) {
      this.myFilesKeys = new BoundedCache(CRYPTO_CACHE_LIMIT);
      this.myFiles = new ProtonDriveClient({
        ...this.sdkBase,
        entitiesCache: new BoundedCache(ENTITY_CACHE_LIMIT),
        cryptoCache: this.myFilesKeys,
      } as any);
    }
    return this.myFiles;
  }

  /**
   * A Drive client for one read or save of the shared backup, whose nodes come fresh from the
   * server: the long-lived client's node cache never learns of a revision, a file or a folder
   * another device wrote. The decrypted keys, which a new revision does not change, are shared.
   */
  private backupClient(): any {
    this.myFilesClient();
    return new ProtonDriveClient({
      ...this.sdkBase,
      entitiesCache: new BoundedCache(ENTITY_CACHE_LIMIT),
      cryptoCache: this.myFilesKeys,
    } as any);
  }

  /**
   * What the scan reads for `uids`, as the phone reads it: a photo's full-resolution original,
   * downloaded into memory and dropped once read (or the copy kept offline, when there is one),
   * and the large preview of a video, or of a photo in a format this side cannot decode. The
   * next originals, up to `ahead` at once, download while the one before is read. A photo whose
   * download failed for now comes back with a transient miss, to wait and be asked for again.
   */
  private async *scanPictures(
    photos: any,
    uids: string[],
    ahead = SCAN_DOWNLOADS_AHEAD,
  ): AsyncGenerator<ScanPicture> {
    ahead = Math.max(1, Math.min(SCAN_DOWNLOADS_MAX, Math.floor(ahead) || SCAN_DOWNLOADS_AHEAD));
    let types = new Map<string, string | null>();
    try {
      types = await resolveMediaTypesBatch(photos, uids);
    } catch {
      /* the type is read off each node below instead */
    }
    const previewOnly: string[] = [];
    const originals: string[] = [];
    for (const uid of uids) {
      const type = (types.get(uid) ?? metaGet(uid)?.mediaType ?? "").toLowerCase();
      if (type.startsWith("image/") && !PREVIEW_ONLY_TYPES.has(type)) originals.push(uid);
      else previewOnly.push(uid);
    }
    // Why an original was passed over for its preview: the cause of a photo with no preview either.
    const passedOver = new Map<string, ScanMiss>();
    const fetchOne = async (uid: string): Promise<Buffer | ScanMiss> => {
      const kept = originalGet(uid);
      if (kept) return kept;
      try {
        const { downloader, unused } = await openDownloader(photos, uid);
        const claimed = downloader.getClaimedSizeInBytes?.() ?? 0;
        if (claimed > SCAN_ORIGINAL_MAX_BYTES) {
          unused();
          return missFor("unreadable:tooLarge");
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        const sink = new WritableStream<Uint8Array>({
          write(chunk) {
            total += chunk.byteLength;
            if (total > SCAN_ORIGINAL_MAX_BYTES) throw new ScanTooLarge();
            chunks.push(chunk);
          },
        });
        await downloader.downloadToStream(sink as any).completion();
        return Buffer.concat(chunks);
      } catch (e) {
        return e instanceof ScanTooLarge ? missFor("unreadable:tooLarge") : failureOf(e);
      }
    };
    // A few downloads under way at once, taken in order, so the next originals are arriving
    // while one is read.
    const inFlight: (Promise<Buffer | ScanMiss> | null)[] = originals.slice(0, ahead).map(fetchOne);
    for (let i = 0; i < originals.length; i++) {
      const uid = originals[i];
      const got = (await inFlight[i])!;
      // Let go here, so a read original is held only by the scan until it is decoded.
      inFlight[i] = null;
      if (i + ahead < originals.length) inFlight.push(fetchOne(originals[i + ahead]));
      if (!Buffer.isBuffer(got)) {
        // The connection failed, not the photo: its preview would come the same way.
        if (onTheWay(got)) {
          yield { uid, bytes: null, miss: got };
          continue;
        }
        passedOver.set(uid, got);
      } else if (got.length === 0) {
        passedOver.set(uid, missFor("empty"));
      } else if (await decodable(got)) {
        yield { uid, bytes: got };
        continue;
      } else {
        passedOver.set(uid, missFor("undecodable"));
      }
      previewOnly.push(uid);
    }
    if (previewOnly.length) yield* this.scanPreviews(photos, previewOnly, passedOver);
  }

  /**
   * The small thumbnails the duplicate finder fingerprints: the cached ones first, the rest
   * fetched and cached, as the grid would. It waits while the grid has thumbnails of its own
   * waiting, so a page on screen is never held up by it. A photo a fetch did not answer is left
   * out and asked for again.
   */
  private async *duplicateThumbnails(photos: any, uids: string[]): AsyncGenerator<{ uid: string; bytes: Buffer | null }> {
    const missing: string[] = [];
    for (const uid of uids) {
      const cached = thumbGet(uid, ThumbnailType.Type1);
      if (cached) yield { uid, bytes: cached };
      else missing.push(uid);
    }
    if (missing.length === 0) return;
    for (let waited = 0; this.thumbWaiting.size > 0 && waited < 20; waited++) await new Promise((r) => setTimeout(r, 250));
    try {
      for await (const r of withStallGuard(
        photos.iterateThumbnails(missing, ThumbnailType.Type1),
        THUMBNAIL_STALL_MS,
        "iterateThumbnails(duplicates)",
      )) {
        const uid = (r as any).nodeUid;
        if ((r as any).ok) {
          const bytes = Buffer.from((r as any).thumbnail);
          thumbPut(uid, ThumbnailType.Type1, bytes);
          yield { uid, bytes };
        } else if (!isTransient((r as any).error)) {
          yield { uid, bytes: null };
        }
      }
    } catch (e) {
      if (!isStall(e) && !isTransient(e)) throw e;
    }
  }

  /**
   * The large previews of `uids` for the face scan: the cached ones first, the rest fetched and
   * not cached, since a scan reads the whole library once. A photo without a large preview
   * falls back to its small one. One a fetch did not answer (a stall, a network error) comes back
   * with its miss, so the scan asks for it again later instead of taking it for a photo without
   * faces; one with neither size comes back with the miss of its original when that was passed
   * over first (`passedOver`), else of its preview.
   */
  private async *scanPreviews(
    photos: any,
    uids: string[],
    passedOver: Map<string, ScanMiss> = new Map(),
  ): AsyncGenerator<ScanPicture> {
    const missing: string[] = [];
    for (const uid of uids) {
      const cached = thumbGet(uid, ThumbnailType.Type2);
      if (cached) yield { uid, bytes: cached };
      else missing.push(uid);
    }
    const causes = new Map(passedOver);
    // Large previews first; the photos that have none are asked for their small one.
    let ask = missing;
    for (const type of [ThumbnailType.Type2, ThumbnailType.Type1]) {
      if (ask.length === 0) return;
      const without: string[] = [];
      const answered = new Set<string>();
      const yielded = new Set<string>();
      try {
        for await (const r of withStallGuard(
          photos.iterateThumbnails(ask, type),
          THUMBNAIL_STALL_MS,
          "iterateThumbnails(faces)",
        )) {
          const uid = (r as any).nodeUid;
          answered.add(uid);
          if ((r as any).ok) {
            yielded.add(uid);
            yield { uid, bytes: Buffer.from((r as any).thumbnail) };
            continue;
          }
          const miss = failureOf((r as any).error);
          // A network error is not a missing preview: that photo waits and is asked for again.
          if (onTheWay(miss)) {
            yielded.add(uid);
            yield { uid, bytes: null, miss };
            continue;
          }
          if (!causes.has(uid)) causes.set(uid, miss);
          without.push(uid);
        }
      } catch (e) {
        if (!isStall(e) && !isTransient(e)) throw e;
        // Every photo of this read not yet settled waits; one already answered for the last size has its own miss.
        const miss = failureOf(e);
        const last = type === ThumbnailType.Type1;
        for (const uid of ask) {
          if (yielded.has(uid)) continue;
          const own = last && without.includes(uid) ? (causes.get(uid) ?? missFor("metadata")) : miss;
          yield { uid, bytes: null, miss: own };
        }
        return;
      }
      for (const uid of ask) if (!answered.has(uid)) yield { uid, bytes: null, miss: missFor("metadata:unanswered") };
      ask = without;
    }
    // Neither size there: a photo the scan has nothing to read in.
    for (const uid of ask) yield { uid, bytes: null, miss: causes.get(uid) ?? missFor("metadata") };
  }

  /** The whole timeline in one answer, for callers that need it complete. */
  async getTimeline(): Promise<TimelineItem[]> {
    const out: TimelineItem[] = [];
    for await (const item of this.timelineItems()) out.push(item);
    return out;
  }

  /**
   * The timeline, newest first, one item at a time as the SDK pages it in. Stops at a
   * sanity ceiling far past any personal library, and says so in the log, with the
   * count and nothing else.
   */
  private async *timelineItems(): AsyncGenerator<TimelineItem> {
    if (!this.photos) throw new Error("Not signed in");
    // Resolving the root first is what surfaces a missing photos volume as an error
    // here, rather than as an empty timeline.
    await this.photos.getMyPhotosRootFolder();
    let count = 0;
    for await (const item of withStallGuard(
      this.photos.iterateTimeline(),
      SDK_STALL_MS,
      "iterateTimeline(getTimeline)",
    )) {
      const uid = (item as any).uid ?? (item as any).nodeUid;
      const ct = (item as any).captureTime;
      const captureTime = ct instanceof Date ? ct.getTime() : Number(ct) * 1000;
      yield { uid, captureTime, tags: ((item as any).tags ?? []) as number[] };
      if (++count >= TIMELINE_CEILING) {
        process.stderr.write(`[sidecar] timeline reached ${TIMELINE_CEILING} items, the rest is not shown\n`);
        return;
      }
    }
  }

  /** Open on the photos kept offline only: the vault is open, but Proton could not be reached
   *  to resume the session, and the window tries again on its own. */
  private get offlineOnly(): boolean {
    return !this.photos && this.offlineResume !== null && isReady();
  }

  /** Whether the account is open on the photos kept offline only, for the RPC layer's errors. */
  isOfflineOnly(): boolean {
    return this.offlineOnly;
  }

  /** The timeline read in progress, which `timelinePage` answers from. */
  private timelineRun: TimelineRun | null = null;
  private timelineRuns = 0;

  /**
   * Starts reading the timeline in the background and returns at once. The window
   * then asks for it page by page with `timelinePage`, so a large library paints its
   * first screen while the rest is still arriving, and no single answer has to carry
   * all of it. A new start replaces the run before it.
   */
  startTimeline(): { run: number } {
    if (!this.photos && this.offlineOnly) {
      const run: TimelineRun = { id: ++this.timelineRuns, items: offlineLibrary(), done: true, error: null, offline: true };
      this.timelineRun = run;
      return { run: run.id };
    }
    if (!this.photos) throw new Error("Not signed in");
    const run: TimelineRun = { id: ++this.timelineRuns, items: [], done: false, error: null, startedAt: Date.now() };
    this.timelineRun = run;
    run.ended = (async () => {
      try {
        for await (const item of this.timelineItems()) {
          if (this.timelineRun !== run) return;
          run.items.push(item);
        }
        // Kept for a start with no network, where these photos are all the timeline there is.
        noteOfflineTimes(run.items);
      } catch (e) {
        run.error = (e as Error).message;
      }
      run.done = true;
    })();
    return { run: run.id };
  }

  /**
   * What has arrived of a timeline read from `offset` on, at most `limit` items.
   * `done` once the read has finished and this page reaches its end; `error` then says
   * why it stopped early, if it did.
   */
  timelinePage(runId: number, offset: number, limit: number): TimelinePage {
    const run = this.timelineRun;
    if (!run || run.id !== runId) throw new Error("This timeline read was replaced");
    const items = run.items.slice(offset, offset + Math.max(1, limit));
    const done = run.done && offset + items.length >= run.items.length;
    return { items, done, error: done ? run.error : null };
  }

  /** Uncached thumbnails asked for over the thumbnail server, gathered into one fetch. */
  private thumbWaiting = new Map<string, ((bytes: Buffer | null) => void)[]>();
  /**
   * People's covers cut to their faces, from the HD preview (the grid thumbnail when a
   * photo has none, or the preview cannot be had), for the thumbnail server.
   */
  private faceCovers = new FaceCovers(
    async (uid) => {
      const preview = await this.previewBytes(uid).catch(() => null);
      if (preview) return { bytes: preview, keep: true };
      const thumb = thumbGet(uid, ThumbnailType.Type1);
      return thumb ? { bytes: thumb, keep: false } : null;
    },
    // A small circle is cut from the grid thumbnail, and every cut is kept sealed for the
    // next run: a page of hundreds of faces no longer fetches a preview for each, each time.
    { thumbnail: (uid, gone) => this.thumbnailFor(uid, gone), disk: { get: coverGet, put: coverPut } },
  );
  /** Videos the window is playing, for the thumbnail server: see `videoSource`. */
  private videos = new OpenVideos((uid, signal) => this.videoSource(uid, signal));
  /** The trash as last read, shared by the window and the drive's listing: see `TrashListing`. */
  private trash = new TrashListing();
  /**
   * The photos volume's event feed, read from the last event taken in: a change made on another
   * device tells the window to read the timeline again. Runs while signed in with the vault open.
   */
  private photoEvents = new PhotoEvents(
    (scope, lastEventId, signal) => {
      const photos = this.photos;
      if (!photos) throw new NotReadyError();
      return photos.iterateEvents(scope, lastEventId, signal) as AsyncIterable<FeedEvent>;
    },
    async () => {
      const photos = this.photos;
      if (!photos) throw new NotReadyError();
      return (await photos.getMyPhotosRootFolder()).treeEventScopeId;
    },
    sealedAnchorStore(),
    () => hostNotice("timelineChanged"),
  );
  private thumbFlush: ReturnType<typeof setTimeout> | null = null;
  private thumbFetching = 0;

  /**
   * Starts the loopback thumbnail server for the window and returns the URL base it
   * appends a uid to. A fresh token each time, so a base from before a lock is dead.
   */
  async thumbServer(): Promise<{ base: string }> {
    if (!this.photos && !this.offlineOnly) throw new Error("Not signed in");
    return {
      base: await startThumbServer(
        (uid, gone) => this.thumbnailFor(uid, gone),
        (uid, box, gone, side) => this.faceCovers.get(uid, box, gone, side),
        (uid) => this.videos.get(uid),
      ),
    };
  }

  /**
   * One grid thumbnail for the server: from the sealed cache when it is there, which is
   * a file read and a decrypt, and otherwise fetched with whichever others are missing
   * at the same moment, so a screen of new photos is one request rather than one each.
   * A tile the webview stopped waiting for leaves the queue unfetched.
   */
  private thumbnailFor(uid: string, gone: AbortSignal): Promise<Buffer | null> {
    if (gone.aborted) return Promise.resolve(null);
    const cached = thumbGet(uid, ThumbnailType.Type1);
    if (cached) return Promise.resolve(cached);
    if (!this.photos) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiting = this.thumbWaiting.get(uid);
      if (waiting) waiting.push(resolve);
      else this.thumbWaiting.set(uid, [resolve]);
      gone.addEventListener(
        "abort",
        () => {
          const still = this.thumbWaiting.get(uid);
          if (!still?.includes(resolve)) return;
          still.splice(still.indexOf(resolve), 1);
          if (still.length === 0) this.thumbWaiting.delete(uid);
          resolve(null);
        },
        { once: true },
      );
      if (!this.thumbFlush) this.thumbFlush = setTimeout(() => this.fetchWaitingThumbs(), 15);
    });
  }

  /**
   * Fetches up to 30 waiting thumbnails, two batches at most in flight, the latest asked
   * first: after a long scroll those are the ones on screen.
   */
  private async fetchWaitingThumbs(): Promise<void> {
    this.thumbFlush = null;
    if (this.thumbFetching >= 2 || this.thumbWaiting.size === 0) return;
    const photos = this.photos;
    const batch = [...this.thumbWaiting.keys()].slice(-30);
    const answers = new Map<string, ((bytes: Buffer | null) => void)[]>();
    for (const uid of batch) {
      answers.set(uid, this.thumbWaiting.get(uid)!);
      this.thumbWaiting.delete(uid);
    }
    const answer = (uid: string, bytes: Buffer | null) => {
      for (const resolve of answers.get(uid) ?? []) resolve(bytes);
      answers.delete(uid);
    };
    this.thumbFetching++;
    // A second batch may run beside this one when more are already waiting.
    if (this.thumbWaiting.size > 0 && this.thumbFetching < 2 && !this.thumbFlush) {
      this.thumbFlush = setTimeout(() => this.fetchWaitingThumbs(), 0);
    }
    try {
      if (!photos) throw new Error("locked");
      for await (const r of withStallGuard(
        photos.iterateThumbnails(batch, ThumbnailType.Type1),
        THUMBNAIL_STALL_MS,
        "iterateThumbnails",
      )) {
        const uid = (r as any).nodeUid;
        if ((r as any).ok) {
          const bytes = Buffer.from((r as any).thumbnail);
          thumbPut(uid, ThumbnailType.Type1, bytes);
          answer(uid, bytes);
        } else {
          answer(uid, null);
        }
      }
    } catch {
      /* a failed or stalled batch answers nothing for what is left; the cell keeps its placeholder */
    } finally {
      for (const uid of [...answers.keys()]) answer(uid, null);
      this.thumbFetching--;
      if (this.thumbWaiting.size > 0 && !this.thumbFlush) {
        this.thumbFlush = setTimeout(() => this.fetchWaitingThumbs(), 0);
      }
    }
  }

  /**
   * Grid thumbnails, served from the encrypted on-disk cache when present.
   *
   * Every cached one in the request is answered, however many: each is a file read and
   * a decrypt, well under a millisecond. Only the first few missing ones are fetched,
   * because a fetch is a network round trip that holds the channel, and a viewer opening
   * must never wait behind a long one. The rest come back with no entry, which the grid
   * reads as "ask again", so a screen of cached tiles costs one call instead of several.
   */
  async getThumbnails(
    uids: string[],
    fetchLimit = THUMBNAIL_FETCH_PER_CALL,
    signal?: AbortSignal,
  ): Promise<{ uid: string; dataUrl: string | null }[]> {
    if (!this.photos && this.offlineOnly) {
      return uids.map((uid) => {
        const cached = thumbGet(uid, ThumbnailType.Type1);
        return { uid, dataUrl: cached ? toDataUrl(cached) : null };
      });
    }
    if (!this.photos) throw new Error("Not signed in");
    const out: { uid: string; dataUrl: string | null }[] = [];
    const missing: string[] = [];

    for (const uid of uids) {
      const cached = thumbGet(uid, ThumbnailType.Type1);
      if (cached) out.push({ uid, dataUrl: toDataUrl(cached) });
      else if (missing.length < fetchLimit) missing.push(uid);
    }
    if (missing.length === 0) return out;

    // Guarded: a batch of eight was once seen entering this loop and never leaving,
    // holding the host's single RPC channel until its 300s deadline killed the
    // sidecar. See stallGuard.ts. A stall keeps whatever resolved and drops the rest
    // -- the uids left out carry no entry, which is exactly what the caller already
    // sees when a whole batch fails (useThumbnails.ts swallows that and moves on), so
    // this needs no new handling there and the next pass asks for them again.
    try {
      for await (const r of withStallGuard(
        this.photos.iterateThumbnails(missing, ThumbnailType.Type1, signal),
        THUMBNAIL_STALL_MS,
        "iterateThumbnails",
      )) {
        const uid = (r as any).nodeUid;
        if ((r as any).ok) {
          const bytes = Buffer.from((r as any).thumbnail);
          thumbPut(uid, ThumbnailType.Type1, bytes);
          out.push({ uid, dataUrl: toDataUrl(bytes) });
        } else {
          out.push({ uid, dataUrl: null });
        }
      }
    } catch (e) {
      // A real SDK failure is still the caller's to see; only a stall is absorbed.
      if (!isStall(e)) throw e;
      process.stderr.write(`[sidecar] getThumbnails stalled after ${out.length}/${uids.length}\n`);
    }
    return out;
  }

  /**
   * Fills the thumbnail cache ahead of the grid, a couple of downloads at a time, and
   * answers only how many are now there: the warmer never draws them, so nothing is
   * worth sending back over the channel.
   */
  async warmThumbnails(uids: string[], signal?: AbortSignal): Promise<{ ready: number }> {
    const rows = await this.getThumbnails(uids, THUMBNAIL_WARM_PER_CALL, signal);
    // Only what is now cached: a fetch that failed, or a uid this call did not get to, is
    // not ready, so the window asks for it again rather than counting it warm.
    return { ready: rows.filter((r) => r.dataUrl !== null).length };
  }

  /** HD preview (Type2 thumbnail) for the image viewer / lightbox. */
  async getPreview(uid: string, signal?: AbortSignal): Promise<string | null> {
    if (!this.photos && !this.offlineOnly) throw new Error("Not signed in");
    const bytes = await this.previewBytes(uid, signal);
    return bytes ? toDataUrl(bytes) : null;
  }

  /** The HD preview's bytes: from the sealed cache, else fetched and sealed for next time. */
  private async previewBytes(uid: string, signal?: AbortSignal): Promise<Buffer | null> {
    const cached = thumbGet(uid, ThumbnailType.Type2);
    if (cached) return cached;
    if (!this.photos) return null;

    // The same guard as the grid's thumbnails above, for the same reason: this is the
    // identical SDK call, and the viewer holds the channel while it runs.
    try {
      for await (const r of withStallGuard(
        this.photos.iterateThumbnails([uid], ThumbnailType.Type2, signal),
        THUMBNAIL_STALL_MS,
        "iterateThumbnails",
      )) {
        if ((r as any).ok) {
          const bytes = Buffer.from((r as any).thumbnail);
          thumbPut(uid, ThumbnailType.Type2, bytes);
          return bytes;
        }
        return null;
      }
    } catch (e) {
      if (!isStall(e)) throw e;
      process.stderr.write(`[sidecar] getPreview stalled\n`);
    }
    return null;
  }

  // ---- Download ----

  /**
   * A video for the window to play over the thumbnail server, a range at a time. A copy
   * kept offline plays from the disk, with or without Proton, when it is small enough to
   * hold (the sealed copy is decrypted whole), and is never downloaded again when it is not;
   * otherwise it is downloaded from Proton. NOT_STREAMABLE when it never can be: kept offline
   * over MAX_INMEMORY_VIDEO, not a video, Proton does not say how large it is (which ranges
   * need), or it is over MAX_STREAMED_VIDEO. Null when it cannot be had just now, or `signal`
   * fired. The window falls back to `getVideo` for both.
   */
  private async videoSource(uid: string, signal: AbortSignal): Promise<VideoAnswer> {
    if (isOfflineReady(uid)) {
      // The same cap as `getVideo`, measured before the sealed copy is read.
      const size = originalSize(uid);
      if (size !== null && size > MAX_INMEMORY_VIDEO) return NOT_STREAMABLE;
      const stored = originalGet(uid);
      if (stored) {
        if (stored.length > MAX_INMEMORY_VIDEO) return NOT_STREAMABLE;
        return videoFromBytes(stored, metaGet(uid)?.mediaType || "video/mp4");
      }
    }
    if (!this.photos) return null;
    const node = await this.photos.getNode(uid);
    if (signal.aborted) return null;
    const mime = (node as any)?.mediaType || "video/mp4";
    if (!String(mime).startsWith("video/")) return NOT_STREAMABLE;
    // The downloader holds one of the SDK's few download slots from here until a download
    // of it ends: every way out below either downloads or gives the slot back unused. A
    // wait for a free slot ends when `signal` fires.
    const opened = await openDownloader(this.photos, uid, signal);
    if (signal.aborted) {
      opened.unused();
      return null;
    }
    const size = opened.downloader.getClaimedSizeInBytes?.() ?? 0;
    if (!size || size > MAX_STREAMED_VIDEO) {
      opened.unused();
      return NOT_STREAMABLE;
    }
    return startVideo(opened, size, mime, signal);
  }

  /** True for a video the window should play the older way at once, without streaming it again. */
  videoNotStreamable(uid: string): boolean {
    return this.videos.notStreamable(uid);
  }

  async getVideo(uid: string): Promise<VideoBytes> {
    // A copy kept offline plays from the disk, with or without Proton.
    if (!this.photos && !(this.offlineOnly && isOfflineReady(uid))) throw new Error("Not signed in");
    return readVideo(this.photos, uid);
  }

  private cameraJobs = new CameraFactsJobs((uid) => this.originalForReading(uid));

  /** A photo's own bytes for reading: the copy the viewer holds, the one kept offline, or a download. */
  private async originalForReading(uid: string): Promise<Buffer | null> {
    const viewed = await viewedOriginal(uid);
    if (viewed) return viewed;
    const kept = originalGet(uid);
    if (kept) return kept;
    return this.photos ? downloadWhole(this.photos, uid) : null;
  }

  /** The camera facts of a photo, read in the background: asked again until `done`. */
  cameraFacts(uid: string): CameraFactsReply {
    if (!this.photos && !(this.offlineOnly && isOfflineReady(uid))) throw new Error("Not signed in");
    return this.cameraJobs.ask(uid);
  }

  /** The clip of a Live Photo or a motion photo of the library, or null when it has none. */
  async getMotionClip(uid: string): Promise<ClipBytes | null> {
    if (!this.photos) throw new Error("Not signed in");
    return motionClipOf(this.photos, uid, {
      original: (id) => this.originalForReading(id),
      video: readVideo,
    });
  }

  /** The clip of a picture file on this computer, or null when it has none. */
  localMotionClip(path: string): Promise<ClipBytes | null> {
    return localMotionClip(path);
  }

  /** The editor's source for a cloud photo: same-origin pixels plus the metadata a saved
   *  copy keeps. */
  async cloudEditorSource(uid: string): Promise<CloudEditorSource> {
    if (!this.photos) throw new Error("Not signed in");
    return runCloudEditorSource(this.photos, uid);
  }

  /** Save an edited cloud photo as a new timeline node carrying the source's date, place
   *  and camera, and into `albumUid` when the editor was opened from that album. Returns the
   *  new node's uid; `albumFailed` says the copy is saved but not in the album. */
  async saveCloudEdit(
    jpegBase64: string,
    meta: CloudEditMeta,
    albumUid?: string | null,
  ): Promise<{ uid: string; albumFailed?: true }> {
    if (!this.photos) throw new Error("Not signed in");
    const saved = await runSaveCloudEdit(this.photos, jpegBase64, meta);
    return joinSourceAlbum((album, uids) => this.addPhotosToAlbum(album, uids), saved, albumUid);
  }

  private editorDownloads = new EditorDownloads({ progress: readHydrateProgress, cancel: stopHydrate });

  /** What the video editor needs of a Drive video, and the start of its download into the editor's
   *  staging folder (polled with `videoEditProgress`, then handed to `videoEditStage`). */
  async videoEditSource(uid: string): Promise<VideoEditSource> {
    if (!this.photos) throw new Error("Not signed in");
    const info = await videoEditSourceInfo(this.photos, uid);
    const started = beginHydrate(this.photos, uid, editDownloadDir());
    this.editorDownloads.add(started.path);
    return { ...info, ...started };
  }

  /** How far a download the editor started has got; any other path is refused. */
  videoEditProgress(path: string): { done: boolean; error: string | null } {
    return this.editorDownloads.progress(path);
  }

  /** Stops a download the editor started and deletes what arrived; any other path is refused. */
  videoEditCancel(path: string): { cancelled: true } {
    return this.editorDownloads.cancel(path);
  }

  /** Moves a finished download the editor started into its staging folder. */
  videoEditStage(path: string, ext: string): { path: string } {
    return this.editorDownloads.stage(path, ext);
  }

  /** Uploads what the editor made as a new node carrying the source's capture time, and into
   *  `albumUid` when the editor was opened from that album. */
  async saveEditedMedia(
    input: SaveEditInput,
    albumUid?: string | null,
  ): Promise<{ uid: string; size: number; albumFailed?: true }> {
    if (!this.photos) throw new Error("Not signed in");
    const saved = await runSaveEditedMedia(this.photos, input);
    return joinSourceAlbum((album, uids) => this.addPhotosToAlbum(album, uids), saved, albumUid);
  }

  /** Kicks the save off and returns at once; the UI polls `saveStatus`. */
  startSaveOriginals(uids: string[], destDir: string): { started: boolean } {
    if (!this.photos) throw new Error("Not signed in");
    return { started: runSaveOriginals(this.photos, uids, destDir) };
  }

  saveStatus(): SaveStatus {
    return readSaveStatus();
  }

  async listForMount(offset: number, limit: number): Promise<MountPage> {
    if (!this.photos) throw new Error("Not signed in");
    return readMountPage(this.photos, offset, limit, hiddenStore.hiddenPhotoTest());
  }

  /** The SHA-1 each photo's current revision carries: see `mountDigests`. Host-only. */
  async mountDigests(uids: string[]): Promise<Record<string, string | null>> {
    if (!this.photos) throw new Error("Not signed in");
    return readMountDigests(this.photos, uids);
  }

  /** What became of photos the Explorer folder kept copies of: see `mountFates`. Host-only. */
  async mountFates(uids: string[]): Promise<Record<string, MountFate>> {
    if (!this.photos) throw new Error("Not signed in");
    return readMountFates(this.photos, uids, hiddenStore.hiddenPhotoTest());
  }

  /**
   * Whether the hidden list can be trusted for keeping every photo on this PC. With the shared
   * backup on, another device's hides arrive with a round, so the first round of this session has
   * to have finished; until then a photo hidden elsewhere would still read as an ordinary one.
   */
  keepReady(): { hidden: boolean } {
    const status = this.backup.getStatus();
    return { hidden: !status.on || (status.lastAt !== null && !status.failed) };
  }

  /**
   * The photos hidden in the app, as the ends of their uids the folder can match a downloaded
   * copy against: the link ids of photos hidden on their own, and the uids of hidden albums'
   * photos. Host-only, so a copy of a hidden photo never stays in the plain folder.
   */
  mountHidden(): string[] {
    if (!isReady()) throw new StoreLockedError();
    const s = hiddenStore.snapshot();
    return [...s.photos, ...s.albumPhotos];
  }

  async hydrateFile(uid: string, dir?: string): Promise<HydratedFile> {
    if (!this.photos) throw new Error("Not signed in");
    return runHydrateFile(this.photos, uid, dir);
  }

  /** The Linux drive's streamed download: see `startHydrate`. Host-only. */
  startHydrate(uid: string, dir?: string): { path: string } {
    if (!this.photos) throw new Error("Not signed in");
    return beginHydrate(this.photos, uid, dir);
  }

  hydrateProgress(path: string): { done: boolean; error: string | null } {
    return readHydrateProgress(path);
  }

  cancelHydrate(path: string): { cancelled: true } {
    stopHydrate(path);
    return { cancelled: true };
  }

  /**
   * The Linux drive's folders beside the library: the trash (photos only; an album
   * restores from the app) and what others shared with this account, photos loose and
   * in albums. Names and sizes come the way the main listing's do, so a photo reads
   * the same in every folder it appears in. Host-only.
   */
  async listExtrasForMount(): Promise<MountExtras> {
    if (!this.photos) throw new Error("Not signed in");
    const isMedia = (t: string | null) => !!t && (t.startsWith("image/") || t.startsWith("video/"));

    // Each part is timed into the diagnostics: the whole can hold the background lane a while.
    const photos = this.photos;
    const trashed = (await diag.time("drive", "mount_trash", () => this.trash.get(() => readTrash(photos)))).filter(
      (t) => t.type !== "album",
    );
    const shared = await diag.time("drive", "mount_shared", () => this.getShared(true));
    const sharedFiles = shared.filter((s) => s.type !== "album" && isMedia(s.mediaType));
    // The albums shared with this account, a few listed at once, each answer in its own place.
    const sharedAlbums = shared.filter((s) => s.type === "album");
    const albums: { uid: string; name: string; items: { uid: string; captureTime: number }[] }[] = new Array(
      sharedAlbums.length,
    );
    await diag.time("drive", "mount_albums", async () => {
      let next = 0;
      const lister = async () => {
        for (let at = next++; at < sharedAlbums.length; at = next++) {
          const album = sharedAlbums[at];
          const items: { uid: string; captureTime: number }[] = [];
          try {
            for await (const item of withStallGuard(photos.iterateAlbum(album.uid), SDK_STALL_MS, "iterateAlbum")) {
              const uid = (item as any).nodeUid;
              if (uid) items.push({ uid, captureTime: toMillis((item as any).captureTime) });
            }
          } catch (e) {
            process.stderr.write(`[mount] shared album skipped: ${(e as Error).message}\n`);
          }
          albums[at] = { uid: album.uid, name: album.name || "Album", items };
        }
      };
      await Promise.all(Array.from({ length: Math.min(MOUNT_ALBUMS_AT_ONCE, sharedAlbums.length) }, lister));
    });

    const meta = await diag.time("drive", "mount_meta", () =>
      resolveMountMetaBatch(photos, [
        ...trashed.map((t) => t.uid),
        ...sharedFiles.map((s) => s.uid),
        ...albums.flatMap((a) => a.items.map((i) => i.uid)),
      ]),
    );
    const photo = (uid: string, captureTime: number): MountPhoto[] => {
      const m = meta.get(uid);
      return m ? [{ uid, name: withMediaExtension(m.name, m.mediaType), size: m.size, captureTime }] : [];
    };
    return {
      trash: trashed.flatMap((t) => photo(t.uid, t.captureTime)),
      shared: sharedFiles.flatMap((s) => photo(s.uid, s.captureTime ?? 0)),
      sharedAlbums: albums.map((a) => ({
        uid: a.uid,
        name: a.name,
        photos: a.items.flatMap((i) => photo(i.uid, i.captureTime)),
      })),
    };
  }

  /**
   * The viewer's full-resolution upgrade: starts the transfer on the first call for a
   * photo and reports it on every later one, so the viewer polls this single method.
   */
  async getOriginal(uid: string): Promise<OriginalStatus> {
    // A copy kept offline opens from the disk, with or without Proton.
    if (!this.photos && !(this.offlineOnly && isOfflineReady(uid))) throw new Error("Not signed in");
    return readOriginal(this.photos, uid);
  }

  /** Drop the staged original once the viewer steps away from it or closes. */
  releaseOriginal(uid?: string): { released: true } {
    dropOriginal(uid);
    return { released: true };
  }

  /**
   * The bytes behind an in-memory original, for the host to serve. Nothing but the
   * host's own protocol handler calls this, and only for the token it was just given.
   */
  readOriginalBytes(token: string): { base64: string; mime: string } | null {
    return takeOriginalBytes(token);
  }

  // ---- Available offline (see offline.ts) ----

  /** Mark photos as available offline; the fetch runs in the background. */
  pinOffline(uids: string[]): OfflineStatus {
    if (!this.photos) throw new Error("Not signed in");
    return runPinOffline(this.photos, uids);
  }

  /** Unmark photos and reclaim the space their originals held. */
  unpinOffline(uids: string[]): OfflineStatus {
    return runUnpinOffline(uids);
  }

  /** The Settings panel's "free up" for offline photos: all of them at once. */
  unpinAllOffline(): OfflineStatus {
    return runUnpinAllOffline();
  }

  /** What is pinned, how much of it has landed, and what it costs. */
  offlineStatus(): OfflineStatus {
    return readOfflineStatus();
  }

  /** The albums kept available offline in the app. */
  offlineAlbums(): string[] {
    return readOfflineAlbums();
  }

  /**
   * Keeps an album available offline in the app, its photos and the ones added to it later, or
   * stops: what it fetched goes, unless something else keeps it. Nothing is written to Explorer.
   */
  async offlineAlbumSet(uid: string, on: boolean): Promise<OfflineStatus> {
    if (!this.photos) throw new Error("Not signed in");
    return setAlbumOffline(this.photos, uid, on ? await this.albumMemberUids(uid) : null);
  }

  /** Reads the albums kept offline again, so a photo added to one from anywhere arrives too. */
  private async refreshOfflineAlbums(): Promise<void> {
    if (!this.photos) return;
    for (const uid of readOfflineAlbums()) {
      try {
        setAlbumOffline(this.photos, uid, await this.albumMemberUids(uid));
      } catch (e) {
        if (!isTransient(e)) process.stderr.write(`[offline] an album could not be read: ${(e as Error)?.name ?? "error"}\n`);
      }
    }
  }

  // ---- Albums (see albums.ts) ----

  /**
   * The albums, the hidden ones left out unless asked for: only the unlocked Hidden page asks.
   * An album whose cover is a hidden photo is listed without a cover, so no list anywhere
   * draws a hidden photo.
   */
  async getAlbums(includeHidden = false): Promise<AlbumSummary[]> {
    if (!this.photos) throw new Error("Not signed in");
    const albums = await readAlbums(this.photos);
    if (includeHidden) return albums;
    const hidden = hiddenStore.hiddenPhotoTest();
    return albums
      .filter((a) => !hiddenStore.isHiddenAlbum(a.uid))
      .map((a) => (a.coverUid && hidden(a.coverUid) ? { ...a, coverUid: null } : a));
  }

  async getAlbumPhotoUids(): Promise<string[]> {
    if (!this.photos) throw new Error("Not signed in");
    const uids = await readAlbumPhotoUids(this.photos);
    // Kept for the next start; a cache that cannot be written only costs that start the wait.
    try {
      if (isReady()) writeSealedAtomic(join(storeDir(), ALBUM_MEMBERS_FILE), Buffer.from(JSON.stringify(uids)));
    } catch {
      /* best-effort */
    }
    return uids;
  }

  /** The album members as last read, or null before they ever were: answered from disk at
   *  once, so the timeline can hide them before the albums are walked again. */
  cachedAlbumPhotoUids(): string[] | null {
    // Kept offline is all there is to show: none of it is hidden for being in an album.
    if (!isReady() || this.offlineOnly) return null;
    const raw = readSealedOrSetAside(join(storeDir(), ALBUM_MEMBERS_FILE));
    if (!raw) return null;
    try {
      const uids = JSON.parse(raw.toString("utf8"));
      return Array.isArray(uids) ? uids.filter((u): u is string => typeof u === "string") : null;
    } catch {
      return null;
    }
  }

  async getAlbumPhotos(uid: string): Promise<AlbumPhoto[]> {
    if (!this.photos) throw new Error("Not signed in");
    return readAlbumPhotos(this.photos, uid);
  }

  async listAlbumsForMount(offset?: number, limit?: number): Promise<{ total: number; items: AlbumMount[] }> {
    if (!this.photos) throw new Error("Not signed in");
    const page = await readAlbumsForMount(this.photos, offset, limit);
    // A hidden album, and a hidden photo in any album, stay out of the folder too.
    const hidden = hiddenStore.hiddenPhotoTest();
    return {
      total: page.total,
      items: page.items
        .filter((a) => !hiddenStore.isHiddenAlbum(a.uid))
        .map((a) => ({ ...a, uids: a.uids.filter((u) => !hidden(u)) })),
    };
  }

  async createAlbum(name: string): Promise<AlbumSummary> {
    if (!this.photos) throw new Error("Not signed in");
    return runCreateAlbum(this.photos, name);
  }

  async renameAlbum(uid: string, name: string): Promise<{ uid: string; name: string }> {
    if (!this.photos) throw new Error("Not signed in");
    return runRenameAlbum(this.photos, uid, name);
  }

  async setAlbumCover(uid: string, coverUid: string): Promise<{ uid: string; coverUid: string }> {
    if (!this.photos) throw new Error("Not signed in");
    return runSetAlbumCover(this.photos, uid, coverUid);
  }

  async deleteAlbum(
    uid: string,
    options: { force?: boolean; saveToTimeline?: boolean },
  ): Promise<DeleteAlbumOutcome> {
    if (!this.photos) throw new Error("Not signed in");
    try {
      return await runDeleteAlbum(this.photos, uid, options);
    } finally {
      // A deleted album goes to the trash, and may take its photos with it.
      this.trash.changed();
    }
  }

  async addPhotosToAlbum(albumUid: string, uids: string[]): Promise<AlbumResult[]> {
    if (!this.photos) throw new Error("Not signed in");
    const results = await runAddToAlbum(this.photos, albumUid, uids);
    const added = results.filter((r) => r.ok).map((r) => r.uid);
    hiddenStore.addMembers(albumUid, added);
    addToOfflineAlbum(this.photos, albumUid, added);
    return results;
  }

  async removePhotosFromAlbum(albumUid: string, uids: string[]): Promise<AlbumResult[]> {
    if (!this.photos) throw new Error("Not signed in");
    return runRemoveFromAlbum(this.photos, albumUid, uids);
  }

  // ---- Sharing (SDK: iterateSharedNodes / iterateSharedNodesWithMe) ----

  /** What I share out (`withMe: false`) or what others shared with me (`withMe: true`). */
  async getShared(withMe: boolean): Promise<SharedSummary[]> {
    if (!this.photos) throw new Error("Not signed in");
    const nodes = withMe
      ? this.photos.iterateSharedNodesWithMe()
      : this.photos.iterateSharedNodes();

    const out: SharedSummary[] = [];
    // What is hidden here stays hidden from what is shared too.
    const hidden = hiddenStore.hiddenPhotoTest();
    for await (const node of withStallGuard(nodes, SDK_STALL_MS, "iterateSharedNodes")) {
      const n = node as any;
      if (hidden(n.uid) || hiddenStore.isHiddenAlbum(n.uid)) continue;
      out.push({
        uid: n.uid,
        name: nodeName(n),
        type: n.type,
        mediaType: n.mediaType ?? null,
        isShared: !!n.isShared,
        isSharedPublicly: !!(n.isSharedByUrl ?? n.isSharedPublicly),
        captureTime: n.photo?.captureTime ? toMillis(n.photo.captureTime) : null,
        coverUid: n.album?.coverPhotoNodeUid ?? null,
        photoCount: n.album?.photoCount ?? null,
        lastActivityTime: n.album?.lastActivityTime ? toMillis(n.album.lastActivityTime) : null,
      });
    }
    return out;
  }

  // ---- Invitations to someone else's photos (SDK: iterateInvitations / accept / reject) ----

  async listInvitations(): Promise<Invitation[]> {
    if (!this.photos) throw new Error("Not signed in");
    return runListInvitations(this.photos, (walk) => withStallGuard(walk, SDK_STALL_MS, "iterateInvitations"));
  }

  async acceptInvitation(uid: string): Promise<void> {
    if (!this.photos) throw new Error("Not signed in");
    return runAcceptInvitation(this.photos, uid);
  }

  async declineInvitation(uid: string): Promise<void> {
    if (!this.photos) throw new Error("Not signed in");
    return runDeclineInvitation(this.photos, uid);
  }

  // ---- Sharing a node out (SDK: getSharingInfo / shareNode / unshareNode) ----

  async getSharingInfo(uid: string): Promise<SharingInfo> {
    if (!this.photos) throw new Error("Not signed in");
    return readSharingInfo(this.photos, uid);
  }

  async setPublicLink(uid: string, options?: PublicLinkOptions): Promise<SharingInfo> {
    if (!this.photos) throw new Error("Not signed in");
    return runSetPublicLink(this.photos, uid, options);
  }

  async removePublicLink(uid: string): Promise<SharingInfo> {
    if (!this.photos) throw new Error("Not signed in");
    return runRemovePublicLink(this.photos, uid);
  }

  async invitePeople(uid: string, emails: string[], role: string): Promise<SharingInfo> {
    if (!this.photos) throw new Error("Not signed in");
    return runInvitePeople(this.photos, uid, emails, role);
  }

  async removePerson(uid: string, email: string): Promise<SharingInfo> {
    if (!this.photos) throw new Error("Not signed in");
    return runRemovePerson(this.photos, uid, email);
  }

  async stopSharing(uid: string): Promise<SharingInfo> {
    if (!this.photos) throw new Error("Not signed in");
    return runStopSharing(this.photos, uid);
  }

  // ---- Search index ----

  /**
   * Names and media types for the search index. The SDK has no server-side
   * search, so the client filters locally; this feeds it. `iterateNodes`
   * batches the lookups, so callers may pass large uid chunks.
   */
  async getMetadata(uids: string[]): Promise<NodeMeta[]> {
    if (!this.photos && this.offlineOnly) {
      return uids.flatMap((uid) => {
        const m = metaGet(uid);
        return m ? [{ uid, name: m.name, mediaType: m.mediaType, size: m.size ?? null }] : [];
      });
    }
    if (!this.photos) throw new Error("Not signed in");
    const out: NodeMeta[] = [];
    const missing: string[] = [];

    // Names decrypt once, then come from the encrypted on-disk cache, so opening
    // search never re-indexes the whole library on later sessions.
    for (const uid of uids) {
      const cached = metaGet(uid);
      if (cached) out.push({ uid, name: cached.name, mediaType: cached.mediaType, size: cached.size ?? null });
      else missing.push(uid);
    }
    if (missing.length === 0) return out;

    for await (const node of withStallGuard(
      this.photos.iterateNodes(missing),
      SDK_STALL_MS,
      "iterateNodes",
    )) {
      const n = node as any;
      if (n.missingUid) continue; // node vanished server-side
      const meta = { name: nodeName(n), mediaType: n.mediaType ?? null };
      // This decrypt already holds the revision, so record its claimed size next to the
      // name: the Explorer mount needs exactly that size and can then skip a second fetch
      // for this node. Only a positive size is stored, and it is the exact cloud
      // claimedSize the reconcile guard checks — a node without one stays size-less.
      // The video length comes off the same revision, so the grid's pill costs nothing
      // extra for any photo search has already indexed.
      const revision = activeRevisionOf(n);
      const size = Number(revision?.claimedSize ?? 0);
      const durationMs = nodeDurationMs(n) ?? 0;
      const geo = nodeLocation(n);
      metaPut(n.uid, size > 0 ? { ...meta, size, durationMs, geo } : { ...meta, durationMs, geo });
      // The size travels with the name because the viewer's contents list shows both,
      // and it is already in hand here: fetching it separately would mean a second
      // decrypt of a revision this loop has already opened.
      out.push({ uid: n.uid, name: meta.name, mediaType: meta.mediaType, size: size > 0 ? size : null });
    }
    return out;
  }

  /**
   * Where each photo was taken, for the map: only the photos that carry a place come back.
   * Cache-first, so a library read once answers from disk; the rest are read once, in
   * batches, and kept, with the name and the rest of the record beside the place.
   */
  async getLocations(uids: string[]): Promise<{ points: { uid: string; lat: number; lon: number }[]; read: number }> {
    if (!this.photos) throw new Error("Not signed in");
    const out: { uid: string; lat: number; lon: number }[] = [];
    const missing: string[] = [];
    for (const uid of uids) {
      const cached = metaGet(uid);
      if (cached && cached.geo !== undefined) {
        if (cached.geo) out.push({ uid, lat: cached.geo[0], lon: cached.geo[1] });
      } else {
        missing.push(uid);
      }
    }
    for (let at = 0; at < missing.length; at += LOCATION_BATCH) {
      const batch = missing.slice(at, at + LOCATION_BATCH);
      for await (const node of withStallGuard(this.photos.iterateNodes(batch), SDK_STALL_MS, "iterateNodes")) {
        const n = node as any;
        if (n.missingUid) continue;
        const geo = nodeLocation(n);
        const revision = activeRevisionOf(n);
        const size = Number(revision?.claimedSize ?? 0);
        const meta = { name: nodeName(n), mediaType: n.mediaType ?? null, durationMs: nodeDurationMs(n) ?? 0, geo };
        metaPut(n.uid, size > 0 ? { ...meta, size } : meta);
        if (geo) out.push({ uid: n.uid, lat: geo[0], lon: geo[1] });
      }
    }
    // `read`: how many had to come from Drive, so the map says it is looking only when it is.
    return { points: out, read: missing.length };
  }

  /**
   * Media types, for telling a video from a photo. Cache-first and batched, so a
   * screenful costs one call and most of it is answered from disk with no lookup.
   *
   * The grid and the viewer both branch on this rather than on the Videos tag, because a
   * file uploaded by a client that set no tag has none and would otherwise be treated as
   * a still for good.
   */
  async getMediaTypes(uids: string[]): Promise<{ uid: string; mediaType: string | null }[]> {
    if (!this.photos && this.offlineOnly) {
      return uids.flatMap((uid) => {
        const m = metaGet(uid);
        return m ? [{ uid, mediaType: m.mediaType }] : [];
      });
    }
    if (!this.photos) throw new Error("Not signed in");
    const resolved = await resolveMediaTypesBatch(this.photos, uids);
    return [...resolved].map(([uid, mediaType]) => ({ uid, mediaType }));
  }

  /**
   * Video lengths in milliseconds, for the grid's duration pill. Cache-first, and
   * one lookup for whatever is left, so a screenful of videos costs a single call
   * rather than one per tile. Only the videos that have a length come back.
   */
  async getDurations(uids: string[]): Promise<{ uid: string; durationMs: number }[]> {
    if (!this.photos && this.offlineOnly) {
      return uids.flatMap((uid) => {
        const d = metaGet(uid)?.durationMs;
        return typeof d === "number" && d > 0 ? [{ uid, durationMs: d }] : [];
      });
    }
    if (!this.photos) throw new Error("Not signed in");
    const resolved = await resolveDurationsBatch(this.photos, uids);
    return [...resolved].map(([uid, durationMs]) => ({ uid, durationMs }));
  }

  // ---- Upload ----

  /**
   * Kicks the job off and returns at once; the UI polls `uploadStatus`.
   *
   * `frames` is the host's staged picture of each file sharp cannot open, keyed by path,
   * and is how a video reaches Proton with a thumbnail. `media` is what the host asked
   * Windows about those same files, and is how a video reaches Proton with a length.
   * `album` puts every file into that existing album.
   */
  startUpload(
    paths: string[],
    frames: Record<string, string> = {},
    media: Record<string, ShellMediaInfo> = {},
    album?: { uid: string; name: string },
  ): { started: boolean } {
    if (!this.photos) throw new Error("Not signed in");
    runUpload(this.photos, paths, frames, media, album);
    return { started: true };
  }

  /**
   * Starts importing a Google Takeout or Ente export from zips or folders. Returns at
   * once; `uploadStatus` reports the unpacking, then `ready` with the folders the host
   * makes frames from before calling `queueImport`.
   */
  startImport(paths: string[]): { started: boolean } {
    if (!this.photos) throw new Error("Not signed in");
    runImport(paths);
    return { started: true };
  }

  /** A folder of My files for the picker: the sub-folders holding photos, and its own photos. */
  myFilesList(uid?: string): Promise<MyFolderListing> {
    if (!this.sdkBase) throw new Error("Not signed in");
    // What was learned about which folders hold photos is kept for a while, so walking back up
    // and down again is quick, and forgotten after it, so new files show.
    if (Date.now() - this.myFoldersAt > MY_FOLDERS_FRESH_MS) {
      this.myFoldersKnown = new Map();
      this.myFoldersAt = Date.now();
    }
    return listMyFolder(this.myFilesClient(), isMediaName, uid, this.myFoldersKnown);
  }

  /** Whether each of these folders of My files holds a photo or video somewhere. */
  myFilesCheck(uids: string[]): Promise<Record<string, boolean>> {
    if (!this.sdkBase) throw new Error("Not signed in");
    return checkMyFolders(this.myFilesClient(), uids, isMediaName, this.myFoldersKnown);
  }

  /** Small previews of photos in My files, for the picker, as data URLs by uid. */
  async myFilesThumbs(uids: string[]): Promise<Record<string, string>> {
    if (!this.sdkBase) throw new Error("Not signed in");
    const out: Record<string, string> = {};
    try {
      for await (const r of withStallGuard(
        this.myFilesClient().iterateThumbnails(uids, ThumbnailType.Type1),
        THUMBNAIL_STALL_MS,
        "iterateThumbnails(my files)",
      )) {
        if ((r as any).ok) out[(r as any).nodeUid] = `data:image/jpeg;base64,${Buffer.from((r as any).thumbnail).toString("base64")}`;
      }
    } catch {
      /* what came is shown; the rest keep their placeholder */
    }
    return out;
  }

  /**
   * Starts bringing the photos and videos of folders in My files into Photos, through the
   * import's review; with `move`, the originals go to the Drive trash once they are in.
   */
  startMyFilesImport(
    folders: { uid: string; name: string }[],
    files: { uid: string; folder: string }[],
    move: boolean,
  ): { started: boolean } {
    if (!this.photos || !this.sdkBase) throw new Error("Not signed in");
    runMyFilesImport(this.myFilesClient(), folders, files, move);
    return { started: true };
  }

  /** Reads the export `startImport` made ready into a review, with the host's frames. */
  prepareImport(
    frames: Record<string, string> = {},
    media: Record<string, ShellMediaInfo> = {},
  ): { started: boolean } {
    if (!this.photos) throw new Error("Not signed in");
    runPrepareImport(this.photos, frames, media, () => this.importLibrary());
    return { started: true };
  }

  /**
   * The library as an import checks against it: every photo, and the content hashes the
   * timeline listing handed out, with the key to make a file's own.
   */
  private async importLibrary(): Promise<LibraryIndex | null> {
    const photos = this.photos;
    if (!photos) return null;
    const items = await this.getTimeline();
    // The listing's pages are taken in beside the walk: the last ones may still be on their way.
    await listingSettled();
    const hashKey = await photoRootHashKey(photos);
    const listed = duplicateFinder.listedUids();
    const index = new LibraryIndex(
      items.map((item) => item.uid),
      duplicateFinder.contentHashEntries(),
      listed,
      hashKey,
      hiddenStore.hiddenPhotoTest(),
    );
    diag.log("upload", "import_library", {
      photos: items.length,
      unlisted: items.filter((item) => !listed.has(item.uid)).length,
      key: hashKey ? 1 : 0,
    });
    return index;
  }

  getImportReview() {
    return readImportReview();
  }

  getImportChecks() {
    return readImportChecks();
  }

  /** Pictures for the import review's tiles: see `importThumbnails`. */
  importThumbnails(paths: string[]) {
    return readImportThumbnails(paths);
  }

  /** Uploads the reviewed export, less the items left out. */
  confirmImport(exclude: number[], albums: boolean, live: boolean): { started: boolean } {
    if (!this.photos) throw new Error("Not signed in");
    runConfirmImport(this.photos, exclude, albums, live);
    return { started: true };
  }

  discardImport(): { ok: boolean } {
    runDiscardImport();
    return { ok: true };
  }

  /** A drop onto the Linux file-manager drive. Host-only; see `startDropUpload`. */
  startDropUpload(
    paths: string[],
    frames: Record<string, string> = {},
    media: Record<string, ShellMediaInfo> = {},
    albumUid?: string,
    albumName?: string,
    favorite = false,
  ): { started: boolean } {
    if (!this.photos) throw new Error("Not signed in");
    runDropUpload(this.photos, paths, frames, media, albumUid, albumName, favorite);
    return { started: true };
  }

  /** The File Explorer drops that went up lighter since the host last asked. Host-only. */
  dropReplaced(): string[] {
    return takeDropReplaced();
  }

  uploadStatus(): UploadStatus & { itemsTotal: number } {
    return readUploadStatus();
  }

  cancelUpload(): { cancelled: boolean } {
    abortUpload();
    return { cancelled: true };
  }

  clearUploads(): { cleared: boolean } {
    clearUploads();
    return { cleared: true };
  }

  // ---- Single-photo actions (SDK: getNode / renameNode / trashNodes / updatePhotos) ----

  /**
   * The names this computer already holds for these photos, from the sealed cache (the
   * drive's listing and the search index fill it), with nothing fetched or decrypted: a
   * photo with no cached name is left out. What lets the viewer put a photo's name in its
   * title the moment it steps to it, instead of "…" until the details arrive.
   */
  cachedNames(uids: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const uid of uids) {
      const name = metaGet(uid)?.name;
      if (name) out[uid] = name;
    }
    return out;
  }

  /** Everything the details panel shows. Size and hashes live on the revision. */
  async getNodeDetails(uid: string): Promise<Record<string, unknown>> {
    if (!this.photos && this.offlineOnly) {
      const m = metaGet(uid);
      if (!m) throw new Error("Not signed in");
      const taken = offlineLibrary().find((p) => p.uid === uid)?.captureTime ?? null;
      return { uid, name: m.name, mediaType: m.mediaType, captureTime: taken, size: m.size ?? null, tags: [] };
    }
    if (!this.photos) throw new Error("Not signed in");
    const n: any = await this.photos.getNode(uid);
    const revision = activeRevisionOf(n);

    return {
      uid: n.uid,
      name: nodeName(n),
      type: n.type,
      mediaType: n.mediaType ?? null,
      captureTime: n.photo?.captureTime ? toMillis(n.photo.captureTime) : null,
      creationTime: toMillis(n.creationTime),
      modificationTime: revision?.claimedModificationTime
        ? toMillis(revision.claimedModificationTime)
        : null,
      size: revision?.claimedSize ?? null,
      storageSize: revision?.storageSize ?? n.totalStorageSize ?? null,
      sha1: revision?.claimedDigests?.sha1 ?? null,
      sha1Verified: revision?.claimedDigests?.sha1Verified ?? null,
      extra: revision?.claimedAdditionalMetadata ?? null,
      tags: n.photo?.tags ?? [],
      albumCount: (n.photo?.albums ?? []).length,
      isShared: !!n.isShared,
      isSharedPublicly: !!(n.isSharedByUrl ?? n.isSharedPublicly),
      owner: n.ownedBy?.email ?? null,
    };
  }

  async renamePhoto(uid: string, newName: string): Promise<{ uid: string; name: string }> {
    if (!this.photos) throw new Error("Not signed in");
    const n: any = await this.photos.renameNode(uid, newName);
    const name = nodeName(n) || newName;
    // The cached name is what the Explorer folder and the search index list a photo
    // under. Left as it was, the folder would bring the old name back at its next fill
    // and clear away the renamed copy as one the library no longer has.
    const cached = metaGet(uid);
    if (cached) metaPut(uid, { ...cached, name });
    return { uid: n.uid ?? uid, name };
  }

  /** Moves photos to the trash. The SDK reports per-node results. */
  async trashPhotos(uids: string[]): Promise<{ uid: string; ok: boolean; error?: string }[]> {
    if (!this.photos) throw new Error("Not signed in");
    const out: { uid: string; ok: boolean; error?: string }[] = [];
    try {
      for await (const r of withStallGuard(this.photos.trashNodes(uids), SDK_STALL_MS, "trashNodes")) {
        const result = r as any;
        out.push(
          result.ok
            ? { uid: result.uid, ok: true }
            : { uid: result.uid, ok: false, error: String(result.error?.message ?? result.error) },
        );
      }
    } finally {
      this.trash.changed();
    }
    duplicateFinder.removed(out.filter((r) => r.ok).map((r) => r.uid));
    return out;
  }

  // ---- Hidden photos and albums (hidden.ts) ----

  /** The hidden list; "Locked" while the store is, so a locked app answers nothing rather than an empty list. */
  hiddenState(): HiddenState {
    if (!isReady()) throw new StoreLockedError();
    return hiddenStore.snapshot();
  }

  /** Hides or shows photos or albums; a hidden album's photos are read first, to hide them with it. */
  async hiddenSet(kind: HiddenKind, uids: string[], hidden: boolean): Promise<HiddenState> {
    if (!this.photos) throw new Error("Not signed in");
    const members = new Map<string, string[]>();
    if (kind === "albums" && hidden) for (const uid of uids) members.set(uid, await this.albumMemberUids(uid));
    hiddenStore.set(kind, uids, hidden, Date.now(), members);
    diag.log("hidden", hidden ? "hide" : "show", { kind, count: uids.length });
    this.backup.changed();
    return hiddenStore.snapshot();
  }

  /** Reads each hidden album's photos again, so one added since is hidden too. */
  async hiddenRefresh(): Promise<HiddenState> {
    if (!this.photos) throw new Error("Not signed in");
    for (const uid of hiddenStore.hiddenAlbumUids()) {
      if (!uid.includes("~")) continue;
      try {
        hiddenStore.setMembers(uid, await this.albumMemberUids(uid));
      } catch (e) {
        if (!isTransient(e)) process.stderr.write(`[hidden] an album could not be read: ${(e as Error)?.name ?? "error"}\n`);
      }
    }
    return hiddenStore.snapshot();
  }

  private async albumMemberUids(albumUid: string): Promise<string[]> {
    const uids: string[] = [];
    for await (const item of withStallGuard(this.photos.iterateAlbum(albumUid), SDK_STALL_MS, "iterateAlbum(hidden)")) {
      const uid = (item as any).nodeUid;
      if (uid) uids.push(uid);
    }
    return uids;
  }

  // ---- Copy text ----

  private ocrJobs = new Map<number, OcrJob>();
  private ocrNext = 0;
  /** The newest read asked for with the button: only a newer press passes it. */
  private ocrNewestPress = 0;
  /** The last photos read, by what was read, so going back to one shows its text at once. */
  private ocrRead = new Map<string, OcrJob["result"]>();
  /**
   * The photo fetches of reads. Stepping through the viewer must not start a download per
   * photo, all at once, holding every original in memory together: a read ahead waits a
   * moment and fetches only if no newer read has started by then, at most
   * OCR_FETCHES_AT_ONCE fetches run at once, and a read of a photo already being fetched
   * shares that fetch. A read asked for with the button takes no place in that line: it
   * fetches at once, past fetches of reads ahead that may be stale.
   */
  private ocrFetchesRunning = 0;
  private ocrFetchWaiters: (() => void)[] = [];
  private ocrFetchesByKey = new Map<string, Promise<Buffer | null>>();
  /** How long a read ahead waits for a newer one before it fetches (tests shorten it). */
  ocrSettleMs = OCR_SETTLE_MS;
  /** How long a fetch may hold its place before the next read is let past it. */
  ocrFetchGiveUpMs = OCR_FETCH_GIVE_UP_MS;

  /**
   * Starts reading the text in a photo of the library (its full-resolution original, or its
   * large preview for a format this side cannot decode) or in a picture file on this computer,
   * and answers at once with the read's id; `ocrResult` follows it. `ahead` is the viewer
   * reading a photo before it is asked to; a read asked for with the button does not wait.
   */
  ocrStart(source: { uid?: string; path?: string }, ahead = false): { id: number } {
    const id = ++this.ocrNext;
    if (!ahead) this.ocrNewestPress = id;
    const job: OcrJob = { state: "working", stage: null, result: null };
    this.ocrJobs.set(id, job);
    for (const old of this.ocrJobs.keys()) if (old <= id - 4) this.ocrJobs.delete(old);
    if (ocrModelStatus().state !== "ready") {
      job.state = "unavailable";
      return { id };
    }
    const key = source.path ? `path:${source.path}` : `uid:${source.uid ?? ""}`;
    const known = this.ocrRead.get(key);
    if (known) {
      job.result = known;
      job.state = "done";
      return { id };
    }
    const started = Date.now();
    // Only the newest read is worth anything: the reader stops an older one at its next
    // step anyway, so one still waiting to fetch its photo gives up before it does. A read
    // asked for with the button is passed only by a newer press, never by a read ahead,
    // which may reach this side after it.
    const superseded = ahead ? () => id !== this.ocrNext : () => id !== this.ocrNewestPress;
    void (async () => {
      const bytes = await this.ocrFetch(key, source, ahead, superseded);
      if (!bytes || superseded()) {
        job.state = "failed";
        return;
      }
      const fetched = Date.now();
      const result = await readText(bytes, (stage) => (job.stage = stage));
      job.result = result;
      job.state = result ? "done" : "failed";
      if (result) {
        this.ocrRead.delete(key);
        this.ocrRead.set(key, result);
        for (const old of this.ocrRead.keys()) {
          if (this.ocrRead.size <= OCR_KEPT) break;
          this.ocrRead.delete(old);
        }
      }
      diag.log("ocr", "read", { ms: Date.now() - started, fetch_ms: fetched - started, blocks: result?.blocks.length ?? -1 });
    })().catch((e) => {
      job.state = "failed";
      process.stderr.write(`[ocr] read failed: ${(e as Error)?.name ?? "error"}\n`);
    });
    return { id };
  }

  /**
   * The bytes for a read, or null when a newer read passed it before it fetched or its
   * fetch gave up. A fetch of the same photo under way is shared rather than repeated,
   * give-up time included.
   */
  private async ocrFetch(
    key: string,
    source: { uid?: string; path?: string },
    ahead: boolean,
    superseded: () => boolean,
  ): Promise<Buffer | null> {
    const sharing = this.ocrFetchesByKey.get(key);
    if (sharing) return sharing;
    if (ahead) {
      await new Promise((r) => setTimeout(r, this.ocrSettleMs));
      if (superseded()) return null;
    }
    while (ahead && this.ocrFetchesRunning >= OCR_FETCHES_AT_ONCE) {
      await new Promise<void>((r) => this.ocrFetchWaiters.push(r));
      if (superseded()) return null;
    }
    const shared = this.ocrFetchesByKey.get(key);
    if (shared) return shared;

    this.ocrFetchesRunning++;
    let freed = false;
    const free = () => {
      if (freed) return;
      freed = true;
      this.ocrFetchesRunning--;
      for (const wake of this.ocrFetchWaiters.splice(0)) wake();
    };
    const fetching = this.ocrBytes(source).catch(() => null);
    // A download that never settles must not hold its place for good: past the give-up
    // time the next read is let through, and this one answers nothing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), this.ocrFetchGiveUpMs);
    });
    const answer = Promise.race([fetching, gaveUp]);
    this.ocrFetchesByKey.set(key, answer);
    void answer.then(() => {
      clearTimeout(timer);
      free();
      if (this.ocrFetchesByKey.get(key) === answer) this.ocrFetchesByKey.delete(key);
    });
    return answer;
  }

  /** The bytes a read is made from: a picture file, or the photo's original. */
  private async ocrBytes(source: { uid?: string; path?: string }): Promise<Buffer | null> {
    let bytes: Buffer | null = null;
    if (source.path) bytes = await readPictureFile(source.path);
    else if (source.uid && this.photos) {
      // The original the viewer is showing is read as it is, not fetched a second time.
      bytes = await viewedOriginal(source.uid);
      if (!bytes) for await (const got of this.scanPictures(this.photos, [source.uid])) bytes = got.bytes;
    }
    return bytes;
  }

  ocrResult(id: number): OcrJob | null {
    return this.ocrJobs.get(id) ?? null;
  }

  // ---- Duplicates ----

  duplicatesStart(): DuplicateStatus {
    if (!this.photos) throw new Error("Not signed in");
    return duplicateFinder.start();
  }

  duplicatesStatus(): DuplicateStatus {
    return duplicateFinder.getStatus();
  }

  duplicatesGroups(): ShownGroups {
    if (!this.photos) throw new Error("Not signed in");
    return duplicateFinder.groups();
  }

  /** Moves the chosen copies to the trash, as far as the finder's own groups allow (duplicates.ts). */
  async duplicatesTrash(
    picks: { uids: string[]; keep: string[] }[],
    whole: string[][],
  ): Promise<{ trashed: string[]; failed: number; skipped: number }> {
    if (!this.photos) throw new Error("Not signed in");
    const photos = this.photos;
    const result = await duplicateFinder.trash(
      picks,
      whole,
      (uids) => this.trashPhotos(uids),
      async (uids) => {
        const there = new Set<string>();
        for await (const node of withStallGuard(photos.iterateNodes(uids), SDK_STALL_MS, "iterateNodes(duplicates)")) {
          const n = node as any;
          if (n?.uid && !n.missingUid && !n.trashTime) there.add(n.uid);
        }
        return there;
      },
    );
    diag.log("duplicates", "trash", { trashed: result.trashed.length, failed: result.failed, skipped: result.skipped });
    return result;
  }

  duplicatesIgnore(uids: string[], on: boolean): DuplicateStatus {
    if (on) duplicateFinder.ignore(uids);
    else duplicateFinder.unignore(uids);
    return duplicateFinder.getStatus();
  }

  // ---- Trash (SDK: iterateTrashedNodeUids / restoreNodes / deleteNodes / emptyTrash) ----

  /**
   * The trash. `ahead` is the window reading it before Trash is opened, which may take a
   * read a few seconds old; without it the read is the trash as it is now (one still under
   * way is shared, as it started after anything this app changed).
   */
  async listTrashed(ahead = false): Promise<TrashItem[]> {
    if (!this.photos) throw new Error("Not signed in");
    const photos = this.photos;
    return this.trash.get(() => readTrash(photos), !ahead);
  }

  /**
   * How many items the trash holds, or how many of `uids` it still holds, read without
   * decrypting any: for following an emptying.
   */
  async trashCount(uids?: string[]): Promise<{ count: number }> {
    if (!this.photos) throw new Error("Not signed in");
    const count = await countTrashed(this.photos, uids);
    // Proton is still emptying it: the kept listing is read afresh next time.
    this.trash.changed();
    return { count };
  }

  async restorePhotos(uids: string[]): Promise<TrashResult[]> {
    if (!this.photos) throw new Error("Not signed in");
    try {
      const results = await runRestore(this.photos, uids);
      duplicateFinder.restored(results.filter((r) => r.ok).map((r) => r.uid));
      return results;
    } finally {
      this.trash.changed();
    }
  }

  async deletePhotosForever(uids: string[]): Promise<TrashResult[]> {
    if (!this.photos) throw new Error("Not signed in");
    try {
      return await runDeleteForever(this.photos, uids);
    } finally {
      this.trash.changed();
    }
  }

  /** Empty trash over what the window listed: see `emptyTrash` in `trash.ts`. */
  async emptyTrash(listed: string[]): Promise<TrashResult[]> {
    if (!this.photos) throw new Error("Not signed in");
    try {
      return await runEmptyTrash(this.photos, listed);
    } finally {
      this.trash.changed();
    }
  }

  /**
   * Sets or clears the Favorite tag on photos, reporting per-node results like
   * `trashPhotos`. Favouriting a photo that lives only in an album also moves it
   * into the timeline (an SDK-side effect); the photo stays in the album.
   */
  async setFavorite(
    uids: string[],
    favorite: boolean,
  ): Promise<{ uid: string; ok: boolean; error?: string }[]> {
    if (!this.photos) throw new Error("Not signed in");
    const updates = uids.map((uid) => ({
      nodeUid: uid,
      tagsToAdd: favorite ? [PhotoTag.Favorites] : [],
      tagsToRemove: favorite ? [] : [PhotoTag.Favorites],
    }));
    const out: { uid: string; ok: boolean; error?: string }[] = [];
    for await (const r of withStallGuard(
      this.photos.updatePhotos(updates),
      SDK_STALL_MS,
      "updatePhotos",
    )) {
      const result = r as any;
      out.push(
        result.ok
          ? { uid: result.uid, ok: true }
          : { uid: result.uid, ok: false, error: String(result.error?.message ?? result.error) },
      );
    }
    return out;
  }
}

export const session = new ProtonSession();

/** What a read of the phone's copies answers: the people and labels, and how many photos the
 *  search reaches (its vectors stay here). */
/** `ownUnreadable`: the kinds whose file of this install's would not open, which a round leaves unwritten. */
export type DriveReply = DriveCollections & { searchPhotos: number; searchOtherModel: number; ownUnreadable: BackupKind[] };

/**
 * The phone's copies as last downloaded, sealed in the account's store, one file per copy and
 * named by a digest so no Drive id is on disk in the clear. A copy is reused only while its
 * Drive revision is the one it was read at.
 */
function driveCopyCache(): CopyCache | null {
  if (!isReady()) return null;
  const dir = join(storeDir(), DRIVE_COPIES_DIR);
  const fileOf = (uid: string) => join(dir, `${createHash("sha256").update(uid).digest("hex")}.bin`);
  const revisionOf = (uid: string) => join(dir, `${createHash("sha256").update(uid).digest("hex")}.rev`);
  return {
    get(uid, revision) {
      const stored = readSealedOrSetAside(revisionOf(uid));
      if (!stored || stored.toString("utf8") !== revision) return null;
      return readSealedOrSetAside(fileOf(uid));
    },
    put(uid, revision, bytes) {
      try {
        mkdirSync(dir, { recursive: true });
        writeSealedAtomic(fileOf(uid), bytes);
        writeSealedAtomic(revisionOf(uid), Buffer.from(revision, "utf8"));
      } catch {
        /* best-effort: the next read downloads it again */
      }
    },
    keepOnly(uids) {
      const keep = new Set<string>();
      for (const uid of uids) {
        const name = createHash("sha256").update(uid).digest("hex");
        keep.add(`${name}.bin`);
        keep.add(`${name}.rev`);
      }
      try {
        for (const name of readdirSync(dir)) if (!keep.has(name)) rmSync(join(dir, name), { force: true });
      } catch {
        /* nothing cached yet */
      }
    },
  };
}
