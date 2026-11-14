/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type Pending = { cmd: string; args: any; answer: (v: unknown) => void };
const sent: Pending[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    (cmd: string, args: any) => new Promise((resolve) => sent.push({ cmd, args, answer: resolve })),
  ),
}));
vi.mock("./i18n", () => ({ translateNow: (k: string) => k }));

import { rpc } from "./rpc";

const calls = () => sent.filter((s) => s.cmd === "rpc");
const cancels = () => sent.filter((s) => s.cmd === "cancel_rpc").map((s) => s.args.callId);

describe("every call from the window", () => {
  beforeEach(() => {
    sent.length = 0;
    vi.useRealTimers();
  });

  it("carries an id, and a call that answers sends no cancel", async () => {
    const asking = rpc<number>("labelsVersion");
    await vi.waitFor(() => expect(calls().length).toBe(1));
    expect(typeof calls()[0].args.callId).toBe("number");
    calls()[0].answer({ ok: true, result: 7 });
    expect(await asking).toBe(7);
    expect(cancels()).toEqual([]);
  });

  it("is cancelled at the host when it takes too long", async () => {
    vi.useFakeTimers();
    const asking = rpc("labelsVersion", {}, { timeoutMs: 1000 });
    const failed = expect(asking).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(0);
    const id = calls()[0].args.callId;
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    expect(cancels()).toEqual([id]);
  });

  it("is cancelled at the host when its caller lets go, once", async () => {
    const stop = new AbortController();
    const asking = rpc("getPreview", { uid: "u" }, { signal: stop.signal });
    await vi.waitFor(() => expect(calls().length).toBe(1));
    const id = calls()[0].args.callId;
    stop.abort();
    calls()[0].answer({ ok: false, error: "rpc cancelled" });
    await expect(asking).rejects.toThrow();
    expect(cancels()).toEqual([id]);
  });

  it("is never sent when its caller has already let go", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(rpc("getPreview", { uid: "u" }, { signal: stop.signal })).rejects.toThrow("abandoned");
    expect(sent).toEqual([]);
  });

  it("gets a new id for each call", async () => {
    void rpc("labelsVersion");
    void rpc("labelsVersion");
    await vi.waitFor(() => expect(calls().length).toBe(2));
    expect(calls()[0].args.callId).not.toBe(calls()[1].args.callId);
  });
});
