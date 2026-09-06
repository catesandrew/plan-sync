import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToManifest, defaultManifestPath } from "../src/manifest";
import * as siblingInit from "../src/tracks/sibling/init";
import * as siblingPush from "../src/tracks/sibling/push";
import * as siblingStatus from "../src/tracks/sibling/status";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
}

function captureStdout(fn: () => void): string {
  let stdout = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return stdout;
}

describe("status --track sibling: per-file report", () => {
  let tmpRoot: string;
  let anchorDir: string;
  let remoteBareDir: string;
  let clonePath: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-sibling-status-"));
    anchorDir = path.join(tmpRoot, "anchor");
    remoteBareDir = path.join(tmpRoot, "remote.git");
    clonePath = path.join(tmpRoot, "sibling-clone");

    fs.mkdirSync(anchorDir, { recursive: true });
    git(["init", "--quiet"], anchorDir);
    git(["init", "--quiet", "--bare", remoteBareDir], tmpRoot);

    originalCwd = process.cwd();
    process.chdir(anchorDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("throws a clear error when init hasn't been run", () => {
    expect(() => siblingStatus.run([])).toThrow(/init --track sibling/);
  });

  it("reports in sync / pending (local changes) / pending (never synced) / missing locally for the appropriate manifest entries", () => {
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]);

    const manifestPath = defaultManifestPath();
    fs.mkdirSync(path.join(anchorDir, ".omc"), { recursive: true });
    fs.writeFileSync(path.join(anchorDir, ".omc", "synced.md"), "unchanged content\n");
    fs.writeFileSync(path.join(anchorDir, ".omc", "modified.md"), "original content\n");
    fs.writeFileSync(path.join(anchorDir, ".omc", "gone.md"), "will be deleted locally\n");
    // "never-synced.md" is deliberately never created on disk.

    addToManifest(manifestPath, "synced.md");
    addToManifest(manifestPath, "modified.md");
    addToManifest(manifestPath, "never-synced.md");
    addToManifest(manifestPath, "gone.md");

    siblingPush.run([]);

    // After the push: edit one file locally (manifest unchanged) and delete
    // another locally (manifest unchanged) — the ordinary workflow.
    fs.writeFileSync(path.join(anchorDir, ".omc", "modified.md"), "changed after push\n");
    fs.rmSync(path.join(anchorDir, ".omc", "gone.md"));

    const output = captureStdout(() => siblingStatus.run([]));

    expect(output).toContain("synced.md: in sync");
    expect(output).toContain("modified.md: pending (local changes)");
    expect(output).toContain("never-synced.md: pending (never synced)");
    expect(output).toContain("gone.md: missing locally");
    expect(output).toContain("4 file(s) tracked");
  });
});
