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

// A memory-bounded worker pool for cloud capture-date fixes.
//
// Downloads and uploads overlap in a small number of workers. Each worker holds an
// uncompressed original Buffer, so the scheduler uses the cached file size as a weighted
// memory reservation (3x for the download/Buffer.concat peak) and caps both worker count
// and estimated resident bytes.
//
// The work runs in deliberately small windows: a window's photos are re-uploaded with the
// date written into the file (see `dateFixCore.ts`), every copy is read back and confirmed
// to carry the date, its album membership is restored and confirmed on the live node, and
// only then are the window's originals trashed in one SDK-batched operation — all before
// the next window starts. The attempts can never run far ahead of what is confirmed on
// Drive: a selection's progress is sealed window by window, no wide "expedition" ever
// holds large temporary cloud storage or a long unverified chain, and an interruption
// loses at most one small window of work.
//
// Rate limits, offline spells and transient server errors are retried by the SDK's own
// API service (honouring `retry-after`), so nothing here layers a second retry loop over
// it; the windows only bound how much is in flight while it backs off.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { availableParallelism } from "node:os";

import { collectResults } from "./nodes.ts";
import { SDK_STALL_MS, withStallGuard } from "./stallGuard.ts";
import {
  driveAlreadyCarries,
  dumpErrorDiagnostics,
  uploadDateFixCopy,
  verifyDateFixCopy,
  type DateFixItem,
  type DateFixResult,
  type UploadedDateFixCopy,
} from "./dateFixCore.ts";

export type { DateFixItem, DateFixResult } from "./dateFixCore.ts";

export type DateFixStage = "uploading" | "albums" | "trashing" | "done";

export type DateFixStatus = {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  skipped: number;
  active: number;
  uploaded: number;
  /** Photos whose Drive date already matched the filename, so nothing was written. */
  unchanged: number;
  batch: number;
  batches: number;
  batchDone: number;
  batchTotal: number;
  stage: DateFixStage;
  cancelled: boolean;
  /** The job stopped itself: Drive took the date for none of the photos it tried. */
  halted: boolean;
};

type RunOptions = {
  concurrency?: number;
  memoryBudgetBytes?: number;
  shouldCancel?: () => boolean;
  onProgress?: (status: DateFixStatus) => void;
};

type QueuedItem = { item: DateFixItem; index: number; memoryWeight: number };
type UploadedCopy = UploadedDateFixCopy & { index: number; failedAlbums: Set<string> };
type DateFixJob = {
  status: DateFixStatus;
  results: DateFixResult[];
  cancelRequested: boolean;
};

// Windows stay small on purpose — a window's uploads are its own sealed transaction on
// the cloud, so a large selection completes in many short, verified trips rather than one
// long unverified one. Item count and bytes each cap the window; whichever hits first
// seals it. Concurrency stays below the SDK's upload queue cap. A small floor overlaps
// network waits even on low-core machines; the ceiling avoids over-parallelizing JS crypto.
const DEFAULT_CONCURRENCY = Math.max(2, Math.min(4, availableParallelism()));
const DEFAULT_MEMORY_BUDGET = 256 * 1024 * 1024;
const MAX_REPLACEMENT_BATCH_ITEMS = 8;
const MAX_TEMPORARY_UPLOAD_BYTES = 192 * 1024 * 1024;
const UNKNOWN_FILE_SIZE = 64 * 1024 * 1024;
/**
 * What a photo of unknown size counts for when the windows are planned. The memory
 * reservation above stays pessimistic, but here the worst case of 64 MB cut a selection
 * whose sizes were not cached into windows of three: 786 trips for 2,358 photos. A
 * photo's typical size keeps a window of unknowns at its full count, and the upload
 * still meters its own memory per photo.
 */
const UNKNOWN_WINDOW_SIZE = 8 * 1024 * 1024;
const MIN_FILE_RESERVATION = 8 * 1024 * 1024;

/**
 * After this many photos that could not be dated, with not one success in the whole job,
 * the job stops: Drive is not accepting the date from this session, and going on would
 * only spend a download and an upload per photo to learn it again. What was not reached
 * is reported as not started.
 */
const JOB_BREAKER_FAILURES = 3;

let currentJob: DateFixJob | null = null;

function initialStatus(total: number): DateFixStatus {
  return {
    running: true,
    done: 0,
    total,
    failed: 0,
    skipped: 0,
    active: 0,
    uploaded: 0,
    unchanged: 0,
    batch: 1,
    batches: 1,
    batchDone: 0,
    batchTotal: total,
    stage: "uploading",
    cancelled: false,
    halted: false,
  };
}

function residentReservation(item: DateFixItem): number {
  const claimed = Number(item.expectedSize);
  const estimate = Number.isFinite(claimed) && claimed > 0 ? claimed : UNKNOWN_FILE_SIZE;
  // The downloader accumulates chunks and concatenates them into a Buffer; WebCrypto and
  // the uploader may also retain working copies. Reserve 3x the claimed size for the peak.
  return Math.max(MIN_FILE_RESERVATION, Math.ceil(estimate * 3));
}

function clampConcurrency(requested: unknown): number {
  const value = Number(requested ?? DEFAULT_CONCURRENCY);
  return Number.isFinite(value) ? Math.max(1, Math.min(4, Math.floor(value))) : DEFAULT_CONCURRENCY;
}

type IndexedItem = { item: DateFixItem; index: number };

/**
 * Splits a selection into the small sealed windows every run works through: at most
 * MAX_REPLACEMENT_BATCH_ITEMS photos and MAX_TEMPORARY_UPLOAD_BYTES of claimed size, with
 * an oversized photo alone in its own window. The byte cap is what bounds the temporary
 * cloud storage a window's uploads hold until their originals are trashed.
 */
function planWindows(items: DateFixItem[]): IndexedItem[][] {
  const windows: IndexedItem[][] = [];
  let window: IndexedItem[] = [];
  let windowBytes = 0;
  items.forEach((item, index) => {
    const claimed = Number(item.expectedSize);
    const bytes = Number.isFinite(claimed) && claimed > 0 ? claimed : UNKNOWN_WINDOW_SIZE;
    if (
      window.length > 0 &&
      (window.length >= MAX_REPLACEMENT_BATCH_ITEMS || windowBytes + bytes > MAX_TEMPORARY_UPLOAD_BYTES)
    ) {
      windows.push(window);
      window = [];
      windowBytes = 0;
    }
    window.push({ item, index });
    windowBytes += bytes;
    // An oversized photo forms a one-item window: it is still processable, but its
    // corrected copy is trashed before another window consumes more cloud quota.
    if (bytes > MAX_TEMPORARY_UPLOAD_BYTES) {
      windows.push(window);
      window = [];
      windowBytes = 0;
    }
  });
  if (window.length > 0) windows.push(window);
  return windows;
}

/**
 * A window's nodes in one batched SDK lookup rather than one `getNode` round-trip per
 * photo. Best-effort: whatever it does not return (a client without the batch call, a
 * lookup that failed partway) is read singly by the caller, which then also surfaces
 * that photo's own error.
 */
async function readWindowNodes(photos: any, uids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (typeof photos.iterateNodes !== "function" || uids.length === 0) return out;
  try {
    for await (const node of withStallGuard(photos.iterateNodes(uids), SDK_STALL_MS, "iterateNodes(datefix)")) {
      const n = node as any;
      if (!n?.missingUid && n?.uid) out.set(n.uid, n);
    }
  } catch {
    /* the per-photo read below covers whatever this did not */
  }
  return out;
}

/** Moves a corrected copy that could not be confirmed to the trash. Best-effort. */
async function discardCopy(photos: any, copyUid: string): Promise<void> {
  try {
    const [result] = await collectResults(photos.trashNodes([copyUid]));
    if (!result?.ok) process.stderr.write(`[datefix] could not trash an unconfirmed copy\n`);
  } catch {
    process.stderr.write(`[datefix] could not trash an unconfirmed copy\n`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function forEachBounded<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await work(items[index]);
      }
    }),
  );
}

/** Run one bounded upload window, then restore its albums and trash its originals. */
async function fixDateBatch(
  photos: any,
  items: DateFixItem[],
  options: RunOptions = {},
): Promise<DateFixResult[]> {
  const concurrency = clampConcurrency(options.concurrency);
  const requestedMemoryBudget = Number(options.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET);
  const memoryBudget = Number.isFinite(requestedMemoryBudget)
    ? Math.max(MIN_FILE_RESERVATION, requestedMemoryBudget)
    : DEFAULT_MEMORY_BUDGET;
  const sourceUids = new Set(items.map((item) => item.uid));
  const status = initialStatus(items.length);
  const results: (DateFixResult | undefined)[] = new Array(items.length);
  const uploadedCopies: UploadedCopy[] = [];
  // Sorting lightest-first lets the scheduler use remaining memory without repeatedly
  // scanning or shifting a large selection (which would become quadratic at library scale).
  const queue: QueuedItem[] = items
    .map((item, index) => ({ item, index, memoryWeight: residentReservation(item) }))
    .sort((a, b) => a.memoryWeight - b.memoryWeight || a.index - b.index);
  let nextTask = 0;

  const emit = () => {
    if (options.shouldCancel?.()) status.cancelled = true;
    options.onProgress?.({ ...status });
  };
  const wasCancelled = () => {
    if (options.shouldCancel?.()) status.cancelled = true;
    return status.cancelled;
  };
  let activeCount = 0;
  let activeMemory = 0;
  let changeVersion = 0;
  const waiters = new Set<() => void>();
  const notify = () => {
    changeVersion++;
    for (const wake of waiters) wake();
    waiters.clear();
  };
  const waitForChange = (seen: number) =>
    new Promise<void>((resolve) => {
      if (changeVersion !== seen) resolve();
      else waiters.add(resolve);
    });
  const claim = (): QueuedItem | undefined => {
    if (wasCancelled() || activeCount >= concurrency) return undefined;
    const task = queue[nextTask];
    if (!task || (activeCount > 0 && activeMemory + task.memoryWeight > memoryBudget)) return undefined;
    nextTask++;
    activeCount++;
    activeMemory += task.memoryWeight;
    status.active = activeCount;
    emit();
    return task;
  };

  async function uploadWorker(): Promise<void> {
    for (;;) {
      if (wasCancelled()) return;
      const task = claim();
      if (!task) {
        if (nextTask >= queue.length || wasCancelled()) return;
        const seen = changeVersion;
        await waitForChange(seen);
        continue;
      }

      try {
        const copy = await uploadDateFixCopy(photos, task.item);
        if (!copy) {
          // Drive already shows the filename date: nothing to replace, nothing to trash.
          results[task.index] = { uid: task.item.uid, ok: true, unchanged: true };
          status.unchanged++;
          continue;
        }
        if (sourceUids.has(copy.newUid)) {
          throw new Error("upload reused a selected original; originals kept");
        }
        // The confirmation the trash fence rests on: the copy is read back and only a
        // copy that verifiably carries the new date is allowed into the album/trash
        // stages; one that does not fails here, its original in place.
        try {
          await verifyDateFixCopy(photos, task.item, copy.newUid);
        } catch (verifyError) {
          // The copy never took the date, and its original stays: the copy would only be
          // a duplicate of it. It goes to the trash (restorable from there), so a failed
          // fix leaves the library exactly as it found it.
          await discardCopy(photos, copy.newUid);
          throw verifyError;
        }
        uploadedCopies.push({ ...copy, index: task.index, failedAlbums: new Set() });
        status.uploaded++;
      } catch (error) {
        const message = messageOf(error);
        process.stderr.write(`[datefix] failed for ${task.item.uid}: ${message}\n`);
        dumpErrorDiagnostics(task.item.uid, error);
        results[task.index] = { uid: task.item.uid, ok: false, error: message };
        status.failed++;
      } finally {
        activeCount--;
        activeMemory -= task.memoryWeight;
        status.active = activeCount;
        status.done++;
        emit();
        notify();
      }
    }
  }

  emit();
  await Promise.all(Array.from({ length: concurrency }, () => uploadWorker()));

  // If cancelled, finish the already-started copies safely but do not begin any more.
  // Items never claimed by a worker are explicitly reported as skipped, not failures.
  if (wasCancelled()) {
    for (const task of queue.slice(nextTask)) {
      results[task.index] = { uid: task.item.uid, ok: false, cancelled: true };
      status.skipped++;
    }
    emit();
  }

  status.stage = "albums";
  emit();
  const byAlbum = new Map<string, UploadedCopy[]>();
  for (const copy of uploadedCopies) {
    for (const albumUid of new Set(copy.albumUids)) {
      const group = byAlbum.get(albumUid) ?? [];
      group.push(copy);
      byAlbum.set(albumUid, group);
    }
  }

  // One SDK call per album; the SDK chunks large membership lists to Proton's request
  // limit and reports per-link results. Each positive answer is then confirmed against
  // the live node itself: the trash fence trusts a membership only when a read-back
  // shows the copy actually standing in that album, since a batch answer and the
  // photo's state can drift. The trash fence thus stays per photo.
  const albumGroups = [...byAlbum.entries()];
  await forEachBounded(albumGroups, Math.min(3, concurrency), async ([albumUid, copies]) => {
    // Membership is only asked of copies the batch call reported as joined.
    const joined = new Set<string>();
    try {
      const albumResults = await collectResults(
        photos.addPhotosToAlbum(albumUid, copies.map((copy) => copy.newUid)),
      );
      const answered = copies.filter(
        (copy) => albumResults.find((result) => result.uid === copy.newUid)?.ok,
      );
      for (const copy of albumResults.filter((result) => !result.ok)) {
        const copyByUid = copies.find((c) => c.newUid === copy.uid);
        if (copyByUid) copyByUid.failedAlbums.add(albumUid);
      }
      // Read each joined copy back: the membership counts only when the live node
      // carries it too.
      await forEachBounded(answered, Math.min(3, concurrency), async (copy) => {
        try {
          const node = await photos.getNode(copy.newUid);
          const albums = new Set(
            ((node?.photo?.albums ?? []) as { nodeUid?: unknown }[]).map((a) => String(a?.nodeUid ?? "")),
          );
          if (albums.has(albumUid)) joined.add(copy.newUid);
          else copy.failedAlbums.add(albumUid);
        } catch {
          // A copy that vanishes before its membership can be confirmed is treated like
          // a refused re-add: the original is kept and the photo retries as a duplicate.
          copy.failedAlbums.add(albumUid);
        }
      });
    } catch {
      for (const copy of copies) copy.failedAlbums.add(albumUid);
    }
    for (const copy of copies) {
      if (!joined.has(copy.newUid) && !copy.failedAlbums.has(albumUid)) copy.failedAlbums.add(albumUid);
    }
  });

  const readyToTrash: UploadedCopy[] = [];
  for (const copy of uploadedCopies) {
    if (copy.failedAlbums.size > 0) {
      const message = `re-add failed for ${copy.failedAlbums.size} of ${copy.albumUids.length} album(s); original kept`;
      results[copy.index] = { uid: copy.item.uid, ok: false, error: message };
      status.failed++;
      process.stderr.write(`[datefix] ${message} for ${copy.item.uid}\n`);
    } else {
      readyToTrash.push(copy);
    }
  }

  // Batch-trash only originals whose corrected copies are uploaded and confirmed in
  // every original album. A failed trash is best-effort: the corrected date is already
  // live, and leaving a duplicate is safer than rolling back or losing a photo.
  status.stage = "trashing";
  emit();
  if (readyToTrash.length > 0) {
    try {
      const trashResults = await collectResults(photos.trashNodes(readyToTrash.map((copy) => copy.item.uid)));
      const byUid = new Map(trashResults.map((result) => [result.uid, result]));
      for (const copy of readyToTrash) {
        const trash = byUid.get(copy.item.uid);
        if (!trash?.ok) {
          process.stderr.write(`[datefix] trash of original ${copy.item.uid} was refused\n`);
        }
        results[copy.index] = { uid: copy.item.uid, ok: true };
      }
    } catch (error) {
      process.stderr.write(`[datefix] batch trash failed: ${messageOf(error)}\n`);
      for (const copy of readyToTrash) results[copy.index] = { uid: copy.item.uid, ok: true };
    }
  }

  status.stage = "done";
  status.running = false;
  status.active = 0;
  emit();
  return results.map((result, index) => result ?? { uid: items[index].uid, ok: false, cancelled: true });
}

/**
 * Processes a selection, window by window. Each window's photos are read in one batch;
 * one Drive already shows on the named day is left alone, half of a live photo is
 * refused (its pair is dated together), and the rest are re-uploaded with the date
 * written into the file itself and confirmed, their albums restored, and only then
 * their originals trashed — all before the next window starts. A job in which not one
 * photo takes the date stops after a few, rather than spend an upload on every photo.
 */
export async function fixDatesFromName(
  photos: any,
  items: DateFixItem[],
  options: RunOptions = {},
): Promise<DateFixResult[]> {
  const status = initialStatus(items.length);
  const windows = planWindows(items);
  status.batches = Math.max(1, windows.length);
  const emit = () => {
    if (options.shouldCancel?.()) status.cancelled = true;
    options.onProgress?.({ ...status });
  };
  const wasCancelled = () => {
    if (options.shouldCancel?.()) status.cancelled = true;
    return status.cancelled;
  };
  const results: (DateFixResult | undefined)[] = new Array(items.length);
  // `done` counts only outcomes that are final on Drive (or final failures), never mere
  // attempts: a photo waiting for its upload is not done until the upload is sealed.
  const seal = (index: number, result: DateFixResult) => {
    results[index] = result;
    if (result.cancelled) {
      status.skipped++;
      return;
    }
    status.done++;
    status.batchDone++;
    if (result.unchanged) status.unchanged++;
    else if (result.ok) status.uploaded++;
    else status.failed++;
  };
  let fixed = 0;
  let failed = 0;
  emit();

  for (let w = 0; w < windows.length; w++) {
    if (wasCancelled()) break;
    const window = windows[w]!;
    status.batch = w + 1;
    status.batchDone = 0;
    status.batchTotal = window.length;
    status.stage = "uploading";
    emit();

    // The guards, before anything is spent: the photo must be readable, must not be one
    // half of a live photo, and must actually show another day on Drive.
    const nodes = await readWindowNodes(photos, window.map(({ item }) => item.uid));
    const toFix: IndexedItem[] = [];
    for (const entry of window) {
      const { item, index } = entry;
      try {
        const node: any = nodes.get(item.uid) ?? (await photos.getNode(item.uid));
        if (node?.photo?.mainPhotoNodeUid || (node?.photo?.relatedPhotoNodeUids ?? []).length > 0) {
          throw new Error("a live photo's still and video are dated together; neither is replaced alone");
        }
        if (driveAlreadyCarries(node, item)) seal(index, { uid: item.uid, ok: true, unchanged: true });
        else toFix.push(entry);
      } catch (error) {
        const message = messageOf(error);
        process.stderr.write(`[datefix] skipped ${item.uid}: ${message}\n`);
        seal(index, { uid: item.uid, ok: false, error: message });
      }
    }
    emit();
    if (toFix.length === 0) continue;

    const windowResults = await fixDateBatch(
      photos,
      toFix.map((entry) => entry.item),
      {
        ...options,
        onProgress: (part) => {
          status.active = part.active;
          status.stage = part.stage === "done" ? "trashing" : part.stage;
          status.cancelled = status.cancelled || part.cancelled;
          emit();
        },
      },
    );
    toFix.forEach((entry, i) => {
      const result = windowResults[i] ?? { uid: entry.item.uid, ok: false, cancelled: true };
      if (result.ok && !result.unchanged) fixed++;
      else if (!result.ok && !result.cancelled) failed++;
      seal(entry.index, result);
    });
    status.active = 0;
    emit();
    if (fixed === 0 && failed >= JOB_BREAKER_FAILURES) {
      // Not one photo has taken the date: stop rather than upload the whole selection to
      // learn the same thing. The rest is reported as not started.
      status.halted = true;
      process.stderr.write("[datefix] Drive accepted the date for no photo; the job stops here\n");
      break;
    }
  }

  for (let index = 0; index < items.length; index++) {
    if (!results[index]) seal(index, { uid: items[index]!.uid, ok: false, cancelled: true });
  }
  status.running = false;
  status.stage = "done";
  status.active = 0;
  emit();
  return results as DateFixResult[];
}

/** Starts a date-fix batch without holding the single RPC channel for its duration. */
export function startDateFixJob(photos: any, items: DateFixItem[]): { started: boolean } {
  if (currentJob?.status.running) return { started: false };
  const job: DateFixJob = {
    status: initialStatus(items.length),
    results: [],
    cancelRequested: false,
  };
  currentJob = job;
  void fixDatesFromName(photos, items, {
    shouldCancel: () => job.cancelRequested,
    onProgress: (status) => {
      job.status = status;
    },
  }).then(
    (results) => {
      job.results = results;
    },
    (error) => {
      process.stderr.write(`[datefix] batch failed: ${messageOf(error)}\n`);
      job.results = items.map((item) => ({ uid: item.uid, ok: false, error: messageOf(error) }));
      job.status.failed = items.length;
    },
  ).finally(() => {
    job.status.running = false;
    job.status.active = 0;
    job.status.stage = "done";
  });
  return { started: true };
}

export function dateFixJobStatus(): DateFixStatus {
  return currentJob ? { ...currentJob.status } : { ...initialStatus(0), running: false, stage: "done" };
}

export function cancelDateFixJob(): DateFixStatus {
  if (currentJob?.status.running) {
    currentJob.cancelRequested = true;
    currentJob.status.cancelled = true;
  }
  return dateFixJobStatus();
}

export function dateFixJobResults(): DateFixResult[] {
  return currentJob?.status.running ? [] : [...(currentJob?.results ?? [])];
}
