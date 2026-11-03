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

// The People index end to end against a Drive kept in memory, with real OpenPGP: the phone's
// copy read in, edits made, this PC's copy saved beside it, and that copy read back as the
// phone would read it.

import "@protontech/crypto/polyfill";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { CryptoProxy, initCrypto } from "./crypto.ts";
import { openEnvelope, sealEnvelope } from "./driveData.ts";
import { FACE_EMBED_SHA256, emptyFaces } from "./mlReplica.ts";
import { MlService } from "./mlService.ts";
import { parseFacesSnapshot, writeFacesSnapshot, writeSearchSnapshot, type SnapFace } from "./mlSnapshot.ts";
import { SEARCH_MODEL_ID } from "./semantic.ts";
import { initStore, setDataKey } from "./store.ts";

const PHONE = "bbbbbbbb-0000-0000-0000-000000000002";
let key: any;

beforeAll(async () => {
  initCrypto();
  key = await CryptoProxy.generateKey({ userIDs: [{ name: "Owner", email: "owner@example.com" }] } as any);
}, 30_000);

function identity(axis: number, jitter: number): Float32Array {
  const v = new Float32Array(512);
  v[axis] = 1;
  v[100 + jitter] = 0.2;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

function face(k: string, axis: number, confirmed: string | null): SnapFace {
  return {
    key: k, index: 0, box: [0.1, 0.1, 0.3, 0.4], score: 0.9, blur: 40, rejected: false, person: confirmed, confirmed,
    points: Float32Array.of(30, 40, 70, 40, 50, 60, 35, 80, 65, 80), embedding: identity(axis, k.length),
  };
}

/** A Drive with My files in memory: folders, files and their revisions. */
function memoryDrive() {
  type Node = { uid: string; type: "file" | "folder"; name: string; parent: string; revisions: Buffer[]; trashTime?: Date };
  const nodes = new Map<string, Node>([["root", { uid: "root", type: "folder", name: "", parent: "", revisions: [] }]]);
  let next = 0;
  const view = (n: Node) => ({
    uid: n.uid,
    type: n.type,
    name: { ok: true, value: n.name },
    activeRevision: { ok: true, value: { uid: `${n.uid}@${n.revisions.length}` } },
    modificationTime: new Date(n.revisions.length),
    trashTime: n.trashTime,
  });
  const uploader = (write: (bytes: Buffer) => void) => ({
    async uploadFromStream(stream: ReadableStream<Uint8Array>) {
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      write(Buffer.concat(chunks));
      return { completion: async () => ({}) };
    },
  });
  const client = {
    getMyFilesRootFolder: async () => view(nodes.get("root")!),
    async *iterateFolderChildren(uid: string) {
      for (const n of nodes.values()) if (n.parent === uid) yield view(n);
    },
    async createFolder(parent: string, name: string) {
      const n: Node = { uid: `n${next++}`, type: "folder", name, parent, revisions: [] };
      nodes.set(n.uid, n);
      return view(n);
    },
    async getFileUploader(parent: string, name: string) {
      return uploader((bytes) => {
        const n: Node = { uid: `n${next++}`, type: "file", name, parent, revisions: [bytes] };
        nodes.set(n.uid, n);
      });
    },
    async getFileRevisionUploader(uid: string) {
      return uploader((bytes) => nodes.get(uid)!.revisions.push(bytes));
    },
    getFileDownloader: async (uid: string) => ({
      downloadToStream(sink: WritableStream<Uint8Array>) {
        return {
          completion: async () => {
            const w = sink.getWriter();
            const revs = nodes.get(uid)!.revisions;
            await w.write(new Uint8Array(revs[revs.length - 1]));
            await w.close();
          },
        };
      },
    }),
  };
  const put = async (path: string[], name: string, bytes: Buffer) => {
    let parent = "root";
    for (const segment of path) {
      const found = [...nodes.values()].find((n) => n.parent === parent && n.name === segment);
      parent = found ? found.uid : (await client.createFolder(parent, segment)).uid;
    }
    await (await client.getFileUploader(parent, name)).uploadFromStream(new Blob([new Uint8Array(bytes)]).stream());
  };
  const files = () => [...nodes.values()].filter((n) => n.type === "file");
  return { client, put, files };
}

function service(drive: ReturnType<typeof memoryDrive>) {
  const account = { getOwnAddresses: async () => [{ keys: [{ key }], primaryKeyIndex: 0 }] };
  return new MlService({
    myFiles: () => drive.client,
    account: () => account,
    copyCache: () => null,
    timeline: async () => [],
    previews: async function* () {},
    thumbnail: async () => null,
    original: async () => null,
  });
}

describe("the People index against Drive", () => {
  it("reads the phone's copy, takes edits, saves its own copy the phone can open, and keeps the edits", async () => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-ml-")));
    setDataKey(randomBytes(32));
    const drive = memoryDrive();
    const phoneCopy = {
      ...emptyFaces(PHONE, "Pixel 8"),
      createdAt: 1000,
      modelSha256: FACE_EMBED_SHA256,
      faces: [face("p1", 1, "Ana"), face("p2", 1, "Ana"), face("p3", 2, null), face("p4", 2, null)],
      markers: ["p1", "p2", "p3", "p4"].map((k) => ({ key: k, hiRes: false })),
    };
    await drive.put(["Photos for Proton", "ML data"], `faces-${PHONE}.pfpml`, await sealEnvelope(writeFacesSnapshot(phoneCopy), key, key));

    const ml = service(drive);
    let view = await ml.view();
    expect(view.people.map((p) => p.name)).toEqual(["Ana", null]);

    // Reading alone writes nothing to Drive.
    await ml.saveNow();
    await ml.saveIdle();
    expect(drive.files()).toHaveLength(1);

    // Name the group, then take a photo off Ana.
    const group = view.people.find((p) => !p.name)!;
    view = await ml.edit({ action: "name", person: group.id, name: "Bruno" });
    view = await ml.edit({ action: "removePhotos", person: "n:Ana", keys: ["p2"] });
    expect(view.people.map((p) => [p.name, [...p.keys].sort()])).toEqual([
      ["Bruno", ["p3", "p4"]],
      ["Ana", ["p1"]],
    ]);

    await ml.saveNow();
    await ml.saveIdle();
    const sync = ml.syncStatus();
    await ml.saveIdle();
    expect(sync.error).toBeNull();
    expect(sync.savedAt).not.toBeNull();
    const mine = drive.files().filter((f) => f.name.startsWith("faces-") && !f.name.includes(PHONE));
    expect(mine).toHaveLength(1);
    expect(drive.files().some((f) => f.name.startsWith("search-"))).toBe(true);

    // The phone opens this PC's copy with the account's key and finds every decision in it.
    const opened = await openEnvelope(mine[0].revisions[0], [key], [key]);
    expect(opened.ok).toBe(true);
    const snap = parseFacesSnapshot((opened as { plain: Buffer }).plain);
    expect(snap.modelVersion).toBe(7);
    expect(snap.modelSha256).toBe(FACE_EMBED_SHA256);
    const confirmedOf = (k: string) => snap.faces.find((f) => f.key === k)?.confirmed;
    expect(confirmedOf("p3")).toBe("Bruno");
    expect(confirmedOf("p2")).toBeNull();
    expect(snap.notPerson).toEqual([{ name: "Ana", key: "p2", index: 0 }]);

    // Saving again with nothing new uploads nothing new, and says so with what the copy holds.
    await ml.saveNow();
    await ml.saveIdle();
    expect(mine[0].revisions).toHaveLength(1);
    expect(ml.syncStatus().last).toMatchObject({ outcome: "upToDate", faces: 4, people: 2 });
    expect(ml.syncStatus().progress).toBeNull();

    // Put in the trash, the copy is no longer there for any device: saving by hand sends it
    // again as a new file, rather than a revision nobody would read.
    mine[0].trashTime = new Date();
    await ml.saveNow();
    await ml.saveIdle();
    const live = drive.files().filter((f) => f.name.startsWith("faces-") && !f.name.includes(PHONE) && !f.trashTime);
    expect(live).toHaveLength(1);
    expect(live[0]).not.toBe(mine[0]);
    expect(ml.syncStatus().last?.outcome).toBe("saved");

    // A fresh start of the app reads the edits back from disk.
    const again = service(drive);
    const back = await again.view();
    expect(back.people.map((p) => [p.name, [...p.keys].sort()])).toEqual([
      ["Bruno", ["p3", "p4"]],
      ["Ana", ["p1"]],
    ]);
  }, 60_000);
});

describe("looking at the library", () => {
  it("never takes a photo it could not fetch for one with no faces, and gives the phone's photos a second look", async () => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-ml-scan-")));
    setDataKey(randomBytes(32));
    const drive = memoryDrive();
    // The phone looked at p6 the ordinary way and found one face on it.
    const phoneCopy = {
      ...emptyFaces(PHONE, "Pixel 8"),
      createdAt: 1000,
      modelSha256: FACE_EMBED_SHA256,
      faces: [face("p6", 1, "Ana")],
      markers: [{ key: "p6", hiRes: false }],
    };
    await drive.put(["Photos for Proton", "ML data"], `faces-${PHONE}.pfpml`, await sealEnvelope(writeFacesSnapshot(phoneCopy), key, key));
    // And its search vector, so p6 needs nothing but the thorough look.
    const phoneSearch = { deviceId: PHONE, deviceLabel: "Pixel 8", createdAt: 1000, modelId: SEARCH_MODEL_ID, dim: 512, vectors: new Map([["p6", new Uint16Array(512).fill(0x3c00)]]) };
    await drive.put(["Photos for Proton", "ML data"], `search-${PHONE}.pfpml`, await sealEnvelope(writeSearchSnapshot(phoneSearch), key, key));

    const timeline = ["p1", "p2", "p3", "p4", "p5", "p6"].map((k) => ({ uid: `vol~${k}`, video: false }));
    const asked = new Map<string, number>();
    // What each picture holds, for the stand-in models: "face" finds one face, "blank" none,
    // "junk" will not decode.
    const picture = (what: string) => Buffer.from(what);
    const service = new MlService({
      myFiles: () => drive.client,
      account: () => ({ getOwnAddresses: async () => [{ keys: [{ key }], primaryKeyIndex: 0 }] }),
      copyCache: () => null,
      timeline: async () => timeline,
      previews: async function* (uids) {
        for (const uid of uids) {
          const n = (asked.get(uid) ?? 0) + 1;
          asked.set(uid, n);
          if (uid === "vol~p1") yield { uid, bytes: picture("face") };
          // p2 stalls the first time it is asked for, then comes.
          if (uid === "vol~p2" && n > 1) yield { uid, bytes: picture("blank") };
          // p3, p4 and p5 have no HD preview.
          if (uid === "vol~p3" || uid === "vol~p4" || uid === "vol~p5") yield { uid, bytes: null };
          if (uid === "vol~p6") yield { uid, bytes: picture("two") };
        }
      },
      thumbnail: async (uid) => (uid === "vol~p3" ? picture("face") : uid === "vol~p5" ? picture("junk") : null),
      original: async () => null,
      analyzer: () => ({
        open: async () => true,
        close: async () => {},
        look: async (bytes: Buffer, faces: boolean, thorough?: boolean) => {
          const what = bytes.toString();
          if (what === "junk") throw new Error("cannot decode");
          expect(thorough).toBe(true);
          const at = (x: number) => ({ box: [x, 0.1, x + 0.2, 0.4] as [number, number, number, number], score: 0.9, blur: 40, points: Float32Array.of(30, 40, 70, 40, 50, 60, 35, 80, 65, 80), embedding: identity(5, 3) });
          // "two" holds the face the phone found, at 0.1, and a small one it missed, at 0.6.
          const found = what === "face" ? [at(0.1)] : what === "two" ? [at(0.1), at(0.6)] : [];
          return { vector: new Uint16Array(512).fill(0x3c00), faces: faces ? found : [] };
        },
      }),
    });

    service.startIndex();
    await service.indexDone();
    const job = service.indexStatus();
    expect(job.error).toBeNull();
    expect([job.firstLooks, job.secondLooks]).toEqual([5, 1]);
    expect(job.retryLater).toBe(1); // p4: nothing could be fetched, so it is left for next run
    expect(job.unreadable).toBe(1); // p5: its one picture would not decode
    expect(job.withFaces).toBe(3); // p1, p3 (from its thumbnail), p6
    expect(job.noFaces).toBe(1); // p2, once it came
    expect(asked.get("vol~p2")).toBe(2);

    // p4 is not marked: the next run asks for it again. The others are done, thoroughly.
    const view = await service.view();
    expect(view.scanned).toBe(5);
    // p6 keeps the phone's Ana and gains the face the phone missed.
    const faces = await service.photoFaces("p6");
    expect(faces.map((f) => f.name)).toEqual(["Ana", null]);

    // A second run looks only at what is left: p4, never fetched, and p5, whose picture would
    // not decode, tried again for its search vector, as an older build left many marked so.
    service.startIndex();
    await service.indexDone();
    expect(service.indexStatus()).toMatchObject({ firstLooks: 2, secondLooks: 0, retryLater: 1 });
  }, 60_000);
});

describe("what a fresh start reads", () => {
  it("counts over the library told before quitting, and merges likely matches once turned on", async () => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-ml-lib-")));
    setDataKey(randomBytes(32));
    const drive = memoryDrive();
    const near = (k: string) => ({ ...face(k, 1, null), embedding: (() => {
      const v = new Float32Array(512);
      v[1] = 0.55;
      v[9] = Math.sqrt(1 - 0.55 * 0.55);
      return v;
    })() });
    const phoneCopy = {
      ...emptyFaces(PHONE, "Pixel 8"),
      createdAt: 1000,
      modelSha256: FACE_EMBED_SHA256,
      // p9 was deleted since the phone looked at it.
      faces: [face("p1", 1, "Ana"), face("p2", 1, "Ana"), face("p9", 1, "Ana"), near("p3"), near("p4")],
      markers: ["p1", "p2", "p9", "p3", "p4"].map((k) => ({ key: k, hiRes: false })),
    };
    await drive.put(["Photos for Proton", "ML data"], `faces-${PHONE}.pfpml`, await sealEnvelope(writeFacesSnapshot(phoneCopy), key, key));

    const ml = service(drive);
    await ml.view();
    await ml.setLibrary(["p1", "p2", "p3", "p4"]);
    const ana = (v: Awaited<ReturnType<MlService["view"]>>) => [...(v.people.find((p) => p.name === "Ana")?.keys ?? [])].sort();
    expect(ana(await ml.view())).toEqual(["p1", "p2"]);

    // Started again, before the timeline has come: the same count, not one with p9 in it.
    const again = service(drive);
    expect(ana(await again.view())).toEqual(["p1", "p2"]);

    // Turned on, the look-alike group joins Ana at once, and stays after a restart.
    expect(await again.autoMergeStatus()).toEqual({ on: false });
    expect((await again.setAutoMerge(true)).merged).toBe(1);
    expect(ana(await again.view())).toEqual(["p1", "p2", "p3", "p4"]);
    const third = service(drive);
    expect(await third.autoMergeStatus()).toEqual({ on: true });
    expect(ana(await third.view())).toEqual(["p1", "p2", "p3", "p4"]);
  }, 60_000);
});
