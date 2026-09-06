import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as allowRun } from "../src/commands/allow";
import { defaultManifestPath, readManifest } from "../src/manifest";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("allow: glob expansion", () => {
  let tmpRoot: string;
  let anchorDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-allow-"));
    anchorDir = path.join(tmpRoot, "anchor");
    fs.mkdirSync(anchorDir, { recursive: true });
    git(anchorDir, ["init", "--quiet"]);

    originalCwd = process.cwd();
    process.chdir(anchorDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeOmcFile(relPath: string, content = "content\n"): void {
    const filePath = path.join(anchorDir, ".omc", relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  it("a literal path with no glob metacharacters is added exactly as before", () => {
    writeOmcFile("notes.md");

    allowRun(["notes.md"]);

    expect(readManifest(defaultManifestPath())).toEqual(["notes.md"]);
  });

  it("expands a glob pattern to match files at varying depth", () => {
    writeOmcFile("plans/a.md");
    writeOmcFile("plans/sub/b.md");
    writeOmcFile("plans/sub/deep/c.md");
    writeOmcFile("plans/skip.txt");
    writeOmcFile("other.md");

    allowRun(["plans/**/*.md"]);

    expect(readManifest(defaultManifestPath()).sort()).toEqual([
      "plans/a.md",
      "plans/sub/b.md",
      "plans/sub/deep/c.md",
    ]);
  });

  it("skips directories and symlinks when expanding a glob (only regular files match)", () => {
    writeOmcFile("plans/a.md");
    // A directory whose name happens to match the pattern shape must never
    // be treated as a file match.
    fs.mkdirSync(path.join(anchorDir, ".omc", "plans", "b.md"), {
      recursive: true,
    });

    const outsideTarget = path.join(tmpRoot, "outside.md");
    fs.writeFileSync(outsideTarget, "should never be matched\n");
    fs.symlinkSync(
      outsideTarget,
      path.join(anchorDir, ".omc", "plans", "linked.md"),
    );

    allowRun(["plans/*.md"]);

    expect(readManifest(defaultManifestPath())).toEqual(["plans/a.md"]);
  });

  it("does not descend through a symlinked directory component", () => {
    const outsideDir = path.join(tmpRoot, "outside-dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "secret\n");

    fs.mkdirSync(path.join(anchorDir, ".omc"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(anchorDir, ".omc", "linked-dir"));
    writeOmcFile("clean.md");

    allowRun(["**/*.md"]);

    expect(readManifest(defaultManifestPath())).toEqual(["clean.md"]);
  });

  it("warns (not throws) to stderr when a glob pattern matches no files, and adds nothing", () => {
    writeOmcFile("notes.md");

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    expect(() => allowRun(["nonexistent/**/*.md"])).not.toThrow();

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    stderrSpy.mockRestore();

    expect(warnings).toContain("matched no files");
    expect(readManifest(defaultManifestPath())).toEqual([]);
  });

  it("prints a summary of newly-added vs already-present files for a multi-match glob", () => {
    writeOmcFile("plans/a.md");
    writeOmcFile("plans/b.md");
    allowRun(["plans/a.md"]); // literal pre-seed: already present before the glob run

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    allowRun(["plans/*.md"]);

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    stdoutSpy.mockRestore();

    expect(output).toContain("2 file(s)");
    expect(output).toContain("1 newly added");
    expect(output).toContain("1 already present");

    expect(readManifest(defaultManifestPath()).sort()).toEqual([
      "plans/a.md",
      "plans/b.md",
    ]);
  });
});
