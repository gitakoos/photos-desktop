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

// The desktop's face and search index as a device of its own: the replica (mlReplica.ts) kept
// sealed on disk, filled from every device's copy in Drive and from this PC's own scans,
// changed by the People pages' edits, and saved back to Drive as this device's copy a short
// while after anything changes, so the phone can restore it like any other device's.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { addressKeys, loadFullCopies, mlCopyNames, saveMlCopy, sealEnvelope, type CopyCache } from "./driveData.ts";
import { Analyzer, indexModelsStatus, startIndexModelsDownload, type ModelsStatus } from "./mlIndexer.ts";
import { Replica, type Op, type PhotoFace, type ReplicaView, type Seen, type Suggestion } from "./mlReplica.ts";
import { parseFacesSnapshot, parseSearchSnapshot, withoutSaveTime, writeFacesSnapshot, writeSearchSnapshot } from "./mlSnapshot.ts";
import { SEARCH_MODEL_ID } from "./semantic.ts";
import { ML_DIR, isReady, readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

/** How long after the last change the copies are saved to Drive. */
const SAVE_DELAY_MS = 20_000;
/** Photos looked at between two saves of the scans to disk. */
const PERSIST_EVERY = 25;

export type IndexStatus = {
  running: boolean;
  phase: "idle" | "listing" | "scanning" | "retrying" | "saving";
  done: number;
  total: number;
  /** Photos no device had looked at, and photos given the thorough second look. */
  firstLooks: number;
  secondLooks: number;
  /** Faces found by this run, and the photos it found any on. */
  faces: number;
  withFaces: number;
  /** Photos looked at with no face on them, which is the right answer for many. */
  noFaces: number;
  /** Photos that could not be fetched this run (the network, a stall): tried again next run. */
  retryLater: number;
  /** Photos with no picture that can be read: none of their preview, thumbnail or original. */
  unreadable: number;
  /** Kept for the window's older line: the same as `unreadable`. */
  failed: number;
  finishedAt: number | null;
  error: string | null;
};

export type SyncStatus = {
  /** When this device's copies were last saved to Drive, if ever. */
  savedAt: number | null;
  saving: boolean;
  /** Changes not saved to Drive yet. */
  pending: boolean;
  error: string | null;
  /** The other devices' copies merged in. */
  sources: { device: string; kind: "faces" | "search"; savedAt: number }[];
  unreadable: number;
  /** A save under way: getting the copy ready, then sending it, in bytes. */
  progress: { phase: "preparing" | "uploading"; sent: number; total: number } | null;
  /** What the last save, or the last look at whether one was needed, came to. */
  last: { outcome: "saved" | "upToDate"; faces: number; photos: number; people: number; vectors: number } | null;
};

/** One edit the People pages ask for. */
export type EditRequest =
  | { action: "name"; person: string; name: string }
  | { action: "removePhotos"; person: string; keys: string[] }
  | { action: "movePhotos"; person: string; keys: string[]; name: string }
  | { action: "addPhotos"; name: string; keys: string[] }
  | { action: "setCover"; name: string; key: string }
  | { action: "hide"; person: string }
  | { action: "acceptSuggestion"; group: string; name: string; faces?: string[] }
  | { action: "dismissSuggestion"; group: string; name: string; faces?: string[] }
  | { action: "nameFaces"; faces: string[]; name: string };

export type MlDeps = {
  myFiles: () => any;
  account: () => any;
  copyCache: () => CopyCache | null;
  /** Every photo of the timeline: its uid (`volume~link`) and whether it is a video. */
  timeline: () => Promise<{ uid: string; video: boolean }[]>;
  /** The HD previews of some photos, as they arrive; null for one that has none. A photo the
   *  iteration never reaches (a stall, an error) is left out, to be asked for again. */
  previews: (uids: string[]) => AsyncIterable<{ uid: string; bytes: Buffer | null }>;
  /** A photo's small grid thumbnail, for one with no HD preview; null when it has none. */
  thumbnail: (uid: string) => Promise<Buffer | null>;
  /** A photo's original file, for one with no thumbnail at all; null when too large or absent. */
  original: (uid: string) => Promise<Buffer | null>;
  /** The models, for a test to stand in for; the real ones when absent. */
  analyzer?: () => Pick<Analyzer, "open" | "close" | "look">;
};

/** One photo of the run, and what it is looked at for. */
type Todo = { uid: string; video: boolean; vector: boolean; faces: boolean; second: boolean };

/** What fetching one photo's picture came to. */
type Fetched = { bytes: Buffer } | { none: true } | { missing: true };

const linkOf = (uid: string) => uid.slice(uid.indexOf("~") + 1);

/** How many passes one automatic merge makes at most: each regroups the library. */
const AUTO_MERGE_PASSES = 1;

export class MlService {
  private replica: Replica | null = null;
  private loading: Promise<void> | null = null;
  private refreshed: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private sync: SyncStatus = { savedAt: null, saving: false, pending: false, error: null, sources: [], unreadable: 0, progress: null, last: null };
  private job: IndexStatus = idleJob();
  private cancel = false;
  private running: Promise<void> = Promise.resolve();
  /** Whether likely matches are merged into named people without asking, as on Android. */
  private autoMergeOn = false;
  /** Whether Drive was read once this session. */
  private readOnce = false;

  constructor(private readonly deps: MlDeps) {}

  /** Forgets everything held in memory, on lock and sign-out. */
  reset(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.cancel = true;
    this.replica = null;
    this.readOnce = false;
    this.loading = null;
    this.refreshed = null;
    this.sync = { savedAt: null, saving: false, pending: false, error: null, sources: [], unreadable: 0, progress: null, last: null };
    this.job = idleJob();
  }

  // ---- On disk ----

  private dir(): string {
    return join(storeDir(), ML_DIR);
  }

  private file(name: string): string {
    return join(this.dir(), name);
  }

  private readJson<T>(name: string): T | null {
    const raw = readSealedOrDiscard(this.file(name));
    if (!raw) return null;
    try {
      return JSON.parse(raw.toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  private writeJson(name: string, value: unknown): void {
    mkdirSync(this.dir(), { recursive: true });
    writeSealedAtomic(this.file(name), Buffer.from(JSON.stringify(value), "utf8"));
  }

  /** The replica, read from disk the first time. */
  private async ready(): Promise<Replica> {
    if (this.replica) return this.replica;
    if (!this.loading) {
      this.loading = (async () => {
        if (!isReady()) throw new Error("Locked");
        const device = this.readJson<{ id: string }>("device.json") ?? { id: randomUUID() };
        if (!existsSync(this.file("device.json"))) this.writeJson("device.json", device);
        // A plain label rather than the computer's name, which often carries its owner's:
        // the copy is encrypted, but the label still shows on every device's restore list.
        const label = "Windows PC";
        const r = new Replica(device.id, label, SEARCH_MODEL_ID);
        const faces = readSealedOrDiscard(this.file("local-faces.bin"));
        const search = readSealedOrDiscard(this.file("local-search.bin"));
        try {
          if (faces) r.local = { ...parseFacesSnapshot(faces), deviceId: device.id, deviceLabel: label };
          if (search) r.localSearch = { ...parseSearchSnapshot(search), deviceId: device.id, deviceLabel: label };
        } catch {
          /* a damaged file starts over; the scans are looked at again */
        }
        r.ops = this.readJson<Op[]>("ops.json") ?? [];
        r.seen = this.readJson<Seen>("seen.json") ?? {};
        // The library as last told, so the counts read at start are the ones read before quitting,
        // not every photo any device ever indexed until the timeline arrives.
        const library = this.readJson<string[]>("library.json");
        if (library) r.setLibrary(library);
        this.autoMergeOn = this.readJson<{ autoMerge?: boolean }>("prefs.json")?.autoMerge === true;
        // Who each face was grouped as when the app last ran: the first grouping leans on it.
        const names = this.readJson<Record<string, string>>("names.json");
        if (names) r.lastNames = new Map(Object.entries(names));
        const saved = this.readJson<{ at: number; hash: string }>("saved.json");
        this.sync.savedAt = saved?.at ?? null;
        this.replica = r;
      })().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
    return this.replica!;
  }

  /**
   * Whether `r` is still the replica of the session that is signed in. A lock or a sign-out
   * drops it, and work begun before that (a scan, a read of Drive, a save) must then leave
   * the disk and Drive alone: the store and the account may already be someone else's.
   */
  private current(r: Replica): boolean {
    return this.replica === r;
  }

  /** Who the grouping made each face, for the next start to lean on. */
  private persistNames(r: Replica): void {
    if (!this.current(r) || r.lastNames.size === 0) return;
    this.writeJson("names.json", Object.fromEntries(r.lastNames));
  }

  private persistScans(r: Replica): void {
    if (!this.current(r)) return;
    mkdirSync(this.dir(), { recursive: true });
    writeSealedAtomic(this.file("local-faces.bin"), writeFacesSnapshot(r.local));
    writeSealedAtomic(this.file("local-search.bin"), writeSearchSnapshot(r.localSearch));
  }

  // ---- Drive ----

  /** Reads every device's copy from Drive into the replica; once a session unless `force`. */
  async refresh(force = false): Promise<void> {
    if (this.refreshed && !force) return this.refreshed;
    const run = (async () => {
      const r = await this.ready();
      const { copies, unreadable, seen } = await loadFullCopies(this.deps.myFiles(), this.deps.account(), this.deps.copyCache());
      process.stderr.write(`[ml] drive: ${JSON.stringify({
        ...seen,
        copies: copies.map((c) => ({
          kind: c.kind,
          own: c.snap.deviceId === r.deviceId,
          device: c.snap.deviceLabel,
          savedAt: c.snap.createdAt,
          ...(c.kind === "faces"
            ? { faces: c.snap.faces.length, markers: c.snap.markers.length, modelVersion: c.snap.modelVersion, dim: c.snap.dim }
            : { vectors: c.snap.vectors.size, sameModel: c.snap.modelId === SEARCH_MODEL_ID }),
        })),
      })}\n`);
      const faces = copies.flatMap((c) => (c.kind === "faces" ? [c.snap] : []));
      const search = copies.flatMap((c) => (c.kind === "search" ? [c.snap] : []));
      if (!this.current(r)) return;
      r.setCopies(faces, search);
      this.readOnce = true;
      this.writeJson("seen.json", r.seen);
      this.autoMerge(r);
      this.sync.unreadable = unreadable;
      this.sync.sources = [
        ...faces.filter((s) => s.deviceId !== r.deviceId).map((s) => ({ device: s.deviceLabel, kind: "faces" as const, savedAt: s.createdAt })),
        ...search.filter((s) => s.deviceId !== r.deviceId).map((s) => ({ device: s.deviceLabel, kind: "search" as const, savedAt: s.createdAt })),
      ];
      // What the other devices know may not be in this device's copy yet.
      this.scheduleSave(r, true);
    })();
    this.refreshed = run;
    run.catch(() => {
      if (this.refreshed === run) this.refreshed = null;
    });
    return run;
  }

  /** Saves this device's copies a while after the last change, when they differ from the last saved. */
  private scheduleSave(r: Replica, quiet = false): void {
    if (!quiet) this.sync.pending = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistNames(r);
      void this.save(r).catch(() => {});
    }, SAVE_DELAY_MS);
  }

  /** Saves now, when there is anything to save that Drive does not already hold. */
  /**
   * Starts a save now and answers at once: the page follows it through `syncStatus`, its
   * progress included. Asked for by hand, it also checks the copies are still in Drive (not
   * deleted or in the trash), and sends them again when they are not.
   */
  async saveNow(): Promise<SyncStatus> {
    const r = await this.ready();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.sync.saving) {
      this.sync.progress = { phase: "preparing", sent: 0, total: 0 };
      this.saveRun = this.save(r, true).catch(() => {});
    }
    return this.syncStatus();
  }

  /** Resolves once the save `saveNow` started has ended. */
  async saveIdle(): Promise<void> {
    await this.saveRun;
  }
  private saveRun: Promise<void> = Promise.resolve();

  /** Lets the event loop breathe between the heavy steps of a save, so progress is read. */
  private breathe(): Promise<void> {
    return new Promise((done) => setImmediate(done));
  }

  private async save(r: Replica, byHand = false): Promise<void> {
    if (!this.current(r)) return;
    if (this.sync.saving) {
      this.scheduleSave(r);
      return;
    }
    this.sync.saving = true;
    this.sync.error = null;
    this.sync.progress = { phase: "preparing", sent: 0, total: 0 };
    try {
      // Only a device that added something of its own, a scan or an edit, has a copy to save:
      // reading the phone's alone writes nothing to Drive.
      if (r.local.markers.length === 0 && r.ops.length === 0) {
        this.sync.pending = false;
        return;
      }
      await this.breathe();
      const report = r.report();
      const now = Date.now();
      const facesSnap = r.exportFaces(now);
      const searchSnap = r.exportSearch(now);
      const facesPlain = writeFacesSnapshot(facesSnap);
      const searchPlain = writeSearchSnapshot(searchSnap);
      await this.breathe();
      // Read back before it leaves: the copy must hold every face, decision and vector the
      // index has, or it is not sent.
      const back = parseFacesSnapshot(facesPlain);
      const backSearch = parseSearchSnapshot(searchPlain);
      let vectors = 0;
      for (const v of backSearch.vectors.values()) if (v) vectors++;
      const shortBy = [
        back.faces.length < report.merged.faces ? `faces ${back.faces.length}/${report.merged.faces}` : "",
        back.markers.length < report.merged.scanned ? `scanned ${back.markers.length}/${report.merged.scanned}` : "",
        vectors < report.merged.vectors ? `vectors ${vectors}/${report.merged.vectors}` : "",
      ].filter(Boolean);
      process.stderr.write(`[ml] index: ${JSON.stringify({ ...report, copy: { faces: back.faces.length, scanned: back.markers.length, manual: back.manual.length, notPerson: back.notPerson.length, covers: back.covers.length, vectors, facesBytes: facesPlain.length, searchBytes: searchPlain.length } })}\n`);
      if (shortBy.length) throw new Error(`the copy came out short (${shortBy.join(", ")})`);
      const summary = {
        faces: back.faces.length,
        photos: report.merged.photosWithFaces,
        people: report.merged.people,
        vectors,
      };

      // Each copy is written once; the hash that tells an unchanged index from a changed one
      // reads it with the save time blanked, so saving again with nothing new uploads nothing.
      const hash = createHash("sha256").update(withoutSaveTime(facesPlain)).update(withoutSaveTime(searchPlain)).digest("hex");
      const last = this.readJson<{ at: number; hash: string }>("saved.json");
      const client = this.deps.myFiles();
      const names = [`faces-${r.deviceId}.pfpml`, `search-${r.deviceId}.pfpml`];
      if (last?.hash === hash) {
        const inDrive = byHand ? await mlCopyNames(client) : null;
        if (!inDrive || names.every((n) => inDrive.has(n))) {
          this.sync.pending = false;
          this.sync.last = { outcome: "upToDate", ...summary };
          return;
        }
      }
      const keys = await addressKeys(this.deps.account());
      if (keys.length === 0) throw new Error("no address key");
      const sealedFaces = await sealEnvelope(facesPlain, keys[0], keys[0]);
      await this.breathe();
      const sealedSearch = await sealEnvelope(searchPlain, keys[0], keys[0]);
      const total = sealedFaces.length + sealedSearch.length;
      this.sync.progress = { phase: "uploading", sent: 0, total };
      await saveMlCopy(client, names[0], sealedFaces, (sent) => {
        this.sync.progress = { phase: "uploading", sent: Math.min(sent, sealedFaces.length), total };
      });
      await saveMlCopy(client, names[1], sealedSearch, (sent) => {
        this.sync.progress = { phase: "uploading", sent: sealedFaces.length + Math.min(sent, sealedSearch.length), total };
      });
      this.writeJson("saved.json", { at: now, hash });
      this.sync.savedAt = now;
      this.sync.pending = false;
      this.sync.last = { outcome: "saved", ...summary };
    } catch (e) {
      this.sync.error = (e as Error).message || "save failed";
      process.stderr.write(`[ml] saving to Drive failed: ${(e as Error).name}: ${(e as Error).message}\n`);
      throw e;
    } finally {
      this.sync.saving = false;
      this.sync.progress = null;
    }
  }

  syncStatus(): SyncStatus {
    return { ...this.sync, sources: [...this.sync.sources], progress: this.sync.progress && { ...this.sync.progress } };
  }

  // ---- What the pages read ----

  async view(): Promise<ReplicaView & { names: string[] }> {
    const r = await this.ready();
    // Waits for Drive only the first time. A later forced read runs on its own: waiting on it
    // held the page, and every edit queued behind it, for a whole download.
    if (!this.readOnce) await this.refresh().catch(() => {});
    return { ...r.view(), names: r.names() };
  }

  /** Tells the index which photos the library holds, by link id, so only those are grouped. */
  async setLibrary(keys: string[]): Promise<{ ok: true }> {
    const r = await this.ready();
    const before = r.faceVersion;
    r.setLibrary(keys);
    if (r.faceVersion !== before && this.current(r)) {
      this.writeJson("library.json", keys);
      this.autoMerge(r);
    }
    return { ok: true };
  }

  // ---- Merging likely matches on their own ----

  async autoMergeStatus(): Promise<{ on: boolean }> {
    await this.ready();
    return { on: this.autoMergeOn };
  }

  /** Turns the automatic merge on or off; turning it on merges at once. */
  async setAutoMerge(on: boolean): Promise<{ on: boolean; merged: number }> {
    const r = await this.ready();
    this.autoMergeOn = on;
    this.writeJson("prefs.json", { autoMerge: on });
    return { on, merged: on ? this.autoMerge(r) : 0 };
  }

  /**
   * Folds every unnamed group that clearly looks like a named person into them, pass after
   * pass until none is left, as "yes" to each suggestion would: ordinary confirmations, saved
   * and synced like any edit. Only once the library is known, so it never acts on photos since
   * deleted. Returns how many groups were merged.
   */
  private autoMerge(r: Replica): number {
    if (!this.autoMergeOn || !r.libraryKnown || !this.current(r)) return 0;
    let merged = 0;
    for (let pass = 0; pass < AUTO_MERGE_PASSES; pass++) {
      const pairs = r.autoMergePairs();
      if (pairs.length === 0) break;
      const t = r.clock();
      for (const p of pairs) r.apply({ t, kind: "confirm", faces: p.faces, name: p.name });
      merged += pairs.length;
    }
    if (merged > 0) {
      this.writeJson("ops.json", r.ops);
      this.scheduleSave(r);
    }
    return merged;
  }

  /** The faces on one photo, by its link id, for the viewer's tags. */
  async photoFaces(key: string): Promise<PhotoFace[]> {
    const r = await this.ready();
    return r.photoFaces(key);
  }

  async suggestionsFor(name: string): Promise<Suggestion[]> {
    const r = await this.ready();
    return r.suggestionsFor(name);
  }

  /** Every device's search vectors, for ranking a typed query. */
  async searchVectors(): Promise<Map<string, Uint16Array | null>> {
    const r = await this.ready();
    await this.refresh().catch(() => {});
    return r.searchVectors();
  }

  // ---- Edits ----

  async edit(req: EditRequest): Promise<ReplicaView & { names: string[] }> {
    const r = await this.ready();
    const t = r.clock();
    const name = "name" in req ? req.name.trim().slice(0, 200) : "";
    if ("name" in req && !name) throw new Error("A name is needed");
    const person = "person" in req ? r.person(req.person) : null;
    if ("person" in req && !person) throw new Error("That person is gone");
    const ops: Op[] = [];
    // A name that was renamed away is free again once someone is given it on purpose.
    const target =
      req.action === "name" || req.action === "movePhotos" || req.action === "addPhotos" || req.action === "nameFaces"
        ? name
        : null;
    if (target && r.isAliased(target)) ops.push({ t, kind: "alias", from: target, to: target });
    switch (req.action) {
      case "name":
        if (person!.name) {
          // A rename; onto a name already in use, a merge.
          if (person!.name !== name) ops.push({ t, kind: "alias", from: person!.name, to: name });
        } else {
          ops.push({ t, kind: "confirm", faces: r.refs(person!.faces), name });
        }
        break;
      case "removePhotos": {
        const faces = r.facesOn(req.person, req.keys);
        if (person!.name) {
          ops.push({ t, kind: "notPerson", faces, name: person!.name, on: true });
          ops.push({ t, kind: "unassign", faces });
          ops.push({ t, kind: "manual", keys: req.keys, name: person!.name, on: false });
        } else {
          // An unnamed group has no name to keep the face out of: it leaves People.
          ops.push({ t, kind: "reject", faces });
        }
        break;
      }
      case "movePhotos": {
        const faces = r.facesOn(req.person, req.keys);
        ops.push({ t, kind: "confirm", faces, name });
        if (person!.name) {
          ops.push({ t, kind: "notPerson", faces, name: person!.name, on: true });
          ops.push({ t, kind: "manual", keys: req.keys, name: person!.name, on: false });
          // A photo with no face of theirs moves as a hand-added one.
          const withFace = new Set(faces.map((f) => f.id.slice(0, f.id.lastIndexOf("#"))));
          const bare = req.keys.filter((k) => !withFace.has(k));
          if (bare.length) ops.push({ t, kind: "manual", keys: bare, name, on: true });
        }
        break;
      }
      case "addPhotos":
        ops.push({ t, kind: "manual", keys: req.keys.map(linkOf), name, on: true });
        break;
      case "setCover":
        ops.push({ t, kind: "cover", name, key: linkOf(req.key) });
        break;
      case "hide":
        ops.push({ t, kind: "reject", faces: r.refs(person!.faces) });
        if (person!.name) {
          ops.push({ t, kind: "manual", keys: person!.keys, name: person!.name, on: false });
          ops.push({ t, kind: "cover", name: person!.name, key: null });
        }
        break;
      case "nameFaces":
        // A face named from the viewer, on its own or out of whatever group it was in.
        ops.push({ t, kind: "confirm", faces: r.refs(req.faces), name });
        break;
      case "acceptSuggestion":
      case "dismissSuggestion": {
        // The faces the card showed, when the page sent them: the answer is about those, even
        // when the groups were redrawn since (an automatic merge, a scan, another edit).
        const shown = req.faces?.length ? r.refs(req.faces) : [];
        const s = shown.length
          ? null
          : r.suggestionsFor(name, 50).find((x) => x.group === req.group) ?? r.view().suggestions.find((x) => x.group === req.group && x.name === name);
        let faces = shown.length ? shown : s ? r.refs(s.faces) : [];
        // A "no" leaves alone a face that is already this person: an automatic merge may have
        // taken it in since the card was drawn, and the two answers would fight.
        if (req.action === "dismissSuggestion") {
          const own = new Set(r.person(`n:${name}`)?.faces ?? []);
          faces = faces.filter((f) => !own.has(f.id));
        }
        // Gone with nothing to act on: the page is brought up to date rather than told no.
        if (faces.length === 0) break;
        ops.push(
          req.action === "acceptSuggestion"
            ? { t, kind: "confirm", faces, name }
            : { t, kind: "notPerson", faces, name, on: true },
        );
        break;
      }
    }
    if (ops.length === 0) return { ...r.view(), names: r.names() };
    for (const op of ops) r.apply(op);
    this.writeJson("ops.json", r.ops);
    this.scheduleSave(r);
    return { ...r.view(), names: r.names() };
  }

  // ---- Looking at the library ----

  modelsStatus(): ModelsStatus {
    return indexModelsStatus();
  }

  downloadModels(): ModelsStatus {
    return startIndexModelsDownload();
  }

  indexStatus(): IndexStatus {
    return { ...this.job };
  }

  cancelIndex(): IndexStatus {
    this.cancel = true;
    return this.indexStatus();
  }

  /** Starts looking at every photo no device has looked at yet. */
  /** Resolves once the run under way, if any, has ended. */
  async indexDone(): Promise<void> {
    await this.running;
  }

  startIndex(): IndexStatus {
    if (this.job.running) return this.indexStatus();
    if (!this.deps.analyzer && indexModelsStatus().missing > 0) throw new Error("The models are not downloaded yet");
    this.cancel = false;
    this.job = { ...idleJob(), running: true, phase: "listing" };
    this.running = this.runIndex().catch((e) => {
      this.job.error = (e as Error).message || "failed";
      process.stderr.write(`[ml] the library scan stopped: ${(e as Error).name}\n`);
    }).finally(() => {
      this.job.running = false;
      this.job.phase = "idle";
      this.job.finishedAt = Date.now();
    });
    return this.indexStatus();
  }

  /**
   * The run, in two kinds of look. A first look for every photo no device has looked at: its
   * search vector and, for a photo, its faces. Then a second, thorough look for every photo
   * that has had only an ordinary one, by any device, the phone included: the sensitive
   * detector over the whole picture and its quarters, which finds the small faces of a group
   * photo the ordinary look misses. A first look here is already the thorough one, so each
   * photo is looked at thoroughly once, ever.
   *
   * A picture that cannot be fetched (the network, a stall) is never taken for a photo with
   * no faces: it is asked for again at the end of the run, and if it still does not come it is
   * left for the next run. Only a photo none of whose pictures can be read is marked as done.
   * The next batch is fetched while the current one is looked at.
   */
  private async runIndex(): Promise<void> {
    const r = await this.ready();
    await this.refresh().catch(() => {});
    const covered = r.covered();
    const first: Todo[] = [];
    const second: Todo[] = [];
    for (const it of await this.deps.timeline()) {
      const key = linkOf(it.uid);
      const needsVector = !covered.search.has(key);
      const scanned = covered.faces.get(key);
      if (needsVector || (!it.video && scanned === undefined)) {
        first.push({ uid: it.uid, video: it.video, vector: needsVector, faces: !it.video && scanned !== true, second: false });
      } else if (!it.video && scanned === false) {
        second.push({ uid: it.uid, video: false, vector: false, faces: true, second: true });
      }
    }
    const todo = [...first, ...second];
    this.job.firstLooks = first.length;
    this.job.secondLooks = second.length;
    this.job.total = todo.length;
    this.job.phase = "scanning";
    if (todo.length === 0) return;
    const analyzer = this.deps.analyzer?.() ?? new Analyzer();
    if (!(await analyzer.open())) throw new Error("The models are not ready");
    const live = () => !this.cancel && this.current(r);
    let sincePersist = 0;
    const retry: Todo[] = [];

    /** The HD previews of a batch, each as fetched, none, or missing. */
    const fetchBatch = async (batch: Todo[]): Promise<Map<string, Fetched>> => {
      const got = new Map<string, Fetched>();
      try {
        for await (const { uid, bytes } of this.deps.previews(batch.map((t) => t.uid))) {
          got.set(uid, bytes ? { bytes } : { none: true });
        }
      } catch {
        /* whatever did not come is missing, and asked for again */
      }
      for (const t of batch) if (!got.has(t.uid)) got.set(t.uid, { missing: true });
      return got;
    };

    /** Looks at one photo from what was fetched; false when it has to wait for a later try. */
    const lookAt = async (t: Todo, fetched: Fetched, lastTry: boolean): Promise<boolean> => {
      if ("missing" in fetched && !lastTry) return false;
      const key = linkOf(t.uid);
      // The HD preview first. A photo with none is one of 1920 pixels or less, which the phone
      // uploads without one: its original is small, and far sharper than the 512-pixel grid
      // thumbnail, which comes last.
      const sources: (() => Promise<Buffer | null>)[] = [];
      if ("bytes" in fetched) sources.push(async () => fetched.bytes);
      if (!t.video) sources.push(() => this.deps.original(t.uid).catch(() => null));
      sources.push(() => this.deps.thumbnail(t.uid).catch(() => null));
      let gotAny = false;
      for (const source of sources) {
        const bytes = await source();
        if (!bytes) continue;
        gotAny = true;
        try {
          const look = await analyzer.look(bytes, t.faces, true, t.vector);
          // What the second look finds joins what was known; a face already known stays as it
          // was, with every decision about it.
          // A look for the search vector alone (a video the phone already looked at for faces)
          // leaves its faces as they are.
          if (!t.faces) {
            if (t.vector) r.setVector(key, look.vector);
            return true;
          }
          const known = r.knownFaces(key);
          const added = look.faces.filter((f) => !known.some((k) => overlap(k.box, f.box) >= SAME_FACE));
          const faces = [...known.map(({ index, box, score, blur, points, embedding }) => ({ index, box, score, blur, points, embedding })), ...added];
          r.addScan(key, faces, t.vector ? look.vector : undefined, Date.now(), true);
          this.job.faces += added.length;
          if (faces.length > 0) this.job.withFaces++;
          else if (t.faces) this.job.noFaces++;
          return true;
        } catch {
          /* this picture would not decode: the next source may */
        }
      }
      if (gotAny) {
        // Every picture there is came and none would decode: nothing a later try can change.
        // What other devices found on it stays.
        if (!t.faces) {
          if (t.vector) r.setVector(key, null);
        } else {
          const known = r.knownFaces(key).map(({ index, box, score, blur, points, embedding }) => ({ index, box, score, blur, points, embedding }));
          r.addScan(key, known, t.vector ? null : undefined, Date.now(), true);
        }
        this.job.unreadable++;
        this.job.failed++;
        return true;
      }
      if (!lastTry) return false;
      this.job.retryLater++;
      return true;
    };

    const step = () => {
      this.job.done++;
      if (++sincePersist >= PERSIST_EVERY) {
        this.persistScans(r);
        sincePersist = 0;
      }
    };

    try {
      const BATCH = 8;
      let next = live() ? fetchBatch(todo.slice(0, BATCH)) : null;
      for (let at = 0; at < todo.length && next && live(); at += BATCH) {
        const batch = todo.slice(at, at + BATCH);
        const got = await next;
        // Fetched ahead: the next batch downloads while this one is looked at.
        next = at + BATCH < todo.length && live() ? fetchBatch(todo.slice(at + BATCH, at + 2 * BATCH)) : null;
        for (const t of batch) {
          if (!live()) break;
          if (await lookAt(t, got.get(t.uid)!, false)) step();
          else retry.push(t);
        }
      }
      // What did not come the first time, asked for one at a time.
      this.job.phase = "retrying";
      for (const t of retry) {
        if (!live()) break;
        const got = await fetchBatch([t]);
        await lookAt(t, got.get(t.uid)!, true);
        step();
      }
    } finally {
      await analyzer.close();
      this.persistScans(r);
      this.persistNames(r);
      // What the pages read caught up with every photo the run looked at.
      r.fresh();
    }
    if (!this.current(r)) return;
    this.autoMerge(r);
    this.job.phase = "saving";
    await this.save(r).catch(() => {});
  }
}

function idleJob(): IndexStatus {
  return {
    running: false, phase: "idle", done: 0, total: 0, firstLooks: 0, secondLooks: 0,
    faces: 0, withFaces: 0, noFaces: 0, retryLater: 0, unreadable: 0, failed: 0, finishedAt: null, error: null,
  };
}

/** Two boxes this much the same are one face. */
const SAME_FACE = 0.4;

function overlap(a: number[], b: number[]): number {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - iw * ih;
  return u > 0 ? (iw * ih) / u : 0;
}
