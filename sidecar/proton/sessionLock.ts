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

// The saved session's lock, kept beside it in the store folder.
//
// Proton swaps the refresh token on every use and refuses the previous one from then on
// (code 10013). Two processes that read the same saved token and both renew it leave one
// of them holding a refused token, and the next start of that one signs in again. The
// lock lets one process at a time read the saved session, renew it and save the result.
//
// The lock is a file created exclusively. Its holder writes who it is into it and touches
// it while it holds it, so a lock left by a process that died is taken over: at once when
// its process is known to be gone, otherwise once it has gone untouched for a while.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { diag } from "./diag.ts";

export const SESSION_LOCK_FILE = "session.lock";

/**
 * How long a process waits for another to finish with the session. A renewal is given a
 * minute before it is cut (api.ts), so this outlasts one that is only slow.
 */
export const LOCK_WAIT_MS = 75_000;
/** A lock untouched for this long belongs to a process that is gone or stuck. */
export const LOCK_STALE_MS = 60_000;
const LOCK_TOUCH_MS = 5_000;
const LOCK_POLL_MS = 100;

export type LockOptions = { waitMs?: number; staleMs?: number; touchMs?: number; pollMs?: number };

type Holder = { id: string; pid: number; host: string; ns: string };

/** The locks this process holds now, by id: one of ours not among them was left by a failed release. */
const heldHere = new Set<string>();

/** Whether this process holds the session lock now: a quit at such a moment may cut a renewal short. */
export function sessionLockHeld(): boolean {
  return heldHere.size > 0;
}

/**
 * The first 8 hex characters of a token's SHA-256, for the log: two lines naming the same
 * tag spent the same token, and nothing of the token can be read back from it.
 */
export function tokenTag(token: string | null | undefined): string {
  if (!token) return "none";
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * The pid namespace this process runs in. Each Flatpak start may get its own, and a pid
 * read in one means nothing in another, so a holder's pid is only checked from its own.
 */
function pidNamespace(): string {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process is there, only not ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Why the lock as seen is left over rather than held, or null while it is held. */
function staleReason(raw: string, mtimeMs: number, staleMs: number): string | null {
  if (Date.now() - mtimeMs > staleMs) return "age";
  let holder: Partial<Holder>;
  try {
    holder = JSON.parse(raw) as Partial<Holder>;
  } catch {
    // Being written this moment, or torn by a crash; the age above settles the second.
    return null;
  }
  if (typeof holder.pid !== "number" || holder.host !== hostname() || holder.ns !== pidNamespace()) return null;
  if (holder.pid === process.pid) return heldHere.has(String(holder.id)) ? null : "orphan";
  return isAlive(holder.pid) ? null : "dead";
}

/**
 * Moves a left-over lock out of the way. Renamed aside first, which only one process can
 * do: two that both found it stale must not delete each other's fresh lock in turn. When
 * what was moved is not what was judged stale, a new holder came in between, and its lock
 * is put back.
 */
function takeOver(path: string, raw: string): void {
  const aside = `${path}.stale-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // another waiter moved it first
  }
  try {
    if (readFileSync(aside, "utf8") !== raw) linkSync(aside, path);
  } catch {
    /* the place was taken again meanwhile, and that holder's lock stands */
  }
  rmSync(aside, { force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Takes the lock, or answers null when it cannot be had for a reason other than another holder. */
async function acquire(path: string, opts: LockOptions): Promise<(() => void) | null> {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const holder: Holder = { id: randomBytes(8).toString("hex"), pid: process.pid, host: hostname(), ns: pidNamespace() };
  const deadline = Date.now() + waitMs;
  let waited = false;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EPERM on Windows: the previous lock is being deleted this moment.
      if (code !== "EEXIST" && !(code === "EPERM" && process.platform === "win32")) {
        diag.log("session", "lock_unavailable", { code: code ?? "unknown" });
        return null;
      }
    }
    if (fd !== null) {
      try {
        writeSync(fd, JSON.stringify(holder));
      } catch (e) {
        closeSync(fd);
        rmSync(path, { force: true });
        diag.log("session", "lock_unavailable", { code: (e as NodeJS.ErrnoException).code ?? "unknown" });
        return null;
      }
      closeSync(fd);
      break;
    }
    try {
      const raw = readFileSync(path, "utf8");
      const reason = staleReason(raw, statSync(path).mtimeMs, staleMs);
      if (reason) {
        diag.log("session", "lock_taken_over", { pid: process.pid, reason });
        takeOver(path, raw);
        continue;
      }
    } catch (e) {
      // Released between the open and the read; anything else is waited out like a holder.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
    }
    if (!waited) {
      waited = true;
      diag.log("session", "lock_wait", { pid: process.pid });
    }
    if (Date.now() >= deadline) {
      diag.log("session", "lock_timeout", { pid: process.pid, waited_ms: waitMs });
      // Named so that `isTransient` reads it as a try worth repeating, not as a refused session.
      const err = new Error("the saved session is in use by another start of the app");
      err.name = "TimeoutError";
      throw err;
    }
    await sleep(opts.pollMs ?? LOCK_POLL_MS);
  }
  heldHere.add(holder.id);
  const touch = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      /* the next touch tries again */
    }
  }, opts.touchMs ?? LOCK_TOUCH_MS);
  touch.unref?.();
  return () => {
    clearInterval(touch);
    heldHere.delete(holder.id);
    try {
      // Only our own: a lock taken over from us belongs to its new holder now.
      if ((JSON.parse(readFileSync(path, "utf8")) as Partial<Holder>).id === holder.id) rmSync(path, { force: true });
    } catch {
      /* left behind, it is taken over as an orphan or a dead process's */
    }
  };
}

/**
 * Runs `work` holding the session lock of the store folder `dir`, and lets it go however
 * `work` ends. Throws a transient `TimeoutError` when another process keeps it past the
 * wait. A lock that cannot be made at all (a read-only folder) is no reason to sign
 * anyone out: `work` then runs without it, as it did before the lock existed.
 */
export async function withSessionLock<T>(dir: string, work: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const release = await acquire(join(dir, SESSION_LOCK_FILE), opts);
  try {
    return await work();
  } finally {
    release?.();
  }
}
