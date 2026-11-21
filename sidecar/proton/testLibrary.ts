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

// A made-up large library for the face benchmarks: a phone's copy of it, this computer's own
// part, the steps a scan runs on them, and a probe that times the sidecar's answers meanwhile.

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import type { FaceCopy, SnapshotFace } from "./driveData.ts";
import { FACE_EMBEDDING_DIM } from "./faceCluster.ts";
import { autoMergeAsync, groupAfterPass, placeNew, settleTakenIn } from "./facePeople.ts";
import { FACE_MODEL_VERSION, FaceStore, type FaceRecord } from "./faceStore.ts";
import { FACE_CLUSTER_PARAMS_VERSION, FACE_MODEL_SHA256, adoptScannedAsync, applyCopyAsync } from "./faceSync.ts";
import { initStore, setDataKey } from "./store.ts";
import { direction, faceOf, seeded } from "./testFaces.ts";

const PHONE_ID = "00000000-0000-0000-0000-000000000001";
const OWN_ID = "f0000000-0000-4000-8000-000000000001";

type Box = [number, number, number, number];

const boxAt = (index: number, shift = 0): Box => [0.05 + 0.3 * index + shift, 0.1, 0.3 + 0.3 * index + shift, 0.45];

export type Library = {
  copy: FaceCopy;
  uidByLink: Map<string, string>;
  /** The photos this computer scanned itself before the phone's copy came, with its own faces. */
  local: Map<string, FaceRecord[]>;
};

/**
 * A library of about `faces` faces: identities of very different sizes (a long tail of people seen
 * a few times), weak faces, strays, one to three faces a photo. The phone scanned every photo, named
 * a few hundred people, confirmed some faces, left some out and marked some as not someone; this
 * computer scanned a fifth of the photos itself, its boxes a little off the phone's.
 */
export function library(seed: number, faces: number): Library {
  const rand = seeded(seed);
  const identities = Math.max(20, Math.round(faces / 25));
  const named = Math.min(400, Math.max(5, Math.round(identities / 10)));
  const strays = Math.round(faces * 0.1);
  const weights = Array.from({ length: identities }, (_, i) => 1 / Math.pow(i + 1, 0.9));
  const total = weights.reduce((a, b) => a + b, 0);
  type Made = { identity: number; embedding: Float32Array; score: number };
  const made: Made[] = [];
  for (let i = 0; i < identities; i++) {
    const base = direction(rand);
    const count = Math.max(1, Math.round(((faces - strays) * weights[i]) / total));
    for (let k = 0; k < count; k++) {
      const weak = rand() < 0.2;
      made.push({ identity: i, embedding: faceOf(base, rand, weak ? 0.9 : 0.5), score: weak ? 0.6 + rand() * 0.1 : 0.8 + rand() * 0.2 });
    }
  }
  for (let i = 0; i < strays; i++) made.push({ identity: -1, embedding: direction(rand), score: 0.6 + rand() * 0.4 });
  for (let i = made.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [made[i], made[j]] = [made[j], made[i]];
  }
  const nameOf = (identity: number) => (identity >= 0 && identity < named ? `Person ${identity}` : null);
  const snapshot: SnapshotFace[] = [];
  const scanned: string[] = [];
  const uidByLink = new Map<string, string>();
  const local = new Map<string, FaceRecord[]>();
  const notPerson: FaceCopy["notPerson"] = [];
  let photo = 0;
  for (let at = 0; at < made.length; photo++) {
    const key = `k${photo}`;
    const uid = `vol~${key}`;
    scanned.push(key);
    uidByLink.set(key, uid);
    const here = rand() < 0.2;
    const records: FaceRecord[] = [];
    const n = 1 + Math.floor(rand() * 3);
    for (let index = 0; index < n && at < made.length; index++, at++) {
      const face = made[at];
      const name = nameOf(face.identity);
      snapshot.push({
        key,
        index,
        box: boxAt(index),
        points: [],
        score: face.score,
        blur: 100,
        embedding: face.embedding,
        rejected: rand() < 0.01,
        person: name,
        confirmed: name && rand() < 0.2 ? name : null,
      });
      if (name && rand() < 0.01) notPerson.push({ name: `Person ${(face.identity + 1) % named}`, key, index, at: 0 });
      if (here) {
        records.push({
          id: `${uid}#${index}`,
          uid,
          box: boxAt(index, 0.01),
          points: [],
          score: face.score,
          blur: 100,
          sideways: 0,
          embedding: faceOf(face.embedding, rand, 0.1),
        });
      }
    }
    if (here) local.set(uid, records);
  }
  // A few photos the phone looked at and found no face on.
  for (let i = 0; i < Math.round(photo / 20); i++) {
    const key = `e${i}`;
    scanned.push(key);
    uidByLink.set(key, `vol~${key}`);
  }
  const copy: FaceCopy = {
    deviceId: PHONE_ID,
    deviceLabel: "phone",
    createdAt: 1,
    faceModelVersion: FACE_MODEL_VERSION,
    faceModelSha256: FACE_MODEL_SHA256,
    clusterParamsVersion: FACE_CLUSTER_PARAMS_VERSION,
    embeddingDim: FACE_EMBEDDING_DIM,
    facesWipedAt: 0,
    faces: snapshot,
    notPerson,
    covers: new Map(),
    coverSetAt: new Map(),
    manual: [],
    removals: [],
    namedAt: new Map(),
    nameChanges: [],
    scanned,
    hiddenPeople: [],
  };
  return { copy, uidByLink, local };
}

/** This computer before the phone's copy came: its own photos scanned and placed, never grouped as a whole. */
export async function storeBefore(lib: Library): Promise<FaceStore> {
  initStore(mkdtempSync(join(tmpdir(), "pfp-face-bench-")));
  setDataKey(randomBytes(32));
  const store = new FaceStore();
  store.load();
  store.people.deviceId = OWN_ID;
  for (const [uid, faces] of lib.local) store.put(uid, faces);
  await placeNew(store);
  store.flush();
  return store;
}

/** What a scan does with the phone's copy, step by step as the scanner runs them, with the time of each. */
export async function takeInAndGroup(store: FaceStore, lib: Library): Promise<Record<string, number>> {
  const steps: Record<string, number> = {};
  const step = async (name: string, work: () => unknown) => {
    const started = performance.now();
    running = name;
    await work();
    steps[name] = Math.round(performance.now() - started);
  };
  await step("adopt", () => adoptScannedAsync(store, lib.copy, lib.uidByLink));
  await step("pair", () => applyCopyAsync(store, lib.copy));
  await step("place", () => settleTakenIn(store, true));
  await step("save", () => store.flushSliced());
  await step("group", () => groupAfterPass(store, () => true));
  await step("merge", () => autoMergeAsync(store));
  await step("save2", () => store.flushSliced());
  return steps;
}

/** The step of `takeInAndGroup` running now, for the probe to say where the longest waits came from. */
let running = "";

/** Who each face went to, the people and the marks: what has to come out alike. */
export function outcome(store: FaceStore): string {
  const p = store.people;
  const sorted = (o: Record<string, unknown>) => Object.keys(o).sort().map((k) => [k, o[k]]);
  return JSON.stringify({
    faces: store.allFaces().map((f) => [f.id, f.box]),
    people: p.people,
    assign: sorted(p.assign),
    confirmed: sorted(p.confirmed),
    blocked: sorted(p.blocked),
    rejected: [...p.rejected].sort(),
  });
}

/** The probe, on its own thread: cheap calls and thumbnail requests at a steady rate, each timed from when it was due. */
const PROBE = `
const { parentPort, workerData } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const rpc = [];
const thumb = [];
const pending = new Map();
let seq = 0;
let thumbDue = null;
parentPort.on("message", (m) => {
  if (m.type === "pong") {
    rpc.push(performance.now() - pending.get(m.id));
    pending.delete(m.id);
  } else if (m.type === "stop") {
    clearInterval(rpcTimer);
    clearInterval(thumbTimer);
    const now = performance.now();
    for (const due of pending.values()) rpc.push(now - due);
    if (thumbDue !== null) thumb.push(now - thumbDue);
    parentPort.postMessage({ type: "done", rpc, thumb });
  }
});
const rpcTimer = setInterval(() => {
  const id = seq++;
  pending.set(id, performance.now());
  parentPort.postMessage({ type: "ping", id });
}, workerData.rpcEvery);
const thumbTimer = setInterval(async () => {
  if (thumbDue !== null) return;
  thumbDue = performance.now();
  try {
    const res = await fetch(workerData.url);
    await res.arrayBuffer();
    thumb.push(performance.now() - thumbDue);
  } catch {}
  thumbDue = null;
}, workerData.thumbEvery);
`;

export type Spread = { count: number; p50: number; p99: number; max: number };

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
  const r = (v: number) => Math.round(v * 10) / 10;
  return { count: sorted.length, p50: r(at(0.5)), p99: r(at(0.99)), max: r(sorted[sorted.length - 1] ?? 0) };
}

export type Probed<T> = {
  out: T;
  lag: Spread & { mean: number };
  /** The longest the event loop was held, by the step running at the time. */
  blocks: Record<string, number>;
  /** The longest hold seen while a read of the people was under way. */
  duringReads: number;
  /** The garbage collector's pauses: how many, and the longest. */
  gc: { count: number; max: number };
  rpc: Spread;
  thumb: Spread;
  reads: Spread;
};

/**
 * Runs `work` while the probe calls this thread, and while `read` (the window's read of the people)
 * runs every two seconds as the window's poll does; answers the delays seen.
 */
export async function probed<T>(work: () => Promise<T>, read: () => unknown): Promise<Probed<T>> {
  const thumbnail = randomBytes(24_000);
  const server: Server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(thumbnail);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/thumb`;
  const worker = new Worker(PROBE, { eval: true, workerData: { url, rpcEvery: 20, thumbEvery: 50 } });
  worker.on("message", (m) => {
    if (m.type === "ping") worker.postMessage({ type: "pong", id: m.id });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reads: number[] = [];
  let reading = false;
  const reader = setInterval(() => {
    if (reading) return;
    reading = true;
    const started = performance.now();
    void Promise.resolve(read()).finally(() => {
      reads.push(performance.now() - started);
      reading = false;
    });
  }, 2_000);
  const gc = { count: 0, max: 0 };
  const collector = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gc.count++;
      gc.max = Math.max(gc.max, Math.round(e.duration * 10) / 10);
    }
  });
  collector.observe({ entryTypes: ["gc"] });
  let duringReads = 0;
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const blocks: Record<string, number> = {};
  let last = performance.now();
  let lastStep = running;
  const ticker = setInterval(() => {
    const now = performance.now();
    const held = Math.round(now - last - 5);
    const label = lastStep === running ? running : `${lastStep}..${running}`;
    last = now;
    lastStep = running;
    if (held > (blocks[label] ?? 0)) blocks[label] = held;
    if (reading) duringReads = Math.max(duringReads, held);
  }, 5);
  let out: T;
  try {
    out = await work();
  } finally {
    loop.disable();
    collector.disconnect();
    clearInterval(reader);
    clearInterval(ticker);
  }
  const done = new Promise<{ rpc: number[]; thumb: number[] }>((resolve) =>
    worker.on("message", (m) => {
      if (m.type === "done") resolve(m);
    }),
  );
  worker.postMessage({ type: "stop" });
  const seen = await done;
  await worker.terminate();
  await new Promise((resolve) => server.close(resolve));
  const ms = (ns: number) => Math.round(ns / 1e5) / 10;
  return {
    out,
    lag: {
      count: loop.count,
      p50: ms(loop.percentile(50)),
      p99: ms(loop.percentile(99)),
      max: Math.max(ms(loop.max), ...Object.values(blocks)),
      mean: ms(loop.mean),
    },
    blocks,
    duringReads,
    gc,
    rpc: spread(seen.rpc),
    thumb: spread(seen.thumb),
    reads: spread(reads),
  };
}

