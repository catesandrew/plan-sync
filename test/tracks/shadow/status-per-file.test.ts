import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as shadowInit } from "../../../src/tracks/shadow/init";
import { run as shadowPush } from "../../../src/tracks/shadow/push";
import { run as shadowStatus } from "../../../src/tracks/shadow/status";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

describe("status --track shadow: per-file report", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "omc-sync-shadow-status-perfile-"),
    );
    anchorRepo = path.join(tmpDir, "anchor-repo");
    originRemote = path.join(tmpDir, "origin-remote.git");
    stateDir = path.join(tmpDir, "state-dir");

    fs.mkdirSync(anchorRepo, { recursive: true });
    execFileSync("git", ["init", "--bare", originRemote]);

    git(anchorRepo, ["init"]);
    git(anchorRepo, ["config", "user.name", "Test User"]);
    git(anchorRepo, ["config", "user.email", "test@example.com"]);
    git(anchorRepo, ["remote", "add", "origin", originRemote]);
    fs.writeFileSync(path.join(anchorRepo, "README.md"), "hello\n");
    git(anchorRepo, ["add", "README.md"]);
    git(anchorRepo, ["commit", "-m", "initial commit"]);

    originalCwd = process.cwd();
    originalOmcStateDir = process.env.OMC_STATE_DIR;
    process.env.OMC_STATE_DIR = stateDir;
    process.chdir(anchorRepo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalOmcStateDir === undefined) {
      delete process.env.OMC_STATE_DIR;
    } else {
      process.env.OMC_STATE_DIR = originalOmcStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(entries: string[]): void {
    const manifestPath = path.join(anchorRepo, ".omc", ".sync-manifest");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, entries.join("\n") + "\n");
  }

  function writeOmcFile(relPath: string, content: string): void {
    const filePath = path.join(anchorRepo, ".omc", relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  it("reports in sync / pending (local changes) / pending (never synced) / missing locally for the appropriate manifest entries", () => {
    shadowInit([]);
    writeManifest(["synced.md", "modified.md", "never-synced.md", "gone.md"]);
    writeOmcFile("synced.md", "unchanged content\n");
    writeOmcFile("modified.md", "original content\n");
    writeOmcFile("gone.md", "will be deleted locally\n");
    // "never-synced.md" is deliberately never created on disk.

    shadowPush([]);

    // After the push: edit one file locally (manifest unchanged) and delete
    // another locally (manifest unchanged) — the ordinary workflow.
    writeOmcFile("modified.md", "changed after push\n");
    fs.rmSync(path.join(anchorRepo, ".omc", "gone.md"));

    const output = captureStdout(() => shadowStatus([]));

    expect(output).toContain("synced.md: in sync");
    expect(output).toContain("modified.md: pending (local changes)");
    expect(output).toContain("never-synced.md: pending (never synced)");
    expect(output).toContain("gone.md: missing locally");
    expect(output).toContain("4 file(s) tracked");
  });
});
