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
import { hostname } from "node:os";
import { join } from "node:path";

import { addressKeys, loadFullCopies, saveMlCopy, sealEnvelope, type CopyCache } from "./driveData.ts";
import { Analyzer, indexModelsStatus, startIndexModelsDownload, type ModelsStatus } from "./mlIndexer.ts";
import { Replica, type Op, type PhotoFace, type ReplicaView, type Seen, type Suggestion } from "./mlReplica.ts";
import { parseFacesSnapshot, parseSearchSnapshot, writeFacesSnapshot, writeSearchSnapshot } from "./mlSnapshot.ts";
import { SEARCH_MODEL_ID } from "./semantic.ts";
import { ML_DIR, isReady, readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

/** How long after the last change the copies are saved to Drive. */
const SAVE_DELAY_MS = 20_000;
/** Photos looked at between two saves of the scans to disk. */
const PERSIST_EVERY = 25;

export type IndexStatus = {
  running: boolean;
  phase: "idle" | "listing" | "scanning" | "saving";
  done: number;
  total: number;
  faces: number;
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
};

/** One edit the People pages ask for. */
export type EditRequest =
  | { action: "name"; person: string; name: string }
  | { action: "removePhotos"; person: string; keys: string[] }
  | { action: "movePhotos"; person: string; keys: string[]; name: string }
  | { action: "addPhotos"; name: string; keys: string[] }
  | { action: "setCover"; name: string; key: string }
  | { action: "hide"; person: string }
  | { action: "acceptSuggestion"; group: string; name: string }
  | { action: "dismissSuggestion"; group: string; name: string }
  | { action: "nameFaces"; faces: string[]; name: string };

export type MlDeps = {
  myFiles: () => any;
  account: () => any;
  copyCache: () => CopyCache | null;
  /** Every photo of the timeline: its uid (`volume~link`) and whether it is a video. */
  timeline: () => Promise<{ uid: string; video: boolean }[]>;
  /** The HD previews of some photos, as they arrive; null for one that has none. */
  previews: (uids: string[]) => AsyncIterable<{ uid: string; bytes: Buffer | null }>;
};

const linkOf = (uid: string) => uid.slice(uid.indexOf("~") + 1);

export class MlService {
  private replica: Replica | null = null;
  private loading: Promise<void> | null = null;
  private refreshed: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private sync: SyncStatus = { savedAt: null, saving: false, pending: false, error: null, sources: [], unreadable: 0 };
  private job: IndexStatus = idleJob();
  private cancel = false;

  constructor(private readonly deps: MlDeps) {}

  /** Forgets everything held in memory, on lock and sign-out. */
  reset(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.cancel = true;
    this.replica = null;
    this.loading = null;
    this.refreshed = null;
    this.sync = { savedAt: null, saving: false, pending: false, error: null, sources: [], unreadable: 0 };
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
        const label = `Windows (${hostname().slice(0, 28)})`;
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

  private persistScans(r: Replica): void {
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
      const { copies, unreadable } = await loadFullCopies(this.deps.myFiles(), this.deps.account(), this.deps.copyCache());
      const faces = copies.flatMap((c) => (c.kind === "faces" ? [c.snap] : []));
      const search = copies.flatMap((c) => (c.kind === "search" ? [c.snap] : []));
      r.setCopies(faces, search);
      this.writeJson("seen.json", r.seen);
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
      void this.save(r).catch(() => {});
    }, SAVE_DELAY_MS);
  }

  /** Saves now, when there is anything to save that Drive does not already hold. */
  async saveNow(): Promise<SyncStatus> {
    const r = await this.ready();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.save(r).catch(() => {});
    return this.syncStatus();
  }

  private async save(r: Replica): Promise<void> {
    if (this.sync.saving) {
      this.scheduleSave(r);
      return;
    }
    // Only a device that added something of its own, a scan or an edit, has a copy to save:
    // reading the phone's alone writes nothing to Drive.
    if (r.local.markers.length === 0 && r.ops.length === 0) {
      this.sync.pending = false;
      return;
    }
    const facesPlain = writeFacesSnapshot(r.exportFaces(0));
    const searchPlain = writeSearchSnapshot(r.exportSearch(0));
    // Hashed with the save time left out, so an unchanged index is not saved again.
    const hash = createHash("sha256").update(facesPlain).update(searchPlain).digest("hex");
    const last = this.readJson<{ at: number; hash: string }>("saved.json");
    if (last?.hash === hash) {
      this.sync.pending = false;
      return;
    }
    this.sync.saving = true;
    this.sync.error = null;
    try {
      const keys = await addressKeys(this.deps.account());
      if (keys.length === 0) throw new Error("no address key");
      const now = Date.now();
      const client = this.deps.myFiles();
      await saveMlCopy(client, `faces-${r.deviceId}.pfpml`, await sealEnvelope(writeFacesSnapshot(r.exportFaces(now)), keys[0], keys[0]));
      await saveMlCopy(client, `search-${r.deviceId}.pfpml`, await sealEnvelope(writeSearchSnapshot(r.exportSearch(now)), keys[0], keys[0]));
      this.writeJson("saved.json", { at: now, hash });
      this.sync.savedAt = now;
      this.sync.pending = false;
    } catch (e) {
      this.sync.error = (e as Error).message || "save failed";
      process.stderr.write(`[ml] saving to Drive failed: ${(e as Error).name}\n`);
      throw e;
    } finally {
      this.sync.saving = false;
    }
  }

  syncStatus(): SyncStatus {
    return { ...this.sync, sources: [...this.sync.sources] };
  }

  // ---- What the pages read ----

  async view(): Promise<ReplicaView & { names: string[] }> {
    const r = await this.ready();
    await this.refresh().catch(() => {});
    return { ...r.view(), names: r.names() };
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
        const s = r.suggestionsFor(name, 50).find((x) => x.group === req.group) ?? r.view().suggestions.find((x) => x.group === req.group && x.name === name);
        if (!s) throw new Error("That suggestion is gone");
        ops.push(
          req.action === "acceptSuggestion"
            ? { t, kind: "confirm", faces: r.refs(s.faces), name }
            : { t, kind: "notPerson", faces: r.refs(s.faces), name, on: true },
        );
        break;
      }
    }
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
  startIndex(): IndexStatus {
    if (this.job.running) return this.indexStatus();
    if (indexModelsStatus().missing > 0) throw new Error("The models are not downloaded yet");
    this.cancel = false;
    this.job = { ...idleJob(), running: true, phase: "listing" };
    void this.runIndex().catch((e) => {
      this.job.error = (e as Error).message || "failed";
      process.stderr.write(`[ml] the library scan stopped: ${(e as Error).name}\n`);
    }).finally(() => {
      this.job.running = false;
      this.job.phase = "idle";
      this.job.finishedAt = Date.now();
    });
    return this.indexStatus();
  }

  private async runIndex(): Promise<void> {
    const r = await this.ready();
    await this.refresh().catch(() => {});
    const covered = r.covered();
    const todo = (await this.deps.timeline()).filter((it) => {
      const key = linkOf(it.uid);
      return !covered.search.has(key) || (!it.video && !covered.faces.has(key));
    });
    this.job.total = todo.length;
    this.job.phase = "scanning";
    if (todo.length === 0) return;
    const analyzer = new Analyzer();
    if (!(await analyzer.open())) throw new Error("The models are not ready");
    const video = new Set(todo.filter((it) => it.video).map((it) => it.uid));
    let sincePersist = 0;
    try {
      const BATCH = 8;
      for (let at = 0; at < todo.length && !this.cancel; at += BATCH) {
        const batch = todo.slice(at, at + BATCH).map((it) => it.uid);
        for await (const { uid, bytes } of this.deps.previews(batch)) {
          if (this.cancel) break;
          const key = linkOf(uid);
          try {
            if (!bytes) throw new Error("no preview");
            const look = await analyzer.look(bytes, !video.has(uid));
            r.addScan(key, video.has(uid) ? [] : look.faces, look.vector);
            this.job.faces += look.faces.length;
          } catch {
            // A photo that cannot be read is marked so no device tries it again.
            r.addScan(key, [], null);
            this.job.failed++;
          }
          this.job.done++;
          if (++sincePersist >= PERSIST_EVERY) {
            this.persistScans(r);
            sincePersist = 0;
          }
        }
      }
    } finally {
      await analyzer.close();
      this.persistScans(r);
    }
    this.job.phase = "saving";
    await this.save(r).catch(() => {});
  }
}

function idleJob(): IndexStatus {
  return { running: false, phase: "idle", done: 0, total: 0, faces: 0, failed: 0, finishedAt: null, error: null };
}
