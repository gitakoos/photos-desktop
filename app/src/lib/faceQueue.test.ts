import { describe, expect, it, vi } from "vitest";
import { createFaceQueue } from "./faceQueue";

function deferred() {
  let resolve!: (v: string | null) => void;
  const promise = new Promise<string | null>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createFaceQueue", () => {
  it("asks for at most `limit` at once and starts the next as one answers", async () => {
    const pending = new Map<string, ReturnType<typeof deferred>>();
    const load = vi.fn((uid: string) => {
      const d = deferred();
      pending.set(uid, d);
      return d.promise;
    });
    const ask = createFaceQueue(load, 3);
    const done = vi.fn();
    for (const uid of ["a", "b", "c", "d", "e"]) ask(uid, done);
    expect(load).toHaveBeenCalledTimes(3);
    pending.get("a")!.resolve("url-a");
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(4);
    expect(load).toHaveBeenLastCalledWith("d");
    expect(done).toHaveBeenCalledWith("url-a");
  });

  it("never asks for one cancelled before its turn", async () => {
    const pending: ReturnType<typeof deferred>[] = [];
    const load = vi.fn((_uid: string) => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    });
    const ask = createFaceQueue(load, 1);
    ask("a", () => {});
    const cancel = ask("b", () => {});
    cancel();
    pending[0].resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalledWith("b");
  });
});
