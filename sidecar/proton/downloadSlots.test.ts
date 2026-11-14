/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { lendSlot, openDownloader, slotsInUse } from "./downloadSlots.ts";
import { getOriginal, getVideo, releaseOriginal } from "./download.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A photos client with the SDK's download slots as the SDK has them: five, taken when a
 * downloader is made (waiting, until its signal fires, while all are taken), and given back
 * only in the `finally` of a download of it, which fails at once if its signal has fired.
 */
function slotClient(opts: { claimed?: number; bytes?: number; setupMs?: number; mediaType?: string } = {}) {
  const { claimed = 64, bytes = 64, setupMs = 0, mediaType = "image/jpeg" } = opts;
  const slots = { inUse: 0 };
  return {
    slots,
    getNode: async (uid: string) => ({ uid, name: { ok: true, value: `${uid}.jpg` }, mediaType }),
    async getFileDownloader(_uid: string, signal?: AbortSignal) {
      while (slots.inUse >= 5) {
        if (signal?.aborted) throw new Error("AbortError");
        await sleep(2);
      }
      slots.inUse++;
      await sleep(setupMs);
      return {
        getClaimedSizeInBytes: () => claimed,
        downloadToStream(stream: WritableStream<Uint8Array>) {
          const completion = (async () => {
            try {
              if (signal?.aborted) throw new Error("AbortError");
              const writer = stream.getWriter();
              await writer.write(new Uint8Array(bytes).fill(7));
              await writer.close();
            } finally {
              slots.inUse--;
            }
          })();
          return { completion: () => completion };
        },
      };
    },
  };
}

describe("a downloader that is not used", () => {
  it("gives its slot back", async () => {
    const client = slotClient();
    const { unused } = await openDownloader(client, "u");
    expect(client.slots.inUse).toBe(1);
    unused();
    unused(); // a second call gives nothing back twice
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0));
  });

  it("is counted while it holds its slot, and not after", async () => {
    const client = slotClient();
    const before = slotsInUse().count;
    const used = await openDownloader(client, "a");
    const left = await openDownloader(client, "b");
    expect(slotsInUse().count).toBe(before + 2);
    await used.downloader.downloadToStream(new WritableStream()).completion();
    left.unused();
    await vi.waitFor(() => expect(slotsInUse().count).toBe(before));
  });

  it("waits for a free slot only so long, then fails rather than hangs", async () => {
    const client = slotClient();
    for (let i = 0; i < 5; i++) await openDownloader(client, `held${i}`);
    await expect(openDownloader(client, "late", 30)).rejects.toThrow();
  });
});

describe("the paths that made a downloader and then did not download", () => {
  beforeEach(() => releaseOriginal());

  it("the viewer stepping on while a photo's original was being set up", async () => {
    const client = slotClient({ setupMs: 20 });
    // Twenty photos stepped through faster than each downloader is made.
    for (let i = 0; i < 20; i++) {
      await getOriginal(client, `p${i}`);
      await sleep(1);
      releaseOriginal(`p${i}`);
    }
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0), { timeout: 3000 });
    // And the next download still gets a slot.
    const { unused } = await openDownloader(client, "next", 100);
    unused();
  });

  it("a video over the size cap", async () => {
    const client = slotClient({ claimed: 500 * 1024 * 1024, mediaType: "video/mp4" });
    for (let i = 0; i < 8; i++) await expect(getVideo(client, `v${i}`)).rejects.toThrow("VIDEO_TOO_LARGE");
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0));
  });
});

describe("a downloader made just as its wait ran out", () => {
  it("gives its slot back and is not handed out", async () => {
    const client = slotClient({ setupMs: 40 });
    await expect(openDownloader(client, "slow", 10)).rejects.toThrow();
    await vi.waitFor(() => expect(client.slots.inUse).toBe(0));
  });
});

describe("a slot lent to a video's read lane", () => {
  it("comes back when another download finds every slot taken, but not for another lane", async () => {
    const client = slotClient();
    for (let i = 0; i < 5; i++) await openDownloader(client, `full${i}`);
    let given = 0;
    const unlend = lendSlot(() => given++);
    // Another lane does not take it.
    await expect(openDownloader(slotClient(), "lane", 30, { borrow: true })).resolves.toBeTruthy();
    expect(given).toBe(0);
    // Anything else does.
    await openDownloader(slotClient(), "save", 30);
    expect(given).toBe(1);
    unlend();
  });
});
