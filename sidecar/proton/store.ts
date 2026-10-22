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

// The app-owned encrypted store.
//
// The AES-256-GCM data key is derived from the user's Proton password by the
// vault (vault.ts) and set on unlock; it never reaches disk and never leaves
// this process. Everything written here lands inside the app's own directory.
//
// Blob layout: nonce(12) || ciphertext || tag(16).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { guarded, writeChunk } from "./fileWrites.ts";

const NONCE_LEN = 12;
const TAG_LEN = 16;

/**
 * The pinned-for-offline list, sealed with the same key as everything else here.
 * Named in this module because `wipeCache` has to take it with the blobs it
 * describes: a list naming photos whose originals are gone is worse than no list.
 */
export const OFFLINE_LIST_FILE = "offline.enc";

/**
 * The saved session, sealed with that same key. Named here for the same reason as
 * the pin list: a vault-key change reseals the store, and a session blob written
 * under the previous key is unreadable from that moment on.
 */
export const SESSION_FILE = "session.enc";

/**
 * The photos filed in an album, as last read: the timeline hides them at once on the
 * next start instead of showing them until the albums are walked again. Named here so
 * `wipeCache` takes it with the account's other caches.
 */
export const ALBUM_MEMBERS_FILE = "album-members.enc";

/** The phone's copies on Drive as last downloaded (people, labels, search), each under the
 *  revision it was read at. The account's own data, so `wipeCache` takes it. */
export const DRIVE_COPIES_DIR = "drive-copies";

let dataDir: string | null = null;
let dataKey: Buffer | null = null;

export function initStore(dir: string): void {
  dataDir = dir;
  mkdirSync(thumbDir(), { recursive: true });
  // A wipe the app quit in the middle of leaves its set-aside folders behind.
  try {
    for (const name of readdirSync(dir)) {
      if (name.includes(DISCARD_MARK)) void rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    /* nothing to sweep */
  }
}

/** Marks a folder set aside by `discardDir`, still being deleted. */
const DISCARD_MARK = ".discard-";

/**
 * Empties a folder at once and deletes what was in it in the background. A cache can
 * hold a file per photo, which on a large library is hundreds of thousands of files:
 * deleting them where they are would stop the sidecar for as long as that takes. A
 * rename is one step whatever the folder holds, so the folder is moved aside and the
 * deletion runs behind. A folder that cannot be moved (a file in it is open) is
 * deleted where it is, as before.
 */
function discardDir(path: string): void {
  if (!existsSync(path)) return;
  const aside = `${path}${DISCARD_MARK}${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  void rm(aside, { recursive: true, force: true }).catch(() => {});
}

/** The vault sets the data key once it is derived from the password. */
export function setDataKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("data key must be 32 bytes");
  dataKey = key;
}

/** Forget the key; the store stays locked until the next unlock. */
export function clearDataKey(): void {
  if (dataKey) dataKey.fill(0);
  dataKey = null;
}

export function storeDir(): string {
  if (!dataDir) throw new Error("store not initialised");
  return dataDir;
}

export function isReady(): boolean {
  return dataDir !== null && dataKey !== null;
}

function thumbDir(): string {
  if (!dataDir) throw new Error("store not initialised");
  return join(dataDir, "thumbs");
}

function metaDir(): string {
  if (!dataDir) throw new Error("store not initialised");
  return join(dataDir, "meta");
}

function originalDir(): string {
  if (!dataDir) throw new Error("store not initialised");
  return join(dataDir, "originals");
}

/**
 * Drop everything sealed with the vault key: thumbnails, the search-index metadata,
 * the originals kept for offline use with the list that names them, and the saved
 * session. Used when the vault key changes and on sign-out. All of it is written
 * under the same key, so leaving any of it behind would strand unreadable blobs of
 * the previous account on disk.
 *
 * The session goes with the rest because a key change reseals the vault in place: a
 * session left behind would sit beside a freshly salted vault it can no longer be
 * opened by.
 */
export function wipeCache(): void {
  if (!dataDir) return;
  try {
    discardDir(thumbDir());
    mkdirSync(thumbDir(), { recursive: true });
    discardDir(metaDir());
    discardDir(originalDir());
    rmSync(join(dataDir, OFFLINE_LIST_FILE), { force: true });
    rmSync(join(dataDir, SESSION_FILE), { force: true });
    rmSync(join(dataDir, ALBUM_MEMBERS_FILE), { force: true });
    discardDir(join(dataDir, DRIVE_COPIES_DIR));
  } catch {
    /* best-effort */
  }
}

export function seal(plain: Buffer): Buffer {
  if (!dataKey) throw new Error("store not initialised");
  const nonce = randomBytes(NONCE_LEN);
  const c = createCipheriv("aes-256-gcm", dataKey, nonce);
  const ciphertext = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, ciphertext, c.getAuthTag()]);
}

export function unseal(blob: Buffer): Buffer {
  if (!dataKey) throw new Error("store not initialised");
  if (blob.length <= NONCE_LEN + TAG_LEN) throw new Error("blob truncated");
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", dataKey, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/**
 * Seal `plain` and publish it at `path` by writing aside and renaming, the way
 * `OriginalSealer` publishes a finished blob.
 *
 * The small sealed files are rewritten in place during ordinary use: the session on
 * every token refresh, the pin list on every pin. A bare write truncates the old blob
 * before it writes the new one, so a crash or a power cut mid-write leaves a file that
 * will never decrypt again. Renaming over the destination is atomic, so a reader sees
 * either the previous blob whole or the new one whole.
 *
 * Throws what the write threw, leaving the destination untouched; each caller decides
 * what a failure to persist costs it.
 */
export function writeSealedAtomic(path: string, plain: Buffer): void {
  const part = `${path}.part`;
  try {
    writeFileSync(part, seal(plain));
    renameSync(part, path);
  } catch (e) {
    try {
      rmSync(part, { force: true });
    } catch {
      /* an orphaned `.part` is inert: nothing reads it and the next write replaces it */
    }
    throw e;
  }
}

/**
 * Read a sealed file, discarding it if it will not open. Null covers both outcomes, so
 * a caller handles "nothing saved" once.
 *
 * The counterpart to `writeSealedAtomic`, and the reason a torn blob is survivable. A
 * file that fails to unseal is torn, or was written under a previous key; either way
 * nothing will ever read it again. Leaving it turns an unreadable kilobyte into a state
 * that fails identically on every retry, and the only way out of that is the one that
 * takes the whole cache with it. Dropping it makes the next start look like a first
 * start instead.
 */
export function readSealedOrDiscard(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  try {
    return unseal(readFileSync(path));
  } catch {
    // The discard is silent to the user by design, since it costs only a sign-in.
    // Silent in the log too would mean an unexplained sign-in with nothing to look
    // at, so the fact is recorded. The base name only: it names which of a handful
    // of fixed files this was, and carries no uid or account.
    process.stderr.write(`[store] discarded a sealed file that would not open: ${basename(path)}\n`);
    try {
      rmSync(path, { force: true });
    } catch {
      /* it fails to open the same way next time, and is dropped then */
    }
    return null;
  }
}

/** Content-addressed file name; the uid never appears in the clear on disk. */
function thumbPath(uid: string, type: number): string {
  const name = createHash("sha256").update(`${uid}:${type}`).digest("hex");
  return join(thumbDir(), `${name}.bin`);
}

/** Cached decrypted thumbnail bytes, or null on a miss / unreadable entry. */
export function thumbGet(uid: string, type: number): Buffer | null {
  if (!isReady()) return null;
  const path = thumbPath(uid, type);
  if (!existsSync(path)) return null;
  try {
    return unseal(readFileSync(path));
  } catch {
    return null; // tampered or written under a previous key
  }
}

export function thumbPut(uid: string, type: number, data: Buffer): void {
  if (!isReady()) return;
  try {
    writeFileSync(thumbPath(uid, type), seal(data));
  } catch {
    /* caching is best-effort; never fail a request over it */
  }
}

// Per-node metadata, content-addressed and encrypted. Everything here is immutable
// for the life of a node: a re-upload is a new uid, so the name, media type, the
// revision's claimed size and a video's length never change. The search index writes
// name + media type; the Explorer mount adds `size` (the exact cloud claimedSize) so a
// later startup can place a photo's placeholder without re-fetching and re-decrypting
// the node. `size` is optional because a search-index write has none — the mount fills
// it in on the one getNode it still does for that photo.
//
// `durationMs` is a video's length, in milliseconds, from the same decrypted revision.
// Present means resolved, and a resolved 0 means the node carries no length to show (an
// image, or a video uploaded before the attribute existed) — so the grid asks once and
// never re-decrypts a node that will not answer. Absent means simply not looked at yet.
type NodeMetaBlob = {
  name: string;
  mediaType: string | null;
  size?: number;
  durationMs?: number;
  /** Where it was taken, latitude then longitude; null when it carries no place. Absent on a
   *  record written before places were kept, which is then read again once. */
  geo?: [number, number] | null;
};

function metaPath(uid: string): string {
  const name = createHash("sha256").update(`meta:${uid}`).digest("hex");
  return join(metaDir(), `${name}.bin`);
}

export function metaGet(uid: string): NodeMetaBlob | null {
  if (!isReady()) return null;
  const path = metaPath(uid);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(unseal(readFileSync(path)).toString("utf8")) as NodeMetaBlob;
  } catch {
    return null; // tampered or written under a previous key
  }
}

export function metaPut(uid: string, meta: NodeMetaBlob): void {
  if (!isReady()) return;
  try {
    mkdirSync(metaDir(), { recursive: true });
    writeFileSync(metaPath(uid), seal(Buffer.from(JSON.stringify(meta))));
  } catch {
    /* best-effort */
  }
}

// ---- Originals kept for offline use ----
//
// A photo the user marked as available offline keeps its full-resolution original
// here, sealed with the same key and content-addressed the same way the thumbnails
// are. These are the only large blobs in the store, so they are written through a
// streaming cipher: a pinned video would otherwise need its whole plaintext, its
// whole ciphertext and the download buffer resident at once.
//
// The bytes the ciphertext adds are fixed (nonce + tag), so a blob's size on disk
// tells us the original's size without opening it.
const SEAL_OVERHEAD = NONCE_LEN + TAG_LEN;

// Named through a call rather than by importing the interface: the literal algorithm
// selects the AEAD overload, which is the one that carries `getAuthTag`.
const gcmCipher = (key: Buffer, nonce: Buffer) => createCipheriv("aes-256-gcm", key, nonce);
type GcmCipher = ReturnType<typeof gcmCipher>;

function originalPath(uid: string): string {
  const name = createHash("sha256").update(`orig:${uid}`).digest("hex");
  return join(originalDir(), `${name}.bin`);
}

/** Whether this photo's original is stored and complete. */
export function originalHas(uid: string): boolean {
  if (!isReady()) return false;
  try {
    return existsSync(originalPath(uid));
  } catch {
    return false;
  }
}

/** The stored original's plaintext bytes, or null on a miss / unreadable entry. */
export function originalGet(uid: string): Buffer | null {
  if (!isReady()) return null;
  const path = originalPath(uid);
  if (!existsSync(path)) return null;
  try {
    return unseal(readFileSync(path));
  } catch {
    return null; // tampered or written under a previous key
  }
}

/**
 * The stored original's plaintext size, taken from the blob's length on disk rather
 * than its contents. Null when nothing usable is stored for this uid.
 *
 * This is what lets a caller apply a size limit before it commits to the file: reading
 * an original costs roughly twice its size in memory (the sealed bytes and the
 * plaintext), which for a pinned video is exactly the cost a limit exists to refuse.
 */
export function originalSize(uid: string): number | null {
  if (!isReady()) return null;
  try {
    const size = statSync(originalPath(uid)).size;
    return size > SEAL_OVERHEAD ? size - SEAL_OVERHEAD : null;
  } catch {
    return null; // absent, or unreadable
  }
}

/**
 * Drop one stored original. `true` when bytes were actually reclaimed.
 *
 * A `.part` from an interrupted transfer goes with it: it is invisible to
 * `originalHas`, so unpinning is the only thing that would ever come back for it, and
 * leaving it would hold disk the user asked to have back.
 */
export function originalDelete(uid: string): boolean {
  if (!dataDir) return false;
  const path = originalPath(uid);
  let reclaimed = false;
  for (const candidate of [path, `${path}.part`]) {
    try {
      if (!existsSync(candidate)) continue;
      rmSync(candidate, { force: true });
      reclaimed = true;
    } catch {
      /* a delete that failed leaves the blob; the next unpin or sign-out takes it */
    }
  }
  return reclaimed;
}

/**
 * Decrypt one stored original straight into `dest`, a chunk at a time. Answers the
 * plaintext byte count.
 *
 * The read-side counterpart to `OriginalSealer`. `originalGet` has to hold the sealed
 * bytes and the whole plaintext at once, which for the largest originals is the very
 * cost the viewer's in-memory cap exists to refuse; this holds one chunk of each.
 *
 * GCM proves a blob intact only at the end, so what lands in `dest` is unverified until
 * the final call returns. A blob that fails that check has by then already put plaintext
 * on disk, so the file is deleted before this throws: no caller is ever handed a partial
 * or tampered write to mistake for the photo.
 *
 * `cancelled` is polled between chunks, so a viewer that has moved on stops the write
 * rather than paying for a photo nobody will look at.
 */
export async function decryptOriginalTo(
  uid: string,
  dest: string,
  cancelled?: () => boolean,
): Promise<number> {
  if (!dataKey) throw new Error("store not initialised");
  const src = originalPath(uid);
  const total = statSync(src).size;
  if (total <= SEAL_OVERHEAD) throw new Error("blob truncated");

  // The nonce opens the blob and the tag closes it, and the tag has to be in hand
  // before any ciphertext is fed in, so both are read up front.
  const nonce = Buffer.alloc(NONCE_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  const fd = openSync(src, "r");
  try {
    readSync(fd, nonce, 0, NONCE_LEN, 0);
    readSync(fd, tag, 0, TAG_LEN, total - TAG_LEN);
  } finally {
    closeSync(fd);
  }

  const d = createDecipheriv("aes-256-gcm", dataKey, nonce);
  d.setAuthTag(tag);
  const input = createReadStream(src, { start: NONCE_LEN, end: total - TAG_LEN - 1 });
  const out = guarded(createWriteStream(dest));
  let plainBytes = 0;
  try {
    for await (const chunk of input) {
      if (cancelled?.()) throw new Error("CANCELLED");
      const plain = d.update(chunk as Buffer);
      plainBytes += plain.length;
      // Respect backpressure so a large original cannot balloon the write buffer.
      await writeChunk(out, plain);
    }
    const tail = d.final(); // throws unless the whole blob authenticates
    plainBytes += tail.length;
    if (tail.length) out.write(tail);
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return plainBytes;
  } catch (e) {
    input.destroy();
    // On Windows an open handle blocks the delete, so the stream is closed first.
    if (!out.destroyed) {
      await new Promise<void>((resolve) => {
        out.once("close", () => resolve());
        out.destroy();
      });
    }
    try {
      rmSync(dest, { force: true });
    } catch {
      /* the viewer's release and the startup sweep both come back for it */
    }
    throw e;
  }
}

/**
 * Drop every stored original, whatever any list says is pinned, and answer how many
 * were reclaimed. A `.part` from an interrupted transfer goes with them.
 *
 * The blobs are content-addressed, so a name on disk cannot be turned back into a uid:
 * freeing what is genuinely stored has to be a sweep of the directory. That is also
 * what makes it the honest answer to "free up everything", because a pin list that was
 * torn, or written under a previous key, reads as empty and names none of them.
 */
export function originalDeleteAll(): number {
  if (!dataDir) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(originalDir())) {
      try {
        rmSync(join(originalDir(), name), { force: true });
        if (name.endsWith(".bin")) removed++;
      } catch {
        /* a blob that will not delete stays; the next sweep or sign-out takes it */
      }
    }
  } catch {
    /* no directory yet: nothing is stored */
  }
  return removed;
}

/**
 * What the stored originals cost on disk, and how many there are. Reported as the
 * plaintext total, so it matches the sizes the rest of the app talks about; the
 * seal's fixed overhead per blob is subtracted rather than measured.
 */
export function originalUsage(): { bytes: number; count: number } {
  if (!dataDir) return { bytes: 0, count: 0 };
  let bytes = 0;
  let count = 0;
  try {
    for (const name of readdirSync(originalDir())) {
      if (!name.endsWith(".bin")) continue; // never count a `.part` still being written
      try {
        const size = statSync(join(originalDir(), name)).size;
        if (size > SEAL_OVERHEAD) {
          bytes += size - SEAL_OVERHEAD;
          count++;
        }
      } catch {
        /* a blob that vanished mid-walk simply does not count */
      }
    }
  } catch {
    /* no directory yet: nothing is stored */
  }
  return { bytes, count };
}

/**
 * A streaming writer for one original.
 *
 * GCM is a stream mode, so the ciphertext can be emitted chunk by chunk and the tag
 * appended at the end; the blob layout is byte-for-byte the one `seal` produces, and
 * `unseal` reads it back with no special case.
 *
 * It writes to a `.part` file and renames on completion, so an interrupted download
 * can never leave a blob that `originalHas` would report as ready.
 */
export class OriginalSealer {
  private readonly dest: string;
  private readonly part: string;
  private readonly cipher: GcmCipher;
  private readonly file: ReturnType<typeof createWriteStream>;
  private plainBytes = 0;
  private done = false;

  constructor(uid: string) {
    if (!isReady()) throw new Error("store not initialised");
    mkdirSync(originalDir(), { recursive: true });
    this.dest = originalPath(uid);
    this.part = `${this.dest}.part`;
    const nonce = randomBytes(NONCE_LEN);
    this.cipher = gcmCipher(dataKey as Buffer, nonce);
    this.file = guarded(createWriteStream(this.part));
    this.file.write(nonce);
  }

  /** Seal and append one chunk, honouring backpressure so the buffer stays flat. */
  write(chunk: Uint8Array): Promise<void> | void {
    this.plainBytes += chunk.byteLength;
    return writeChunk(this.file, this.cipher.update(chunk));
  }

  /** Close the blob and publish it. Returns the plaintext byte count. */
  async finish(): Promise<number> {
    const tail = Buffer.concat([this.cipher.final(), this.cipher.getAuthTag()]);
    this.file.write(tail);
    await new Promise<void>((resolve, reject) => {
      // Close ourselves and wait for the flush; `end(cb)` cannot hang the way
      // waiting on someone else to close the stream could.
      this.file.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    renameSync(this.part, this.dest);
    this.done = true;
    return this.plainBytes;
  }

  /** Abandon a partial blob. Safe to call after `finish`, and safe to call twice. */
  async abort(): Promise<void> {
    if (this.done) return;
    this.done = true;
    if (!this.file.destroyed) {
      await new Promise<void>((resolve) => {
        this.file.once("close", () => resolve());
        this.file.destroy();
      });
    }
    try {
      // On Windows an open handle blocks the delete, which is why the stream is
      // closed above rather than left to the caller.
      rmSync(this.part, { force: true });
    } catch {
      /* a leftover `.part` is inert: it is never read and the next attempt overwrites it */
    }
  }
}
