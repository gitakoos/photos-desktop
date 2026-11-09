import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  // A channel that never answers: all that is left to end a call is its own ceiling.
  invoke: () => new Promise(() => {}),
}));

import { rpc } from "./rpc";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Whether the call has given up once `ms` have gone by. */
async function gaveUpAfter(method: string, ms: number): Promise<boolean> {
  let settled = false;
  rpc(method).catch(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

describe("how long a call waits for the channel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives an ordinary call a minute", async () => {
    expect(await gaveUpAfter("someOrdinaryCall", MINUTE + SECOND)).toBe(true);
  });

  it.each(["startTimeline", "timelinePage"])(
    "does not lose a large library's timeline when %s queues behind the first screen",
    async (method) => {
      expect(await gaveUpAfter(method, 5 * MINUTE)).toBe(false);
    },
  );
});
