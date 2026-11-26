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

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OFFLINE_LIST_FILE,
  OriginalSealer,
  SESSION_FILE,
  clearDataKey,
  coverGet,
  coverPut,
  decryptOriginalTo,
  setDataKey,
  seal,
  unseal,
  initStore,
  metaGet,
  metaPut,
  originalDelete,
  originalDeleteAll,
  originalGet,
  originalHas,
  originalSize,
  originalUsage,
  readSealedOrSetAside,
  thumbGet,
  thumbPut,
  wipeCache,
  writeSealedAtomic,
  HIDDEN_FILE,
  SET_ASIDE_PREFIX,
  StoreLockedError,
  setAsideVault,
} from "./store.ts";

/** The first bytes of a real JPEG, for proving a blob on disk is not one. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

/** Write one original through the streaming sealer, as a pin does. */
async function storeOriginal(uid: string, plain: Buffer): Promise<void> {
  const sealer = new OriginalSealer(uid);
  // In chunks, so the streaming path is the one under test rather than a single write.
  for (let at = 0; at < plain.length; at += 1000) {
    await sealer.write(plain.subarray(at, at + 1000));
  }
  await sealer.finish();
}

// seal/unseal only need the AES data key (not a directory), so a random 32-byte
// key stands in for the vault-derived one.
beforeAll(() => setDataKey(randomBytes(32)));

describe("store seal/unseal (AES-256-GCM)", () => {
  it("round-trips arbitrary bytes", () => {
    const data = Buffer.from("session tokens + key passphrases", "utf8");
    expect(unseal(seal(data)).equals(data)).toBe(true);
  });

  it("produces a fresh nonce each time (no ciphertext reuse)", () => {
    const data = Buffer.from("same plaintext");
    expect(seal(data).equals(seal(data))).toBe(false);
  });

  it("rejects a tampered blob (GCM auth failure)", () => {
    const blob = seal(Buffer.from("secret"));
    blob[blob.length - 1] ^= 0xff; // flip a tag byte
    expect(() => unseal(blob)).toThrow();
  });

  it("rejects a truncated blob", () => {
    expect(() => unseal(Buffer.alloc(8))).toThrow(/truncated/);
  });
});

// Sign-out and a vault-key change both go through wipeCache. Both caches are
// sealed with the account's key, so neither may outlive the account: leaving the
// search-index metadata behind would strand the previous account's file names
// on disk.
describe("face covers kept between runs", () => {
  it("are sealed on disk, read back by key, and go with the thumbnails", () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-store-test-"));
    initStore(dir);
    const cut = Buffer.concat([JPEG_MAGIC, Buffer.from("a face")]);

    coverPut("vol~a|0.1,0.2,0.3,0.4|128", cut);

    expect(coverGet("vol~a|0.1,0.2,0.3,0.4|128")?.equals(cut)).toBe(true);
    expect(coverGet("vol~a|0.1,0.2,0.3,0.4|192")).toBeNull();
    const files = readdirSync(join(dir, "thumbs"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, "thumbs", files[0])).subarray(0, 4).equals(JPEG_MAGIC)).toBe(false);
    expect(files[0]).not.toContain("vol");

    wipeCache();
    expect(coverGet("vol~a|0.1,0.2,0.3,0.4|128")).toBeNull();
  });
});

describe("wipeCache", () => {
  it("removes the search metadata as well as the thumbnails", () => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-store-test-")));

    thumbPut("uid-1", 0, Buffer.from("thumbnail bytes"));
    metaPut("uid-1", { name: "a-private-file-name.jpg", mediaType: "image/jpeg" });
    expect(thumbGet("uid-1", 0)).not.toBeNull();
    expect(metaGet("uid-1")?.name).toBe("a-private-file-name.jpg");

    wipeCache();

    expect(thumbGet("uid-1", 0)).toBeNull();
    expect(metaGet("uid-1")).toBeNull();
  });

  // A file per photo is hundreds of thousands of files on a large library, so the
  // folders are moved aside at once and deleted behind; nothing of them may stay.
  it("deletes the set-aside folders in the background", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-store-test-"));
    initStore(dir);
    for (let i = 0; i < 50; i++) thumbPut(`uid-${i}`, 0, Buffer.from("thumbnail bytes"));

    wipeCache();

    const leftovers = () => readdirSync(dir).filter((n) => n.includes(".discard-"));
    for (let i = 0; i < 100 && leftovers().length > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(leftovers()).toEqual([]);
    expect(readdirSync(join(dir, "thumbs"))).toEqual([]);
  });

  it("sweeps away a set-aside folder a quit left behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-store-test-"));
    mkdirSync(join(dir, "thumbs.discard-1234abcd"), { recursive: true });
    writeFileSync(join(dir, "thumbs.discard-1234abcd", "x.bin"), "old");

    initStore(dir);

    for (let i = 0; i < 100 && existsSync(join(dir, "thumbs.discard-1234abcd")); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(join(dir, "thumbs.discard-1234abcd"))).toBe(false);
  });

  it("leaves the store usable afterwards", () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-store-test-"));
    initStore(dir);
    wipeCache();
    // The thumbnail directory is recreated, so the next sign-in can cache again.
    expect(existsSync(join(dir, "thumbs"))).toBe(true);
    thumbPut("uid-2", 0, Buffer.from("after wipe"));
    expect(thumbGet("uid-2", 0)?.toString()).toBe("after wipe");
  });

  // The session is sealed with the same key as the caches, and a key change reseals the
  // vault in place. Left behind, it would sit beside a freshly salted vault that can no
  // longer open it.
  it("takes the saved session with the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-store-test-"));
    initStore(dir);
    writeFileSync(join(dir, SESSION_FILE), seal(Buffer.from('{"uid":"u"}')));

    wipeCache();

    expect(existsSync(join(dir, SESSION_FILE))).toBe(false);
  });
});

// Both small sealed files are rewritten in place during ordinary use: the session on
// every token refresh, the pin list on every pin. A bare write truncates before it
// writes, so a crash mid-write leaves a blob that never opens again. That would brick
// the unlock, since the only route out of it signs the account out and takes every
// offline photo with it.
describe("sealed files: writing and recovering", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    setDataKey(randomBytes(32));
    dir = mkdtempSync(join(tmpdir(), "pfp-sealed-test-"));
    initStore(dir);
    path = join(dir, "small.enc");
  });

  it("round-trips through the seal and leaves no scratch file behind", () => {
    writeSealedAtomic(path, Buffer.from("session tokens"));

    expect(unseal(readFileSync(path)).toString()).toBe("session tokens");
    // The `.part` is the whole mechanism; a leftover one would be a silent disk leak.
    expect(existsSync(`${path}.part`)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".part"))).toHaveLength(0);
  });

  // A power cut cannot be staged from inside the process, so what is pinned here is the
  // mechanism that survives one: the destination is only ever replaced by a rename, and
  // a write that fails takes its scratch file with it rather than the destination.
  it("leaves the previous blob and no scratch file when a write fails", () => {
    writeSealedAtomic(path, Buffer.from("the good session"));
    const before = readFileSync(path);

    clearDataKey(); // sealing cannot proceed without a key
    expect(() => writeSealedAtomic(path, Buffer.from("never lands"))).toThrow();
    setDataKey(randomBytes(32));

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  // The case both callers actually live in: the session is rewritten on every token
  // refresh and the pin list on every pin, so the rename lands on a file that is
  // already there far more often than on empty space.
  it("replaces a blob that is already there", () => {
    writeSealedAtomic(path, Buffer.from("the first session"));
    writeSealedAtomic(path, Buffer.from("the second session"));

    expect(unseal(readFileSync(path)).toString()).toBe("the second session");
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it("replaces a scratch file left behind by a crashed write", () => {
    writeFileSync(`${path}.part`, randomBytes(48)); // what a killed process leaves

    writeSealedAtomic(path, Buffer.from("the next session"));

    expect(unseal(readFileSync(path)).toString()).toBe("the next session");
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it("reads a sealed file back", () => {
    writeSealedAtomic(path, Buffer.from("readable"));

    expect(readSealedOrSetAside(path)?.toString()).toBe("readable");
    expect(existsSync(path)).toBe(true);
  });

  it("answers a missing file with null", () => {
    expect(readSealedOrSetAside(join(dir, "not-there.enc"))).toBeNull();
  });

  const asides = () => readdirSync(dir).filter((n) => n.startsWith("small.enc.unreadable-"));

  // The fix for the bricked unlock: a torn blob has to be as recoverable as a missing
  // one. Anything else fails identically on every retry with the correct password.
  it("sets a torn blob aside and reports it as absent, rather than throwing", () => {
    writeSealedAtomic(path, Buffer.from("the good session"));
    const torn = randomBytes(64); // a write torn by a crash or a power cut
    writeFileSync(path, torn);

    expect(readSealedOrSetAside(path)).toBeNull();

    // Out of the way, so the next start looks like a first start instead of failing the same
    // way, and kept, never deleted.
    expect(existsSync(path)).toBe(false);
    expect(asides().map((n) => readFileSync(join(dir, n)).equals(torn))).toContain(true);
  });

  it("sets aside a blob written under a previous key, which that key still opens", () => {
    const old = randomBytes(32);
    setDataKey(Buffer.from(old));
    writeSealedAtomic(path, Buffer.from("sealed under the old password"));

    setDataKey(randomBytes(32)); // the password changed

    const before = new Set(asides());
    expect(readSealedOrSetAside(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
    const added = asides().filter((n) => !before.has(n));
    expect(added).toHaveLength(1);
    setDataKey(old);
    expect(readSealedOrSetAside(join(dir, added[0]))?.toString()).toBe("sealed under the old password");
  });

  // A locked store read the hidden list as a torn file and deleted it.
  it("refuses to read while locked, and leaves the file alone", () => {
    const key = randomBytes(32);
    setDataKey(Buffer.from(key));
    writeSealedAtomic(path, Buffer.from("the hidden list"));
    const sealed = readFileSync(path);

    clearDataKey();
    expect(() => readSealedOrSetAside(path)).toThrow(StoreLockedError);
    expect(() => writeSealedAtomic(path, Buffer.from(""))).toThrow(StoreLockedError);
    expect(readFileSync(path).equals(sealed)).toBe(true);

    setDataKey(key);
    expect(readSealedOrSetAside(path)?.toString()).toBe("the hidden list");
  });

  // The caches are what make a discard cheap: nothing else on disk is touched, so a
  // torn kilobyte costs a sign-in and not a re-download of the whole library.
  it("takes only the torn file, leaving the caches alone", () => {
    thumbPut("uid-1", 0, Buffer.from("thumbnail bytes"));
    writeFileSync(path, randomBytes(64));

    expect(readSealedOrSetAside(path)).toBeNull();

    expect(thumbGet("uid-1", 0)?.toString()).toBe("thumbnail bytes");
  });

  it("lets sign-out take the files set aside with the rest", () => {
    writeFileSync(path, randomBytes(64));
    expect(readSealedOrSetAside(path)).toBeNull();
    expect(asides().length).toBeGreaterThan(0);
    wipeCache();
    expect(asides()).toEqual([]);
  });
});

describe("a vault set aside whole", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pfp-aside-"));
    initStore(dir);
    setDataKey(randomBytes(32));
  });

  it("moves the vault and what it sealed into a folder of its own, deleting nothing", () => {
    writeSealedAtomic(join(dir, HIDDEN_FILE), Buffer.from("hidden"));
    writeSealedAtomic(join(dir, SESSION_FILE), Buffer.from("session"));
    thumbPut("uid-1", 0, Buffer.from("thumb"));
    writeFileSync(join(dir, "vault.json"), "meta");
    writeFileSync(join(dir, "settings"), "host's own");

    const aside = setAsideVault(["vault.json"]);

    expect(aside).not.toBeNull();
    expect(existsSync(join(dir, HIDDEN_FILE))).toBe(false);
    expect(existsSync(join(dir, "vault.json"))).toBe(false);
    expect(readFileSync(join(aside!, "vault.json"), "utf8")).toBe("meta");
    expect(unseal(readFileSync(join(aside!, HIDDEN_FILE))).toString()).toBe("hidden");
    expect(readdirSync(join(aside!, "thumbs"))).toHaveLength(1);
    // What is not the vault's stays, and the store is usable at once.
    expect(readFileSync(join(dir, "settings"), "utf8")).toBe("host's own");
    expect(existsSync(join(dir, "thumbs"))).toBe(true);
    thumbPut("uid-2", 0, Buffer.from("new"));
    expect(thumbGet("uid-2", 0)?.toString()).toBe("new");
  });

  it("goes only at sign-out", async () => {
    writeSealedAtomic(join(dir, HIDDEN_FILE), Buffer.from("hidden"));
    setAsideVault([]);
    const folders = () => readdirSync(dir).filter((n) => n.startsWith(SET_ASIDE_PREFIX));
    expect(folders()).toHaveLength(1);
    wipeCache();
    for (let i = 0; i < 100 && folders().length > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(folders()).toEqual([]);
  });
});

// The originals kept for offline use are the only photo bytes the app stores at rest.
// They go through the same key as everything else here, and the point of these tests is
// that nothing readable is ever left on disk.
describe("stored originals", () => {
  let dir: string;
  beforeEach(() => {
    setDataKey(randomBytes(32));
    dir = mkdtempSync(join(tmpdir(), "pfp-orig-test-"));
    initStore(dir);
  });

  it("fails, rather than hanging or crashing, when the staged copy cannot be written", async () => {
    // Large enough that the write stream asks for a pause. Before, a failed write never
    // sent the 'drain' that pause waited for, so the open hung for good, and the stream's
    // unheard 'error' ended the whole process.
    await storeOriginal("uid-big", randomBytes(4 * 1024 * 1024));
    const folder = mkdtempSync(join(tmpdir(), "pfp-not-a-file-"));

    const outcome = await Promise.race([
      decryptOriginalTo("uid-big", folder).then(
        () => "written",
        () => "failed",
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 10_000)),
    ]);

    expect(outcome).toBe("failed");
  });

  it("round-trips a photo through the streaming sealer", async () => {
    const photo = Buffer.concat([JPEG_MAGIC, randomBytes(9000)]);

    expect(originalHas("uid-A")).toBe(false);
    await storeOriginal("uid-A", photo);

    expect(originalHas("uid-A")).toBe(true);
    expect(originalGet("uid-A")?.equals(photo)).toBe(true);
  });

  it("leaves NO readable photo on disk: the blob is ciphertext, not a JPEG", async () => {
    const photo = Buffer.concat([JPEG_MAGIC, randomBytes(9000)]);
    await storeOriginal("uid-A", photo);

    const files = readdirSync(join(dir, "originals"));
    expect(files).toHaveLength(1);
    const onDisk = readFileSync(join(dir, "originals", files[0]));

    // Not a JPEG: an image viewer pointed at this file finds nothing to open.
    expect(onDisk.subarray(0, 4).equals(JPEG_MAGIC)).toBe(false);
    // And not the photo in any arrangement — the plaintext appears nowhere in it.
    expect(onDisk.includes(photo.subarray(0, 64))).toBe(false);
    // Only the nonce and tag are added, so the size gives away nothing but the size.
    expect(onDisk.length).toBe(photo.length + 12 + 16);
    // The file name is the uid's hash, so the disk never names the photo either.
    expect(files[0]).not.toContain("uid-A");
  });

  it("cannot be opened with a different key, and says so rather than returning junk", async () => {
    await storeOriginal("uid-A", Buffer.concat([JPEG_MAGIC, randomBytes(4000)]));

    setDataKey(randomBytes(32)); // the account, or the password, changed

    expect(originalGet("uid-A")).toBeNull();
  });

  it("unpinning deletes the blob and reclaims the space", async () => {
    const photo = Buffer.concat([JPEG_MAGIC, randomBytes(20_000)]);
    await storeOriginal("uid-A", photo);
    expect(originalUsage()).toEqual({ bytes: photo.length, count: 1 });

    expect(originalDelete("uid-A")).toBe(true);

    expect(originalHas("uid-A")).toBe(false);
    expect(originalGet("uid-A")).toBeNull();
    expect(originalUsage()).toEqual({ bytes: 0, count: 0 });
    expect(readdirSync(join(dir, "originals"))).toHaveLength(0);
    // A second unpin is not an error, it simply reclaimed nothing.
    expect(originalDelete("uid-A")).toBe(false);
  });

  it("reports the plaintext total across several photos", async () => {
    await storeOriginal("uid-A", randomBytes(1000));
    await storeOriginal("uid-B", randomBytes(2500));

    expect(originalUsage()).toEqual({ bytes: 3500, count: 2 });
  });

  it("never reports an abandoned transfer as stored", async () => {
    const sealer = new OriginalSealer("uid-A");
    await sealer.write(randomBytes(5000));
    await sealer.abort();

    // A half-written blob would otherwise look complete and be served as the photo.
    expect(originalHas("uid-A")).toBe(false);
    expect(originalUsage()).toEqual({ bytes: 0, count: 0 });
    expect(readdirSync(join(dir, "originals"))).toHaveLength(0);
  });

  // Reading an original costs the sealed bytes and the plaintext at once, so a caller
  // that only needs to apply a size limit must be able to ask without paying that. The
  // blob's fixed overhead is what makes the length on disk answer it.
  it("reports a stored original's size without reading it", async () => {
    const photo = Buffer.concat([JPEG_MAGIC, randomBytes(30_000)]);
    await storeOriginal("uid-A", photo);

    expect(originalSize("uid-A")).toBe(photo.length);
    // The same number `originalUsage` bills for, so the two can never disagree.
    expect(originalSize("uid-A")).toBe(originalUsage().bytes);
  });

  it("has no size for a photo that is not stored", () => {
    expect(originalSize("uid-missing")).toBeNull();
  });

  it("has no size for an abandoned transfer", async () => {
    const sealer = new OriginalSealer("uid-A");
    await sealer.write(randomBytes(5000));
    await sealer.abort();

    expect(originalSize("uid-A")).toBeNull();
  });

  // "Free up everything" has to work from the directory, because the blobs are
  // content-addressed: a name on disk cannot be turned back into a uid, so a list that
  // reads as empty would otherwise leave every original stranded.
  it("sweeps every stored original, and the scratch files with them", async () => {
    await storeOriginal("uid-A", randomBytes(1000));
    await storeOriginal("uid-B", randomBytes(2500));
    const abandoned = new OriginalSealer("uid-C");
    await abandoned.write(randomBytes(400));
    await abandoned.abort();
    // A `.part` that outlived its process: invisible to `originalHas`, still on disk.
    writeFileSync(join(dir, "originals", "stale.bin.part"), randomBytes(700));

    expect(originalDeleteAll()).toBe(2); // the two complete blobs

    expect(originalUsage()).toEqual({ bytes: 0, count: 0 });
    expect(readdirSync(join(dir, "originals"))).toHaveLength(0);
  });

  it("sweeps nothing, without complaint, when nothing is stored", () => {
    expect(originalDeleteAll()).toBe(0);
  });

  it("sign-out takes the originals AND the list naming them", async () => {
    await storeOriginal("uid-A", Buffer.concat([JPEG_MAGIC, randomBytes(8000)]));
    // The pinned list lives beside them, sealed with the same key.
    writeFileSync(join(dir, OFFLINE_LIST_FILE), seal(Buffer.from('{"v":1,"uids":["uid-A"]}')));
    expect(originalUsage().count).toBe(1);

    wipeCache(); // what sign-out and a password change both call

    expect(originalHas("uid-A")).toBe(false);
    expect(originalUsage()).toEqual({ bytes: 0, count: 0 });
    expect(existsSync(join(dir, "originals"))).toBe(false);
    expect(existsSync(join(dir, OFFLINE_LIST_FILE))).toBe(false);
  });
});
