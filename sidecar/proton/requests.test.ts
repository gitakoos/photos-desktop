/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect } from "vitest";
import { beginRequest, endRequest, liveRequests, takeCancelLine } from "./requests.ts";

describe("the host's cancels", () => {
  it("abort the request they name, and only it", () => {
    const a = beginRequest(1);
    const b = beginRequest(2);
    expect(takeCancelLine({ cancel: 1 })).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    endRequest(1);
    endRequest(2);
    expect(liveRequests()).toBe(0);
  });

  it("are taken and dropped when the request has already answered", () => {
    const a = beginRequest(3);
    endRequest(3);
    expect(takeCancelLine({ cancel: 3 })).toBe(true);
    expect(a.signal.aborted).toBe(false);
  });

  it("are not confused with a request or anything else", () => {
    expect(takeCancelLine({ id: 4, method: "getPreview", params: {} })).toBe(false);
    expect(takeCancelLine({ cancel: 5, method: "x" })).toBe(false);
    expect(takeCancelLine({ cancel: "5" })).toBe(false);
    expect(takeCancelLine(null)).toBe(false);
    expect(takeCancelLine("cancel")).toBe(false);
  });

  it("give a request with no id a signal that nothing can abort", () => {
    const ctx = beginRequest(null);
    expect(ctx.signal.aborted).toBe(false);
    expect(liveRequests()).toBe(0);
  });
});
