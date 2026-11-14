/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect, vi } from "vitest";
import {
  ArrivingVideo,
  OpenVideos,
  downloadVideo,
  parseRange,
  releaseUnusedDownloader,
  videoFromBytes,
  SeekingVideo,
  seekVideo,
} from "./videoStream.ts";

const live = () => new AbortController().signal;

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of gen) parts.push(Buffer.from(p));
  return Buffer.concat(parts);
}

const FILE = Buffer.from(Array.from({ length: 700_000 }, (_, i) => i % 251));

/**
 * The SDK's download queue and a downloader of `bytes`, modelled as the SDK has them: the
 * slot is taken when the downloader is made and given back only in the `finally` of a
 * download, which stops at the next block once its signal fires.
 */
function sdk(bytes: Buffer, block = 100_000) {
  const queue = { inUse: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const auto = { on: true };
  function downloader(signal: AbortSignal) {
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
              await writer.write(bytes.subarray(at, at + block));
              await new Promise((r) => setTimeout(r, 1));
            }
            await writer.close();
          } finally {
            queue.inUse--;
          }
        })();
        return { completion: () => completion, isDownloadCompleteWithSignatureIssues: () => false };
      },
    };
  }
  return { queue, downloader, hold: () => (auto.on = false), go: () => release() };
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
    const stop = new AbortController();
    const v = downloadVideo(s.downloader(stop.signal), FILE.length, "video/mp4", stop);
    expect(s.queue.inUse).toBe(1);
    expect((await collect(v.read(0, 99, live()))).equals(FILE.subarray(0, 100))).toBe(true);
    expect((await collect(v.read(600_000, FILE.length - 1, live()))).equals(FILE.subarray(600_000))).toBe(true);
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
  });

  it("gives the slot back when closed before the download is done", async () => {
    const s = sdk(FILE);
    s.hold();
    const stop = new AbortController();
    const v = downloadVideo(s.downloader(stop.signal), FILE.length, "video/mp4", stop);
    v.close();
    s.go();
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
  });

  it("gives back the slot of a downloader that is not used", async () => {
    const s = sdk(FILE);
    const stop = new AbortController();
    releaseUnusedDownloader(s.downloader(stop.signal), stop);
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
  });

  it("never holds more than one slot per video, however many videos are played one after another", async () => {
    const s = sdk(FILE);
    const open = new OpenVideos(async () => {
      const stop = new AbortController();
      return downloadVideo(s.downloader(stop.signal), FILE.length, "video/mp4", stop);
    });
    for (let i = 0; i < 12; i++) {
      const v = (await open.get(`v${i}`))!;
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
    const playing = (await open.get("playing"))!;
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
    const paused = (await open.get("paused"))!;
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

  it("tries again for one that could not be opened", async () => {
    let opens = 0;
    const open = new OpenVideos(async () => {
      opens++;
      if (opens === 1) throw new Error("network");
      return videoFromBytes(FILE, "video/mp4");
    });
    expect(await open.get("u")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await open.get("u")).not.toBeNull();
    open.clear();
  });
});

describe("a video read range by range from Proton", () => {
  /** A file of `size` bytes, each the low byte of its position, behind a fake seekable stream. */
  function seekable(size: number) {
    let position = 0;
    const log = { seeks: [] as number[], reads: 0, cancels: 0 };
    let failAt: number | null = null;
    const stream = {
      seek(p: number) {
        log.seeks.push(p);
        position = p;
      },
      async read(n: number) {
        log.reads++;
        await new Promise((r) => setTimeout(r, 1));
        if (failAt !== null && position <= failAt && failAt < position + n) throw new Error("block failed");
        const len = Math.max(0, Math.min(n, size - position));
        const value = Uint8Array.from({ length: len }, (_, i) => (position + i) & 0xff);
        position += len;
        return { value, done: position >= size };
      },
      // As the SDK's: its reader is held, so a cancel is refused.
      async cancel() {
        log.cancels++;
        throw new TypeError("ReadableStream is locked");
      },
    };
    return { stream, log, fail: (at: number) => (failAt = at) };
  }
  const collect = async (gen: AsyncGenerator<Uint8Array>) => {
    const parts: Uint8Array[] = [];
    for await (const piece of gen) parts.push(Uint8Array.from(piece));
    return Array.from(Buffer.concat(parts));
  };
  const MB = 1024 * 1024;

  it("answers any range with the right bytes, the end of the file included", async () => {
    const { stream } = seekable(10 * MB + 123);
    const video = new SeekingVideo(10 * MB + 123, "video/mp4", stream, () => {});
    const gone = new AbortController().signal;
    const middle = await collect(video.read(3 * MB + 7, 3 * MB + 300_000, gone));
    expect(middle.length).toBe(300_000 - 7 + 1);
    expect(middle.every((b, i) => b === ((3 * MB + 7 + i) & 0xff))).toBe(true);
    const tail = await collect(video.read(10 * MB, 10 * MB + 500, gone));
    expect(tail.length).toBe(123);
    expect(tail[122]).toBe((10 * MB + 122) & 0xff);
  });

  it("reads a span ahead and serves what it kept without asking again", async () => {
    const { stream, log } = seekable(20 * MB);
    const video = new SeekingVideo(20 * MB, "video/mp4", stream, () => {});
    const gone = new AbortController().signal;
    await collect(video.read(0, 1 * MB, gone));
    const reads = log.reads;
    await collect(video.read(100, 2 * MB, gone));
    expect(log.reads).toBe(reads);
  });

  it("takes turns on the one stream when two ranges are read at once", async () => {
    const { stream } = seekable(30 * MB);
    const video = new SeekingVideo(30 * MB, "video/mp4", stream, () => {});
    const gone = new AbortController().signal;
    const [a, b] = await Promise.all([collect(video.read(0, 6 * MB, gone)), collect(video.read(25 * MB, 30 * MB - 1, gone))]);
    expect(a.every((x, i) => x === (i & 0xff))).toBe(true);
    expect(b.every((x, i) => x === ((25 * MB + i) & 0xff))).toBe(true);
  });

  it("stops a read the player gave up, and lets the slot go once on close", async () => {
    const { stream, log } = seekable(20 * MB);
    let closed = 0;
    const video = new SeekingVideo(20 * MB, "video/mp4", stream, () => closed++);
    const stop = new AbortController();
    let got = 0;
    for await (const piece of video.read(0, 20 * MB - 1, stop.signal)) {
      got += piece.length;
      if (got > MB) stop.abort();
    }
    expect(got).toBeLessThan(20 * MB);
    video.close();
    video.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(1);
    // The slot goes back through the downloader's signal (onClose), not the stream's cancel.
    expect(log.cancels).toBe(0);
  });

  it("is broken and closed once a read fails, and opened afresh on the next ask", async () => {
    const { stream, fail } = seekable(20 * MB);
    fail(9 * MB);
    let closed = 0;
    const video = new SeekingVideo(20 * MB, "video/mp4", stream, () => closed++);
    const gone = new AbortController().signal;
    await expect(collect(video.read(9 * MB, 10 * MB, gone))).rejects.toThrow();
    expect(video.broken()).toBe(true);
    expect(closed).toBe(1);
    // A read of what it does not hold fails too: the server cuts the answer short and the
    // player asks again, which opens it afresh.
    await expect(collect(video.read(0, 100, gone))).rejects.toThrow();
    let loads = 0;
    const open = new OpenVideos(async () =>
      ++loads === 1 ? video : new SeekingVideo(20 * MB, "video/mp4", seekable(20 * MB).stream, () => {}),
    );
    await open.get("u");
    const again = await open.get("u");
    expect(loads).toBe(2);
    expect(again!.broken!()).toBe(false);
  });

  it("lets a reader the player gave up leave while it waits its turn", async () => {
    const { stream } = seekable(40 * MB);
    const video = new SeekingVideo(40 * MB, "video/mp4", stream, () => {});
    const first = collect(video.read(0, 8 * MB, new AbortController().signal));
    const leaving = new AbortController();
    const second = collect(video.read(30 * MB, 31 * MB, leaving.signal));
    leaving.abort();
    expect((await second).length).toBe(0);
    expect((await first).length).toBe(8 * MB + 1);
  });

  it("reads ahead of the player on its other lanes", async () => {
    const one = seekable(64 * MB);
    const video = new SeekingVideo(64 * MB, "video/mp4", one.stream, () => {});
    const two = seekable(64 * MB);
    const three = seekable(64 * MB);
    video.addLane(two.stream, () => {});
    video.addLane(three.stream, () => {});
    expect(video.laneCount()).toBe(3);
    const gone = new AbortController().signal;
    const first = await collect(video.read(0, 100, gone));
    expect(first.length).toBe(101);
    await vi.waitFor(() => expect(one.log.reads + two.log.reads + three.log.reads).toBeGreaterThanOrEqual(5));
    // The four blocks after the first were read before the player asked for them.
    const seeks = [...one.log.seeks, ...two.log.seeks, ...three.log.seeks].sort((a, b) => a - b);
    expect(seeks.slice(0, 5)).toEqual([0, 4 * MB, 8 * MB, 12 * MB, 16 * MB]);
    const later = await collect(video.read(16 * MB, 16 * MB + 10, gone));
    expect(later[0]).toBe((16 * MB) & 0xff);
    // Already read ahead: that block is not asked of Proton again.
    const at16 = [...one.log.seeks, ...two.log.seeks, ...three.log.seeks].filter((p) => p === 16 * MB);
    expect(at16.length).toBe(1);
    video.close();
  });

  it("lets a lane asked to leave finish its read first, and plays on without it", async () => {
    const one = seekable(64 * MB);
    const video = new SeekingVideo(64 * MB, "video/mp4", one.stream, () => {});
    let left = 0;
    const leave = video.addLane(seekable(64 * MB).stream, () => left++)!;
    const reading = collect(video.read(0, 9 * MB, new AbortController().signal));
    leave();
    const bytes = await reading;
    expect(bytes.length).toBe(9 * MB + 1);
    expect(bytes.every((b, i) => b === (i & 0xff))).toBe(true);
    await vi.waitFor(() => expect(left).toBe(1));
    expect(video.laneCount()).toBe(1);
    expect(video.broken()).toBe(false);
    video.close();
  });

  it("lets a lane go whose read ahead failed, and plays on", async () => {
    const one = seekable(64 * MB);
    const video = new SeekingVideo(64 * MB, "video/mp4", one.stream, () => {});
    const bad = seekable(64 * MB);
    bad.fail(0);
    for (let at = 0; at < 64 * MB; at += 4 * MB) bad.fail(at);
    let left = 0;
    // Every read on this lane fails.
    bad.stream.read = async () => {
      throw new Error("block failed");
    };
    video.addLane(bad.stream, () => left++);
    const bytes = await collect(video.read(0, 12 * MB, new AbortController().signal));
    expect(bytes.length).toBe(12 * MB + 1);
    expect(bytes.every((b, i) => b === (i & 0xff))).toBe(true);
    expect(video.broken()).toBe(false);
    await vi.waitFor(() => expect(left).toBe(1));
    video.close();
  });

  it("is broken, not spinning, when a read ahead fails on its only stream", async () => {
    const one = seekable(64 * MB);
    const video = new SeekingVideo(64 * MB, "video/mp4", one.stream, () => {});
    // The SDK's stream stays errored once a read has failed.
    let reads = 0;
    const read = one.stream.read;
    one.stream.read = async (n: number) => {
      if (++reads > 1) throw new Error("stream errored");
      return read(n);
    };
    const first = await collect(video.read(0, 100, new AbortController().signal));
    expect(first.length).toBe(101);
    await vi.waitFor(() => expect(video.broken()).toBe(true));
    expect(reads).toBeLessThan(10);
  });

  it("reads nothing for a place the player left while it waited, and serves the newest first", async () => {
    const { stream, log } = seekable(64 * MB);
    const video = new SeekingVideo(64 * MB, "video/mp4", stream, () => {});
    const first = collect(video.read(0, 100, new AbortController().signal));
    // Two places asked for while the one stream is busy; the player leaves the first.
    const left = new AbortController();
    const skipped = collect(video.read(40 * MB, 40 * MB + 10, left.signal));
    const wanted = collect(video.read(52 * MB, 52 * MB + 10, new AbortController().signal));
    left.abort();
    expect((await skipped).length).toBe(0);
    expect((await wanted)[0]).toBe((52 * MB) & 0xff);
    await first;
    expect(log.seeks).not.toContain(40 * MB);
    video.close();
  });

  it("serves a live ask whose block the asks before it gave up on", async () => {
    const { stream } = seekable(64 * MB);
    const video = new SeekingVideo(64 * MB, "video/mp4", stream, () => {});
    const busy = collect(video.read(0, 100, new AbortController().signal));
    const leaving = [new AbortController(), new AbortController(), new AbortController()];
    const gaveUp = leaving.map((c, i) => collect(video.read(40 * MB + i * 1000, 40 * MB + i * 1000 + 10, c.signal)));
    const live = collect(video.read(40 * MB + 5000, 40 * MB + 5010, new AbortController().signal));
    for (const c of leaving) {
      c.abort();
      await new Promise((r) => setTimeout(r, 2));
    }
    await Promise.all(gaveUp);
    const bytes = await live;
    expect(bytes.length).toBe(11);
    expect(bytes[0]).toBe((40 * MB + 5000) & 0xff);
    await busy;
    expect(video.broken()).toBe(false);
    video.close();
  });

  it("lets a lane added after it closed go at once", () => {
    const video = new SeekingVideo(20 * MB, "video/mp4", seekable(20 * MB).stream, () => {});
    video.close();
    let left = 0;
    expect(video.addLane(seekable(20 * MB).stream, () => left++)).toBeNull();
    expect(left).toBe(1);
  });

  it("is not used for a file with no block sizes on record, and its slot goes back", () => {
    let given = 0;
    const downloader = {
      getSeekableStream() {
        throw new Error("Revision does not have defined claimed block sizes");
      },
    };
    expect(
      seekVideo(downloader, 500 * MB, "video/mp4", { stop: new AbortController(), unused: () => given++, released: () => {} }),
    ).toBeNull();
    expect(given).toBe(1);
  });
});
