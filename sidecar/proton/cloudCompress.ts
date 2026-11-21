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

// Compress on Drive: photos and videos already on Drive replaced by lighter copies, as the
// Android app does it.
//
// Each original is downloaded to a temporary file, compressed with the upload levels chosen in
// Settings (whether or not compression is on for uploads), and only a copy at least a tenth
// smaller goes up. The copy keeps the original's date, place, tags and other metadata, joins
// every album the original was in, and takes over what this computer keeps by it; the original
// goes to the Drive trash last (`finishReplacement`, shared with the date and place editor).
// A Live Photo, a burst, a panorama, a RAW file and a hidden photo are left as they are.
//
// The queue is kept on disk with each photo's stage, and what a copy goes up as before it is
// sent, so a restart or a lock carries on without a second upload. One photo at a time.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, rmSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";

import {
  canCompressType,
  compressExisting,
  compressionDir,
  holdTemp,
  jpegName,
  makeCompressionDir,
  mp4Name,
  releaseTemp,
  type PreparedCopy,
} from "./compression.ts";
import {
  abandonCopy,
  albumUidsOf,
  FINISH_ATTEMPTS,
  finishReplacement,
  FollowBusy,
  isLivePhoto,
  guardedDeps,
  liveOriginal,
  persistUnlessLocked,
  pickUpSentCopy,
  recordSent,
  replacing,
  storedThumbnails,
  withHeldProgress,
  type DateEditDeps,
  type Replacement,
  type SentCopy,
} from "./dateEdit.ts";
import { activeRevisionOf, nodeName, toMillis } from "./nodes.ts";
import { readSealedOrSetAside, storeDir, writeSealedAtomic } from "./store.ts";
import { openDownloader } from "./downloadSlots.ts";

/** Proton's photo tags a copy would lose the meaning of: motion photo, selfie-burst, burst, panorama, RAW. */
export const KEPT_TAGS = new Set([3, 4, 7, 8, 9]);

/** A copy has to be at least this much smaller than the original to replace it. */
export const MIN_SAVING = 0.1;

const QUEUE_FILE = "cloud-compress.enc";

const RAW_TYPES = /^image\/(x-)?(adobe-dng|dng|raw|canon-cr2|canon-cr3|nikon-nef|sony-arw|panasonic-rw2|olympus-orf|fuji-raf|x-[a-z0-9-]*raw)/;

export type CompressDeps = DateEditDeps & {
  /** Whether the photo is in this computer's Hidden, which Compress on Drive leaves alone. */
  isHidden: (uid: string) => boolean;
};

type Entry = Replacement & {
  /** Bytes the copy saves, recorded when it went up. */
  saved?: number;
};

export type CompressStatus = {
  running: boolean;
  total: number;
  done: number;
  compressed: number;
  kept: number;
  failed: number;
  /** Bytes the copies made in this run save, together. */
  savedBytes: number;
  /** How far the photo in hand is, 0 to 1, while a video is compressed. */
  current: number;
  errors: { uid: string; error: string }[];
  cancelled: boolean;
};

/** Why a photo is left as it is, or null when it can be compressed. */
export function keptBecause(node: any, hidden: boolean): "live" | "tag" | "raw" | "type" | "hidden" | null {
  if (hidden) return "hidden";
  if (isLivePhoto(node)) return "live";
  const tags = (node?.photo?.tags ?? []) as number[];
  if (tags.some((tag) => KEPT_TAGS.has(tag))) return "tag";
  const mediaType = String(node?.mediaType ?? "").toLowerCase().split(";")[0].trim();
  if (RAW_TYPES.test(mediaType)) return "raw";
  if (!canCompressType(mediaType)) return "type";
  return null;
}

/** Whether a copy of `copySize` bytes is worth an original of `sourceSize`. */
export function worthReplacing(sourceSize: number, copySize: number): boolean {
  return sourceSize > 0 && copySize > 0 && copySize <= sourceSize * (1 - MIN_SAVING);
}

/** The original's claimed metadata with its frame scaled to the copy's. */
export function scaledClaim(claimed: any, scale: number): Record<string, unknown> {
  const base: Record<string, any> = claimed && typeof claimed === "object" ? { ...claimed } : {};
  const media = base.Media && typeof base.Media === "object" ? { ...base.Media } : null;
  if (media && scale > 0 && scale < 1) {
    if (Number(media.Width) > 0) media.Width = Math.round(Number(media.Width) * scale);
    if (Number(media.Height) > 0) media.Height = Math.round(Number(media.Height) * scale);
    base.Media = media;
  }
  return base;
}

async function downloadToFile(photos: any, uid: string, path: string, signal: AbortSignal): Promise<number> {
  const { downloader, unused } = await openDownloader(photos, uid, signal);
  const file = await open(path, "w").catch((e) => {
    unused();
    throw e;
  });
  let size = 0;
  try {
    // The SDK reports the end through `completion()` and need not close the stream it was given,
    // so the file is written chunk by chunk here and closed once that resolves.
    const stream = new WritableStream<Uint8Array>({
      async write(chunk) {
        await file.write(chunk);
        size += chunk.byteLength;
      },
    });
    await downloader.downloadToStream(stream as any).completion();
  } finally {
    await file.close();
  }
  return size;
}

async function sha1Of(path: string): Promise<string> {
  const hash = createHash("sha1");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * One photo, from the stage it reached: "compressed" when a lighter copy replaced it, "kept"
 * when it is left as it is. Throws with the reason a step failed; the original is then in place.
 */
export async function compressOne(
  deps: CompressDeps,
  e: Entry,
  save: () => void,
  signal: AbortSignal,
  onProgress: (value: number) => void,
): Promise<"compressed" | "kept"> {
  const { photos } = deps;
  await pickUpSentCopy(photos, e, save);
  if (e.stage === "queued") {
    const node = await liveOriginal(photos, e);
    if (keptBecause(node, deps.isHidden(e.uid))) return "kept";
    const name = nodeName(node);
    const mediaType = String(node?.mediaType ?? "").toLowerCase().split(";")[0].trim();
    if (!name || !mediaType) throw new Error("The photo could not be read");
    const captureMs = toMillis(node?.photo?.captureTime);
    const revision = activeRevisionOf(node);

    await makeCompressionDir();
    // The original's own extension: the system's video reader picks its format by it.
    const original = join(
      compressionDir(),
      `drive-${createHash("sha1").update(e.uid).digest("hex").slice(0, 16)}${extname(name).toLowerCase()}`,
    );
    holdTemp(original);
    let copy: PreparedCopy | null = null;
    try {
      const sourceSize = await downloadToFile(photos, e.uid, original, signal);
      copy = await compressExisting(original, mediaType, new Date(captureMs > 0 ? captureMs : Date.now()), signal, onProgress);
      // The decrypted original is not needed once its copy is made: it goes before the upload.
      await rm(original, { force: true }).catch(() => {});
      if (!copy || !worthReplacing(sourceSize, copy.size)) return "kept";
      if (signal.aborted) throw new Error("cancelled");

      const modified = toMillis(revision?.claimedModificationTime);
      const tags = ((node?.photo?.tags ?? []) as number[]).slice();
      // The copy goes up under the original's name, its extension the copy's own format.
      const sendName = copy.mediaType === "video/mp4" ? mp4Name(name) : copy.mediaType === "image/jpeg" ? jpegName(name) : name;
      const sent: SentCopy = {
        name: sendName,
        sha1: await sha1Of(copy.path),
        albums: albumUidsOf(node),
        tags,
        expectMs: captureMs,
        saved: sourceSize - copy.size,
      };
      e.sent = sent;
      save();
      const uploader = await photos.getFileUploader(
        sendName,
        {
          mediaType: copy.mediaType,
          expectedSize: copy.size,
          expectedSha1: sent.sha1,
          ...(modified > 0 ? { modificationTime: new Date(modified) } : {}),
          ...(captureMs > 0 ? { captureTime: new Date(captureMs) } : {}),
          tags,
          additionalMetadata: scaledClaim(revision?.claimedAdditionalMetadata, copy.scale),
        },
        new AbortController().signal,
      );
      const stream = Readable.toWeb(createReadStream(copy.path)) as any;
      const controller = await uploader.uploadFromStream(stream, await storedThumbnails(photos, e.uid));
      const { nodeUid } = await controller.completion();
      if (!nodeUid || nodeUid === e.uid) throw new Error("Drive did not keep a new copy");
      recordSent(e, nodeUid, sent);
      save();
    } finally {
      await rm(original, { force: true }).catch(() => {});
      releaseTemp(original);
      if (copy) {
        await rm(copy.path, { force: true }).catch(() => {});
        releaseTemp(copy.path);
      }
    }
  }
  await finishReplacement(deps, e, save);
  return "compressed";
}

function readQueue(): Entry[] {
  const raw = readSealedOrSetAside(join(storeDir(), QUEUE_FILE));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as { v: 1; items: Entry[] };
    return Array.isArray(parsed?.items) ? parsed.items.filter((i) => typeof i?.uid === "string" && typeof i?.stage === "string") : [];
  } catch {
    return [];
  }
}

function writeQueue(items: Entry[]): void {
  const path = join(storeDir(), QUEUE_FILE);
  if (items.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(storeDir(), { recursive: true });
  writeSealedAtomic(path, Buffer.from(JSON.stringify({ v: 1, items }), "utf8"));
}

const idle = (): CompressStatus => ({
  running: false,
  total: 0,
  done: 0,
  compressed: 0,
  kept: 0,
  failed: 0,
  savedBytes: 0,
  current: 0,
  errors: [],
  cancelled: false,
});

/** Runs Compress on Drive one photo after another, kept on disk until each is through. */
export class CloudCompressor {
  private status: CompressStatus = idle();
  private queue: Entry[] = [];
  private running: Promise<void> | null = null;
  private cancel = false;
  private abort: AbortController | null = null;
  private deps: CompressDeps | null = null;
  /** Counts each attach and detach, so a job knows the session it started under is gone. */
  private attachment = 0;

  constructor(
    /** The wait before the rest of a replacement whose copy is up is tried again. */
    private readonly retryMs = 30_000,
    private readonly persist: (items: Entry[]) => void = writeQueue,
    private readonly load: () => Entry[] = readQueue,
  ) {}

  /**
   * Signed in: picks up a queue a restart or a lock cut short. A job this process took further than
   * the store could record while locked goes on from where it is held.
   */
  attach(deps: CompressDeps): void {
    this.deps = deps;
    this.attachment++;
    const saved = this.load();
    if (saved.length === 0) return;
    this.queue = withHeldProgress(saved, this.queue);
    this.status = { ...idle(), total: saved.length };
    this.kick();
  }

  /** Signed out or locked: stops the current photo at its next step, keeping the queue on disk. */
  detach(): void {
    this.cancel = true;
    this.abort?.abort();
    this.deps = null;
    this.attachment++;
  }

  getStatus(): CompressStatus {
    return { ...this.status, errors: [...this.status.errors] };
  }

  start(uids: string[]): CompressStatus {
    const fresh = [...new Set(uids.filter((u) => typeof u === "string" && u))];
    if (fresh.length === 0) return this.getStatus();
    if (!this.running) this.status = idle();
    for (const uid of fresh) {
      if (this.queue.some((q) => q.uid === uid)) continue;
      this.queue.push({ uid, stage: "queued" });
      this.status.total++;
    }
    this.persist(this.queue);
    this.kick();
    return this.getStatus();
  }

  /** Drops the photos not started and stops the one in hand unless its copy is already up. */
  stop(): CompressStatus {
    if (!this.running) return this.getStatus();
    this.cancel = true;
    if (this.queue[0]?.stage === "queued") this.abort?.abort();
    return this.getStatus();
  }

  private kick(): void {
    if (this.running || !this.deps) return;
    this.cancel = false;
    this.status.running = true;
    this.running = this.drain().finally(() => {
      this.running = null;
      this.status.running = false;
      this.status.current = 0;
      // Attached again while the last run was still winding down: the queue goes on under the new session.
      if (this.deps && this.queue.length > 0) this.kick();
    });
  }

  private async drain(): Promise<void> {
    const attachment = this.attachment;
    while (this.queue.length > 0) {
      if (!this.deps || this.attachment !== attachment) return;
      const deps = guardedDeps(this.deps, () => this.attachment === attachment);
      const entry = this.queue[0];
      // A photo whose copy may be up is never dropped: its copy is found and the replacement finished.
      if (this.cancel && entry.stage === "queued" && !entry.sent) {
        this.status.cancelled = true;
        this.queue = this.queue.filter((q) => q.stage !== "queued" || q.sent);
        this.persist(this.queue);
        continue;
      }
      // A date or place change of the same photo goes first; this one waits its turn.
      if (replacing.has(entry.uid)) {
        this.queue.push(this.queue.shift()!);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const claimed = entry.uid;
      replacing.add(claimed);
      this.abort = new AbortController();
      this.status.current = 0;
      try {
        const outcome = await compressOne(deps, entry, () => this.persist(this.queue), this.abort.signal, (v) => {
          this.status.current = Math.max(0, Math.min(1, v));
        });
        if (outcome === "compressed") {
          this.status.compressed++;
          this.status.savedBytes += Math.max(0, entry.saved ?? 0);
        } else this.status.kept++;
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        if (e instanceof FollowBusy) {
          this.queue.push(this.queue.shift()!);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        // Locked or signed out: the photo stays in the queue for the next sign-in, as far as it got.
        if (this.attachment !== attachment) {
          persistUnlessLocked(this.persist, this.queue);
          return;
        }
        if (this.abort.signal.aborted && entry.stage === "queued" && !entry.sent) {
          this.status.cancelled = true;
        } else {
          // A job whose copy is up, or may be, is tried again rather than given up, so no second copy is sent.
          if (entry.stage !== "queued" || entry.sent) {
            entry.attempts = (entry.attempts ?? 0) + 1;
            if (entry.attempts < FINISH_ATTEMPTS) {
              process.stderr.write(`[cloudcompress] finishing a replacement failed, tried again later: ${message}\n`);
              this.queue.push(this.queue.shift()!);
              this.persist(this.queue);
              await new Promise((r) => setTimeout(r, this.retryMs));
              continue;
            }
          }
          const error = await abandonCopy(deps, entry, message);
          this.status.failed++;
          this.status.errors.push({ uid: claimed, error });
          process.stderr.write(`[cloudcompress] a photo was not compressed: ${error}\n`);
        }
      } finally {
        replacing.delete(claimed);
        replacing.delete(entry.uid);
        this.abort = null;
      }
      this.status.done++;
      this.queue = this.queue.filter((q) => q !== entry);
      persistUnlessLocked(this.persist, this.queue);
    }
  }
}

export const cloudCompressor = new CloudCompressor();
