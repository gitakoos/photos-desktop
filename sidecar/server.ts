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

// Node sidecar: hosts the official Proton Drive TypeScript SDK and answers
// requests from the Tauri Rust host over newline-delimited JSON-RPC (stdin/stdout).
//
// Request  : {"id": number, "method": string, "params"?: any}
// Response : {"id": number, "ok": true, "result": any} | {"id": number, "ok": false, "error": string}
//
// stdout carries ONLY JSON responses. Diagnostics go to stderr.

// Polyfill Uint8Array base64/hex methods (core-js), used by @protontech/crypto.
import "@protontech/crypto/polyfill";
import { VERSION } from "@protontech/drive-sdk";
import { session } from "./proton/session.ts";
import { initStore } from "./proton/store.ts";
import { modelStatus as semanticModelStatus, removeModel, startModelDownload } from "./proton/semantic.ts";
import { detectFaces, faceModelStatus, startFaceModelDownload } from "./proton/faces.ts";
import { ocrModelStatus, removeOcrModels, startOcrModelDownload } from "./proton/ocr.ts";
import { faceHandlers } from "./proton/faceApi.ts";
import { faceScanner } from "./proton/faceScan.ts";
import { closeModelThread } from "./proton/ortSession.ts";
import { labelHandlers } from "./proton/labelApi.ts";
import { setVaultMetaKey } from "./proton/vault.ts";
import { respond, type RpcWriter } from "./rpc.ts";
import { CANCELLED, follow, settle, takeCancelLine } from "./cancels.ts";
import { setHostWriter, takeHostLine } from "./proton/hostCall.ts";
import { readCompressionSettings, setCompression, sweepCompressionTemp } from "./proton/compression.ts";
import { scrubSecrets } from "./scrub.ts";
import { diag, type DiagArea } from "./proton/diag.ts";
import { sessionLockHeld } from "./proton/sessionLock.ts";
import { diagnosticsReport, saveDiagnostics, watchJobs, withoutNames } from "./proton/diagReport.ts";
import { checkUpdate, downloadUpdate, startUpdateDownload, updateStatus } from "./update.ts";

// Two hard rules for the sidecar's output. (1) stdout carries ONLY JSON-RPC
// responses; a stray write corrupts the channel and knocks the sidecar offline.
// (2) sidecar.log (the packaged build's stderr) must NEVER hold account key
// material: the SDK and openpgp log through console.*, and their output or an
// error stack can carry armored keys, passphrases or session keys.
const RELEASE = process.env.SIDECAR_RELEASE === "1";

// ONNX Runtime reads this once when it first loads, which is always later than here (every
// module imports it on demand). The host sets it too; this keeps it off when the sidecar is
// started some other way.
process.env.ORT_DISABLE_TELEMETRY = "1";

// Single choke point for the log: everything written to stderr (our own
// diagnostics from every module, the crash handlers, and the dev console echo)
// is scrubbed first, so a library that embeds a key in an error can never leak
// it to disk.
const rawStderrWrite = process.stderr.write.bind(process.stderr);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stderr as any).write = (chunk: any, ...rest: any[]) => {
  if (typeof chunk !== "string") return rawStderrWrite(chunk, ...rest);
  const clean = scrubSecrets(chunk);
  keepInDiagnostics(clean);
  return rawStderrWrite(clean, ...rest);
};

/** The log's tags whose lines the diagnostics keep too, and the part each belongs to. */
const TAGGED: Record<string, DiagArea> = {
  faces: "faces",
  search: "search",
  labels: "labels",
  backup: "backup",
  import: "import",
  upload: "upload",
  "drive-data": "drive",
  sidecar: "app",
  store: "app",
};

/** A tagged line some module wrote, kept in its part of the diagnostics as well. */
function keepInDiagnostics(text: string): void {
  for (const line of text.split("\n")) {
    const m = /^\[([a-z-]+)\] (.*)$/.exec(line);
    const area = m && TAGGED[m[1]];
    if (area) diag.capture(area, withoutNames(m![2]));
  }
}

// Library console.* is kept OFF both channels: never stdout, and in the packaged
// build never the log either. It lands in a small in-memory ring (not persisted,
// not exposed); dev echoes it to the console for visibility.
const consoleRing: string[] = [];
for (const method of ["log", "info", "debug", "warn", "trace", "error"] as const) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (console as any)[method] = (...args: unknown[]) => {
    const line = scrubSecrets(`[console.${method}] ${args.map((a) => String(a)).join(" ")}`);
    consoleRing.push(line);
    if (consoleRing.length > 200) consoleRing.shift();
    if (!RELEASE) rawStderrWrite(line + "\n"); // dev visibility only; never persisted in the packaged app
  };
}

// Keep the sidecar alive on stray async errors from background SDK tasks, so a
// single rejection can't silently drop the authenticated session. Written via
// the scrubbing stderr wrap above.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[sidecar] unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
  );
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`[sidecar] uncaughtException: ${err.stack ?? String(err)}\n`);
});
// Every exit Node itself runs leaves a line with its code; one that leaves none was a native crash
// or a kill, which the host logs with the process's exit status.
process.on("exit", (code) => {
  rawStderrWrite(`[sidecar] exit code=${code}\n`);
});

type Request = { id: number; method: string; params?: any };

let initialised = false;

/** A list of photo uids from the window: strings only, each at most once, at most `max` (a few thousand by default). */
function uidList(v: unknown, max = 5000): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((u): u is string => typeof u === "string" && u.length > 0 && u.length < 512))].slice(0, max);
}

/** The album an editor was opened from, which its saved copy joins; null outside an album. */
function albumUidOf(p: any): string | null {
  const v = p?.albumUid;
  return typeof v === "string" && v.length > 0 && v.length < 512 ? v : null;
}

/** What a read of the copies on Drive takes, as the window asks for it. */
function driveKinds(p: any) {
  return { faces: p?.faces !== false, labels: p?.labels !== false, search: !!p?.search, faceData: !!p?.faceData };
}

/** `signal` is aborted when the window lets go of the call after it was sent on. */
const handlers: Record<string, (params: any, signal?: AbortSignal) => Promise<unknown> | unknown> = {
  // Sent by the Rust host before anything else: the app directory, and the key
  // that seals the vault's own metadata. The store's data key is NOT passed here;
  // it is derived from the user's password by the vault on unlock, so the cache
  // and session stay sealed until then. The key below opens neither, and exists
  // only so the salt behind that derivation is not readable on disk.
  // Once per process: the host sends it first, and nothing may move the store to another
  // directory or swap the key under a running session afterwards.
  __init: (p) => {
    if (initialised) throw new Error("already initialised");
    initStore(p.dataDir);
    setVaultMetaKey(p.vaultKey);
    initialised = true;
    // What a crash or a forced quit left in the temporary folder: decrypted originals and lighter copies.
    void sweepCompressionTemp();
    return { store: "ready" };
  },
  ping: () => ({ sdkVersion: VERSION, node: process.version }),
  lockStatus: () => session.lockStatus(),
  localLockState: () => session.localLockState(),
  localLockCheck: (p) => session.localLockCheck(p?.password),
  localLockSet: (p) => session.localLockSet(p?.password, p?.current),
  localLockClear: (p) => session.localLockClear(p?.current),
  unlock: (p) => session.unlock(p.password),
  unlockDevice: () => session.unlockDevice(),
  retryResume: () => session.retryResume(),
  startBrowserLogin: () => session.startBrowserLogin(),
  browserLoginStatus: (p) => session.browserLoginStatus(p?.nudge === true),
  cancelBrowserLogin: () => session.cancelBrowserLogin(),
  protectSession: (p) => session.protectSession(typeof p?.password === "string" ? p.password : null),
  signInChoice: () => session.signInChoice(),
  dateEditInfo: (p) => session.dateEditInfo(Array.isArray(p?.uids) ? p.uids.map(String).slice(0, 5000) : []),
  metaInfo: (p) => session.metaInfo(Array.isArray(p?.uids) ? p.uids.map(String).slice(0, 5000) : [], p?.read === true),
  startDateEdit: (p) =>
    session.startDateEdit(
      (Array.isArray(p?.items) ? p.items : [])
        .slice(0, 5000)
        .map((i: any) => ({
          uid: String(i?.uid ?? ""),
          captureMs: Number(i?.captureMs) || 0,
          ...(i?.place === null
            ? { place: null }
            : i?.place && typeof i.place === "object"
              ? { place: { lat: Number(i.place.lat), lon: Number(i.place.lon) } }
              : {}),
          ...(i?.meta && typeof i.meta === "object" ? { meta: i.meta } : {}),
        })),
    ),
  dateEditStatus: () => session.dateEditStatus(),
  stopDateEdit: () => session.stopDateEdit(),
  startCloudCompress: (p) => session.startCloudCompress(Array.isArray(p?.uids) ? p.uids.map(String).slice(0, 50000) : []),
  cloudCompressStatus: () => session.cloudCompressStatus(),
  stopCloudCompress: () => session.stopCloudCompress(),
  gifBegin: (p) => session.gifBegin(Number(p?.width), Number(p?.height)),
  gifFrame: (p) => session.gifFrame(String(p?.job ?? ""), Number(p?.index), typeof p?.data === "string" ? p.data : ""),
  gifCancel: (p) => session.gifCancel(String(p?.job ?? "")),
  gifFinish: (p) => session.gifFinish(String(p?.job ?? ""), String(p?.uid ?? "")),
  keepSignIn: (p) => session.keepSignIn(p?.choice === "device" ? "device" : "password"),
  lock: () => session.lock(),
  getTimeline: () => session.getTimeline(),
  startTimeline: () => session.startTimeline(),
  timelinePage: (p) => session.timelinePage(p.run, p.offset ?? 0, p.limit ?? 20000),
  getThumbnails: (p, signal) => session.getThumbnails(p.uids, undefined, signal),
  warmThumbnails: (p, signal) => session.warmThumbnails(p.uids, signal),
  getPreview: (p, signal) => session.getPreview(p.uid, signal),
  getOriginal: (p) => session.getOriginal(p.uid),
  releaseOriginal: (p) => session.releaseOriginal(p?.uid),
  readOriginalBytes: (p) => session.readOriginalBytes(p.token),
  pinOffline: (p) => session.pinOffline(p.uids ?? []),
  unpinOffline: (p) => session.unpinOffline(p.uids ?? []),
  unpinAllOffline: () => session.unpinAllOffline(),
  offlineStatus: () => session.offlineStatus(),
  offlineAlbums: () => session.offlineAlbums(),
  offlineAlbumSet: (p) => session.offlineAlbumSet(String(p?.uid ?? ""), p?.on === true),
  getVideo: (p) => session.getVideo(p.uid),
  videoNotStreamable: (p) => session.videoNotStreamable(String(p?.uid ?? "")),
  getMotionClip: (p) => session.getMotionClip(String(p?.uid ?? "")),
  localMotionClip: (p) => session.localMotionClip(String(p?.path ?? "")),
  cameraFacts: (p) => session.cameraFacts(String(p?.uid ?? "")),
  startSaveOriginals: (p) => session.startSaveOriginals(p.uids, p.destDir),
  saveStatus: () => session.saveStatus(),
  listForMount: (p) => session.listForMount(p.offset ?? 0, p.limit ?? 50),
  hydrateFile: (p) => session.hydrateFile(p.uid, typeof p.dir === "string" ? p.dir : undefined),
  // The same download for the "keep every photo" pass, on a lane that yields to the window.
  hydrateFileBg: (p) => session.hydrateFile(p.uid, typeof p.dir === "string" ? p.dir : undefined),
  mountFates: (p) => session.mountFates(Array.isArray(p?.uids) ? p.uids.map(String) : []),
  mountDigests: (p) => session.mountDigests(Array.isArray(p?.uids) ? p.uids.map(String) : []),
  keepReady: () => session.keepReady(),
  mountHidden: () => session.mountHidden(),
  startHydrate: (p) => session.startHydrate(p.uid, typeof p.dir === "string" ? p.dir : undefined),
  hydrateProgress: (p) => session.hydrateProgress(String(p.path ?? "")),
  cancelHydrate: (p) => session.cancelHydrate(String(p.path ?? "")),
  listExtrasForMount: () => session.listExtrasForMount(),
  heapStats: () => process.memoryUsage(),
  getAlbums: (p) => session.getAlbums(p?.includeHidden === true),
  getAlbumPhotos: (p) => session.getAlbumPhotos(p.uid),
  getAlbumPhotoUids: () => session.getAlbumPhotoUids(),
  cachedAlbumPhotoUids: () => session.cachedAlbumPhotoUids(),
  listAlbumsForMount: (p) =>
    session.listAlbumsForMount(
      Math.max(0, Math.floor(Number(p?.offset) || 0)),
      p?.limit === undefined ? undefined : Math.max(1, Math.floor(Number(p.limit) || 1)),
    ),
  createAlbum: (p) => session.createAlbum(p.name),
  renameAlbum: (p) => session.renameAlbum(p.uid, p.name),
  setAlbumCover: (p) => session.setAlbumCover(p.uid, p.coverUid),
  deleteAlbum: (p) => session.deleteAlbum(p.uid, { force: !!p.force, saveToTimeline: !!p.saveToTimeline }),
  addPhotosToAlbum: (p) => session.addPhotosToAlbum(p.albumUid, p.uids),
  removePhotosFromAlbum: (p) => session.removePhotosFromAlbum(p.albumUid, p.uids),
  getShared: (p) => session.getShared(!!p.withMe),
  listInvitations: () => session.listInvitations(),
  acceptInvitation: (p) => session.acceptInvitation(String(p.uid)),
  declineInvitation: (p) => session.declineInvitation(String(p.uid)),
  getSharingInfo: (p) => session.getSharingInfo(p.uid),
  // An absent password or expiry keeps whatever the link has; null takes it off.
  setPublicLink: (p) =>
    session.setPublicLink(p.uid, { customPassword: p.customPassword, expiration: p.expiration }),
  removePublicLink: (p) => session.removePublicLink(p.uid),
  invitePeople: (p) => session.invitePeople(p.uid, p.emails ?? [], String(p.role ?? "viewer")),
  removePerson: (p) => session.removePerson(p.uid, p.email),
  stopSharing: (p) => session.stopSharing(p.uid),
  getMetadata: (p) => session.getMetadata(p.uids),
  getDurations: (p) => session.getDurations(p.uids),
  getLocations: (p) => session.getLocations(Array.isArray(p?.uids) ? p.uids : []),
  getMediaTypes: (p) => session.getMediaTypes(p.uids),
  startUpload: (p) =>
    session.startUpload(
      p.paths,
      p.frames ?? {},
      p.media ?? {},
      typeof p.albumUid === "string" && p.albumUid
        ? { uid: p.albumUid, name: typeof p.albumName === "string" ? p.albumName : "" }
        : undefined,
    ),
  startImport: (p) =>
    session.startImport(
      Array.isArray(p.paths) ? p.paths.filter((x: unknown) => typeof x === "string") : [],
    ),
  prepareImport: (p) => session.prepareImport(p.frames ?? {}, p.media ?? {}),
  myFilesList: (p) => session.myFilesList(typeof p?.uid === "string" && p.uid ? p.uid : undefined),
  myFilesCheck: (p) =>
    session.myFilesCheck((Array.isArray(p?.uids) ? p.uids : []).filter((u: unknown) => typeof u === "string").slice(0, 32)),
  myFilesThumbs: (p) =>
    session.myFilesThumbs((Array.isArray(p?.uids) ? p.uids : []).filter((u: unknown) => typeof u === "string").slice(0, 48)),
  startMyFilesImport: (p) =>
    session.startMyFilesImport(
      (Array.isArray(p?.folders) ? p.folders : [])
        .filter((f: any) => typeof f?.uid === "string" && typeof f?.name === "string")
        .slice(0, 200),
      (Array.isArray(p?.files) ? p.files : [])
        .filter((f: any) => typeof f?.uid === "string" && typeof f?.folder === "string")
        .slice(0, 20_000),
      p?.move === true,
    ),
  getImportReview: () => session.getImportReview(),
  getImportChecks: () => session.getImportChecks(),
  importThumbnails: (p) =>
    session.importThumbnails(Array.isArray(p.paths) ? p.paths.filter((x: unknown): x is string => typeof x === "string") : []),
  confirmImport: (p) =>
    session.confirmImport(
      Array.isArray(p.exclude) ? p.exclude.filter((x: unknown) => Number.isInteger(x)) : [],
      p.albums !== false,
      p.live !== false,
    ),
  discardImport: () => session.discardImport(),
  dropReplaced: () => session.dropReplaced(),
  startDropUpload: (p) =>
    session.startDropUpload(
      Array.isArray(p.paths) ? p.paths.filter((x: unknown) => typeof x === "string") : [],
      p.frames ?? {},
      p.media ?? {},
      typeof p.albumUid === "string" ? p.albumUid : undefined,
      typeof p.albumName === "string" ? p.albumName : undefined,
      p.favorite === true,
    ),
  uploadStatus: () => session.uploadStatus(),
  uploadCompressionSet: (p) => {
    setCompression(readCompressionSettings(p));
    return { ok: true };
  },
  getDriveCollections: (p) => session.getDriveCollections(!!p?.refresh, driveKinds(p)),
  sharedBackupSet: (p) => session.setSharedBackup(p?.on === true, driveKinds(p)),
  sharedBackupStatus: () => session.sharedBackupStatus(),
  sharedBackupCheck: () => session.sharedBackupCheck(),
  sharedBackupRefresh: () => session.sharedBackupRefresh(),
  sharedBackupShown: (p) => session.sharedBackupShown(p?.shown !== false),
  checkPhotoEvents: () => session.checkPhotoEvents(),
  sharedBackupFlush: (p) => session.sharedBackupFlush(Math.max(0, Math.min(Number(p?.waitMs) || 0, 30_000))),
  signOutSave: (p) => session.signOutSave(Math.max(0, Math.min(Number(p?.waitMs) || 0, 5_000)), p?.start === true),
  sharedBackupNow: () => {
    void session.backUpNow().catch(() => undefined);
    return session.sharedBackupStatus();
  },
  sharedBackupLoad: () => session.loadFromDrive(),
  // What the window chose, by sync id; with seed, the choices from before the feature.
  settingsSyncReport: (p) =>
    session.settingsSyncReport(
      (Array.isArray(p?.values) ? p.values : [])
        .filter((v: any) => typeof v?.id === "string")
        .slice(0, 64)
        .map((v: any) => ({ id: String(v.id).slice(0, 64), x: v.x })),
      p?.seed === true,
    ),
  settingsSyncPull: (p) =>
    session.settingsSyncPull(
      (Array.isArray(p?.done) ? p.done : [])
        .filter((v: any) => typeof v?.id === "string" && Number.isFinite(v?.t))
        .slice(0, 64)
        .map((v: any) => ({ id: String(v.id).slice(0, 64), t: Number(v.t) })),
    ),
  driveBackups: () => session.driveBackups(),
  driveBackupTrash: (p) => session.trashDriveBackup(String(p?.device ?? "").slice(0, 64)),
  faceClearHere: async () => {
    await session.clearFacesHere();
    return { ok: true };
  },
  faceClearEverywhere: async () => {
    await session.clearFacesEverywhere();
    return { ok: true };
  },
  semanticSearch: (p) =>
    session.semanticSearch(
      String(p?.query ?? "").slice(0, 500),
      Math.min(1000, Math.max(1, Math.floor(Number(p?.limit) || 200))),
    ),
  themes: () => session.themes(),
  semanticModelStatus: () => semanticModelStatus(),
  semanticModelDownload: () => startModelDownload(),
  semanticModelRemove: () => removeModel(),
  faceModelStatus: () => faceModelStatus(),
  faceModelDownload: () => startFaceModelDownload(),
  detectFaces: (p) => detectFaces(String(p?.rgb ?? "")),
  ...faceHandlers,
  ...labelHandlers(() => session.backup.changed()),
  thumbServer: () => session.thumbServer(),
  cancelUpload: () => session.cancelUpload(),
  clearUploads: () => session.clearUploads(),
  getNodeDetails: (p) => session.getNodeDetails(p.uid),
  cachedNames: (p) => session.cachedNames(uidList(p?.uids).slice(0, 200)),
  cloudEditorSource: (p) => session.cloudEditorSource(p.uid),
  saveCloudEdit: (p) => session.saveCloudEdit(p.jpegBase64, p.meta, albumUidOf(p)),
  videoEditSource: (p) => session.videoEditSource(String(p?.uid ?? "")),
  videoEditProgress: (p) => session.videoEditProgress(String(p?.path ?? "")),
  videoEditCancel: (p) => session.videoEditCancel(String(p?.path ?? "")),
  videoEditStage: (p) => session.videoEditStage(String(p?.path ?? ""), String(p?.ext ?? "")),
  saveEditedMedia: (p) =>
    session.saveEditedMedia({
      path: String(p?.path ?? ""),
      thumb: typeof p?.thumb === "string" ? p.thumb : null,
      name: String(p?.name ?? ""),
      captureTime: Number.isFinite(p?.captureTime) ? p.captureTime : null,
      camera: typeof p?.camera === "string" ? p.camera : null,
      latitude: Number.isFinite(p?.latitude) ? p.latitude : null,
      longitude: Number.isFinite(p?.longitude) ? p.longitude : null,
      width: Number.isFinite(p?.width) ? p.width : null,
      height: Number.isFinite(p?.height) ? p.height : null,
      durationMs: Number.isFinite(p?.durationMs) ? p.durationMs : null,
    }, albumUidOf(p)),
  renamePhoto: (p) => session.renamePhoto(p.uid, p.name),
  trashPhotos: (p) => session.trashPhotos(p.uids),
  listTrashed: () => session.listTrashed(),
  // `uids`: only those are counted, the ones an emptying destroys.
  trashCount: (p) => session.trashCount(Array.isArray(p?.uids) ? uidList(p.uids, Infinity) : undefined),
  // The same listing, read ahead for a Trash view not yet open: its own name so the host
  // runs it in the background lane rather than in front of what the window is waiting on.
  listTrashedAhead: () => session.listTrashed(true),
  hiddenState: () => session.hiddenState(),
  hiddenSet: (p) =>
    session.hiddenSet(p?.kind === "albums" ? "albums" : "photos", uidList(p?.uids), p?.hidden !== false),
  hiddenRefresh: () => session.hiddenRefresh(),
  albumOrderGet: (p) => session.albumOrderGet(String(p?.uid ?? "").slice(0, 512)),
  albumOrderSetMode: (p) =>
    session.albumOrderSetMode(
      String(p?.uid ?? "").slice(0, 512),
      p?.mode === "oldest" ? "oldest" : p?.mode === "custom" ? "custom" : "newest",
    ),
  albumOrderSave: (p) =>
    session.albumOrderSave(
      String(p?.uid ?? "").slice(0, 512),
      (Array.isArray(p?.order) ? p.order : [])
        .filter((u: unknown): u is string => typeof u === "string" && u.length > 0 && u.length < 512)
        .slice(0, 200_000),
    ),
  albumOrderSeed: (p) => session.albumOrderSeed(p?.modes && typeof p.modes === "object" ? p.modes : {}),
  ocrModelStatus: () => ocrModelStatus(),
  ocrModelDownload: () => startOcrModelDownload(),
  ocrModelRemove: () => removeOcrModels(),
  ocrStart: (p) =>
    session.ocrStart(
      {
        uid: typeof p?.uid === "string" ? p.uid : undefined,
        path: typeof p?.path === "string" ? p.path : undefined,
      },
      p?.ahead === true,
    ),
  ocrResult: (p) => session.ocrResult(Number(p?.id)),
  duplicatesStart: () => session.duplicatesStart(),
  duplicatesStatus: () => session.duplicatesStatus(),
  duplicatesGroups: () => session.duplicatesGroups(),
  duplicatesTrash: (p) =>
    session.duplicatesTrash(
      (Array.isArray(p?.groups) ? p.groups : []).map((g: any) => ({ uids: uidList(g?.uids), keep: uidList(g?.keep) })),
      (Array.isArray(p?.whole) ? p.whole : []).map(uidList),
    ),
  duplicatesIgnore: (p) => session.duplicatesIgnore(uidList(p?.uids), p?.on !== false),
  restorePhotos: (p) => session.restorePhotos(p.uids),
  deletePhotosForever: (p) => session.deletePhotosForever(p.uids),
  // What the Trash view listed, all of it: no list destroys nothing.
  emptyTrash: (p) => session.emptyTrash(uidList(p?.uids, Infinity)),
  setFavorite: (p) => session.setFavorite(p.uids, !!p.favorite),
  whoami: () => session.whoami(),
  getAccountInfo: () => session.getAccountInfo(),
  // `discard`: the user chose to sign out although changes are not on Drive yet.
  signOut: (p) => session.signOut(p?.discard === true),
  checkUpdate: () => checkUpdate(),
  downloadUpdate: () => downloadUpdate(),
  startUpdateDownload: () => startUpdateDownload(),
  updateStatus: () => updateStatus(),
  diagSetDetailed: (p) => {
    diag.setDetailed(p?.on === true);
    return { detailed: diag.isDetailed() };
  },
  diagReport: (p) => diagnosticsReport(Array.isArray(p?.header) ? p.header : []),
  diagSave: (p) => saveDiagnostics(String(p?.path ?? ""), Array.isArray(p?.header) ? p.header : []),
};

/** The error a call that needs Proton answers while only the photos kept offline are open. */
const OFFLINE_ERROR = "OFFLINE";

async function handle(req: Request): Promise<unknown> {
  // The table's own entries only: a name like `constructor` or `toString` must not reach
  // whatever the object inherits.
  const handler = Object.hasOwn(handlers, req.method) ? handlers[req.method] : undefined;
  if (!handler) {
    return { id: req.id, ok: false, error: `unknown method: ${req.method}` };
  }
  const started = Date.now();
  const signal = follow(req.id);
  try {
    const result = await handler(req.params ?? {}, signal);
    diag.record("rpc", req.method, Date.now() - started);
    return { id: req.id, ok: true, result };
  } catch (e) {
    // Let go of by the window: not a failure, and nobody reads the answer.
    if (signal?.aborted) {
      diag.record("rpc", req.method, Date.now() - started);
      return { id: req.id, ok: false, error: CANCELLED };
    }
    diag.record("rpc", req.method, Date.now() - started, false, { error: (e as Error)?.name ?? "error" });
    const message = (e as Error).message ?? String(e);
    // Open on the photos kept offline: what needs Proton says so, in the window's language.
    const offline = message === "Not signed in" && session.isOfflineOnly();
    return { id: req.id, ok: false, error: offline ? OFFLINE_ERROR : message };
  } finally {
    settle(req.id);
  }
}

const write: RpcWriter = (line) => {
  process.stdout.write(line);
};

process.stderr.write("[sidecar] ready\n");
// The process id, so the session lines of this sidecar can be told from those of another
// writing to the same log, one left behind by an earlier start among them.
diag.log("app", "start", { pid: process.pid, parent: process.ppid });
watchJobs(() => session.sharedBackupStatus());
setHostWriter(write);
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      respond(write, null, { id: null, ok: false, error: "invalid JSON request" });
      continue;
    }
    // The host answering a call of ours, not asking anything.
    if (takeHostLine(req)) continue;
    // The host passing on that the window let go of a call already sent.
    if (takeCancelLine(req)) continue;
    const id = req?.id ?? null;
    void handle(req)
      .then((res) => respond(write, id, res))
      .catch((e) =>
        respond(write, id, { id, ok: false, error: (e as Error).message ?? String(e) }),
      );
  }
});
/**
 * The host closed the channel, or the channel broke with the host gone: either way nothing can
 * ask this process anything again, so it ends. A broken pipe raises an error instead of an end,
 * and with no listener for that this process would stay behind with the session unlocked and
 * renewing it, beside the next start. Noted so the log tells a quit apart from a sidecar that
 * was stopped, and shows whether a token renewal was under way. The model calls under way finish
 * first, and what the scan stored is written. The process then ends itself the way the host ends
 * a sidecar it drops, at once and with nothing more run: a normal exit tears the model threads
 * down, which can abort the process while one is still in the runtime. The end waits for the line
 * to go out, and for no longer than a moment when the log's pipe is already gone.
 */
let quitting = false;
/** The longest the quit waits on a model call to finish: about the slowest one, a model opened on the card. */
const QUIT_MODEL_WAIT_MS = 3_000;
function quit(): void {
  if (quitting) return;
  quitting = true;
  diag.log("session", "quit", { pid: process.pid, renewing: sessionLockHeld() });
  faceScanner.finishSaving();
  void closeModelThread(QUIT_MODEL_WAIT_MS).then(() => {
    // What the scan stored while the calls finished.
    faceScanner.finishSaving();
    const end = (): void => void process.kill(process.pid, "SIGKILL");
    process.stderr.write("", end);
    setTimeout(end, 500);
  });
}
process.stdin.on("end", quit);
process.stdin.on("close", quit);
process.stdin.on("error", quit);
