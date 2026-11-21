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

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { SESSION_LOCK_FILE, tokenTag, withSessionLock } from "./sessionLock.ts";
import { isTransient } from "./transient.ts";

const folder = () => mkdtempSync(join(tmpdir(), "pfp-lock-test-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ns(): string {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
}

/** A lock as another holder would have left it. */
function foreignLock(dir: string, holder: { pid: number; host?: string; ns?: string; id?: string }, ageMs = 0): string {
  const path = join(dir, SESSION_LOCK_FILE);
  writeFileSync(path, JSON.stringify({ id: holder.id ?? "foreign", pid: holder.pid, host: holder.host ?? hostname(), ns: holder.ns ?? ns() }));
  if (ageMs) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(path, then, then);
  }
  return path;
}

/** The pid of a process that has ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

describe("the session lock", () => {
  it("is held while the work runs and gone after it, also when the work throws", async () => {
    const dir = folder();
    const path = join(dir, SESSION_LOCK_FILE);
    expect(await withSessionLock(dir, async () => existsSync(path))).toBe(true);
    expect(existsSync(path)).toBe(false);
    await expect(withSessionLock(dir, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(existsSync(path)).toBe(false);
  });

  it("lets one holder in at a time", async () => {
    const dir = folder();
    const order: string[] = [];
    const run = (name: string) =>
      withSessionLock(dir, async () => {
        order.push(`${name} in`);
        await sleep(50);
        order.push(`${name} out`);
      }, { pollMs: 10 });
    await Promise.all([run("a"), run("b")]);
    expect(order).toEqual(["a in", "a out", "b in", "b out"]);
  });

  it("takes over a lock whose process has ended", async () => {
    const dir = folder();
    foreignLock(dir, { pid: deadPid() });
    expect(await withSessionLock(dir, async () => "ran", { waitMs: 1_000 })).toBe("ran");
    expect(existsSync(join(dir, SESSION_LOCK_FILE))).toBe(false);
  });

  it("takes over a lock nobody has touched for too long, though its pid is alive", async () => {
    const dir = folder();
    foreignLock(dir, { pid: process.ppid }, 120_000);
    expect(await withSessionLock(dir, async () => "ran", { waitMs: 1_000 })).toBe("ran");
  });

  it("takes over a lock of this process that no holder here owns any more", async () => {
    const dir = folder();
    foreignLock(dir, { pid: process.pid, id: "released-badly" });
    expect(await withSessionLock(dir, async () => "ran", { waitMs: 1_000 })).toBe("ran");
  });

  it("waits out a live holder for a bounded time, then gives up with a transient error", async () => {
    const dir = folder();
    const path = foreignLock(dir, { pid: process.ppid });
    let ran = false;
    const started = Date.now();
    const err = await withSessionLock(dir, async () => {
      ran = true;
    }, { waitMs: 300, pollMs: 20 }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(isTransient(err)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(ran).toBe(false);
    // The holder's lock is left as it was.
    expect(JSON.parse(readFileSync(path, "utf8")).id).toBe("foreign");
  });

  it("never judges a pid from another pid namespace or another machine", async () => {
    const dir = folder();
    foreignLock(dir, { pid: deadPid(), ns: "pid:[elsewhere]" });
    await expect(withSessionLock(dir, async () => "ran", { waitMs: 200, pollMs: 20 })).rejects.toThrow();
    foreignLock(dir, { pid: deadPid(), host: "another-machine" });
    await expect(withSessionLock(dir, async () => "ran", { waitMs: 200, pollMs: 20 })).rejects.toThrow();
  });

  it("keeps a held lock fresh, so a long renewal is not taken for a dead one", async () => {
    const dir = folder();
    const path = join(dir, SESSION_LOCK_FILE);
    await withSessionLock(dir, async () => {
      const then = new Date(Date.now() - 30_000);
      utimesSync(path, then, then);
      await sleep(120);
      expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(10_000);
    }, { touchMs: 20 });
  });

  it("runs the work without the lock when the lock cannot be made at all", async () => {
    const dir = join(folder(), "missing");
    expect(await withSessionLock(dir, async () => "ran")).toBe("ran");
  });
});

describe("tokenTag", () => {
  it("names a token by 8 hex characters of its hash and nothing of the token", () => {
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    const tag = tokenTag(token);
    expect(tag).toMatch(/^[0-9a-f]{8}$/);
    expect(token).not.toContain(tag);
    expect(tokenTag(token)).toBe(tag);
    expect(tokenTag("another")).not.toBe(tag);
    expect(tokenTag("")).toBe("none");
    expect(tokenTag(undefined)).toBe("none");
  });
});
