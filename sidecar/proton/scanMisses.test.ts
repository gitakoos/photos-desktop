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

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ScanMissBook, failureOf, missFor } from "./scanMisses.ts";
import { StallError } from "./stallGuard.ts";
import { initStore, setDataKey } from "./store.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const timeout = missFor("timeout");

function loaded(): ScanMissBook {
  const book = new ScanMissBook();
  book.load(0);
  return book;
}

/** Files `count` counted failures in a row, each once the wait before it is over; answers the last. */
function failRepeatedly(book: ScanMissBook, uid: string, count: number): "skip" | "wait" {
  let answer: "skip" | "wait" = "wait";
  let now = 0;
  for (let i = 0; i < count; i++) {
    answer = book.miss(uid, timeout, now);
    now += 5 * HOUR;
  }
  return answer;
}

describe("the record of photos the scan could not read", () => {
  beforeEach(() => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-misses-")));
    setDataKey(randomBytes(32));
  });

  it("holds a photo that failed for now back for five minutes", () => {
    const book = loaded();
    expect(book.miss("vol~a", timeout, 0)).toBe("wait");
    expect(book.isDue("vol~a", 5 * MIN - 1)).toBe(false);
    expect(book.isDue("vol~a", 5 * MIN)).toBe(true);
  });

  it("waits fifteen minutes after the second failure, thirty after the third", () => {
    const book = loaded();
    book.miss("vol~a", timeout, 0);
    book.miss("vol~a", timeout, 10 * MIN);
    expect(book.nextDue(10 * MIN)).toBe(25 * MIN);
    book.miss("vol~a", timeout, HOUR);
    expect(book.nextDue(HOUR)).toBe(90 * MIN);
  });

  it("waits four hours after the sixth failure and every later one", () => {
    const book = loaded();
    failRepeatedly(book, "vol~a", 7);
    expect(book.attempts("vol~a")).toBe(7);
    expect(book.nextDue(30 * HOUR)).toBe(34 * HOUR);
  });

  it("gives a photo up on its eighth counted failure, naming the last cause", () => {
    const book = loaded();
    expect(failRepeatedly(book, "vol~a", 7)).toBe("wait");
    expect(book.miss("vol~a", missFor("server"), 40 * HOUR)).toBe("skip");
    expect(book.skippedFor("vol~a")).toBe("gaveUp:server");
    expect(book.isDue("vol~a", 40 * HOUR)).toBe(true);
    expect(book.summary()).toEqual({ waiting: 0, skipped: 1, waitingBy: {}, skippedBy: { "gaveUp:server": 1 } });
  });

  it("never counts a failure for want of a connection, and tries again after five minutes", () => {
    const book = loaded();
    book.miss("vol~a", timeout, 0);
    expect(book.miss("vol~a", missFor("offline"), HOUR)).toBe("wait");
    expect(book.attempts("vol~a")).toBe(1);
    expect(book.nextDue(HOUR)).toBe(HOUR + 5 * MIN);
    expect(book.summary().waitingBy).toEqual({ offline: 1 });
  });

  it("skips a photo that will never read at once, with its cause", () => {
    const book = loaded();
    expect(book.miss("vol~a", missFor("undecodable"), 0)).toBe("skip");
    expect(book.miss("vol~b", missFor("unreadable:tooLarge"), 0)).toBe("skip");
    expect(book.summary().skippedBy).toEqual({ undecodable: 1, "unreadable:tooLarge": 1 });
  });

  it("tries a photo whose preview is missing from its metadata again", () => {
    const book = loaded();
    expect(book.miss("vol~a", missFor("metadata"), 0)).toBe("wait");
  });

  it("forgets the failures of a photo once it reads", () => {
    const book = loaded();
    book.miss("vol~a", timeout, 0);
    book.miss("vol~b", missFor("empty"), 0);
    book.read("vol~a");
    book.read("vol~b");
    expect(book.summary()).toEqual({ waiting: 0, skipped: 0, waitingBy: {}, skippedBy: {} });
    expect(book.isDue("vol~a", 0)).toBe(true);
  });

  it("keeps the count, the wait and the skips across a restart", () => {
    const book = loaded();
    book.miss("vol~a", timeout, 0);
    book.miss("vol~a", timeout, 10 * MIN);
    book.miss("vol~b", missFor("undecodable"), 0);
    book.flush();
    const again = new ScanMissBook();
    again.load(20 * MIN);
    expect(again.attempts("vol~a")).toBe(2);
    expect(again.nextDue(20 * MIN)).toBe(25 * MIN);
    expect(again.skippedFor("vol~b")).toBe("undecodable");
  });

  it("never waits past four hours after a restart, whatever the clock said", () => {
    const book = loaded();
    book.miss("vol~a", timeout, 30 * DAY);
    book.flush();
    const again = new ScanMissBook();
    again.load(0);
    expect(again.nextDue(0)).toBe(4 * HOUR);
  });

  it("lets a skipped photo go once its file changes", () => {
    const book = loaded();
    book.miss("vol~a", missFor("undecodable"), 0);
    expect(book.release(new Map([["vol~a", "rev1"]]), HOUR)).toEqual([]);
    expect(book.release(new Map([["vol~a", "rev1"]]), 2 * HOUR)).toEqual([]);
    expect(book.release(new Map([["vol~a", "rev2"]]), 3 * HOUR)).toEqual(["vol~a"]);
    expect(book.skippedFor("vol~a")).toBeNull();
  });

  it("keeps a skipped photo whose file could not be compared", () => {
    const book = loaded();
    book.miss("vol~a", missFor("undecodable"), 0);
    book.stamp(new Map([["vol~a", "rev1"]]));
    expect(book.release(new Map(), 30 * DAY)).toEqual([]);
  });

  it("lets a photo given up on go after a week, and one skipped as unreadable never by time alone", () => {
    const book = loaded();
    failRepeatedly(book, "vol~a", 8);
    book.miss("vol~b", missFor("undecodable"), 0);
    expect(book.release(new Map(), 7 * DAY)).toEqual([]);
    expect(book.release(new Map(), 7 * DAY + 35 * HOUR)).toEqual(["vol~a"]);
  });

  it("keeps a skipped photo's stamp across a restart", () => {
    const book = loaded();
    book.miss("vol~a", missFor("undecodable"), 0);
    book.stamp(new Map([["vol~a", "rev1"]]));
    book.flush();
    const again = new ScanMissBook();
    again.load(0);
    expect(again.release(new Map([["vol~a", "rev2"]]), HOUR)).toEqual(["vol~a"]);
  });

  it("follows an edited photo to its new copy", () => {
    const book = loaded();
    book.miss("vol~old", missFor("undecodable"), 0);
    book.move("vol~old", "vol~new");
    expect(book.skippedFor("vol~old")).toBeNull();
    expect(book.skippedFor("vol~new")).toBe("undecodable");
  });

  it("drops the wait of a photo read elsewhere, and keeps its skips", () => {
    const book = loaded();
    book.miss("vol~a", timeout, 0);
    book.miss("vol~b", missFor("undecodable"), 0);
    book.settled(["vol~a", "vol~b"]);
    expect(book.summary()).toEqual({ waiting: 0, skipped: 1, waitingBy: {}, skippedBy: { undecodable: 1 } });
  });

  it("keeps the records of photos missing from one library read, and shows only the listed ones", () => {
    const book = loaded();
    book.miss("vol~a", timeout, 0);
    book.miss("vol~b", timeout, 0);
    book.miss("vol~c", missFor("undecodable"), 0);
    expect(book.summary(new Set(["vol~a"]))).toEqual({ waiting: 1, skipped: 0, waitingBy: { timeout: 1 }, skippedBy: {} });
    expect(book.attempts("vol~b")).toBe(1);
    expect(book.skippedFor("vol~c")).toBe("undecodable");
  });

  it("starts over empty", () => {
    const book = loaded();
    book.miss("vol~a", timeout, 0);
    book.clear();
    book.flush();
    const again = new ScanMissBook();
    again.load(0);
    expect(again.attempts("vol~a")).toBe(0);
  });
});

describe("the cause a failed read is filed under", () => {
  const http = (status: number) => Object.assign(new Error("refused"), { status });
  const coded = (code: string) => Object.assign(new Error("connect"), { code });
  const named = (name: string, message = "x") => Object.assign(new Error(message), { name });

  it("takes the server's word that the photo is gone as final", () => {
    expect(failureOf(http(404))).toEqual({ kind: "permanent", cause: "notFound" });
    expect(failureOf(Object.assign(named("ValidationError"), { code: 2501 }))).toEqual({ kind: "permanent", cause: "notFound" });
  });

  it("tries a busy server again", () => {
    expect(failureOf(http(503))).toEqual({ kind: "transient", cause: "server" });
    expect(failureOf(http(429))).toEqual({ kind: "transient", cause: "server" });
  });

  it("tries a refused session again", () => {
    expect(failureOf(http(403))).toEqual({ kind: "transient", cause: "auth" });
  });

  it("names any other status", () => {
    expect(failureOf(http(422))).toEqual({ kind: "transient", cause: "other:http422" });
  });

  it("files a stall and a timeout as a timeout", () => {
    expect(failureOf(new StallError("iterateThumbnails", 1000))).toEqual({ kind: "transient", cause: "timeout" });
    expect(failureOf(coded("ETIMEDOUT"))).toEqual({ kind: "transient", cause: "timeout" });
  });

  it("files a dropped connection as network, and no connection at all as offline", () => {
    expect(failureOf(coded("ECONNRESET"))).toEqual({ kind: "transient", cause: "network" });
    expect(failureOf(coded("ENOTFOUND"))).toEqual({ kind: "transient", cause: "offline" });
    expect(failureOf(coded("ENETUNREACH"))).toEqual({ kind: "transient", cause: "offline" });
  });

  it("files a failed decrypt as crypto", () => {
    expect(failureOf(named("DecryptionError"))).toEqual({ kind: "transient", cause: "crypto" });
    expect(failureOf(new Error("Signature verification failed"))).toEqual({ kind: "transient", cause: "crypto" });
  });

  it("names the error's class, never its message", () => {
    expect(failureOf(named("WeirdError", "photo IMG_0001.jpg of someone@example.com"))).toEqual({
      kind: "transient",
      cause: "other:WeirdError",
    });
    expect(failureOf(new Error("IMG_0001.jpg"))).toEqual({ kind: "transient", cause: "other:unnamed" });
  });

  it("sorts the SDK's text for a preview read by what it says", () => {
    expect(failureOf("fetch failed")).toEqual({ kind: "transient", cause: "network" });
    expect(failureOf("This item has no image preview")).toEqual({ kind: "transient", cause: "metadata" });
    expect(failureOf("Item not found")).toEqual({ kind: "permanent", cause: "notFound" });
  });

  it("never files other text under what it says", () => {
    expect(failureOf("IMG_0001.jpg could not be decrypted")).toEqual({ kind: "transient", cause: "other:sdk" });
  });
});
