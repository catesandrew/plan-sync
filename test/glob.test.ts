import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandGlobUnderRoot, globToRegExp } from "../src/glob";

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

  it("a character class matches an ASCII range, and `[!...]` negates it", () => {
    for (const name of ["a.md", "b.md", "c.md", "d.md"]) {
      fs.writeFileSync(path.join(root, name), "x\n");
    }

    expect(expandGlobUnderRoot(root, "[a-c].md")).toEqual(["a.md", "b.md", "c.md"]);
    expect(expandGlobUnderRoot(root, "[ad].md")).toEqual(["a.md", "d.md"]);
    expect(expandGlobUnderRoot(root, "[!a-c].md")).toEqual(["d.md"]);
  });

  // The dialect does NOT support POSIX named classes ([[:alpha:]]) or
  // backslash-escaping inside a bracket expression — this documents and
  // pins that (matching the "or the documented subset" allowance in the
  // plan's AC), and demonstrates cross-implementation agreement with
  // go/internal/glob's identical test: both compileClass implementations
  // are line-for-line equivalent (same negation rule, same range rule, no
  // escape handling), so both parse these as a literal character SET, not
  // a POSIX class or an escape sequence.
  it("does not support POSIX named classes or backslash-escaping inside a bracket expression — documented dialect subset, matching the Go port", () => {
    // `[[:alpha:]]` is a literal-member class over the runes between the
    // outer `[` and the FIRST `]` ('[', ':', 'a', 'l', 'p', 'h'), followed
    // by a literal trailing `]` — NOT a POSIX "alphabetic character" class.
    expect(globToRegExp("[[:alpha:]]").test("a]")).toBe(true);
    expect(globToRegExp("[[:alpha:]]").test("x]")).toBe(false);
    expect(globToRegExp("[[:alpha:]]").test(":]")).toBe(true);
    expect(globToRegExp("[[:alpha:]]").test("1]")).toBe(false);

    // `\` inside a bracket expression is a literal member of the set, not
    // an escape character.
    expect(globToRegExp("[\\.]").test("\\")).toBe(true);
    expect(globToRegExp("[\\.]").test(".")).toBe(true);
    expect(globToRegExp("[\\.]").test("x")).toBe(false);
  });

  // `?` and `*` count CODE POINTS, not UTF-16 code units. A RegExp-based
  // matcher without the `u` flag sees "🎉" (U+1F389) and "𠀋" (U+2000B) as
  // two characters each, so `?.md` would not match them — which is exactly
  // the divergence the hand-written matcher exists to close, and the same
  // rune-based semantics the Go port in go/internal/glob implements.
  it("`?` matches a single non-BMP character, and only one of them", () => {
    for (const name of ["🎉.md", "𠀋.md", "a.md", "ab.md"]) {
      fs.writeFileSync(path.join(root, name), "x\n");
    }

    expect(expandGlobUnderRoot(root, "?.md").sort()).toEqual(
      ["a.md", "🎉.md", "𠀋.md"].sort(),
    );
    expect(globToRegExp("?.md").test("🎉.md")).toBe(true);
    expect(globToRegExp("?.md").test("🎉🎉.md")).toBe(false);
    expect(globToRegExp("??.md").test("🎉🎉.md")).toBe(true);
  });

  it("`*` matches a filename containing non-BMP characters", () => {
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, "release-🎉-notes.md"), "x\n");
    fs.writeFileSync(path.join(root, "plans", "𠀋-draft.md"), "x\n");
    fs.writeFileSync(path.join(root, "plain.txt"), "x\n");

    expect(expandGlobUnderRoot(root, "*.md")).toEqual(["release-🎉-notes.md"]);
    expect(expandGlobUnderRoot(root, "release-*-notes.md")).toEqual([
      "release-🎉-notes.md",
    ]);
    expect(expandGlobUnderRoot(root, "**/*.md").sort()).toEqual(
      ["plans/𠀋-draft.md", "release-🎉-notes.md"].sort(),
    );
    expect(globToRegExp("[🎉a].md").test("🎉.md")).toBe(true);
  });

  it("glob metacharacters are the only metacharacters — `.` and `+` stay literal", () => {
    expect(globToRegExp("a.md").test("axmd")).toBe(false);
    expect(globToRegExp("a+b.md").test("a+b.md")).toBe(true);
    expect(globToRegExp("*.md").test("sub/a.md")).toBe(false);
    expect(globToRegExp("plans/**/*.md").test("plans/a.md")).toBe(true);
    expect(globToRegExp("plans/**/*.md").test("plans/x/y/a.md")).toBe(true);
    expect(globToRegExp("plans/**/*.md").test("other/a.md")).toBe(false);
  });
});
