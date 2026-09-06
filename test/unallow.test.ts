import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as allowRun } from "../src/commands/allow";
import { run as unallowRun } from "../src/commands/unallow";
import { defaultManifestPath, readManifest } from "../src/manifest";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("unallow", () => {
  let tmpRoot: string;
  let anchorDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-unallow-"));
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

  it("removes a single literal entry", () => {
    writeOmcFile("notes.md");
    writeOmcFile("todo.md");
    allowRun(["notes.md", "todo.md"]);

    unallowRun(["notes.md"]);

    expect(readManifest(defaultManifestPath())).toEqual(["todo.md"]);
  });

  it("is a no-op (not a throw) when removing an entry that isn't present", () => {
    writeOmcFile("todo.md");
    allowRun(["todo.md"]);

    expect(() => unallowRun(["never-allowed.md"])).not.toThrow();
    expect(readManifest(defaultManifestPath())).toEqual(["todo.md"]);
  });

  it("removes an entry even after its source file was deleted from disk", () => {
    writeOmcFile("gone.md");
    allowRun(["gone.md"]);
    fs.rmSync(path.join(anchorDir, ".omc", "gone.md"));

    unallowRun(["gone.md"]);

    expect(readManifest(defaultManifestPath())).toEqual([]);
  });

  it("removes every manifest entry matching a glob pattern (matched against the manifest, not the filesystem)", () => {
    writeOmcFile("plans/a.md");
    writeOmcFile("plans/b.md");
    writeOmcFile("notes.md");
    allowRun(["plans/a.md", "plans/b.md", "notes.md"]);
    // Delete one of the sources to prove glob-unallow matches manifest
    // entries, not files still on disk.
    fs.rmSync(path.join(anchorDir, ".omc", "plans", "a.md"));

    unallowRun(["plans/*.md"]);

    expect(readManifest(defaultManifestPath())).toEqual(["notes.md"]);
  });

  it("accepts multiple targets (literal and glob, mixed) in a single call", () => {
    writeOmcFile("notes.md");
    writeOmcFile("todo.md");
    writeOmcFile("plans/a.md");
    writeOmcFile("plans/b.md");
    allowRun(["notes.md", "todo.md", "plans/a.md", "plans/b.md"]);

    unallowRun(["notes.md", "plans/*.md"]);

    expect(readManifest(defaultManifestPath())).toEqual(["todo.md"]);
  });

  it("warns (not throws) to stderr when a glob pattern matches no manifest entries", () => {
    writeOmcFile("todo.md");
    allowRun(["todo.md"]);

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    expect(() => unallowRun(["nonexistent/**/*.md"])).not.toThrow();

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    stderrSpy.mockRestore();

    expect(warnings).toContain("matched no manifest entries");
    expect(readManifest(defaultManifestPath())).toEqual(["todo.md"]);
  });
});
