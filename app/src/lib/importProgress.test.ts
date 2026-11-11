import { describe, expect, it } from "vitest";
import { importFraction } from "./importProgress";

const state = (phase: "downloading" | "unpacking" | "ready" | "planning" | "review", done = 0, total = 0) => ({
  phase,
  done,
  total,
  part: 1,
  parts: 1,
});

describe("how far an import has got", () => {
  it("follows the bytes while a zip unpacks", () => {
    expect(importFraction(state("unpacking", 25, 100))).toBe(0.25);
  });

  it("never runs past the end, whatever the zip's own sizes claimed", () => {
    expect(importFraction(state("unpacking", 120, 100))).toBe(1);
  });

  it("does not claim a number before the size of the zip is known", () => {
    expect(importFraction(state("unpacking", 0, 0))).toBeNull();
  });

  it("follows the bytes while a download comes down", () => {
    expect(importFraction(state("downloading", 30, 120))).toBe(0.25);
  });

  it("does not claim a number before the size of a download is known", () => {
    expect(importFraction(state("downloading", 0, 0))).toBeNull();
  });

  it.each(["ready", "planning", "review"] as const)("has no number to show while %s", (phase) => {
    expect(importFraction(state(phase))).toBeNull();
  });
});
