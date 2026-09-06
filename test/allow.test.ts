import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as allowRun } from "../src/commands/allow";
import { defaultManifestPath, readManifest, resolveManifestPaths } from "../src/manifest";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("allow: every target is saved verbatim as one manifest line", () => {
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

  it("a literal target with no glob metacharacters is saved as a single manifest line", () => {
    writeOmcFile("notes.md");

    allowRun(["notes.md"]);

    expect(readManifest(defaultManifestPath())).toEqual(["notes.md"]);
  });

  it("a glob pattern target is saved VERBATIM as a single manifest line — never expanded into its matches", () => {
    writeOmcFile("plans/a.md");
    writeOmcFile("plans/b.md");
    writeOmcFile("plans/sub/c.md");

    allowRun(["plans/**/*.md"]);

    // Exactly one raw line, the pattern string itself — not one line per
    // matched file.
    expect(readManifest(defaultManifestPath())).toEqual(["plans/**/*.md"]);
  });

  it("accepts multiple targets (literal and glob, mixed) in a single call, one manifest line per target", () => {
    writeOmcFile("notes.md");
    writeOmcFile("plans/a.md");

    allowRun(["notes.md", "todo.md", "plans/*.md"]);

    expect(readManifest(defaultManifestPath()).sort()).toEqual([
      "notes.md",
      "plans/*.md",
      "todo.md",
    ]);
  });

  it("adding the same target twice is idempotent (no duplicate manifest line)", () => {
    writeOmcFile("plans/a.md");

    allowRun(["plans/*.md"]);
    allowRun(["plans/*.md"]);

    expect(readManifest(defaultManifestPath())).toEqual(["plans/*.md"]);
  });

  it("reports the current match count for a pattern target, without requiring any match to exist yet", () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    allowRun(["plans/*.md"]);

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    stdoutSpy.mockRestore();

    expect(output).toContain("'plans/*.md' added");
    expect(output).toContain("0 file(s)");
    // Still added even though nothing currently matches — it's re-evaluated
    // live at the next push/status, so a later-created file is picked up
    // without re-running `allow`.
    expect(readManifest(defaultManifestPath())).toEqual(["plans/*.md"]);
  });

  it("reports the current match count for a literal-looking target", () => {
    writeOmcFile("notes.md");

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    allowRun(["notes.md"]);

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    stdoutSpy.mockRestore();

    expect(output).toContain("'notes.md' added");
    expect(output).toContain("1 file(s)");
  });

  it("a pattern picks up a file created AFTER the allow call, at the next resolution (no re-running allow)", () => {
    allowRun(["plans/*.md"]);
    expect(resolveManifestPaths(defaultManifestPath())).toEqual([]);

    // File created after `allow` ran.
    writeOmcFile("plans/late.md");

    expect(resolveManifestPaths(defaultManifestPath())).toEqual(["plans/late.md"]);
  });
});
