import { describe, expect, it } from "vitest";
import { parseTrack } from "../src/args";

describe("parseTrack", () => {
  it("throws a clear error when --track is omitted and no default is given", () => {
    expect(() => parseTrack([])).toThrow(/--track is required/);
  });

  it("returns the explicit --track when given, with no default", () => {
    expect(parseTrack(["--track", "shadow"])).toEqual({
      track: "shadow",
      rest: [],
    });
  });

  it("falls back to the given default when --track is omitted", () => {
    expect(parseTrack([], "sibling")).toEqual({
      track: "sibling",
      rest: [],
    });
  });

  it("an explicit --track overrides the default", () => {
    expect(parseTrack(["--track", "shadow"], "sibling")).toEqual({
      track: "shadow",
      rest: [],
    });
  });

  it("preserves the remaining (non---track) args alongside the default", () => {
    expect(parseTrack(["--stale-after", "24h"], "shadow")).toEqual({
      track: "shadow",
      rest: ["--stale-after", "24h"],
    });
  });

  it("still throws on an invalid explicit --track value even when a default is given", () => {
    expect(() => parseTrack(["--track", "bogus"], "shadow")).toThrow(
      /--track is required/,
    );
  });
});
