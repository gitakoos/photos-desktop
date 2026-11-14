/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

import { ProtonSession } from "./session.ts";
import { initStore, setDataKey } from "./store.ts";
import { beginRequest, endRequest, takeCancelLine } from "./requests.ts";

/** An SDK whose thumbnail read waits until its signal aborts, as a slow fetch would. */
function slowPhotos() {
  const seen: { aborted: boolean }[] = [];
  return {
    seen,
    async *iterateThumbnails(_uids: string[], _type: unknown, signal?: AbortSignal) {
      const mark = { aborted: false };
      seen.push(mark);
      await new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () => {
          mark.aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      yield { ok: true, thumbnail: new Uint8Array([1]) };
    },
  };
}

describe("a cancel from the host reaches the SDK", () => {
  beforeEach(() => {
    setDataKey(randomBytes(32));
    initStore(mkdtempSync(join(tmpdir(), "pfp-cancel-reach-")));
  });

  it("stops the HD preview's fetch the viewer let go of", async () => {
    const photos = slowPhotos();
    const session = new ProtonSession();
    (session as any).photos = photos;
    const ctx = beginRequest(11);
    const asking = session.getPreview("uid-A", ctx.signal);
    await vi.waitFor(() => expect(photos.seen.length).toBe(1));
    takeCancelLine({ cancel: 11 });
    await expect(asking).rejects.toThrow();
    expect(photos.seen[0].aborted).toBe(true);
    endRequest(11);
  });

  it("stops a thumbnail warm the window replaced", async () => {
    const photos = slowPhotos();
    const session = new ProtonSession();
    (session as any).photos = photos;
    const ctx = beginRequest(12);
    const warming = session.warmThumbnails(["uid-B"], ctx.signal);
    await vi.waitFor(() => expect(photos.seen.length).toBe(1));
    takeCancelLine({ cancel: 12 });
    await expect(warming).rejects.toThrow();
    expect(photos.seen[0].aborted).toBe(true);
    endRequest(12);
  });
});
