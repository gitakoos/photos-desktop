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

import { describe, expect, it, vi } from "vitest";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));
vi.mock("./ocr.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ocr.ts")>()),
  ocrModelStatus: () => ({ state: "ready" }),
  readText: vi.fn(async () => ({ width: 1, height: 1, blocks: [] })),
}));

import { ProtonSession } from "./session.ts";

/** A session whose photo fetches wait until the test lets each one finish. */
function withFetches(giveUpMs = 60_000) {
  const session = new ProtonSession();
  session.ocrSettleMs = 5;
  session.ocrFetchGiveUpMs = giveUpMs;
  const fetching: { uid: string; finish: () => void }[] = [];
  (session as any).ocrBytes = (source: { uid: string }) =>
    new Promise<Buffer>((resolve) => fetching.push({ uid: source.uid, finish: () => resolve(Buffer.from([1])) }));
  return { session, fetching };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uids = (f: { uid: string }[]) => f.map((x) => x.uid);

describe("reading text as the viewer steps through photos", () => {
  it("fetches only the newest of reads started together", async () => {
    const { session, fetching } = withFetches();
    const a = session.ocrStart({ uid: "a" }, true).id;
    session.ocrStart({ uid: "b" }, true);
    const c = session.ocrStart({ uid: "c" }, true).id;
    await pause(30);
    expect(uids(fetching)).toEqual(["c"]);
    expect(session.ocrResult(a)?.state).toBe("failed");
    fetching[0].finish();
    await vi.waitFor(() => expect(session.ocrResult(c)?.state).toBe("done"));
  });

  it("does not make a newer read wait for a stale fetch", async () => {
    const { session, fetching } = withFetches();
    const a = session.ocrStart({ uid: "a" }, true).id;
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a"]));
    const b = session.ocrStart({ uid: "b" }, true).id;
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a", "b"]));
    fetching[1].finish();
    await vi.waitFor(() => expect(session.ocrResult(b)?.state).toBe("done"));
    fetching[0].finish();
    await vi.waitFor(() => expect(session.ocrResult(a)?.state).toBe("failed"));
  });

  it("shares a fetch of the same photo under way", async () => {
    const { session, fetching } = withFetches();
    session.ocrStart({ uid: "a" }, true);
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a"]));
    // Copy text pressed while the read ahead of the same photo is still fetching it.
    const again = session.ocrStart({ uid: "a" }).id;
    await pause(30);
    expect(uids(fetching)).toEqual(["a"]);
    fetching[0].finish();
    await vi.waitFor(() => expect(session.ocrResult(again)?.state).toBe("done"));
  });

  it("runs at most two fetches, and a read waiting for a place gives up if passed", async () => {
    const { session, fetching } = withFetches();
    session.ocrStart({ uid: "a" }, true);
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a"]));
    session.ocrStart({ uid: "b" }, true);
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a", "b"]));
    const c = session.ocrStart({ uid: "c" }, true).id;
    await pause(30);
    expect(uids(fetching)).toEqual(["a", "b"]);
    const d = session.ocrStart({ uid: "d" }, true).id;
    await pause(30);
    fetching[0].finish();
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a", "b", "d"]));
    expect(session.ocrResult(c)?.state).toBe("failed");
    fetching[2].finish();
    await vi.waitFor(() => expect(session.ocrResult(d)?.state).toBe("done"));
  });

  it("lets the next read through when a fetch never answers", async () => {
    const { session, fetching } = withFetches(50);
    const a = session.ocrStart({ uid: "a" }, true).id;
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a"]));
    session.ocrStart({ uid: "b" }, true);
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a", "b"]));
    const c = session.ocrStart({ uid: "c" }, true).id;
    // a and b hang; once they give up, c fetches.
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a", "b", "c"]));
    expect(session.ocrResult(a)?.state).toBe("failed");
    fetching[2].finish();
    await vi.waitFor(() => expect(session.ocrResult(c)?.state).toBe("done"));
  });

  it("gives up a shared fetch with the one it shares", async () => {
    const { session, fetching } = withFetches(50);
    const a = session.ocrStart({ uid: "a" }, true).id;
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a"]));
    const again = session.ocrStart({ uid: "a" }).id;
    await vi.waitFor(() => expect(session.ocrResult(again)?.state).toBe("failed"));
    expect(session.ocrResult(a)?.state).toBe("failed");
    expect(uids(fetching)).toEqual(["a"]);
  });

  it("fetches at once for a read asked for with the button", async () => {
    const { session, fetching } = withFetches();
    session.ocrSettleMs = 60_000;
    session.ocrStart({ uid: "a" });
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a"]));
  });

  it("keeps a read asked for with the button when a read ahead starts after it", async () => {
    const { session, fetching } = withFetches();
    const pressed = session.ocrStart({ uid: "a" }).id;
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a"]));
    // A read ahead that reached this side after the press, as one on a slower lane can.
    session.ocrStart({ uid: "b" }, true);
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a", "b"]));
    fetching[0].finish();
    await vi.waitFor(() => expect(session.ocrResult(pressed)?.state).toBe("done"));
  });

  it("lets a newer press pass an older one", async () => {
    const { session, fetching } = withFetches();
    const first = session.ocrStart({ uid: "a" }).id;
    const second = session.ocrStart({ uid: "b" }).id;
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a", "b"]));
    fetching[0].finish();
    fetching[1].finish();
    await vi.waitFor(() => expect(session.ocrResult(second)?.state).toBe("done"));
    expect(session.ocrResult(first)?.state).toBe("failed");
  });

  it("does not make a press wait behind fetches of reads ahead", async () => {
    const { session, fetching } = withFetches();
    session.ocrStart({ uid: "a" }, true);
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a"]));
    session.ocrStart({ uid: "b" }, true);
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a", "b"]));
    // Both places are held by reads ahead that never answer; the press fetches anyway.
    const pressed = session.ocrStart({ uid: "c" }).id;
    await vi.waitFor(() => expect(uids(fetching)).toEqual(["a", "b", "c"]));
    fetching[2].finish();
    await vi.waitFor(() => expect(session.ocrResult(pressed)?.state).toBe("done"));
  });

  it("answers failed, and frees its place, when a fetch throws", async () => {
    const session = new ProtonSession();
    session.ocrSettleMs = 1;
    let calls = 0;
    (session as any).ocrBytes = async () => {
      calls++;
      if (calls === 1) throw new Error("network");
      return Buffer.from([1]);
    };
    const a = session.ocrStart({ uid: "a" }, true).id;
    await vi.waitFor(() => expect(session.ocrResult(a)?.state).toBe("failed"));
    const b = session.ocrStart({ uid: "b" }, true).id;
    await vi.waitFor(() => expect(session.ocrResult(b)?.state).toBe("done"));
  });
});
