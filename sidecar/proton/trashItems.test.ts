/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { initStore, setDataKey, wipeCache } from "./store.ts";
import { forgetTrashItems, listTrashed } from "./trash.ts";

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-trash-")));
  setDataKey(randomBytes(32));
});

/** A trash of `uids`, counting the nodes it is asked to decrypt. */
function drive(uids: () => string[]) {
  const asked: string[] = [];
  return {
    asked,
    photos: {
      async *iterateTrashedNodeUids() {
        yield* uids();
      },
      async *iterateNodes(list: string[]) {
        for (const uid of list) {
          asked.push(uid);
          yield { uid, name: { ok: true, value: `${uid}.jpg` }, type: "photo", mediaType: "image/jpeg", photo: { captureTime: new Date(1_700_000_000_000 + Number(uid.slice(1)) * 1000), tags: [] } };
        }
      },
    },
  };
}

describe("reading the trash", () => {
  it("decrypts only the items new to it since the last read", async () => {
    let trash = ["a1", "a2", "a3"];
    const d = drive(() => trash);
    expect((await listTrashed(d.photos)).map((t) => t.uid)).toEqual(["a3", "a2", "a1"]);
    expect(d.asked).toHaveLength(3);
    trash = ["a1", "a2", "a3", "a4"];
    expect((await listTrashed(d.photos)).map((t) => t.uid)).toEqual(["a4", "a3", "a2", "a1"]);
    expect(d.asked).toHaveLength(4);
  });

  it("reads an item again once it has left the trash and come back", async () => {
    let trash = ["a1", "a2"];
    const d = drive(() => trash);
    await listTrashed(d.photos);
    trash = ["a2"];
    await listTrashed(d.photos);
    trash = ["a1", "a2"];
    await listTrashed(d.photos);
    expect(d.asked.filter((u) => u === "a1")).toHaveLength(2);
    expect(d.asked.filter((u) => u === "a2")).toHaveLength(1);
  });

  it("reads an item afresh once it was restored here, even trashed again before the next read", async () => {
    const d = drive(() => ["a1", "a2"]);
    await listTrashed(d.photos);
    forgetTrashItems(["a1"]);
    await listTrashed(d.photos);
    expect(d.asked.filter((u) => u === "a1")).toHaveLength(2);
    expect(d.asked.filter((u) => u === "a2")).toHaveLength(1);
  });

  it("does not keep an item whose name would not decrypt", async () => {
    const asked: string[] = [];
    const photos = {
      async *iterateTrashedNodeUids() {
        yield "a1";
      },
      async *iterateNodes(list: string[]) {
        for (const uid of list) {
          asked.push(uid);
          yield { uid, name: { ok: false, error: "no key" }, type: "photo", mediaType: "image/jpeg", photo: { captureTime: new Date(), tags: [] } };
        }
      },
    };
    expect(await listTrashed(photos)).toHaveLength(1);
    await listTrashed(photos);
    expect(asked).toHaveLength(2);
  });

  it("keeps nothing past a wipe", async () => {
    const d = drive(() => ["a1"]);
    await listTrashed(d.photos);
    wipeCache();
    await listTrashed(d.photos);
    expect(d.asked).toHaveLength(2);
  });
});
