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
import { setVaultMetaKey } from "./proton/vault.ts";
import { respond, type RpcWriter } from "./rpc.ts";
import { scrubSecrets } from "./scrub.ts";
import { checkUpdate, downloadUpdate, startUpdateDownload, updateStatus } from "./update.ts";

// Two hard rules for the sidecar's output. (1) stdout carries ONLY JSON-RPC
// responses; a stray write corrupts the channel and knocks the sidecar offline.
// (2) sidecar.log (the packaged build's stderr) must NEVER hold account key
// material: the SDK and openpgp log through console.*, and their output or an
// error stack can carry armored keys, passphrases or session keys.
const RELEASE = process.env.SIDECAR_RELEASE === "1";

// Single choke point for the log: everything written to stderr (our own
// diagnostics from every module, the crash handlers, and the dev console echo)
// is scrubbed first, so a library that embeds a key in an error can never leak
// it to disk.
const rawStderrWrite = process.stderr.write.bind(process.stderr);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process.stderr as any).write = (chunk: any, ...rest: any[]) =>
  rawStderrWrite(typeof chunk === "string" ? scrubSecrets(chunk) : chunk, ...rest);

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

type Request = { id: number; method: string; params?: any };

let initialised = false;

const handlers: Record<string, (params: any) => Promise<unknown> | unknown> = {
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
    return { store: "ready" };
  },
  ping: () => ({ sdkVersion: VERSION, node: process.version }),
  login: (p) => session.login(p.username, p.password),
  submitCaptcha: (p) => session.submitCaptcha(p.token),
  submit2fa: (p) => session.submit2fa(p.code),
  lockStatus: () => session.lockStatus(),
  unlock: (p) => session.unlock(p.password),
  unlockDevice: () => session.unlockDevice(),
  retryResume: () => session.retryResume(),
  startBrowserLogin: () => session.startBrowserLogin(),
  browserLoginStatus: () => session.browserLoginStatus(),
  cancelBrowserLogin: () => session.cancelBrowserLogin(),
  protectSession: (p) => session.protectSession(typeof p?.password === "string" ? p.password : null),
  lock: () => session.lock(),
  getTimeline: () => session.getTimeline(),
  startTimeline: () => session.startTimeline(),
  timelinePage: (p) => session.timelinePage(p.run, p.offset ?? 0, p.limit ?? 20000),
  getThumbnails: (p) => session.getThumbnails(p.uids),
  warmThumbnails: (p) => session.warmThumbnails(p.uids),
  getPreview: (p) => session.getPreview(p.uid),
  getOriginal: (p) => session.getOriginal(p.uid),
  releaseOriginal: (p) => session.releaseOriginal(p?.uid),
  readOriginalBytes: (p) => session.readOriginalBytes(p.token),
  pinOffline: (p) => session.pinOffline(p.uids ?? []),
  unpinOffline: (p) => session.unpinOffline(p.uids ?? []),
  unpinAllOffline: () => session.unpinAllOffline(),
  offlineStatus: () => session.offlineStatus(),
  getVideo: (p) => session.getVideo(p.uid),
  startSaveOriginals: (p) => session.startSaveOriginals(p.uids, p.destDir),
  saveStatus: () => session.saveStatus(),
  listForMount: (p) => session.listForMount(p.offset ?? 0, p.limit ?? 50),
  hydrateFile: (p) => session.hydrateFile(p.uid, typeof p.dir === "string" ? p.dir : undefined),
  startHydrate: (p) => session.startHydrate(p.uid, typeof p.dir === "string" ? p.dir : undefined),
  hydrateProgress: (p) => session.hydrateProgress(String(p.path ?? "")),
  cancelHydrate: (p) => session.cancelHydrate(String(p.path ?? "")),
  listExtrasForMount: () => session.listExtrasForMount(),
  heapStats: () => process.memoryUsage(),
  getAlbums: () => session.getAlbums(),
  getAlbumPhotos: (p) => session.getAlbumPhotos(p.uid),
  getAlbumPhotoUids: () => session.getAlbumPhotoUids(),
  cachedAlbumPhotoUids: () => session.cachedAlbumPhotoUids(),
  listAlbumsForMount: () => session.listAlbumsForMount(),
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
  getImportReview: () => session.getImportReview(),
  getImportChecks: () => session.getImportChecks(),
  confirmImport: (p) =>
    session.confirmImport(
      Array.isArray(p.exclude) ? p.exclude.filter((x: unknown) => Number.isInteger(x)) : [],
      p.albums !== false,
      p.live !== false,
    ),
  discardImport: () => session.discardImport(),
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
  getDriveCollections: (p) =>
    session.getDriveCollections(!!p?.refresh, {
      faces: p?.faces !== false,
      labels: p?.labels !== false,
      search: !!p?.search,
    }),
  semanticSearch: (p) =>
    session.semanticSearch(
      String(p?.query ?? "").slice(0, 500),
      Math.min(1000, Math.max(1, Math.floor(Number(p?.limit) || 200))),
    ),
  semanticModelStatus: () => semanticModelStatus(),
  semanticModelDownload: () => startModelDownload(),
  semanticModelRemove: () => removeModel(),
  faceModelStatus: () => faceModelStatus(),
  faceModelDownload: () => startFaceModelDownload(),
  detectFaces: (p) => detectFaces(String(p?.rgb ?? "")),
  thumbServer: () => session.thumbServer(),
  cancelUpload: () => session.cancelUpload(),
  clearUploads: () => session.clearUploads(),
  getNodeDetails: (p) => session.getNodeDetails(p.uid),
  cloudEditorSource: (p) => session.cloudEditorSource(p.uid),
  saveCloudEdit: (p) => session.saveCloudEdit(p.jpegBase64, p.meta),
  renamePhoto: (p) => session.renamePhoto(p.uid, p.name),
  trashPhotos: (p) => session.trashPhotos(p.uids),
  listTrashed: () => session.listTrashed(),
  restorePhotos: (p) => session.restorePhotos(p.uids),
  deletePhotosForever: (p) => session.deletePhotosForever(p.uids),
  emptyTrash: () => session.emptyTrash(),
  setFavorite: (p) => session.setFavorite(p.uids, !!p.favorite),
  whoami: () => session.whoami(),
  getAccountInfo: () => session.getAccountInfo(),
  signOut: () => session.signOut(),
  checkUpdate: () => checkUpdate(),
  downloadUpdate: () => downloadUpdate(),
  startUpdateDownload: () => startUpdateDownload(),
  updateStatus: () => updateStatus(),
};

async function handle(req: Request): Promise<unknown> {
  // The table's own entries only: a name like `constructor` or `toString` must not reach
  // whatever the object inherits.
  const handler = Object.hasOwn(handlers, req.method) ? handlers[req.method] : undefined;
  if (!handler) {
    return { id: req.id, ok: false, error: `unknown method: ${req.method}` };
  }
  try {
    const result = await handler(req.params ?? {});
    return { id: req.id, ok: true, result };
  } catch (e) {
    return { id: req.id, ok: false, error: (e as Error).message ?? String(e) };
  }
}

const write: RpcWriter = (line) => {
  process.stdout.write(line);
};

process.stderr.write("[sidecar] ready\n");
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
    const id = req?.id ?? null;
    void handle(req)
      .then((res) => respond(write, id, res))
      .catch((e) =>
        respond(write, id, { id, ok: false, error: (e as Error).message ?? String(e) }),
      );
  }
});
process.stdin.on("end", () => process.exit(0));
