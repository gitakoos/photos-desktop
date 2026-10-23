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

// The authenticated Proton session: SRP login, key unlock, and the Photos
// client. Holds state across the login -> 2FA -> browse steps.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { PhotoTag, ProtonDriveClient, ThumbnailType } from "@protontech/drive-sdk";
import { ProtonDrivePhotosClient } from "@protontech/drive-sdk/dist/protonDrivePhotosClient.js";

import {
  CryptoProxy,
  computeKeyPassword,
  initCrypto,
  makeOpenPGPCryptoModule,
  makeSrpModule,
  getSrp,
} from "./crypto.ts";
import {
  ProtonApi,
  captchaUrl,
  makeSdkHttpClient,
  randomModulus,
  refreshSession,
  type HvProof,
  type Session,
} from "./api.ts";
import {
  ALBUM_MEMBERS_FILE,
  DRIVE_COPIES_DIR,
  SESSION_FILE,
  isReady,
  metaGet,
  metaPut,
  readSealedOrDiscard,
  storeDir,
  thumbGet,
  thumbPut,
  wipeCache,
  writeSealedAtomic,
} from "./store.ts";
import {
  createDeviceVault,
  createVault,
  lockVault,
  openOrResetVault,
  unlockDeviceVault,
  unlockVault,
  vaultExists,
  vaultMode,
  type VaultMode,
} from "./vault.ts";
import { BrowserSignIn, type ForkApi, type ForkedSession } from "./browserLogin.ts";
import { BoundedCache } from "./boundedCache.ts";
import {
  loadDriveData,
  type CopyCache,
  type DriveCollections,
  type DriveKinds,
  type SearchSnapshot,
} from "./driveData.ts";
import { encodeText, rank, SEARCH_MODEL_ID } from "./semantic.ts";
import { isTransient, withRetry } from "./transient.ts";
import { nodeDurationMs, nodeLocation, nodeName, toMillis } from "./nodes.ts";
import { isStall, SDK_STALL_MS, withStallGuard } from "./stallGuard.ts";
import { startThumbServer, stopThumbServer } from "./thumbServer.ts";
import {
  cancelHydrate as stopHydrate,
  getOriginal as readOriginal,
  getSaveStatus as readSaveStatus,
  getVideo as readVideo,
  hydrateFile as runHydrateFile,
  hydrateProgress as readHydrateProgress,
  listForMount as readMountPage,
  readOriginalBytes as takeOriginalBytes,
  releaseOriginal as dropOriginal,
  resetDownloadState,
  resolveDurationsBatch,
  resolveMediaTypesBatch,
  resolveMountMetaBatch,
  startHydrate as beginHydrate,
  startSaveOriginals as runSaveOriginals,
  withMediaExtension,
  type HydratedFile,
  type MountPage,
  type OriginalStatus,
  type SaveStatus,
  type VideoBytes,
} from "./download.ts";
import {
  cloudEditorSource as runCloudEditorSource,
  saveCloudEdit as runSaveCloudEdit,
  type CloudEditMeta,
  type CloudEditorSource,
} from "./editor.ts";
import {
  offlineStatus as readOfflineStatus,
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
  prepareImport as runPrepareImport,
  getImportReview as readImportReview,
  getImportChecks as readImportChecks,
  confirmImport as runConfirmImport,
  discardImport as runDiscardImport,
  startDropUpload as runDropUpload,
  type ShellMediaInfo,
  type UploadStatus,
} from "./upload.ts";
import {
  deletePhotosForever as runDeleteForever,
  emptyTrash as runEmptyTrash,
  listTrashed as readTrash,
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
const HOST_STATE_FILES = ["mount_seen.txt", "synced_albums.txt"];
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
/** How many uncached grid thumbnails one call fetches; the rest are asked for again. */
const THUMBNAIL_FETCH_PER_CALL = 8;
/** The background warmer's share of one call: it must never hold the channel long
 *  enough for a thumbnail on screen, or a page being opened, to wait on it. */
const THUMBNAIL_WARM_PER_CALL = 2;

/** How long a sign-in may wait on its 2FA code or captcha before the password goes. */
const PENDING_SIGN_IN_MS = 10 * 60_000;

/**
 * How many entries the SDK may keep before its cache starts over: nodes as serialised
 * text, and decrypted keys, which weigh more. Enough for the albums and the folders a
 * session works in to stay warm; a walk over a whole large library starts the cache over
 * now and then instead of holding every photo's key at once.
 */
const ENTITY_CACHE_LIMIT = 50_000;
/** The pauses between asking again to resume a saved session over a network not yet up. */
const RESUME_RETRY_MS = [2_000, 5_000];
/** Nodes read per request while the map gathers places, so no one request grows unbounded. */
const LOCATION_BATCH = 500;
/** The most timeline items one answer carries. */
const TIMELINE_CEILING = 1_000_000;
const CRYPTO_CACHE_LIMIT = 20_000;

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
type TimelineRun = { id: number; items: TimelineItem[]; done: boolean; error: string | null };
type TimelinePage = { items: TimelineItem[]; done: boolean; error: string | null };

type LoginResult =
  | { status: "ok"; email: string }
  | { status: "2fa" }
  /** The API demands human verification; `url` is the captcha page to embed. */
  | { status: "hv"; url: string }
  /** Signed in through the browser; the user still picks how this machine keeps it. */
  | { status: "protect"; email: string }
  /** The vault opened, but its session is gone: a new sign-in, into the same vault. */
  | { status: "relogin" }
  /** The saved session could not be checked because Proton could not be reached. */
  | { status: "offline" }
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
  /** What both Drive clients are built from, kept for the My files one built on first use. */
  private sdkBase: Record<string, unknown> | null = null;
  /** The client for My files, where the Android app keeps its copies of people and labels. */
  private myFiles: any = null;
  /** Those copies, read once a session and again only when asked, with the kinds they cover. */
  private driveCollections: { kinds: string; run: Promise<DriveReply> } | null = null;
  /** The search copies the last read brought, in the text encoder's space. */
  private searchCopies: SearchSnapshot[] = [];
  private photos: any = null;
  /** Which sign-in a pending-step timer belongs to; a newer attempt disarms older ones. */
  private attempt = 0;

  async login(username: string, password: string): Promise<LoginResult> {
    initCrypto();
    this.attempt++;
    this.browser?.cancel();
    this.browser = null;
    this.username = username;
    this.password = password;
    this.keyPassword = "";
    this.method = "password";
    this.userKeyPassphrases = {};
    return this.authenticate();
  }

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
  async browserLoginStatus(): Promise<BrowserLoginStatus> {
    const signIn = this.browser;
    if (!signIn) return this.browserFinish ?? { status: "cancelled" };
    const s = signIn.state();
    if (s.state === "waiting") return { status: "waiting" };
    if (s.state === "cancelled") return { status: "cancelled" };
    if (s.state === "failed") {
      this.browser = null;
      return { status: "error", error: s.error };
    }
    this.browserFinish ??= this.openForked(s.session);
    return this.browserFinish;
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
    return { status: "protect", email: result.email };
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
    // Whatever an earlier vault sealed cannot be opened by the new key.
    if (vaultExists()) wipeCache();
    if (password !== null) createVault(password);
    else createDeviceVault();
    this.awaitingProtection = false;
    this.browserFinish = null;
    this.persistSession();
    return { status: "ok", email: this.email };
  }

  /**
   * A sign-in waiting on a second step (a 2FA code, a captcha) holds the account
   * password in memory until that step completes. One the user walks away from would
   * hold it for the life of the process, so it is dropped after a while, along with the
   * half-made session: coming back later means signing in again, which costs a retype.
   */
  private expirePendingSignIn(): void {
    const attempt = this.attempt;
    const timer = setTimeout(() => {
      if (attempt !== this.attempt || this.photos) return;
      this.password = "";
      this.session = null;
    }, PENDING_SIGN_IN_MS);
    timer.unref?.();
  }

  /**
   * The SRP handshake. A 9001 means the API wants human verification, so the
   * caller gets a captcha URL to embed and replays this through
   * `submitCaptcha`. The handshake is redone from scratch on that retry, so a
   * spent SRP session is never replayed.
   */
  private async authenticate(hv?: HvProof): Promise<LoginResult> {
    const { username, password } = this;

    const info: any = await ProtonApi.authInfo(username);
    const proofs = await getSrp(
      {
        Version: info.Version,
        Modulus: info.Modulus,
        ServerEphemeral: info.ServerEphemeral,
        Salt: info.Salt,
        Username: username,
      } as any,
      { username, password },
      info.Version,
    );

    let auth: any;
    try {
      auth = await ProtonApi.auth(
        {
          Username: username,
          ClientEphemeral: proofs.clientEphemeral,
          ClientProof: proofs.clientProof,
          SRPSession: info.SRPSession,
        },
        hv,
      );
    } catch (e: any) {
      if (e?.hv) {
        const methods: string[] = e.hv.methods ?? [];
        process.stderr.write(`[sidecar] human verification required (methods: ${methods.join(",")})\n`);
        if (methods.length > 0 && !methods.includes("captcha")) {
          const list = methods.join(" or ");
          return { status: "error", error: `This sign-in needs ${list} verification, which this app cannot show yet.` };
        }
        this.expirePendingSignIn();
        return { status: "hv", url: captchaUrl(e.hv.token) };
      }
      return { status: "error", error: (e as Error).message };
    }

    if (auth.ServerProof !== proofs.expectedServerProof) {
      return { status: "error", error: "Server proof mismatch (do not trust this session)" };
    }

    this.session = { uid: auth.UID, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken };

    const twoFa = auth["2FA"]?.Enabled ?? 0;
    if (twoFa & 1) {
      this.expirePendingSignIn();
      return { status: "2fa" };
    }
    return this.finishFreshLogin();
  }

  /** Replay the sign-in with the token the embedded captcha page produced. */
  async submitCaptcha(token: string): Promise<LoginResult> {
    if (!this.password) return { status: "error", error: "No sign-in is in progress" };
    return this.authenticate({ token, type: "captcha" });
  }

  async submit2fa(code: string): Promise<LoginResult> {
    if (!this.session) return { status: "error", error: "No session in progress" };
    await ProtonApi.auth2fa(this.session, code);
    return this.finishFreshLogin();
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
    if (!this.myFiles) {
      this.myFiles = new ProtonDriveClient({
        ...this.sdkBase,
        entitiesCache: new BoundedCache(ENTITY_CACHE_LIMIT),
        cryptoCache: new BoundedCache(CRYPTO_CACHE_LIMIT),
      } as any);
    }
    const key = `${kinds.faces}:${kinds.labels}:${kinds.search}`;
    if (refresh || !this.driveCollections || this.driveCollections.kinds !== key) {
      const run = loadDriveData(this.myFiles, this.sdkBase.account, kinds, driveCopyCache(), SEARCH_MODEL_ID).then(
        (data) => {
          this.searchCopies = data.search;
          const { search, searchOtherModel, ...collections } = data;
          return {
            ...collections,
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
    if (!query.trim() || this.searchCopies.length === 0) return [];
    const vector = await encodeText(query);
    if (!vector) return [];
    return rank(this.searchCopies, vector, limit);
  }

  /** Tries again to resume a session that `offline` left waiting for the network. */
  async retryResume(): Promise<LoginResult> {
    if (!isReady() || this.offlineResume === null) {
      return { status: "error", error: "Nothing is waiting to be resumed" };
    }
    return this.resumeSaved(this.offlineResume);
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
    this.offlineResume = null;
    try {
      // A blob that will not open is no more recoverable than one that is not there, so
      // it is answered the same way: the password has just been proved correct, and this
      // must not look like a wrong one. `readSealedOrDiscard` drops it, leaving the vault
      // and every cached photo intact and asking only for a sign-in. Surfacing the crypto
      // error instead fails identically on every retry, and the one way out of that is
      // the one that wipes every original the user pinned.
      const path = join(storeDir(), SESSION_FILE);
      const raw = readSealedOrDiscard(path);
      let blob: PersistableSession | null = null;
      if (raw) {
        try {
          blob = JSON.parse(raw.toString("utf8")) as PersistableSession;
        } catch {
          rmSync(path, { force: true }); // opened, but is not the shape we wrote
        }
      }
      if (!blob) {
        lockVault();
        return { status: "error", error: "No saved session" };
      }
      let result = await this.resumeSession(blob, password);
      if (result.status === "offline") {
        // Nothing says the session is gone, only that it could not be asked about: the
        // vault stays open and the window tries again, instead of a full sign-in that
        // would ask for the password and the second factor all over.
        this.offlineResume = password;
        return result;
      }
      if (result.status !== "ok" && (blob.method === "browser" || !password)) {
        // No account password to sign in again with: Proton's page has to do it, and
        // the vault stays open so the new session lands in it with the cache intact.
        this.session = null;
        return { status: "relogin" };
      }
      if (result.status !== "ok") {
        // The stored tokens are dead (e.g. the refresh token expired), but the
        // vault opened, so the password is correct. Fall back to a fresh SRP
        // login for new tokens, keeping the vault key and the cache intact.
        this.attempt++;
        this.username = blob.username;
        this.password = password;
        this.userKeyPassphrases = {};
        result = await this.authenticate();
      }
      // Only a hard failure relocks; an in-progress hv/2fa keeps the unlocked
      // vault so the follow-up step can persist the freshly issued session.
      if (result.status === "error") {
        this.lock();
      }
      return result;
    } catch (e) {
      this.lock();
      return { status: "error", error: (e as Error).message };
    }
  }

  /** Drop the in-memory session and forget the vault key; the next use needs an unlock. */
  lock(): { ok: boolean } {
    // First, so no thumbnail is served from a session that is going away.
    void stopThumbServer();
    this.thumbWaiting.clear();
    lockVault();
    this.offlineResume = null;
    this.timelineRun = null;
    this.browser?.cancel();
    this.browser = null;
    this.browserFinish = null;
    this.awaitingProtection = false;
    this.session = null;
    this.photos = null;
    this.sdkBase = null;
    this.myFiles = null;
    this.driveCollections = null;
    this.searchCopies = [];
    this.email = "";
    this.password = "";
    this.keyPassword = "";
    this.userKeyPassphrases = {};
    // The mount listing is this account's photo uids and capture times. Drop it
    // with everything else: leaving it would let a listing for the NEXT account
    // be served from the previous one's snapshot.
    resetDownloadState();
    // Same for the offline list: it is sealed with the key we just forgot, so the
    // in-memory copy must go too. The stored originals stay for this account to
    // come back to; sign-out is what removes those, through wipeCache.
    resetOfflineState();
    return { ok: true };
  }

  /** Forget the account entirely: relock, then delete the saved session, the vault, and the cache. */
  signOut(): { ok: boolean } {
    // The tokens go on the server too, so a copy of them taken from this machine, or
    // from its memory, is worth nothing afterwards; and the session disappears from the
    // account's security log. Best effort and not waited on: signing out never depends
    // on the network, and a locked app holds no tokens to revoke.
    const live = this.session;
    if (live) void ProtonApi.revoke(live).catch(() => {});
    this.lock();
    try {
      rmSync(join(storeDir(), SESSION_FILE), { force: true });
      rmSync(join(storeDir(), VAULT_META_FILE), { force: true });
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
    return { ok: true };
  }

  /**
   * Write the current session to disk, encrypted with the vault key. Called on a
   * fresh sign-in and again on every token refresh, so a rotated refresh token is
   * never lost. A no-op while the vault is locked (nothing to seal with).
   */
  private persistSession(): void {
    if (!isReady()) return;
    const blob = this.getPersistable();
    if (!blob) return;
    try {
      // Written aside and renamed rather than in place: this runs on every token
      // refresh, so a write torn by a crash would leave an unreadable session behind
      // on an ordinary day of use.
      writeSealedAtomic(join(storeDir(), SESSION_FILE), Buffer.from(JSON.stringify(blob)));
    } catch (e) {
      process.stderr.write(
        `[sidecar] could not persist session: ${(e as NodeJS.ErrnoException).code ?? "unknown"}\n`,
      );
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
      // A network that is still coming up (the app starts with Windows, a VPN is
      // connecting) is asked again a few times before the session is given up on.
      const fresh = await withRetry(() => refreshSession(blob.uid, blob.refreshToken), RESUME_RETRY_MS);
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
      // The refresh has just spent the saved refresh token. Saved straight away: an app
      // stopped while the account is being built would otherwise leave only the spent
      // one on disk, and the next start would have to sign in again.
      this.persistSession();
      return this.finishLogin();
    } catch (e) {
      if (isTransient(e)) return { status: "offline" };
      return { status: "error", error: `resume failed: ${(e as Error).message}` };
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

  private async finishLogin(): Promise<LoginResult> {
    // Capture the password before `buildAccount` clears it: a fresh sign-in needs
    // it to derive the vault key. Resume/unlock arrive with the vault already open.
    const password = this.password;
    try {
      const account = await this.buildAccount();
      const sdkBase = {
        httpClient: makeSdkHttpClient(this.session!, () => this.persistSession()),
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
      const primary = await account.getOwnPrimaryAddress();
      this.email = primary.email;
      // Fresh sign-in: derive the vault key from the just-verified password. It
      // is not re-run when unlock already opened the vault (avoids a second scrypt).
      if (password && !isReady()) openOrResetVault(password);
      // Persist the session (rotated refresh token included) whenever the vault is
      // open, so a cold start can resume without a full re-login.
      if (isReady()) this.persistSession();
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
    if (!this.photos) throw new Error("Not signed in");
    const run: TimelineRun = { id: ++this.timelineRuns, items: [], done: false, error: null };
    this.timelineRun = run;
    void (async () => {
      try {
        for await (const item of this.timelineItems()) {
          if (this.timelineRun !== run) return;
          run.items.push(item);
        }
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
  private thumbFlush: ReturnType<typeof setTimeout> | null = null;
  private thumbFetching = 0;

  /**
   * Starts the loopback thumbnail server for the window and returns the URL base it
   * appends a uid to. A fresh token each time, so a base from before a lock is dead.
   */
  async thumbServer(): Promise<{ base: string }> {
    if (!this.photos) throw new Error("Not signed in");
    return { base: await startThumbServer((uid, gone) => this.thumbnailFor(uid, gone)) };
  }

  /**
   * One grid thumbnail for the server: from the sealed cache when it is there, which is
   * a file read and a decrypt, and otherwise fetched with whichever others are missing
   * at the same moment, so a screen of new photos is one request rather than one each.
   * A tile the webview stopped waiting for leaves the queue unfetched.
   */
  private thumbnailFor(uid: string, gone: AbortSignal): Promise<Buffer | null> {
    if (!this.photos || gone.aborted) return Promise.resolve(null);
    const cached = thumbGet(uid, ThumbnailType.Type1);
    if (cached) return Promise.resolve(cached);
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
  ): Promise<{ uid: string; dataUrl: string | null }[]> {
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
        this.photos.iterateThumbnails(missing, ThumbnailType.Type1),
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
  async warmThumbnails(uids: string[]): Promise<{ ready: number }> {
    const rows = await this.getThumbnails(uids, THUMBNAIL_WARM_PER_CALL);
    return { ready: rows.length };
  }

  /** HD preview (Type2 thumbnail) for the image viewer / lightbox. */
  async getPreview(uid: string): Promise<string | null> {
    if (!this.photos) throw new Error("Not signed in");
    const cached = thumbGet(uid, ThumbnailType.Type2);
    if (cached) return toDataUrl(cached);

    // The same guard as the grid's thumbnails above, for the same reason: this is the
    // identical SDK call, and the viewer holds the channel while it runs.
    try {
      for await (const r of withStallGuard(
        this.photos.iterateThumbnails([uid], ThumbnailType.Type2),
        THUMBNAIL_STALL_MS,
        "iterateThumbnails",
      )) {
        if ((r as any).ok) {
          const bytes = Buffer.from((r as any).thumbnail);
          thumbPut(uid, ThumbnailType.Type2, bytes);
          return toDataUrl(bytes);
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

  async getVideo(uid: string): Promise<VideoBytes> {
    if (!this.photos) throw new Error("Not signed in");
    return readVideo(this.photos, uid);
  }

  /** The editor's source for a cloud photo: same-origin pixels plus the metadata a saved
   *  copy keeps. */
  async cloudEditorSource(uid: string): Promise<CloudEditorSource> {
    if (!this.photos) throw new Error("Not signed in");
    return runCloudEditorSource(this.photos, uid);
  }

  /** Save an edited cloud photo as a new timeline node carrying the source's date, place
   *  and camera. Returns the new node's uid. */
  async saveCloudEdit(jpegBase64: string, meta: CloudEditMeta): Promise<{ uid: string }> {
    if (!this.photos) throw new Error("Not signed in");
    return runSaveCloudEdit(this.photos, jpegBase64, meta);
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
    return readMountPage(this.photos, offset, limit);
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

    const trashed = (await readTrash(this.photos)).filter((t) => t.type !== "album");
    const shared = await this.getShared(true);
    const sharedFiles = shared.filter((s) => s.type !== "album" && isMedia(s.mediaType));
    const albums: { uid: string; name: string; items: { uid: string; captureTime: number }[] }[] = [];
    for (const album of shared.filter((s) => s.type === "album")) {
      const items: { uid: string; captureTime: number }[] = [];
      try {
        for await (const item of withStallGuard(
          this.photos.iterateAlbum(album.uid),
          SDK_STALL_MS,
          "iterateAlbum",
        )) {
          const uid = (item as any).nodeUid;
          if (uid) items.push({ uid, captureTime: toMillis((item as any).captureTime) });
        }
      } catch (e) {
        process.stderr.write(`[mount] shared album skipped: ${(e as Error).message}\n`);
      }
      albums.push({ uid: album.uid, name: album.name || "Album", items });
    }

    const meta = await resolveMountMetaBatch(this.photos, [
      ...trashed.map((t) => t.uid),
      ...sharedFiles.map((s) => s.uid),
      ...albums.flatMap((a) => a.items.map((i) => i.uid)),
    ]);
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
    if (!this.photos) throw new Error("Not signed in");
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

  // ---- Albums (see albums.ts) ----

  async getAlbums(): Promise<AlbumSummary[]> {
    if (!this.photos) throw new Error("Not signed in");
    return readAlbums(this.photos);
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
    if (!isReady()) return null;
    const raw = readSealedOrDiscard(join(storeDir(), ALBUM_MEMBERS_FILE));
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

  async listAlbumsForMount(): Promise<AlbumMount[]> {
    if (!this.photos) throw new Error("Not signed in");
    return readAlbumsForMount(this.photos);
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
    return runDeleteAlbum(this.photos, uid, options);
  }

  async addPhotosToAlbum(albumUid: string, uids: string[]): Promise<AlbumResult[]> {
    if (!this.photos) throw new Error("Not signed in");
    return runAddToAlbum(this.photos, albumUid, uids);
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
    for await (const node of withStallGuard(nodes, SDK_STALL_MS, "iterateSharedNodes")) {
      const n = node as any;
      out.push({
        uid: n.uid,
        name: nodeName(n),
        type: n.type,
        mediaType: n.mediaType ?? null,
        isShared: !!n.isShared,
        isSharedPublicly: !!n.isSharedPublicly,
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
      const revision = n.activeRevision?.ok ? n.activeRevision.value : null;
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
  async getLocations(uids: string[]): Promise<{ uid: string; lat: number; lon: number }[]> {
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
        const revision = n.activeRevision?.ok ? n.activeRevision.value : null;
        const size = Number(revision?.claimedSize ?? 0);
        const meta = { name: nodeName(n), mediaType: n.mediaType ?? null, durationMs: nodeDurationMs(n) ?? 0, geo };
        metaPut(n.uid, size > 0 ? { ...meta, size } : meta);
        if (geo) out.push({ uid: n.uid, lat: geo[0], lon: geo[1] });
      }
    }
    return out;
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

  /** Reads the export `startImport` made ready into a review, with the host's frames. */
  prepareImport(
    frames: Record<string, string> = {},
    media: Record<string, ShellMediaInfo> = {},
  ): { started: boolean } {
    if (!this.photos) throw new Error("Not signed in");
    runPrepareImport(this.photos, frames, media);
    return { started: true };
  }

  getImportReview() {
    return readImportReview();
  }

  getImportChecks() {
    return readImportChecks();
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

  /** Everything the details panel shows. Size and hashes live on the revision. */
  async getNodeDetails(uid: string): Promise<Record<string, unknown>> {
    if (!this.photos) throw new Error("Not signed in");
    const n: any = await this.photos.getNode(uid);
    const revision = n.activeRevision?.ok ? n.activeRevision.value : null;

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
      isSharedPublicly: !!n.isSharedPublicly,
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
    for await (const r of withStallGuard(this.photos.trashNodes(uids), SDK_STALL_MS, "trashNodes")) {
      const result = r as any;
      out.push(
        result.ok
          ? { uid: result.uid, ok: true }
          : { uid: result.uid, ok: false, error: String(result.error?.message ?? result.error) },
      );
    }
    return out;
  }

  // ---- Trash (SDK: iterateTrashedNodeUids / restoreNodes / deleteNodes / emptyTrash) ----

  async listTrashed(): Promise<TrashItem[]> {
    if (!this.photos) throw new Error("Not signed in");
    return readTrash(this.photos);
  }

  async restorePhotos(uids: string[]): Promise<TrashResult[]> {
    if (!this.photos) throw new Error("Not signed in");
    return runRestore(this.photos, uids);
  }

  async deletePhotosForever(uids: string[]): Promise<TrashResult[]> {
    if (!this.photos) throw new Error("Not signed in");
    return runDeleteForever(this.photos, uids);
  }

  async emptyTrash(): Promise<{ emptied: boolean }> {
    if (!this.photos) throw new Error("Not signed in");
    return runEmptyTrash(this.photos);
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
export type DriveReply = DriveCollections & { searchPhotos: number; searchOtherModel: number };

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
      const stored = readSealedOrDiscard(revisionOf(uid));
      if (!stored || stored.toString("utf8") !== revision) return null;
      return readSealedOrDiscard(fileOf(uid));
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
