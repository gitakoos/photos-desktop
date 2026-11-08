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

// Face recognition on this computer: every photo of the library is read once from its large
// preview, its faces found and turned into the phone's recognition numbers, and grouped into
// people. It runs in the background, a few photos at a time as its speed allows, writing down what
// it found in the library's order, and picks up where it stopped.

import { hostname } from "node:os";

import { cropRegion, decodeLikePhone, letterbox, type Decoded } from "./phoneDecode.ts";

import {
  ALIGNED,
  MIN_SHARPNESS,
  alignedBlur,
  embedInput,
  normalizeInPlace,
  sidewaysMeasure,
  similarityTransform,
  warpAligned,
} from "./faceAlign.ts";
import {
  Stopped,
  autoMerge,
  groupMergeOwed,
  mergeSplitGroups,
  placeNew,
  reconsiderLeftovers,
  regroupAll,
  takeHeldOver,
} from "./facePeople.ts";
import { FACE_EMBEDDING_DIM, FACE_SUGGEST_THRESHOLD, dot, meanDirection } from "./faceCluster.ts";
import {
  FACE_INPUT,
  decodeFaces,
  faceModelIntact,
  faceModelPath,
  faceModelSize,
  faceModelStatus,
  startFaceModelDownload,
  suppressFaces,
  toPlanes,
  type FaceHit,
} from "./faces.ts";
import { FaceStore, MAX_FACE_INDEX, type FaceRecord } from "./faceStore.ts";
import { adoptScanned, applyCopy, compareWithPhone, copyFits, copyForDrive, describeComparison } from "./faceSync.ts";
import type { FaceCopy, FaceCopyToWrite, SearchCopyToWrite } from "./driveData.ts";
import { markGpuFailed, openModel, type Accel } from "./inference.ts";
import { pinnedModel, type PinnedModelStatus } from "./pinnedModel.ts";
import {
  SearchStore,
  clipInputFrom,
  compareSearch,
  fillFromCopies,
  imageModel,
  toHalves,
  CLIP_SIDE,
} from "./searchIndex.ts";
import { EMBEDDING_DIM, SEARCH_MODEL_ID, type SearchCopy } from "./semantic.ts";
import { markFreshInstall, readBackupFlags, writeBackupFlags } from "./backupFlags.ts";
import { installDeviceId } from "./deviceId.ts";
import { diag } from "./diag.ts";
import { isReady } from "./store.ts";
import {
  PowerWatch,
  SPEED_LEVELS,
  batchStream,
  defaultSpeed,
  effectiveSpeed,
  newStageTimes,
  runInOrder,
  sleep,
  stageFields,
  thisMachine,
  timed,
  timedSync,
  type ScanSpeed,
  type SpeedLevel,
  type StageTimes,
} from "./scanPipeline.ts";

/** The phone's recognition model, pinned to the release's bytes. */
export const EMBED_MODEL = {
  url: "https://github.com/gitakoos/face-models/releases/download/v2/ghostfacenet.onnx",
  file: "ghostfacenet.onnx",
  size: 16_190_333,
  sha256: "ffd8203a0c9e93d90a4957e24d173a883a5a04d64d23c771742c66273518a0db",
};

const embedModel = pinnedModel(EMBED_MODEL, "faces");

/** The grey the letterbox margins are filled with, as on the phone. */
const PAD_GREY = 114;
/** A picture smaller than this on either side is not looked at. */
const MIN_SIDE = 24;
/** A face smaller than this many pixels, or this share of the picture's shorter side, is left out. */
const MIN_FACE_PX = 40;
const MIN_FACE_FRACTION = 0.03;
/** The smallest face the sensitive pass keeps, in the preview's pixels. */
const MIN_FACE_PX_SENSITIVE = 28;
/** At most this many faces are kept from one photo. */
const MAX_FACES = 32;

/** Photos asked for at once. */
const BATCH = 8;
/** New faces gathered before they are placed with the people. */
const PLACE_EVERY = 200;
/** Changes are written at least this often while a scan runs. */
const FLUSH_MS = 15_000;
/** How this computer is named among the devices that save to Drive. */
export function deviceLabel(): string {
  return (hostname().trim().replace(/\s+/g, " ").slice(0, 40) || "Windows").trimEnd();
}

/** How long a finished scan waits before looking for new photos. */
const RECHECK_MS = 15 * 60_000;
/**
 * Above this many faces the whole-library regroup is left out: it grows with the faces times the
 * groups, and the people the scan formed as it went stand as they are.
 */
const FULL_REGROUP_MAX_FACES = 60_000;

/** Where the scan reads the library from. */
export type ScanSource = {
  /** Every photo of the library. */
  listUids(): Promise<string[]>;
  /**
   * What the models read for these photos: the full-resolution original of a photo, as the
   * phone reads it, else its large preview (a video, or a format this side cannot decode);
   * null for one that has neither. A photo missing from the answer is asked for again later.
   * `ahead` is how many downloads may run at once.
   */
  pictures(uids: string[], ahead?: number): AsyncIterable<{ uid: string; bytes: Buffer | null }>;
  /** The photos in the Drive trash, by link id, which keep their faces; throws when they cannot be read. */
  listTrashed(): Promise<Set<string>>;
  /** Which photos are hidden: they are not scanned, and their faces never go to Drive. */
  hiddenTest(): (uid: string) => boolean;
};

export type ScanState =
  | "off"
  | "models"
  | "waiting"
  | "scanning"
  | "grouping"
  | "finding"
  | "paused"
  | "done"
  | "failed";

export type ScanStatus = {
  state: ScanState;
  /** Photos looked at, of all the library's. */
  done: number;
  total: number;
  faces: number;
  accel: Accel | null;
  /** The two models together, while they download. */
  download: { done: number; total: number } | null;
  error: string | null;
  /** Goes up whenever the people change, so the window knows to read them again. */
  version: number;
  /** This computer's copy on Drive: when it was last saved, and whether the last try failed. */
  drive: { savedAt: number | null; failed: boolean };
  /** The search index made here: photos with a vector, those that could not be read, and the library. */
  search: { indexed: number; unreadable: number; total: number } | null;
  /**
   * Set when another device deleted the face data everywhere and this computer followed: when that
   * delete was made. Face recognition is off here since, and the window turns its switch off too.
   */
  offByWipe: number | null;
  /**
   * How fast the scan goes: the speed chosen in Settings (null for this machine's own), the one this
   * machine starts at, and the one it runs at now, which is Gentle on the battery or a metered connection.
   */
  speed: { chosen: ScanSpeed | null; machine: ScanSpeed; running: ScanSpeed };
};

type Models = { detector: any; embedder: any; accel: Accel };

/** How far "Find more photos" has got for one person. */
export type SweepStatus = {
  personId: string | null;
  running: boolean;
  /** Photos looked at again, of those with no face found the first time. */
  done: number;
  total: number;
  /** Faces found that might be the person. */
  found: number;
};

/** Turns a picture's large preview into the faces in it, as the phone does. */
/** The detector run over one part of the picture, letterboxed into its square; hits in picture pixels. */
async function detectIn(
  img: Decoded,
  region: { x: number; y: number; w: number; h: number },
  detector: any,
  times?: StageTimes,
): Promise<FaceHit[]> {
  const ort = await import("onnxruntime-node");
  const { input, scale, padX, padY } = timedSync(times, "detectPrep", () => {
    const part =
      region.x === 0 && region.y === 0 && region.w === img.width && region.h === img.height
        ? img
        : cropRegion(img, region.x, region.y, region.w, region.h);
    const boxed = letterbox(part, FACE_INPUT, PAD_GREY);
    return { ...boxed, input: new ort.Tensor("float32", toPlanes(boxed.square), [1, 3, FACE_INPUT, FACE_INPUT]) };
  });
  const result = await timed(times, "detect", () => detector.run({ [detector.inputNames[0]]: input }));
  const inv = 1 / scale;
  const toX = (v: number) => (v - padX) * inv + region.x;
  const toY = (v: number) => (v - padY) * inv + region.y;
  return suppressFaces(decodeFaces(result[detector.outputNames[0]].data as Float32Array)).map((hit) => ({
    box: [toX(hit.box[0]), toY(hit.box[1]), toX(hit.box[2]), toY(hit.box[3])],
    eyes: [toX(hit.eyes[0]), toY(hit.eyes[1]), toX(hit.eyes[2]), toY(hit.eyes[3])],
    points: hit.points.map((v, i) => (i % 2 === 0 ? toX(v) : toY(v))),
    score: hit.score,
  }));
}

/** Side of a tile of the sensitive pass, in picture pixels: read at the detector's own size. */
const TILE = FACE_INPUT;
/** How far tiles overlap, so a face on a seam is whole in one of them. */
const TILE_OVERLAP = 0.25;

/** The tiles that cover a picture, overlapping; none for one small enough to read whole. */
export function tilesFor(width: number, height: number): { x: number; y: number; w: number; h: number }[] {
  if (Math.max(width, height) <= TILE * 1.25) return [];
  const step = Math.round(TILE * (1 - TILE_OVERLAP));
  const starts = (size: number) => {
    if (size <= TILE) return [0];
    const out: number[] = [];
    for (let v = 0; v + TILE < size; v += step) out.push(v);
    out.push(size - TILE);
    return out;
  };
  const tiles: { x: number; y: number; w: number; h: number }[] = [];
  for (const y of starts(height)) {
    for (const x of starts(width)) tiles.push({ x, y, w: Math.min(TILE, width), h: Math.min(TILE, height) });
  }
  return tiles;
}

/**
 * Turns a photo into the faces in it, as the phone does. `sensitive` also reads the picture tile
 * by tile at the detector's own size, which finds the small and distant faces a read of the
 * whole picture at once misses, for "Find more photos".
 */
export async function analyzePreview(
  bytes: Buffer,
  models: Models,
  uid: string,
  sensitive = false,
): Promise<FaceRecord[]> {
  return analyzeImage(await decodeLikePhone(bytes), models, uid, sensitive);
}

export async function analyzeImage(
  img: Decoded,
  models: Models,
  uid: string,
  sensitive = false,
  times?: StageTimes,
): Promise<FaceRecord[]> {
  const ort = await import("onnxruntime-node");
  const { rgb, width, height } = img;
  if (width < MIN_SIDE || height < MIN_SIDE) return [];

  let hits = await detectIn(img, { x: 0, y: 0, w: width, h: height }, models.detector, times);
  if (sensitive) {
    for (const tile of tilesFor(width, height)) hits.push(...(await detectIn(img, tile, models.detector, times)));
    hits = suppressFaces(hits);
  }

  const minEdge = sensitive
    ? MIN_FACE_PX_SENSITIVE
    : Math.max(MIN_FACE_PX, MIN_FACE_FRACTION * Math.min(width, height));
  const faces: FaceRecord[] = [];
  const clampX = (v: number) => Math.min(width, Math.max(0, v));
  const clampY = (v: number) => Math.min(height, Math.max(0, v));
  // A face's index counts the detector's faces that pass the size gate, in its order, before the
  // sharpness gate drops any, as on the phone, so the same face has the same id on both.
  let index = -1;
  for (const hit of hits) {
    if (faces.length >= MAX_FACES) break;
    const box = [clampX(hit.box[0]), clampY(hit.box[1]), clampX(hit.box[2]), clampY(hit.box[3])];
    if (Math.min(box[2] - box[0], box[3] - box[1]) < minEdge) continue;
    if (++index > MAX_FACE_INDEX) break;
    const points = hit.points;
    const prepared = timedSync(times, "facePrep", () => {
      const aligned = warpAligned(rgb, width, height, similarityTransform(points));
      const blur = alignedBlur(aligned);
      if (blur < MIN_SHARPNESS) return null;
      return { blur, tensor: new ort.Tensor("float32", embedInput(aligned), [1, ALIGNED, ALIGNED, 3]) };
    });
    if (!prepared) continue;
    const { blur, tensor } = prepared;
    const out = await timed(times, "embed", () => models.embedder.run({ [models.embedder.inputNames[0]]: tensor }));
    const embedding = normalizeInPlace(Float32Array.from(out[models.embedder.outputNames[0]].data as Float32Array));
    if (embedding.length !== FACE_EMBEDDING_DIM) continue;
    faces.push({
      id: `${uid}#${index}`,
      uid,
      box: [box[0] / width, box[1] / height, box[2] / width, box[3] / height],
      points: [...points],
      score: hit.score,
      blur,
      sideways: sidewaysMeasure(points) ?? 0,
      embedding,
    });
  }
  return faces;
}

export class FaceScanner {
  readonly store = new FaceStore();
  /** The search by what a photo shows, indexed in the same pass over the library. */
  readonly search = new SearchStore();
  /** Index the photos for the search too; runs with face recognition off as well. */
  private indexing = false;
  private clip: { session: any; accel: Accel } | null = null;
  private searchCounts: { version: number; counts: { indexed: number; unreadable: number } } | null = null;
  /** Photos in the library as last listed. */
  private libraryCount = 0;
  /** The phones' search indexes as last read from Drive, and whether this one was set beside them. */
  private phoneSearch: SearchCopy[] = [];
  private searchCompared = false;
  private enabled = false;
  private paused = false;
  /** Take the "might be the same person" matches without asking, as they come. */
  private autoMerging = false;
  /** Run "Find more photos" by itself once the scan is through, for everyone named. */
  private findingMore = false;
  /** Share the faces with the other devices through Drive: their copies in, this one out. */
  private syncing = false;
  /** A "Back up now" or "Load from Drive" running, which shares with the other devices once. */
  private once = false;
  /** Puts this computer's copy on Drive; set by the session once signed in. */
  /** Answers false when the copy on Drive already held this and nothing was written. */
  private driveWriter: ((copy: FaceCopyToWrite, all?: boolean) => Promise<boolean>) | null = null;
  /** Puts this computer's search index on Drive. */
  private searchWriter: ((copy: SearchCopyToWrite, all?: boolean) => Promise<boolean>) | null = null;
  /** Tells the shared backup that something to save changed here. */
  private onDriveChange: (() => void) | null = null;
  /** The people's version this computer's copy on Drive was made from. */
  private savedVersion = -1;
  /** The search index's version its copy on Drive was made from. */
  private savedSearchVersion = -1;
  /** The library as last listed: each photo's uid by its Drive link id. */
  private uidByLink = new Map<string, string>();
  private running: Promise<void> | null = null;
  /** A start asked for while a run was still ending, made once it has. */
  private startAfter = false;
  /** Bumped by every stop; a run that sees a newer one ends. */
  private generation = 0;
  private status: ScanStatus = {
    state: "off",
    done: 0,
    total: 0,
    faces: 0,
    accel: null,
    download: null,
    error: null,
    version: 0,
    drive: { savedAt: null, failed: false },
    search: null,
    offByWipe: null,
    speed: { chosen: null, machine: "balanced", running: "balanced" },
  };
  /** The delete everywhere this computer's copy on Drive carries, as last saved from here. */
  private savedWipe = -1;
  private models: Models | null = null;
  /** The models being opened, so photos read side by side open them once. */
  private modelsOpening: Promise<Models> | null = null;
  private clipOpening: Promise<{ session: any; accel: Accel }> | null = null;
  /** The speed chosen in Settings; null for the one this machine starts at. */
  private speedChoice: ScanSpeed | null = null;
  private readonly power: PowerWatch;
  private source: ScanSource | null = null;
  private recheck: ReturnType<typeof setTimeout> | null = null;
  /** The phones' face copies as last read from Drive. */
  private phoneCopies: FaceCopy[] = [];
  /** Whether those copies include this install's own, read back after a fresh install or a sign-out. */
  private readingBack = false;
  private compared = false;
  private sweepStatus: SweepStatus = { personId: null, running: false, done: 0, total: 0, found: 0 };
  /** Bumped by every sweep started or stopped; a sweep that sees a newer one ends. */
  private sweepGeneration = 0;

  constructor(power: PowerWatch = new PowerWatch()) {
    this.power = power;
  }

  /** The speed chosen in Settings, or null for the one this machine starts at; a running scan follows it. */
  setSpeed(choice: ScanSpeed | null): void {
    this.speedChoice = choice;
  }

  /**
   * The speed the scan runs at now, and what that means. The host is asked for the power state
   * again, when it is stale, only while the scan works (`ask`), not for the window's status.
   */
  private speed(ask = true): { chosen: ScanSpeed | null; machine: ScanSpeed; running: ScanSpeed; level: SpeedLevel } {
    const accel = this.status.accel;
    const machine = defaultSpeed(thisMachine(accel === null ? null : accel === "gpu"));
    const running = effectiveSpeed(this.speedChoice ?? machine, ask ? this.power.current() : this.power.peek());
    return { chosen: this.speedChoice, machine, running, level: SPEED_LEVELS[running] };
  }

  /** The pictures as they come, the time spent waiting for each added to `times.wait`. */
  private async *measuredWait<T>(source: AsyncIterable<T>, times: StageTimes): AsyncGenerator<T> {
    const it = source[Symbol.asyncIterator]();
    try {
      for (;;) {
        const started = performance.now();
        const step = await it.next();
        times.wait += performance.now() - started;
        if (step.done) return;
        yield step.value;
      }
    } finally {
      await it.return?.();
    }
  }

  /** Whether there is anything for the scan to do: faces, the search index, or both. */
  private get wanted(): boolean {
    return this.enabled || this.indexing;
  }

  getStatus(): ScanStatus {
    const download = this.downloadProgress();
    const search = this.searchStatus();
    const { chosen, machine, running } = this.speed(false);
    const speed = { chosen, machine, running };
    if (!this.wanted) return { ...this.status, state: "off", download, search, speed };
    return { ...this.status, state: this.paused ? "paused" : this.status.state, download, search, speed };
  }

  private searchStatus(): ScanStatus["search"] {
    if (!this.indexing || !this.search.isLoaded()) return null;
    let cached = this.searchCounts;
    if (!cached || cached.version !== this.search.version) {
      cached = { version: this.search.version, counts: this.search.counts() };
      this.searchCounts = cached;
    }
    return { ...cached.counts, total: this.libraryCount };
  }

  private downloadProgress(): ScanStatus["download"] {
    return modelDownloadProgress([
      ...(this.enabled
        ? [
            { size: faceModelSize, status: faceModelStatus() },
            { size: embedModel.size, status: embedModel.status() },
          ]
        : []),
      ...(this.indexing ? [{ size: imageModel.size, status: imageModel.status() }] : []),
    ]);
  }

  /** The library to read, set on sign-in and cleared on sign-out or lock. */
  setSource(source: ScanSource | null): void {
    this.source = source;
    if (source) this.kick();
    else this.stop(true);
  }

  setEnabled(
    on: boolean,
    autoMerging = this.autoMerging,
    findingMore = this.findingMore,
    syncing = this.syncing,
    indexing = this.indexing,
  ): ScanStatus {
    this.indexing = indexing;
    // Turned off by a delete made elsewhere: stays off until the window has turned its switch off too,
    // so an "on" it sent before it heard of the delete does not undo it.
    if (this.status.offByWipe) on = false;
    const syncOn = syncing && !this.syncing;
    this.syncing = syncing;
    if (syncOn) {
      this.setPhoneCopies(this.phoneCopies);
      this.takeInSearch();
      this.scheduleSave();
    }
    const turnedOn = autoMerging && !this.autoMerging;
    this.autoMerging = autoMerging;
    this.findingMore = findingMore;
    if (turnedOn && this.store.isLoaded()) this.mergeLikely();
    this.enabled = on;
    if (this.wanted) {
      this.paused = false;
      this.kick();
    } else {
      this.stop(false);
    }
    return this.getStatus();
  }

  setPaused(paused: boolean): ScanStatus {
    this.paused = paused;
    if (paused) this.stop(false);
    else this.kick();
    return this.getStatus();
  }

  /** Starts a run unless one is going or nothing can run. */
  private kick(): void {
    if (!this.wanted || this.paused || !this.source) return;
    if (this.running) {
      this.startAfter = true;
      return;
    }
    this.startAfter = false;
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = null;
    const generation = this.generation;
    this.running = this.run(generation)
      .catch((e) => {
        if (e instanceof Stopped) return;
        this.status.state = "failed";
        this.status.error = (e as Error)?.message ?? "failed";
        process.stderr.write(`[faces] the scan stopped: ${(e as Error)?.name ?? "error"}\n`);
      })
      .finally(() => {
        this.running = null;
        this.releaseModels();
        this.saveQuietly();
        if (this.searchDirty()) this.onDriveChange?.();
        // A source set again, or a switch turned, while this run was ending starts the next one now.
        if (this.startAfter && this.generation !== generation) this.kick();
        else if (this.generation === generation && this.wanted && !this.paused && this.source) {
          this.startAfter = false;
          this.recheck = setTimeout(() => this.kick(), RECHECK_MS);
        }
      });
  }

  /** Ends the current run. `forget` also drops what is held, for a sign-out or a lock. */
  stop(forget: boolean): void {
    this.generation++;
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = null;
    if (forget) {
      // Now, while the store's key is still here: a run finishing later writes nothing.
      this.saveQuietly();
      this.store.unload();
      this.search.unload();
    }
  }

  private active(generation: number): boolean {
    return (
      this.generation === generation && this.wanted && !this.paused && !!this.source && !this.sweepStatus.running
    );
  }

  /**
   * The phones' face copies, read from Drive. The first time they meet faces found here, how
   * well the two agree goes into the log: how many faces are on both, and how alike their
   * numbers came out. Counts only, never a name or a photo.
   */
  setPhoneCopies(copies: FaceCopy[], readingBack = false): void {
    this.readingBack = readingBack;
    copies = this.afterWipes(copies, readingBack);
    this.phoneCopies = copies;
    if (!this.store.isLoaded() || copies.length === 0) return;
    if (!this.compared) {
      const report = compareWithPhone(this.store, copies.filter(copyFits));
      if (report.pairs > 0) {
        this.compared = true;
        process.stderr.write(`[faces] phone copy compared: ${describeComparison(report)}\n`);
      }
    }
    if (!this.sharing || !this.enabled) return;
    let changed = this.adoptPhoneScans() > 0;
    for (const copy of copies) {
      const result = applyCopy(this.store, copy, this.readingBack);
      if (!result) continue;
      changed = true;
      // Counts only: what the copy brought, never a name or a photo.
      process.stderr.write(
        `[faces] took in a copy: ${result.renamed} renamed, ${result.named} named, ${result.added} added, ${result.rejected} left out, ` +
          `${result.marked} marked, ${result.conflicts} kept as named here\n`,
      );
    }
    if (!changed) return;
    void placeNew(this.store)
      .then(() => {
        if (this.autoMerging) autoMerge(this.store);
        reconsiderLeftovers(this.store);
      })
      .catch(() => {})
      .finally(() => this.changed());
  }

  /**
   * The rule of a delete of the face data everywhere, before any copy is taken in. A copy carrying an
   * older delete than this computer knows of was written by a device that had not seen it yet, so it
   * is taken in not at all, only noted as taken in, so it is not read again until it changes. A copy
   * carrying a newer one makes this computer delete its own face data first and turn face recognition
   * off, as the device that deleted did; not on the round after a fresh install or a sign-out, which
   * had nothing to delete and whose switch is the one just set. Answers the copies to take in.
   */
  private afterWipes(copies: FaceCopy[], readingBack: boolean): FaceCopy[] {
    let known: number;
    try {
      known = readBackupFlags().knownWipe;
    } catch {
      return [];
    }
    const newest = copies.reduce((m, c) => Math.max(m, c.facesWipedAt), 0);
    if (newest > known) {
      // The switch goes off only where the delete had something to take: an install that holds
      // no face data yet (a new one, turned on just now) keeps it and takes the delete's time in.
      const holds = !this.loadStore() || this.store.scanned().length > 0 || this.store.people.people.length > 0;
      if (!this.wipeHere(newest, !readingBack && holds)) return [];
      known = newest;
    }
    const before = copies.filter((c) => c.facesWipedAt < known);
    if (before.length > 0 && this.store.isLoaded()) {
      const applied = this.store.people.applied;
      for (const c of before) applied[c.deviceId] = Math.max(applied[c.deviceId] ?? -1, c.createdAt);
      this.store.markPeople();
      this.saveQuietly();
    }
    return copies.filter((c) => c.facesWipedAt >= known);
  }

  /**
   * Deletes the face data here for a delete everywhere made elsewhere at `at`, and keeps that time,
   * which this computer's next copy carries on; that copy goes out soon. Answers false when the
   * face data could not be reached (locked), so the next read tries again.
   */
  private wipeHere(at: number, turnOff: boolean): boolean {
    if (!this.loadStore()) return false;
    // Off already, there is no switch to turn off.
    if (turnOff && this.enabled) {
      this.enabled = false;
      this.status.offByWipe = at;
    }
    this.stop(false);
    // The faces of a run still going are not written over the delete: it ends at its next photo.
    this.store.clear();
    this.store.flush();
    writeBackupFlags({ knownWipe: at });
    this.compared = false;
    this.status.version++;
    process.stderr.write("[faces] the face data was deleted everywhere on another device, deleted here too\n");
    this.onDriveChange?.();
    if (!turnOff) this.kick();
    return true;
  }

  /** The face store, read from disk when it is not yet; false while the store is locked. */
  private loadStore(): boolean {
    if (this.store.isLoaded()) return true;
    if (!isReady()) return false;
    try {
      this.store.load();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Takes the photos the other devices' face scans finished as done here, while the faces are
   * shared and scanned here; answers how many were taken. Needs the library listed first.
   */
  private adoptPhoneScans(): number {
    if (!this.sharing || !this.enabled || this.uidByLink.size === 0 || !this.store.isLoaded()) return 0;
    let adopted = 0;
    for (const copy of this.phoneCopies) adopted += adoptScanned(this.store, copy, this.uidByLink, this.readingBack);
    if (adopted > 0) process.stderr.write(`[faces] took ${adopted} photos the other device already scanned\n`);
    return adopted;
  }

  /**
   * The phones' search indexes, read from Drive. The first time they meet vectors made here, how
   * alike the two came out goes into the log, counts only.
   */
  setPhoneSearch(copies: SearchCopy[]): void {
    this.phoneSearch = copies;
    if (this.takeInSearch() > 0) this.onDriveChange?.();
    if (this.searchCompared || !this.search.isLoaded() || copies.length === 0) return;
    const report = compareSearch(this.search.copy(), copies);
    if (report.pairs === 0) return;
    this.searchCompared = true;
    const f = (v: number) => v.toFixed(3);
    process.stderr.write(
      `[search] phone index compared: ${report.pairs} photos on both, cosine median ${f(report.median)} ` +
        `(p10 ${f(report.p10)}, p90 ${f(report.p90)}), ${Math.round(report.close * 100)}% at 0.95 or more\n`,
    );
  }

  /**
   * Forgets the search index made here. While indexing is on, every photo is read again; the
   * scan running now stops first, so nothing it was writing comes back.
   */
  clearSearch(): ScanStatus {
    this.stop(false);
    const wipe = () => {
      try {
        if (!this.search.isLoaded()) this.search.load();
        this.search.clear();
      } catch {
        /* locked: nothing held to clear */
      }
      this.searchCompared = false;
      this.kick();
    };
    if (this.running) void this.running.finally(wipe);
    else wipe();
    return this.getStatus();
  }

  /** The search index made here, for the search to rank beside the phone's; null when not indexing. */
  localSearch(): SearchCopy | null {
    return this.indexing && this.search.isLoaded() ? this.search.copy() : null;
  }

  /**
   * With the shared backup on, the other devices' vectors fill the photos not indexed here yet,
   * so the scan reads only what no device has read. A vector made here is kept; the two agree
   * to the third decimal. Answers how many photos were filled.
   */
  private takeInSearch(): number {
    if (!this.sharing || !this.indexing || !this.search.isLoaded() || this.uidByLink.size === 0) return 0;
    const taken = fillFromCopies(this.search, this.phoneSearch, this.uidByLink);
    if (taken > 0) {
      this.saveQuietly();
      process.stderr.write(`[search] took in ${taken} photos indexed on the other devices\n`);
    }
    return taken;
  }

  /** Who puts this computer's copies on Drive, and who hears that one changed, from the session. */
  setDriveWriter(
    writer: ((copy: FaceCopyToWrite, all?: boolean) => Promise<boolean>) | null,
    searchWriter: ((copy: SearchCopyToWrite, all?: boolean) => Promise<boolean>) | null = null,
    onChange: (() => void) | null = null,
  ): void {
    this.driveWriter = writer;
    this.searchWriter = searchWriter;
    this.onDriveChange = onChange;
  }

  /** Shares with the other devices for the length of `work`, with the automatic backup on or off. */
  async shareOnce<T>(work: () => Promise<T>): Promise<T> {
    this.once = true;
    try {
      return await work();
    } finally {
      this.once = false;
    }
  }

  private get sharing(): boolean {
    return this.syncing || this.once;
  }

  /** Forgets which of the other devices' face copies were taken in, so the next read takes them all in again. */
  forgetTakenIn(): void {
    if (!this.store.isLoaded() || Object.keys(this.store.people.applied).length === 0) return;
    this.store.people.applied = {};
    this.store.markPeople();
  }

  /**
   * Whether the faces have something their copy on Drive does not; with `all`, whether there are faces
   * to save. A delete everywhere the copy there does not carry yet is saved with face recognition off
   * too, in an empty copy: that copy is what takes the delete to the other devices.
   */
  facesDirty(all = false): boolean {
    if (!this.sharing || !this.driveWriter) return false;
    const wipe = this.knownWipe();
    const wipeUnsaved = wipe > 0 && wipe > this.savedWipe;
    if (!this.enabled && !wipeUnsaved) return false;
    if (!this.loadStore()) return false;
    if (wipeUnsaved) return true;
    // After a change of the face models, the names wait for their photos to be looked at again; a copy
    // saved before that would carry none of them over the one on Drive.
    if (this.store.people.heldOver.length > 0) return false;
    return all || !(this.savedVersion === this.status.version && this.status.drive.savedAt !== null);
  }

  /** Whether this computer's copy on Drive carries the newest delete everywhere it knows of. */
  wipeSaved(): boolean {
    return this.savedWipe >= this.knownWipe();
  }

  private knownWipe(): number {
    try {
      return readBackupFlags().knownWipe;
    } catch {
      return 0;
    }
  }

  /** Whether the search index made here has something its copy on Drive does not; with `all`, anything at all. */
  searchDirty(all = false): boolean {
    if (!this.sharing || !this.indexing || !this.searchWriter || !this.search.isLoaded()) return false;
    return (all || this.search.version !== this.savedSearchVersion) && this.search.counts().indexed > 0;
  }

  /** Writes the search index made here to Drive, every photo by its link id. */
  async saveSearch(all = false): Promise<boolean> {
    const writer = this.searchWriter;
    if (!writer || !this.searchDirty(all)) return false;
    const version = this.search.version;
    // In key order, so the same index makes the same copy whatever order it was built in.
    const entries: [string, Uint16Array | null][] = this.search
      .entries()
      .map(([uid, v]): [string, Uint16Array | null] => [uid.slice(uid.indexOf("~") + 1), v])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const wrote = await writer(
      {
        deviceId: installDeviceId(),
        deviceLabel: deviceLabel(),
        createdAt: Date.now(),
        modelId: SEARCH_MODEL_ID,
        dim: EMBEDDING_DIM,
        entries,
      },
      all,
    );
    this.savedSearchVersion = version;
    if (wrote) process.stderr.write(`[search] saved the index to Drive: ${entries.length} photos\n`);
    return wrote;
  }

  /** The library's photo of a Drive link id, as last listed. */
  uidOfLink(link: string): string | undefined {
    return this.uidByLink.get(link);
  }

  /** This install's id, once one has been made: its own copy is never read back as another's. */
  ownDeviceId(): string | null {
    return this.store.isLoaded() ? this.store.people.deviceId : null;
  }

  /** The shared backup saves a few minutes after the last change, so a run of edits is one save. */
  private scheduleSave(): void {
    if (this.syncing) this.onDriveChange?.();
  }

  /** Writes the faces' copy to Drive. Throws when it could not, for the backup to report. */
  async saveFaces(all = false): Promise<boolean> {
    const writer = this.driveWriter;
    if (!writer || !this.facesDirty(all)) return false;
    const version = this.status.version;
    const wipe = this.knownWipe();
    try {
      const at = Date.now();
      const copy = copyForDrive(this.store, deviceLabel(), at, wipe, this.source?.hiddenTest() ?? (() => false));
      const wrote = await writer(copy, all);
      if (wrote) process.stderr.write(`[faces] saved the copy to Drive: ${copy.faces.length} faces, ${copy.markers.length} photos\n`);
      this.saveQuietly();
      this.savedVersion = version;
      this.savedWipe = wipe;
      this.status.drive = { savedAt: wrote ? at : (this.status.drive.savedAt ?? at), failed: false };
      return wrote;
    } catch (e) {
      this.status.drive = { ...this.status.drive, failed: true };
      process.stderr.write(`[faces] the copy on Drive was not saved: ${(e as Error)?.name ?? "error"}\n`);
      // Tried again on the next round of the shared backup.
      throw e;
    }
  }

  getSweep(): SweepStatus {
    return { ...this.sweepStatus };
  }

  /**
   * "Find more photos": the photos the scan found no face on are read again, tile by tile, and
   * every face found is kept like any other. The scan steps aside while it runs and carries on
   * after. Each photo is looked at this way once.
   */
  startSweep(personId: string): SweepStatus {
    if (this.sweepStatus.running && this.sweepStatus.personId === personId) return this.getSweep();
    if (!this.enabled || !this.source || !this.store.isLoaded()) throw new Error("Face recognition is not running");
    const own = this.store.allFaces().filter((f) => this.store.people.assign[f.id] === personId);
    if (own.length === 0) throw new Error("This person has no faces to look for");
    const centroid = meanDirection(own.map((f) => f.embedding));
    const generation = ++this.sweepGeneration;
    // The scan's own run ends at its next photo; it starts again once this is done.
    this.generation++;
    this.sweepStatus = { personId, running: true, done: 0, total: 0, found: 0 };
    void this.sweep(generation, centroid)
      .catch((e) => {
        if (!(e instanceof Stopped)) process.stderr.write(`[faces] find more stopped: ${(e as Error)?.name ?? "error"}\n`);
      })
      .finally(() => {
        if (this.sweepGeneration === generation) this.sweepStatus.running = false;
        this.saveQuietly();
        this.status.version++;
        this.kick();
      });
    return this.getSweep();
  }

  stopSweep(): SweepStatus {
    this.sweepGeneration++;
    this.sweepStatus.running = false;
    this.kick();
    return this.getSweep();
  }

  private async sweep(generation: number, centroid: Float32Array): Promise<void> {
    const live = () => this.sweepGeneration === generation && this.enabled && !!this.source;
    // A run of the scan that was mid-photo finishes it first.
    while (this.running) {
      if (!live()) throw new Stopped();
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.sweepFaceless(
      live,
      (done, total) => {
        this.sweepStatus.done = done;
        this.sweepStatus.total = total;
      },
      (faces) => {
        this.sweepStatus.found += faces.filter((f) => dot(f.embedding, centroid) >= FACE_SUGGEST_THRESHOLD).length;
      },
    );
    this.releaseModels();
  }

  /**
   * The photos with no face found, not yet looked at this way, read again tile by tile. Every
   * face found is kept and placed with the people as it comes; at the end the leftovers are
   * weighed against everyone named once more.
   */
  private async sweepFaceless(
    live: () => boolean,
    progress: (done: number, total: number) => void,
    found: (faces: FaceRecord[]) => void = () => {},
  ): Promise<void> {
    const source = this.source!;
    const todo = this.store.scanned().filter((uid) => this.store.facesOf(uid).length === 0 && !this.store.isSwept(uid));
    let done = 0;
    progress(done, todo.length);
    let lastPlace = Date.now();
    for (let i = 0; i < todo.length; i += BATCH) {
      if (!live()) throw new Stopped();
      for await (const { uid, bytes } of source.pictures(todo.slice(i, i + BATCH))) {
        if (!live()) throw new Stopped();
        let faces: FaceRecord[] = [];
        if (bytes) {
          try {
            faces = await this.analyze(await decodeLikePhone(bytes), uid, true);
          } catch (e) {
            if (e instanceof Stopped) throw e;
          }
        }
        if (faces.length) this.store.put(uid, faces);
        this.store.markSwept(uid);
        progress(++done, todo.length);
        found(faces);
      }
      // What was found shows as it comes, not only at the end.
      if (Date.now() - lastPlace > 3000) {
        await placeNew(this.store);
        this.saveQuietly();
        this.status.version++;
        lastPlace = Date.now();
      }
    }
    await placeNew(this.store);
    reconsiderLeftovers(this.store);
    this.saveQuietly();
    this.status.version++;
  }

  private async ensureModels(generation: number, faces: boolean, index: boolean): Promise<boolean> {
    this.status.state = "models";
    const wanted = [
      ...(faces
        ? [
            { status: faceModelStatus, start: startFaceModelDownload, intact: faceModelIntact },
            { status: () => embedModel.status(), start: () => embedModel.startDownload(), intact: () => embedModel.intact() },
          ]
        : []),
      ...(index
        ? [{ status: () => imageModel.status(), start: () => imageModel.startDownload(), intact: () => imageModel.intact() }]
        : []),
    ];
    for (const m of wanted) if (m.status().state !== "ready") m.start();
    for (;;) {
      if (!this.active(generation)) return false;
      const states = wanted.map((m) => m.status());
      const failed = states.find((x) => x.state === "failed");
      if (failed && failed.state === "failed") throw new Error(failed.error || "download failed");
      if (states.every((x) => x.state === "ready")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    for (const m of wanted) if (!(await m.intact())) throw new Error("a model did not check out");
    return true;
  }

  private async openClip(): Promise<{ session: any; accel: Accel }> {
    if (this.clip) return this.clip;
    this.clipOpening ??= openModel(imageModel.path(), true, "basic")
      .then((clip) => {
        this.clip = clip;
        if (!this.enabled) this.status.accel = clip.accel;
        return clip;
      })
      .finally(() => {
        this.clipOpening = null;
      });
    return this.clipOpening;
  }

  /** The photo's vector for the search, at half precision, as the phone stores it. */
  private async embedForSearch(img: Decoded, times?: StageTimes): Promise<Uint16Array> {
    const ort = await import("onnxruntime-node");
    const input = timedSync(times, "clipPrep", () => clipInputFrom(img));
    const run = async ({ session }: { session: any }) => {
      const out = await timed(times, "clip", () =>
        session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, CLIP_SIDE, CLIP_SIDE]) }),
      );
      return timedSync(times, "clipPrep", () => toHalves(out[session.outputNames[0]].data as Float32Array));
    };
    const clip = await this.openClip();
    try {
      return await run(clip);
    } catch (e) {
      if (clip.accel !== "gpu") throw e;
      markGpuFailed((e as Error)?.name ?? "run failed");
      // A photo read beside this one may have replaced the session already.
      if (this.clip === clip) this.releaseClip();
      return run(await this.openClip());
    }
  }

  private async openModels(): Promise<Models> {
    if (this.models) return this.models;
    this.modelsOpening ??= (async () => {
      const detector = await openModel(faceModelPath(), true);
      const embedder = await openModel(embedModel.path(), true);
      const models: Models = {
        detector: detector.session,
        embedder: embedder.session,
        accel: detector.accel === "gpu" && embedder.accel === "gpu" ? "gpu" : "cpu",
      };
      this.models = models;
      this.status.accel = models.accel;
      return models;
    })().finally(() => {
      this.modelsOpening = null;
    });
    return this.modelsOpening;
  }

  private releaseFaceModels(): void {
    const m = this.models;
    this.models = null;
    void m?.detector?.release?.().catch(() => {});
    void m?.embedder?.release?.().catch(() => {});
  }

  private releaseClip(): void {
    const clip = this.clip;
    this.clip = null;
    void clip?.session?.release?.().catch(() => {});
  }

  private releaseModels(): void {
    this.releaseFaceModels();
    this.releaseClip();
  }

  private saveQuietly(): void {
    try {
      this.store.flush();
      this.search.flush();
    } catch (e) {
      process.stderr.write(`[faces] could not save: ${(e as NodeJS.ErrnoException).code ?? "unknown"}\n`);
    }
  }

  private async run(generation: number): Promise<void> {
    this.status.error = null;
    // What this run does is fixed at its start; a switch changed meanwhile starts the next one.
    const faces = this.enabled;
    const index = this.indexing;
    if (!(await this.ensureModels(generation, faces, index))) return;
    if (faces) this.store.load();
    if (index) this.search.load();
    const source = this.source!;
    this.status.state = "waiting";
    const library = await source.listUids();
    if (!this.active(generation)) return;
    const present = new Set(library);
    this.uidByLink = new Map(library.map((uid) => [uid.slice(uid.indexOf("~") + 1), uid]));
    if (faces) {
      // A photo in the Drive trash can come back, with its faces and names; a trash that cannot be
      // read leaves every photo as it is this time.
      const trashed = await source.listTrashed().catch(() => null);
      if (!this.active(generation)) return;
      if (trashed && this.store.keepOnly(present, trashed) > 0) this.status.version++;
    }
    const hidden = source.hiddenTest();
    if (index) {
      this.search.keepOnly(present);
      this.takeInSearch();
    }
    // The photos another device already scanned count as done here, with its faces.
    if (faces && this.adoptPhoneScans() > 0) {
      await placeNew(this.store);
      if (this.autoMerging) this.mergeLikely();
      this.status.version++;
    }
    const needsFaces = (uid: string) => faces && !this.store.has(uid) && !hidden(uid);
    const needsVector = (uid: string) => index && !this.search.has(uid);
    const todo = library.filter((uid) => needsFaces(uid) || needsVector(uid));
    this.libraryCount = library.length;
    // The faces' own progress: a pass that only builds the search index leaves it where it is.
    this.status.total = library.length;
    this.status.done = faces ? library.filter((uid) => !needsFaces(uid)).length : 0;
    this.status.faces = faces ? this.store.allFaces().length : 0;
    this.status.state = "scanning";
    const passStarted = Date.now();
    if (todo.length > 0) await this.power.refresh();
    if (todo.length > 0) diag.log("faces", "pass_start", { library: library.length, todo: todo.length, faces, index });

    let pending = 0;
    let lastFlush = Date.now();
    const place = async () => {
      if (pending === 0) return;
      pending = 0;
      takeHeldOver(this.store);
      await placeNew(this.store);
      if (this.autoMerging) this.mergeLikely();
      this.status.version++;
    };

    const batches: string[][] = [];
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
    // The time each part took since the last batch's line, written to the log with detailed logging on.
    const times = newStageTimes();
    let batchStarted = performance.now();
    // When the last photo arrived: the wait from there to the next is its download.
    let lastArrival = Date.now();
    const stream = this.measuredWait(
      batchStream(batches, (uids) => source.pictures(uids, this.speed().level.downloads), () => this.speed().level.prefetch),
      times,
    );

    type Found = { facesHere: boolean; vectorHere: boolean; found: FaceRecord[]; vector: Uint16Array | null; read: boolean; ms: number };
    await runInOrder(
      stream,
      () => this.speed().level.photos,
      async (item): Promise<Found | null> => {
        if (item.kind === "end") return null;
        const { uid } = item.picture;
        const arrived = Date.now();
        diag.record("faces", "fetch", arrived - lastArrival, !!item.picture.bytes);
        lastArrival = arrived;
        const pause = this.speed().level.pauseMs;
        if (pause > 0) await sleep(pause);
        const started = Date.now();
        const facesHere = needsFaces(uid);
        const vectorHere = needsVector(uid);
        const read = await this.readPhoto(item.picture, facesHere, vectorHere, times);
        return { facesHere, vectorHere, ...read, ms: Date.now() - started };
      },
      async (item, out) => {
        if (item.kind === "end" || !out) {
          await timed(times, "store", async () => {
            if (pending >= PLACE_EVERY) await place();
            if (Date.now() - lastFlush > FLUSH_MS) {
              this.saveQuietly();
              lastFlush = Date.now();
            }
          });
          if (diag.isDetailed()) {
            const wall = performance.now() - batchStarted;
            diag.log("faces", "scan_batch", {
              speed: this.speed().running,
              width: this.speed().level.photos,
              ahead: this.speed().level.downloads,
              wall: Math.round(wall),
              per_min: times.photos > 0 && wall > 0 ? Math.round((60_000 * times.photos) / wall) : 0,
              ...stageFields(times),
            });
          }
          Object.assign(times, newStageTimes());
          batchStarted = performance.now();
          return;
        }
        const { uid } = item.picture;
        timedSync(times, "store", () => {
          if (out.facesHere) {
            this.store.put(uid, out.found);
            pending += out.found.length;
            this.status.faces += out.found.length;
          }
          if (out.vectorHere) this.search.put(uid, out.vector);
          if (out.facesHere) this.status.done++;
        });
        times.photos++;
        times.faces += out.found.length;
        diag.record("faces", "photo", out.ms, out.read);
      },
      () => this.active(generation),
      () => new Stopped(),
      (item) => item.kind === "picture",
    );
    if (index) this.setPhoneSearch(this.phoneSearch);
    if (todo.length > 0) {
      diag.log("faces", "pass_end", { photos: todo.length, s: Math.round((Date.now() - passStarted) / 1000), faces: this.status.faces });
    }
    if (!faces) {
      this.status.state = "done";
      return;
    }
    // What a change of the face models held over for a photo that is gone, or hidden, is let go.
    takeHeldOver(this.store, (uid) => present.has(uid) && !hidden(uid));
    pending++;
    await place();
    const faceCount = this.store.allFaces().length;
    if (!this.store.people.grouped && faceCount > 0) {
      if (faceCount <= FULL_REGROUP_MAX_FACES) {
        this.status.state = "grouping";
        this.releaseModels();
        await regroupAll(this.store, () => this.active(generation));
        // More groups than the regroup's own merge takes: folded on their directions, as the phone does.
        if (groupMergeOwed(this.store)) await mergeSplitGroups(this.store, () => this.active(generation));
        if (this.autoMerging) this.mergeLikely();
      } else {
        // Too many faces to regroup at once: the groups the scan formed as it went are folded where they
        // are one person, the closing step of the phone's batched grouping.
        this.status.state = "grouping";
        this.releaseModels();
        await mergeSplitGroups(this.store, () => this.active(generation));
        this.store.people.grouped = true;
        this.store.markPeople();
      }
      this.status.version++;
    }
    if (this.findingMore && this.store.people.people.some((x) => x.name)) {
      this.status.state = "finding";
      try {
        // Turned off while it runs, it stops at the next few photos; the rest of the pass goes on.
        await this.sweepFaceless(
          () => this.active(generation) && this.findingMore,
          (done, total) => {
            this.status.done = done;
            this.status.total = total;
          },
        );
      } catch (e) {
        if (!(e instanceof Stopped) || !this.active(generation)) throw e;
      }
      if (this.autoMerging) this.mergeLikely();
      this.status.total = library.length;
      this.status.done = library.length;
    }
    this.status.state = "done";
    this.setPhoneCopies(this.phoneCopies);
    this.scheduleSave();
  }

  /**
   * One photo of the scan read: decoded once, the phone's way, for the faces and the search alike,
   * its faces found and its vector made as asked. Its bytes are let go once decoded, and the
   * decoded picture once read.
   */
  private async readPhoto(
    picture: { uid: string; bytes: Buffer | null },
    facesHere: boolean,
    vectorHere: boolean,
    times: StageTimes,
  ): Promise<{ found: FaceRecord[]; vector: Uint16Array | null; read: boolean }> {
    const { uid } = picture;
    let bytes = picture.bytes;
    picture.bytes = null;
    let img: Decoded | null = null;
    if (bytes) {
      try {
        const held = bytes;
        img = await timed(times, "decode", () => decodeLikePhone(held));
      } catch {
        img = null;
      }
    }
    bytes = null;
    let found: FaceRecord[] = [];
    if (facesHere && img) {
      try {
        found = await this.analyze(img, uid, false, times);
      } catch (e) {
        if (e instanceof Stopped) throw e;
        // A picture the models cannot take is passed over, and counted as looked at.
        found = [];
      }
    }
    let vector: Uint16Array | null = null;
    if (vectorHere && img) {
      try {
        vector = await this.embedForSearch(img, times);
      } catch {
        // Unreadable, and kept as such, so it is not fetched again on every pass.
        vector = null;
      }
    }
    return { found, vector, read: !!img };
  }

  private async analyze(img: Decoded, uid: string, sensitive = false, times?: StageTimes): Promise<FaceRecord[]> {
    const models = await this.openModels();
    try {
      return await analyzeImage(img, models, uid, sensitive, times);
    } catch (e) {
      if (models.accel !== "gpu" || !isRuntimeError(e)) throw e;
      // The card failed mid-run (a driver reset): the rest goes to the processor. A photo read
      // beside this one may have replaced the models already.
      markGpuFailed((e as Error)?.name ?? "run failed");
      if (this.models === models) this.releaseModels();
      return analyzeImage(img, await this.openModels(), uid, sensitive, times);
    }
  }

  /** Everything forgotten and looked at again from the start. */
  rescan(): ScanStatus {
    this.stop(false);
    const restart = () => {
      if (this.store.isLoaded() || this.source) {
        try {
          if (!this.store.isLoaded()) this.store.load();
          this.store.clear();
          this.store.flush();
        } catch {
          /* written on the next save */
        }
      }
      this.status.version++;
      this.kick();
    };
    if (this.running) void this.running.finally(restart);
    else restart();
    return this.getStatus();
  }

  /**
   * "Only on this PC": the face data here goes and the scan starts over, and the copies on Drive are
   * taken in again, this install's own read back too, so the faces and names saved there return.
   * The caller reads Drive once this is done.
   */
  async clearHere(): Promise<void> {
    this.stop(false);
    if (this.running) await this.running.catch(() => undefined);
    if (!this.loadStore()) throw new Error("Locked");
    this.store.clear();
    this.store.flush();
    markFreshInstall();
    this.compared = false;
    this.status.version++;
    this.kick();
  }

  /**
   * "Everywhere": face recognition turns off, the face data here goes, and the delete is kept with
   * its time, for this computer's next copy to carry to the other devices; the caller runs that
   * round, which also moves their face copies to the Drive trash.
   */
  async clearEverywhere(): Promise<void> {
    this.enabled = false;
    this.stop(false);
    if (this.running) await this.running.catch(() => undefined);
    if (!this.loadStore()) throw new Error("Locked");
    this.store.clear();
    this.store.flush();
    writeBackupFlags({ knownWipe: Date.now(), trashPending: true });
    this.compared = false;
    this.status.version++;
    process.stderr.write("[faces] face data deleted everywhere\n");
  }

  /** The window has turned its face recognition switch off after a delete made elsewhere. */
  wipeSeen(): void {
    this.status.offByWipe = null;
  }

  /** Turns it off and forgets every face and person. */
  clearAll(): ScanStatus {
    this.enabled = false;
    this.stop(false);
    const wipe = () => {
      try {
        if (!this.store.isLoaded() && this.source) this.store.load();
        this.store.clear();
        this.store.flush();
      } catch {
        /* nothing to write */
      }
      this.status.version++;
    };
    if (this.running) void this.running.finally(wipe);
    else wipe();
    return this.getStatus();
  }

  /** The automatic merge, written and announced when it merged anything. */
  private mergeLikely(): void {
    if (autoMerge(this.store) > 0) {
      this.saveQuietly();
      this.status.version++;
    }
  }

  /** Writes the change and tells the window. */
  changed(): void {
    this.saveQuietly();
    this.status.version++;
    this.scheduleSave();
  }
}

/** An error from the runtime itself, as against a picture that will not decode. */
function isRuntimeError(e: unknown): boolean {
  const message = String((e as Error)?.message ?? "");
  return !/Input buffer|unsupported image|VipsJpeg|vips/i.test(message);
}

export const faceScanner = new FaceScanner();
export const embedModelStatus = () => embedModel.status();
export const removeEmbedModel = () => embedModel.remove();

/**
 * How far the models a scan needs have come, while any is downloading: the files already here
 * count as done, so the total stays the whole of what this needs and does not drop as each file
 * finishes. Null when none is downloading. Pure.
 */
export function modelDownloadProgress(parts: { size: number; status: PinnedModelStatus }[]): ScanStatus["download"] {
  if (!parts.some((p) => p.status.state === "downloading")) return null;
  let done = 0;
  let total = 0;
  for (const { size, status } of parts) {
    total += size;
    if (status.state === "ready") done += size;
    else if (status.state === "downloading") done += status.done;
  }
  return { done, total };
}
