import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../../src/cli";
import { resolveProjectId, resolveShadowRepoPath } from "../../src/tracks/shadow/paths";

/**
 * US-008 (AC-2): exercises the full Part B (shadow track) lifecycle through
 * the real CLI dispatcher (`dispatch()` from src/cli.ts) rather than calling
 * the individual track modules directly, to catch wiring gaps that the
 * per-story integration tests (test/tracks/shadow/*.test.ts) — which call
 * `run()` on each module directly — wouldn't see.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function run(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });

  const exitCode = dispatch(argv);

  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();

  return { exitCode, stdout, stderr };
}

describe("e2e: shadow track full lifecycle (via CLI dispatch)", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-e2e-shadow-"));
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
    originalOmcStateDir = process.env.PLAN_SYNC_STATE_DIR;
    process.env.PLAN_SYNC_STATE_DIR = stateDir;
    process.chdir(anchorRepo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalOmcStateDir === undefined) {
      delete process.env.PLAN_SYNC_STATE_DIR;
    } else {
      process.env.PLAN_SYNC_STATE_DIR = originalOmcStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("init -> allow -> push -> fresh-machine restore -> checksum match -> uninstall, all through dispatch()", () => {
    // --- Scratch anchor repo: init the shadow track, allow 2 files, push. ---
    expect(run(["init", "--track", "shadow"]).exitCode).toBe(0);

    fs.mkdirSync(path.join(anchorRepo, ".omc"), { recursive: true });
    const doc1 = Buffer.from("shadow doc one\n", "utf8");
    const doc2 = Buffer.from("shadow doc two\r\nwith crlf\r\n", "utf8");
    fs.writeFileSync(path.join(anchorRepo, ".omc", "doc1.md"), doc1);
    fs.writeFileSync(path.join(anchorRepo, ".omc", "doc2.md"), doc2);
    const doc1Hash = sha256(doc1);
    const doc2Hash = sha256(doc2);

    expect(run(["allow", "doc1.md"]).exitCode).toBe(0);
    expect(run(["allow", "doc2.md"]).exitCode).toBe(0);
    expect(run(["push", "--track", "shadow"]).exitCode).toBe(0);

    const projectId = resolveProjectId(anchorRepo);
    const originalShadowRepoPath = resolveShadowRepoPath(projectId, ".omc", {
      env: { PLAN_SYNC_STATE_DIR: stateDir },
    });
    expect(fs.existsSync(originalShadowRepoPath)).toBe(true);

    // --- Simulate a fresh machine: a brand new PLAN_SYNC_STATE_DIR, re-init
    // against the same remote (same anchor repo -> same origin -> same
    // project id), so the shadow repo is a fresh clone-equivalent rather
    // than the same on-disk repo that pushed. ---
    const freshStateDir = path.join(tmpDir, "state-dir-fresh");
    process.env.PLAN_SYNC_STATE_DIR = freshStateDir;

    expect(run(["init", "--track", "shadow"]).exitCode).toBe(0);

    const freshShadowRepoPath = resolveShadowRepoPath(projectId, ".omc", {
      env: { PLAN_SYNC_STATE_DIR: freshStateDir },
    });
    expect(fs.existsSync(freshShadowRepoPath)).toBe(true);
    expect(freshShadowRepoPath).not.toBe(originalShadowRepoPath);

    // Remove the local copies so restore is proven to actually (re)write
    // them from the remote, not merely observe they're "already there".
    fs.rmSync(path.join(anchorRepo, ".omc", "doc1.md"));
    fs.rmSync(path.join(anchorRepo, ".omc", "doc2.md"));

    expect(run(["restore", "--track", "shadow"]).exitCode).toBe(0);

    const restoredDoc1 = fs.readFileSync(path.join(anchorRepo, ".omc", "doc1.md"));
    const restoredDoc2 = fs.readFileSync(path.join(anchorRepo, ".omc", "doc2.md"));
    expect(sha256(restoredDoc1)).toBe(doc1Hash);
    expect(sha256(restoredDoc2)).toBe(doc2Hash);
    expect(restoredDoc1.equals(doc1)).toBe(true);
    expect(restoredDoc2.equals(doc2)).toBe(true);

    // --- Uninstall the shadow track (from the "fresh machine" state): local
    // shadow dir must be removed and the remote ref must no longer resolve. ---
    const refName = `refs/plan-sync/${projectId}/omc/data`;
    expect(
      execFileSync("git", ["ls-remote", originRemote, refName], {
        encoding: "utf8",
      }).trim(),
    ).not.toBe("");

    expect(run(["uninstall", "--track", "shadow"]).exitCode).toBe(0);

    expect(fs.existsSync(freshShadowRepoPath)).toBe(false);
    expect(
      execFileSync("git", ["ls-remote", originRemote, refName], {
        encoding: "utf8",
      }).trim(),
    ).toBe("");
  });
});
