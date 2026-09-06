import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../../src/cli";
import { resolveProjectId, resolveShadowRepoPath } from "../../src/tracks/shadow/paths";

/**
 * US-008 (AC-3): simulates a broken push (an unreachable shadow-repo
 * `origin`) through the real CLI dispatcher and confirms:
 *   - the broken `push --track shadow` attempt throws clearly (non-zero
 *     exit, non-empty stderr) rather than silently succeeding;
 *   - `status --track shadow` afterwards still reports the *last known-good*
 *     push's age accurately (status derives purely from the shadow repo's
 *     own local mirror ref, which a failed push never advances); and
 *   - a short `--stale-after` correctly flags that same last-known-good push
 *     as STALE once the threshold is exceeded.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

describe("e2e: observability — broken push and status staleness (via CLI dispatch)", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-e2e-observability-"));
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

  function writeOmcFile(relPath: string, content: string): void {
    const filePath = path.join(anchorRepo, ".omc", relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  it("a broken push throws clearly, and status still reports the last known-good push (fresh, then STALE)", () => {
    expect(run(["init", "--track", "shadow"]).exitCode).toBe(0);

    writeOmcFile("a.md", "first version\n");
    expect(run(["allow", "a.md"]).exitCode).toBe(0);

    // --- Baseline: a real, successful push. ---
    expect(run(["push", "--track", "shadow"]).exitCode).toBe(0);

    const statusAfterGoodPush = run(["status", "--track", "shadow"]);
    expect(statusAfterGoodPush.exitCode).toBe(0);
    expect(statusAfterGoodPush.stdout).toContain("OK");

    // --- Break the shadow repo's own "origin" so the *next* push attempt
    // fails, without touching the real remote (which still holds the good
    // baseline ref). ---
    const projectId = resolveProjectId(anchorRepo);
    const shadowRepoPath = resolveShadowRepoPath(projectId, ".omc", {
      env: { PLAN_SYNC_STATE_DIR: stateDir },
    });
    const bogusRemote = path.join(tmpDir, "does-not-exist.git");
    execFileSync("git", [
      `--git-dir=${shadowRepoPath}`,
      "remote",
      "set-url",
      "origin",
      bogusRemote,
    ]);

    // New content so the push actually attempts a `git push` (rather than
    // short-circuiting on "nothing to push").
    writeOmcFile("a.md", "second version — should fail to push\n");

    const brokenPushResult = run(["push", "--track", "shadow"]);
    expect(brokenPushResult.exitCode).not.toBe(0);
    expect(brokenPushResult.stderr).toContain("push --track shadow");

    // The real remote must be untouched by the failed push attempt.
    const refName = `refs/plan-sync/${projectId}/omc/data`;
    const remoteRefStillGood = execFileSync(
      "git",
      ["ls-remote", originRemote, refName],
      { encoding: "utf8" },
    ).trim();
    expect(remoteRefStillGood).not.toBe("");

    // --- status must still surface the last known-good push's age
    // accurately: the shadow repo's own local mirror ref (what status
    // reads) was only ever advanced by the successful baseline push, never
    // by the failed one. ---
    const statusAfterBrokenPush = run(["status", "--track", "shadow"]);
    expect(statusAfterBrokenPush.exitCode).toBe(0);
    expect(statusAfterBrokenPush.stdout).toContain("OK");
    expect(statusAfterBrokenPush.stdout).toMatch(/last push/i);

    // --- With a short --stale-after, the same last-known-good push is
    // correctly flagged as STALE (any positive elapsed time exceeds a
    // zero-length freshness window — no sleep() needed). ---
    const staleResult = run(["status", "--track", "shadow", "--stale-after", "0h"]);
    expect(staleResult.exitCode).not.toBe(0);
    expect(staleResult.stdout).toContain("STALE");
  });
});
