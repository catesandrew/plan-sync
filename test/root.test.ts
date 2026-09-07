import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANDIDATE_ROOTS,
  DEFAULT_ROOT,
  resolveRootDir,
  rootSegment,
} from "../src/root";

const tempDirs: string[] = [];

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-root-"));
  tempDirs.push(dir);
  return dir;
}

function initRoot(repoRoot: string, name: string): void {
  const dir = path.join(repoRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".sync-config.json"), "{}");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("resolveRootDir", () => {
  it("falls back to the default root when nothing is initialized", () => {
    expect(resolveRootDir(makeRepoRoot())).toBe(DEFAULT_ROOT);
  });

  it("auto-detects the sole initialized candidate root", () => {
    const repoRoot = makeRepoRoot();
    initRoot(repoRoot, ".omx");
    expect(resolveRootDir(repoRoot)).toBe(".omx");
  });

  it("ignores a candidate directory without a .sync-config.json", () => {
    const repoRoot = makeRepoRoot();
    fs.mkdirSync(path.join(repoRoot, ".omx"), { recursive: true });
    expect(resolveRootDir(repoRoot)).toBe(DEFAULT_ROOT);
  });

  it("falls back to the default root when detection is ambiguous", () => {
    const repoRoot = makeRepoRoot();
    initRoot(repoRoot, ".omx");
    initRoot(repoRoot, ".adlc");
    expect(resolveRootDir(repoRoot)).toBe(DEFAULT_ROOT);
  });

  it("prefers an explicit --root over auto-detection", () => {
    const repoRoot = makeRepoRoot();
    initRoot(repoRoot, ".omx");
    expect(resolveRootDir(repoRoot, "  .adlc  ")).toBe(".adlc");
  });

  it.each([" ", ".", "..", "/etc", "a/b", "a\\b", "../escape"])(
    "rejects the unsafe --root value '%s'",
    (value) => {
      expect(() => resolveRootDir(makeRepoRoot(), value)).toThrow();
    },
  );

  // Regression: '...' is not '.' or '..', contains no separators, and is not
  // absolute — so it used to validate — but rootSegment() strips one leading
  // dot and returned '..', escaping a directory level wherever the segment is
  // joined onto a path (e.g. under PLAN_SYNC_STATE_DIR) and yielding an
  // invalid git refname.
  it("rejects --root '...' instead of silently turning it into '..'", () => {
    const repoRoot = makeRepoRoot();
    expect(() => resolveRootDir(repoRoot, "...")).toThrow(
      /strips to the unsafe namespace segment '\.\.'/,
    );
    expect(() => resolveRootDir(repoRoot, "  ...  ")).toThrow(
      /strips to the unsafe namespace segment '\.\.'/,
    );
  });
});

describe("rootSegment", () => {
  it("strips exactly one leading dot from each candidate root", () => {
    expect(CANDIDATE_ROOTS.map(rootSegment)).toEqual(["omc", "omx", "adlc"]);
  });

  it("leaves a dotless root unchanged", () => {
    expect(rootSegment("omc")).toBe("omc");
  });

  it.each(["...", "..", ".", "", ".a/b", ".a\\b"])(
    "throws rather than returning the unsafe stripped segment for '%s'",
    (value) => {
      expect(() => rootSegment(value)).toThrow(
        /strips to the unsafe namespace segment/,
      );
    },
  );
});
