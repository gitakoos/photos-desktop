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

// The photos the face and search scan could not read, kept by the phone's rule. A failure that is
// evidence about the photo itself is skipped at once; any other is tried again on a ladder of waits,
// each try counted, and the photo is given up on after a fixed number of them. A failure for want of
// a connection is never counted. A skipped photo is tried again once its file changes, and one given
// up on also after a week. Each record keeps its cause, named as the phone names it, for the
// diagnostics, and the book outlives a restart.

import { join } from "node:path";

import { isStall } from "./stallGuard.ts";
import { SCAN_MISSES_FILE, readSealedOrSetAside, storeDir, writeSealedAtomic } from "./store.ts";

/**
 * Why a photo gave the scan nothing to read: its cause, "tag" or "tag:detail" with the phone's tags,
 * and whether it is evidence about the photo itself (`permanent`) or worth another try.
 */
export type ScanMiss = { kind: "transient" | "permanent"; cause: string };

/** The causes that are evidence about the photo itself, skipped at once. */
const PERMANENT_TAGS = new Set(["unavailable", "notFound", "undecodable", "empty", "unreadable", "hang", "gaveUp"]);
/** The cause that says nothing about the photo: no connection at all. Never counted as a try. */
const OFFLINE = "offline";

/** The waits after a photo's first, second, ... counted failure: 5, 15 and 30 minutes, 1 and 2 hours, then 4 hours. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 4 * 3_600_000];
/** How many counted tries a photo may fail before it is given up on: about twelve hours on the ladder. */
export const FAILURE_ATTEMPTS = 8;
/** How long a photo given up on stays skipped before it is tried afresh. */
export const GAVE_UP_RECHECK_MS = 7 * 24 * 3_600_000;
/** Records kept at most, so a damaged file or a huge library cannot inflate the book. */
const MAX_WAITING = 50_000;
const MAX_SKIPPED = 20_000;

const tagOf = (cause: string) => cause.split(":", 1)[0];

/** A miss under `cause`, permanent or not as its tag says. */
export function missFor(cause: string): ScanMiss {
  return { kind: PERMANENT_TAGS.has(tagOf(cause)) ? "permanent" : "transient", cause };
}

/** A word from an error, kept only when it is a plain name: never a message, path or uid. */
function plainName(value: unknown): string | null {
  const text = String(value ?? "");
  return /^[A-Za-z][A-Za-z0-9_]{1,39}$/.test(text) ? text : null;
}

/** A failure the drive SDK hands over as text: a connection or a busy server. */
const NETWORK_TEXT =
  /fetch failed|socket hang up|network|timed? ?out|ECONN[A-Z]+|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|too many requests|rate limit|service unavailable|bad gateway/i;
/** The drive SDK's text for a photo with no preview of the size asked for: its metadata names none. */
const NO_PREVIEW_TEXT = /no image preview|preview not found/i;
/** The drive SDK's text for a photo the server no longer has. */
const GONE_TEXT = /item not found/i;

/** Node's codes for a name that would not resolve or no route out: this computer has no connection. */
const OFFLINE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
]);
/** Proton's body code for "the item asked for does not exist". */
const NOT_EXISTS_CODE = 2501;

/**
 * The cause of one failed read, with the phone's tags: the server's word that the photo is gone
 * (notFound), a busy server (server), a timeout or a stall (timeout), the connection (network), no
 * connection at all (offline), a refused session (auth), the crypto (crypto), else other with the
 * error's class. A preview read fails with the SDK's text rather than an error, sorted by what it says.
 */
export function failureOf(e: unknown): ScanMiss {
  if (typeof e === "string") {
    if (NETWORK_TEXT.test(e)) return missFor("network");
    if (NO_PREVIEW_TEXT.test(e)) return missFor("metadata");
    return missFor(GONE_TEXT.test(e) ? "notFound" : "other:sdk");
  }
  if (isStall(e)) return missFor("timeout");
  const err = (e && typeof e === "object" ? e : {}) as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    cause?: { code?: unknown };
    message?: unknown;
  };
  const name = plainName(err.name);
  if (name === "AbortError") return missFor(OFFLINE);
  const code = String(err.cause?.code ?? err.code ?? "");
  if (OFFLINE_CODES.has(code)) return missFor(OFFLINE);
  if (Number(err.code) === NOT_EXISTS_CODE) return missFor("notFound");
  const status = Number(err.statusCode ?? err.status ?? 0);
  if (Number.isInteger(status) && status >= 100 && status < 600) {
    if (status === 404 || status === 410) return missFor("notFound");
    if (status === 429 || status >= 500) return missFor("server");
    if (status === 401 || status === 403) return missFor("auth");
    if (status === 408) return missFor("timeout");
    return missFor(`other:http${status}`);
  }
  if (name === "TimeoutError" || TIMEOUT_CODES.has(code)) return missFor("timeout");
  if (name === "RateLimitedError") return missFor("server");
  if (name === "ConnectionError" || NETWORK_CODES.has(code)) return missFor("network");
  if (typeof err.message === "string" && /fetch failed|socket hang up|network error/i.test(err.message)) return missFor("network");
  const message = typeof err.message === "string" ? err.message : "";
  if (name === "DecryptionError" || name === "IntegrityError" || /crypto|pgp|signature|decrypt/i.test(`${name ?? ""} ${message}`)) {
    return missFor("crypto");
  }
  return missFor(`other:${name && name !== "Error" ? name : "unnamed"}`);
}

/** The causes of a failure on the way to the photo rather than of the photo: another size will fail alike. */
const CONNECTION_TAGS = new Set(["network", "server", "timeout", OFFLINE]);
export const onTheWay = (miss: ScanMiss) => CONNECTION_TAGS.has(tagOf(miss.cause));

type Waiting = { attempts: number; due: number; cause: string };
type Skipped = { cause: string; stamp: string; at: number };

/** How many photos wait or were skipped, by cause. */
export type MissSummary = {
  waiting: number;
  skipped: number;
  waitingBy: Record<string, number>;
  skippedBy: Record<string, number>;
};

/**
 * The book of the photos the scan could not read. A photo with no record is read as usual; one
 * waiting is left out of a pass until it is due; one skipped is settled and asked for again only once
 * `release` lets it go. Only a read drops a record: one of a photo missing from a library read is
 * kept, so a read that came back short does not begin its photos' counts again. Times are on the
 * wall clock, so a restart keeps the waits; a wait read back is never longer than the ladder's last
 * step, so a clock set back cannot park a photo for good.
 */
export class ScanMissBook {
  private waiting = new Map<string, Waiting>();
  private skipped = new Map<string, Skipped>();
  private loaded = false;
  private dirty = false;

  constructor(private readonly path: () => string = () => join(storeDir(), SCAN_MISSES_FILE)) {}

  isLoaded(): boolean {
    return this.loaded;
  }

  /** Reads the book from disk once; one that cannot be read starts empty. Throws while the store is locked. */
  load(now = Date.now()): void {
    if (this.loaded) return;
    this.waiting.clear();
    this.skipped.clear();
    const blob = readSealedOrSetAside(this.path());
    if (blob) {
      try {
        this.take(JSON.parse(blob.toString("utf8")), now);
      } catch {
        this.waiting.clear();
        this.skipped.clear();
      }
    }
    this.loaded = true;
  }

  private take(saved: { waiting?: unknown[]; skipped?: unknown[] }, now: number): void {
    const longest = RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
    for (const row of (saved.waiting ?? []).slice(0, MAX_WAITING)) {
      if (!Array.isArray(row)) continue;
      const [uid, attempts, due, cause] = row;
      if (typeof uid !== "string" || typeof cause !== "string") continue;
      const left = Math.min(Math.max(Number(due) - now, 0), longest) || 0;
      const count = Math.min(Math.max(Math.floor(Number(attempts)) || 0, 0), FAILURE_ATTEMPTS);
      this.waiting.set(uid, { attempts: count, due: now + left, cause });
    }
    for (const row of (saved.skipped ?? []).slice(-MAX_SKIPPED)) {
      if (!Array.isArray(row)) continue;
      const [uid, cause, stamp, at] = row;
      if (typeof uid !== "string" || typeof cause !== "string") continue;
      this.skipped.set(uid, { cause, stamp: typeof stamp === "string" ? stamp : "", at: Number(at) || now });
    }
  }

  /** Writes the book when it changed. Throws what the write threw; it stays marked to write again. */
  flush(): void {
    if (!this.loaded || !this.dirty) return;
    const waiting = [...this.waiting].slice(0, MAX_WAITING).map(([uid, w]) => [uid, w.attempts, w.due, w.cause]);
    const skipped = [...this.skipped].slice(-MAX_SKIPPED).map(([uid, s]) => [uid, s.cause, s.stamp, s.at]);
    writeSealedAtomic(this.path(), Buffer.from(JSON.stringify({ waiting, skipped })));
    this.dirty = false;
  }

  /** Lets go of what is held, for a sign-out or a lock; nothing is written. */
  unload(): void {
    this.waiting.clear();
    this.skipped.clear();
    this.loaded = false;
    this.dirty = false;
  }

  /** Forgets every record, for a scan that starts over. */
  clear(): void {
    if (this.waiting.size === 0 && this.skipped.size === 0) return;
    this.waiting.clear();
    this.skipped.clear();
    this.dirty = true;
  }

  /** Whether the photo may be asked for in a pass now: it has no wait, or its wait is over. */
  isDue(uid: string, now = Date.now()): boolean {
    const w = this.waiting.get(uid);
    return !w || w.due <= now;
  }

  /** How many counted tries in a row the photo has failed. */
  attempts(uid: string): number {
    return this.waiting.get(uid)?.attempts ?? 0;
  }

  /** The cause a photo was skipped for, or null when it was not. */
  skippedFor(uid: string): string | null {
    return this.skipped.get(uid)?.cause ?? null;
  }

  /**
   * Files a miss. A permanent one is skipped at once. A counted one waits one ladder step longer
   * than the last, and the `FAILURE_ATTEMPTS`th is given up on (gaveUp, naming the last cause); one
   * for want of a connection keeps the count and waits the first step. Answers "skip" when the photo
   * is to be settled now, else "wait".
   */
  miss(uid: string, miss: ScanMiss, now = Date.now()): "skip" | "wait" {
    this.dirty = true;
    if (miss.kind === "permanent") return this.skip(uid, miss.cause, now);
    const prior = this.waiting.get(uid)?.attempts ?? 0;
    if (miss.cause === OFFLINE) {
      this.waiting.set(uid, { attempts: prior, due: now + RETRY_BACKOFF_MS[0], cause: miss.cause });
      return "wait";
    }
    const attempts = prior + 1;
    if (attempts >= FAILURE_ATTEMPTS) return this.skip(uid, `gaveUp:${miss.cause}`, now);
    const step = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1];
    this.waiting.set(uid, { attempts, due: now + step, cause: miss.cause });
    return "wait";
  }

  private skip(uid: string, cause: string, now: number): "skip" {
    this.waiting.delete(uid);
    this.skipped.delete(uid);
    this.skipped.set(uid, { cause, stamp: "", at: now });
    while (this.skipped.size > MAX_SKIPPED) this.skipped.delete(this.skipped.keys().next().value!);
    return "skip";
  }

  /** The photo was read: whatever stood against it goes. */
  read(uid: string): void {
    if (this.waiting.delete(uid) || this.skipped.delete(uid)) this.dirty = true;
  }

  /** Follows a photo to the uid of the copy that replaced it. */
  move(oldUid: string, newUid: string): void {
    const w = this.waiting.get(oldUid);
    const s = this.skipped.get(oldUid);
    if (!w && !s) return;
    this.waiting.delete(oldUid);
    this.skipped.delete(oldUid);
    if (w) this.waiting.set(newUid, w);
    if (s) this.skipped.set(newUid, { ...s, stamp: "" });
    this.dirty = true;
  }

  /** Drops the waits of photos that need no read any more (scanned elsewhere, or read meanwhile). */
  settled(uids: Iterable<string>): void {
    for (const uid of uids) if (this.waiting.delete(uid)) this.dirty = true;
  }

  /** The skipped photos among `uids`. */
  skippedAmong(uids: Iterable<string>): string[] {
    const out: string[] = [];
    for (const uid of uids) if (this.skipped.has(uid)) out.push(uid);
    return out;
  }

  /** Gives the skipped photos with no stamp yet the one their file has now (`stamps`, by uid). */
  stamp(stamps: Map<string, string>): void {
    for (const [uid, stamp] of stamps) {
      const s = this.skipped.get(uid);
      if (!s || s.stamp !== "" || !stamp) continue;
      s.stamp = stamp;
      this.dirty = true;
    }
  }

  /**
   * Takes out and answers the skipped photos due another try at `now`: their file's stamp now
   * (`stamps`, the photo's revision) differs from the one they were skipped with, or they were given
   * up on at least `GAVE_UP_RECHECK_MS` ago. A skipped photo with no stamp yet takes the one given.
   */
  release(stamps: Map<string, string>, now = Date.now()): string[] {
    const released: string[] = [];
    for (const [uid, s] of this.skipped) {
      const stamp = stamps.get(uid) ?? "";
      const changed = s.stamp !== "" && stamp !== "" && stamp !== s.stamp;
      const recheck = tagOf(s.cause) === "gaveUp" && now - s.at >= GAVE_UP_RECHECK_MS;
      if (changed || recheck) released.push(uid);
    }
    for (const uid of released) this.skipped.delete(uid);
    if (released.length) this.dirty = true;
    this.stamp(stamps);
    return released;
  }

  /** When the earliest wait still running at `now` ends, or null when none does. */
  nextDue(now = Date.now()): number | null {
    let earliest: number | null = null;
    for (const w of this.waiting.values()) if (w.due > now && (earliest === null || w.due < earliest)) earliest = w.due;
    return earliest;
  }

  /**
   * The skips and the waits by cause, counted among the photos in `listed`, the library as last
   * read, when given: a record of a photo missing from one read is kept, not shown.
   */
  summary(listed?: Set<string>): MissSummary {
    const waitingBy: Record<string, number> = {};
    const skippedBy: Record<string, number> = {};
    let waiting = 0;
    let skipped = 0;
    for (const [uid, w] of this.waiting) {
      if (listed && !listed.has(uid)) continue;
      waiting++;
      waitingBy[w.cause] = (waitingBy[w.cause] ?? 0) + 1;
    }
    for (const [uid, s] of this.skipped) {
      if (listed && !listed.has(uid)) continue;
      skipped++;
      skippedBy[s.cause] = (skippedBy[s.cause] ?? 0) + 1;
    }
    return { waiting, skipped, waitingBy, skippedBy };
  }
}
