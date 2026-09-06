import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandGlobUnderRoot } from "../src/glob";

describe("expandGlobUnderRoot", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-glob-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a plain filename with no glob metacharacters resolves to itself when the file exists — no special-cased literal branch, just the same walk+match logic", () => {
    fs.writeFileSync(path.join(root, "notes.md"), "content\n");

    expect(expandGlobUnderRoot(root, "notes.md")).toEqual(["notes.md"]);
  });

  it("a plain filename with no glob metacharacters resolves to nothing when the file doesn't exist", () => {
    expect(expandGlobUnderRoot(root, "notes.md")).toEqual([]);
  });

  it("a pattern expands to every currently-matching file under root, at any depth", () => {
    fs.mkdirSync(path.join(root, "plans", "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", "a.md"), "a\n");
    fs.writeFileSync(path.join(root, "plans", "sub", "b.md"), "b\n");
    fs.writeFileSync(path.join(root, "plans", "skip.txt"), "skip\n");

    expect(expandGlobUnderRoot(root, "plans/**/*.md").sort()).toEqual([
      "plans/a.md",
      "plans/sub/b.md",
    ]);
  });

  it("never descends through a symlinked directory component, and never matches a symlinked file", () => {
    const outsideDir = path.join(os.tmpdir(), `omc-sync-glob-outside-${process.pid}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "secret\n");

    fs.symlinkSync(outsideDir, path.join(root, "linked-dir"));
    fs.writeFileSync(path.join(root, "clean.md"), "clean\n");

    try {
      expect(expandGlobUnderRoot(root, "**/*.md")).toEqual(["clean.md"]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
