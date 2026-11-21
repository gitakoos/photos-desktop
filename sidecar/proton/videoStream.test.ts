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

import { describe, it, expect, vi } from "vitest";
import {
  ArrivingVideo,
  NOT_STREAMABLE,
  OpenVideos,
  downloadVideo,
  parseRange,
  startVideo,
  videoFromBytes,
  type VideoAnswer,
  type VideoSource,
} from "./videoStream.ts";
import { openDownloader } from "./downloadSlots.ts";

const live = () => new AbortController().signal;

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of gen) parts.push(Buffer.from(p));
  return Buffer.concat(parts);
}

/** The video an ask answered with, which the test expects to be one. */
const source = (v: VideoAnswer) => v as VideoSource;

const FILE = Buffer.from(Array.from({ length: 700_000 }, (_, i) => i % 251));

/**
 * The SDK's download slots and a downloader of `bytes`, modelled as the SDK has them: the
 * slot is taken when the downloader is made and given back only in the `finally` of a
 * download, which stops at the next block once its signal fires.
 */
function sdk(bytes: Buffer, block = 100_000, signatureIssues = false) {
  const queue = { inUse: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const auto = { on: true };
  const client = {
    async getFileDownloader(_uid: string, signal: AbortSignal) {
      queue.inUse++;
      return {
        getClaimedSizeInBytes: () => bytes.length,
        downloadToStream(sink: WritableStream<Uint8Array>) {
          const completion = (async () => {
            const writer = sink.getWriter();
            try {
              for (let at = 0; at < bytes.length; at += block) {
                if (!auto.on) await gate;
                if (signal.aborted) throw new Error("aborted");
                // A fresh array each block, as the SDK hands them over.
                await writer.write(Uint8Array.from(bytes.subarray(at, at + block)));
                await new Promise((r) => setTimeout(r, 1));
              }
              await writer.close();
              if (signatureIssues) throw new Error("signature");
            } finally {
              queue.inUse--;
            }
          })();
          return { completion: () => completion, isDownloadCompleteWithSignatureIssues: () => signatureIssues };
        },
      };
    },
  };
  return { queue, client, hold: () => (auto.on = false), go: () => release() };
}

describe("a Range header", () => {
  it("reads a start and an end, a start alone, and the last n bytes", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("keeps an end past the file to the file, and serves the first of several ranges", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=0-9, 20-29", 1000)).toEqual({ start: 0, end: 9 });
  });

  it("answers the whole file for none, or one it does not read", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange("items=0-9", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("bytes=9-3", 1000)).toBeNull();
  });

  it("is unsatisfiable past the end", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
  });
});

describe("a video kept on this computer", () => {
  it("is sliced", async () => {
    const v = videoFromBytes(FILE, "video/mp4");
    expect((await collect(v.read(1000, 400_000, live()))).equals(FILE.subarray(1000, 400_001))).toBe(true);
  });
});

describe("a video still arriving", () => {
  it("answers what is here at once and waits for the rest", async () => {
    const v = new ArrivingVideo(10, "video/mp4");
    v.append(Buffer.from([0, 1, 2, 3]));
    const reading = collect(v.read(2, 7, live()));
    await new Promise((r) => setTimeout(r, 5));
    v.append(Buffer.from([4, 5, 6, 7, 8, 9]));
    expect([...(await reading)]).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("serves a range across the pieces it arrived in", async () => {
    const v = new ArrivingVideo(FILE.length, "video/mp4");
    for (let at = 0; at < FILE.length; at += 70_001) v.append(Uint8Array.from(FILE.subarray(at, at + 70_001)));
    v.end(true);
    expect((await collect(v.read(69_000, 500_123, live()))).equals(FILE.subarray(69_000, 500_124))).toBe(true);
    expect((await collect(v.read(FILE.length - 5, FILE.length - 1, live()))).equals(FILE.subarray(FILE.length - 5))).toBe(true);
  });

  it("throws when the file ends short of a range, so the answer is cut", async () => {
    const v = new ArrivingVideo(10, "video/mp4");
    v.append(Buffer.from([0, 1, 2]));
    v.end(true);
    await expect(collect(v.read(0, 9, live()))).rejects.toThrow("shorter");
  });

  it("drops bytes past the stated size", async () => {
    const v = new ArrivingVideo(3, "video/mp4");
    v.append(Buffer.from([0, 1, 2, 3, 4]));
    expect(v.arrived()).toBe(3);
  });

  it("stops a read under way when it is closed, and serves nothing after", async () => {
    let closed = 0;
    const v = new ArrivingVideo(10, "video/mp4", () => closed++);
    v.append(Buffer.from([0, 1]));
    const reading = collect(v.read(0, 9, live()));
    await new Promise((r) => setTimeout(r, 5));
    v.close();
    await expect(reading).rejects.toThrow("stopped");
    await expect(collect(v.read(0, 1, live()))).rejects.toThrow();
    expect(closed).toBe(1);
  });

  it("ends a waiting read quietly when the player goes", async () => {
    const v = new ArrivingVideo(10, "video/mp4");
    const gone = new AbortController();
    const reading = collect(v.read(0, 9, gone.signal));
    gone.abort();
    expect((await reading).length).toBe(0);
  });
});

describe("downloading a video to play", () => {
  it("plays from the first bytes, and gives the download slot back when done", async () => {
    const s = sdk(FILE);
    const v = downloadVideo(await openDownloader(s.client, "v"), FILE.length, "video/mp4");
    expect(s.queue.inUse).toBe(1);
    expect((await collect(v.read(0, 99, live()))).equals(FILE.subarray(0, 100))).toBe(true);
    expect((await collect(v.read(600_000, FILE.length - 1, live()))).equals(FILE.subarray(600_000))).toBe(true);
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
    expect(v.broken()).toBe(false);
  });

  it("gives the slot back when closed before the download is done", async () => {
    const s = sdk(FILE);
    s.hold();
    const v = downloadVideo(await openDownloader(s.client, "v"), FILE.length, "video/mp4");
    v.close();
    s.go();
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
    expect(v.broken()).toBe(true);
  });

  it("never holds more than one slot per video, however many videos are played one after another", async () => {
    const s = sdk(FILE);
    const open = new OpenVideos(async (uid) => downloadVideo(await openDownloader(s.client, uid), FILE.length, "video/mp4"));
    for (let i = 0; i < 12; i++) {
      const v = source(await open.get(`v${i}`));
      await collect(v.read(0, 999, live()));
    }
    open.clear();
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
  });
});

describe("the videos kept open", () => {
  it("opens a video once for all its ranges", async () => {
    let opens = 0;
    const open = new OpenVideos(async () => {
      opens++;
      return videoFromBytes(FILE, "video/mp4");
    });
    const [a, b] = await Promise.all([open.get("u"), open.get("u")]);
    expect(a).toBe(b);
    await open.get("u");
    expect(opens).toBe(1);
    open.clear();
  });

  it("closes the oldest past two, and every one at clear", async () => {
    const closed: string[] = [];
    const open = new OpenVideos(async (uid) => ({ ...videoFromBytes(FILE, "video/mp4"), close: () => closed.push(uid) }));
    await open.get("a");
    await open.get("b");
    await open.get("c");
    await vi.waitFor(() => expect(closed).toEqual(["a"]));
    open.clear();
    await vi.waitFor(() => expect(closed.sort()).toEqual(["a", "b", "c"]));
  });

  it("closes a video left idle, but not one still being read", async () => {
    let now = 0;
    const closed: string[] = [];
    const open = new OpenVideos(
      async (uid) => ({ ...videoFromBytes(FILE, "video/mp4"), close: () => closed.push(uid) }),
      () => now,
      1000,
    );
    const playing = source(await open.get("playing"));
    await open.get("left");
    now = 900;
    await collect(playing.read(0, 10, live()));
    now = 1500;
    open.closeIdle();
    await vi.waitFor(() => expect(closed).toEqual(["left"]));
    expect(open.size()).toBe(1);
    open.clear();
  });

  it("keeps a video whose answer is still open, as a paused player's is", async () => {
    let now = 0;
    const closed: string[] = [];
    const open = new OpenVideos(
      async (uid) => ({ ...videoFromBytes(FILE, "video/mp4"), close: () => closed.push(uid) }),
      () => now,
      1000,
    );
    const paused = source(await open.get("paused"));
    const reading = paused.read(0, FILE.length - 1, live());
    await reading.next(); // the answer is open; the player has stopped reading
    now = 5000;
    open.closeIdle();
    expect(closed).toEqual([]);
    await reading.return(undefined); // the player goes: the answer closes
    now = 7000;
    open.closeIdle();
    await vi.waitFor(() => expect(closed).toEqual(["paused"]));
  });

  it("tries again for one that could not be opened, and opens afresh one that broke", async () => {
    let opens = 0;
    let broken = false;
    const open = new OpenVideos(async () => {
      opens++;
      if (opens === 1) throw new Error("network");
      return { ...videoFromBytes(FILE, "video/mp4"), broken: () => broken };
    });
    expect(await open.get("u")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await open.get("u")).not.toBeNull();
    broken = true;
    await open.get("u");
    expect(opens).toBe(3);
    open.clear();
  });
});

describe("a video whose signature does not check out", () => {
  it("is not played on, gives its slot back, and is refused when asked again", async () => {
    const s = sdk(FILE, 100_000, true);
    const open = new OpenVideos(async (uid) => downloadVideo(await openDownloader(s.client, uid), FILE.length, "video/mp4"));
    const v = source(await open.get("u"));
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
    expect(v.refused?.()).toBe(true);
    // Every byte had arrived, and still none of it is served.
    await expect(collect(v.read(0, 9, live()))).rejects.toThrow("signature");
    expect(open.notStreamable("u")).toBe(true);
    expect(await open.get("u")).toBe(NOT_STREAMABLE);
    expect(open.size()).toBe(0);
    open.clear();
  });

  it("cuts a read under way", async () => {
    const s = sdk(FILE, 100_000, true);
    s.hold();
    const v = downloadVideo(await openDownloader(s.client, "u"), FILE.length * 2, "video/mp4");
    const reading = collect(v.read(0, FILE.length * 2 - 1, live()));
    s.go();
    await expect(reading).rejects.toThrow("signature");
    expect(v.refused()).toBe(true);
  });
});

describe("waiting for a video", () => {
  it("answers null when the lookup does not come back in time, and stops waiting for a slot", async () => {
    let signal: AbortSignal | undefined;
    const open = new OpenVideos(
      (_uid, s) => {
        signal = s;
        return new Promise<VideoAnswer>(() => {});
      },
      Date.now,
      90_000,
      { startMs: 30 },
    );
    expect(await open.get("u")).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(open.size()).toBe(0);
    open.clear();
  });

  it("gives the slot back when the first bytes do not come in time", async () => {
    const s = sdk(FILE);
    s.hold();
    const open = new OpenVideos(
      async (uid, signal) => startVideo(await openDownloader(s.client, uid, signal), FILE.length, "video/mp4", signal),
      Date.now,
      90_000,
      { startMs: 30 },
    );
    expect(await open.get("u")).toBeNull();
    s.go();
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
    open.clear();
  });

  it("closes a video that comes in after the wait was given up", async () => {
    let closed = 0;
    let finish!: (v: VideoAnswer) => void;
    const open = new OpenVideos(() => new Promise<VideoAnswer>((r) => (finish = r)), Date.now, 90_000, { startMs: 20 });
    expect(await open.get("u")).toBeNull();
    finish({ ...videoFromBytes(FILE, "video/mp4"), close: () => closed++ });
    await vi.waitFor(() => expect(closed).toBe(1));
  });

  it("ends a read whose next bytes stall, and stops the download", async () => {
    let stopped = 0;
    const v = new ArrivingVideo(10, "video/mp4", () => stopped++, 30);
    v.append(Buffer.from([0, 1, 2]));
    await expect(collect(v.read(0, 9, live()))).rejects.toThrow("stalled");
    expect(stopped).toBe(1);
    expect(v.broken()).toBe(true);
  });

  it("keeps a read waiting while the bytes keep coming", async () => {
    const v = new ArrivingVideo(6, "video/mp4", () => {}, 60);
    const reading = collect(v.read(0, 5, live()));
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 15));
      v.append(Buffer.from([i]));
    }
    expect([...(await reading)]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("a video that can never be streamed", () => {
  it("is refused at once for a while without being looked up again, and again after", async () => {
    let now = 0;
    let looks = 0;
    const open = new OpenVideos(
      async () => {
        looks++;
        return NOT_STREAMABLE;
      },
      () => now,
      90_000,
      { refusedMs: 1000 },
    );
    expect(await open.get("u")).toBe(NOT_STREAMABLE);
    expect(await open.get("u")).toBe(NOT_STREAMABLE);
    expect(open.notStreamable("u")).toBe(true);
    expect(looks).toBe(1);
    now = 1500;
    expect(open.notStreamable("u")).toBe(false);
    expect(await open.get("u")).toBe(NOT_STREAMABLE);
    expect(looks).toBe(2);
    open.clear();
    expect(open.notStreamable("u")).toBe(false);
  });

  it("is told apart from one that failed for now, which is looked up again", async () => {
    let looks = 0;
    const open = new OpenVideos(async () => {
      looks++;
      return null;
    });
    expect(await open.get("u")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await open.get("u")).toBeNull();
    expect(open.notStreamable("u")).toBe(false);
    expect(looks).toBe(2);
    open.clear();
  });
});

describe("the memory the videos kept open hold", () => {
  const sized = (size: number, closed: string[], uid: string): VideoSource => ({
    ...videoFromBytes(Buffer.alloc(size), "video/mp4"),
    close: () => closed.push(uid),
  });

  it("stays within the cap, the oldest closed first and the newest kept", async () => {
    const closed: string[] = [];
    const open = new OpenVideos(async (uid) => sized(uid === "small" ? 300 : 700, closed, uid), Date.now, 90_000, {
      keptBytes: 1000,
    });
    await open.get("small");
    await open.get("big");
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toEqual([]);
    await open.get("other");
    await vi.waitFor(() => expect(closed).toEqual(["small", "big"]));
    expect(open.size()).toBe(1);
    open.clear();
  });

  it("keeps one still being read past the cap until its answer closes", async () => {
    const closed: string[] = [];
    const open = new OpenVideos(async (uid) => sized(700, closed, uid), Date.now, 90_000, { keptBytes: 1000 });
    const first = source(await open.get("first"));
    const reading = first.read(0, 699, live());
    await reading.next();
    await open.get("second");
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toEqual([]);
    await reading.return(undefined);
    await vi.waitFor(() => expect(closed).toEqual(["first"]));
    open.clear();
  });
});
