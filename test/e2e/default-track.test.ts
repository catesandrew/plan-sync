import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../../src/cli";

/**
 * Feature: default track persistence — `init --track <x>` persists `x` as
 * the default track in `.omc/.sync-config.json`, so subsequent multi-track
 * commands (`push`/`pull`/`restore`/`status`/`uninstall`) work without
 * repeating `--track` on every invocation. An explicit `--track` still
 * overrides the persisted default, and omitting both with no default ever
 * persisted still throws the original clear error.
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

describe("e2e: default track persistence (via CLI dispatch)", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-e2e-default-track-"));
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

  it("push/status/restore/uninstall work without --track after `init --track shadow` persisted the default", () => {
    expect(run(["init", "--track", "shadow"]).exitCode).toBe(0);

    fs.mkdirSync(path.join(anchorRepo, ".omc"), { recursive: true });
    fs.writeFileSync(path.join(anchorRepo, ".omc", "a.md"), "hello\n");
    expect(run(["allow", "a.md"]).exitCode).toBe(0);

    // No --track anywhere below — all must resolve via the persisted default.
    expect(run(["push"]).exitCode).toBe(0);
    expect(run(["status"]).exitCode).toBe(0);

    fs.rmSync(path.join(anchorRepo, ".omc", "a.md"));
    expect(run(["restore"]).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "a.md"), "utf8")).toBe(
      "hello\n",
    );

    expect(run(["uninstall"]).exitCode).toBe(0);
  });

  it("push/pull/status work without --track after `init --track sibling` persisted the default", () => {
    const clonePath = path.join(tmpDir, "sibling-clone");
    expect(
      run([
        "init",
        "--track",
        "sibling",
        "--remote",
        originRemote,
        "--clone-path",
        clonePath,
      ]).exitCode,
    ).toBe(0);

    fs.mkdirSync(path.join(anchorRepo, ".omc"), { recursive: true });
    fs.writeFileSync(path.join(anchorRepo, ".omc", "a.md"), "hello\n");
    expect(run(["allow", "a.md"]).exitCode).toBe(0);

    expect(run(["push"]).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(clonePath, "a.md"), "utf8")).toBe("hello\n");

    expect(run(["status"]).exitCode).toBe(0);
    expect(run(["pull"]).exitCode).toBe(0);
  });

  it("an explicit --track overrides the persisted default", () => {
    // Default persisted is "shadow", but a sibling clone is set up too — the
    // explicit --track sibling flag must win over the persisted default.
    expect(run(["init", "--track", "shadow"]).exitCode).toBe(0);

    const clonePath = path.join(tmpDir, "sibling-clone");
    expect(
      run([
        "init",
        "--track",
        "sibling",
        "--remote",
        originRemote,
        "--clone-path",
        clonePath,
      ]).exitCode,
    ).toBe(0);
    // The second init (sibling) persisted its own default — most-recently
    // initialized track wins, so the default is now "sibling". Explicitly
    // request "shadow" to prove the flag overrides whatever the default is.

    fs.mkdirSync(path.join(anchorRepo, ".omc"), { recursive: true });
    fs.writeFileSync(path.join(anchorRepo, ".omc", "a.md"), "hello\n");
    expect(run(["allow", "a.md"]).exitCode).toBe(0);

    expect(run(["push", "--track", "shadow"]).exitCode).toBe(0);

    // Confirm it actually went to the shadow ref, not the sibling clone.
    expect(fs.existsSync(path.join(clonePath, "a.md"))).toBe(false);
  });

  it("throws the original clear error when --track is omitted and no default has ever been persisted", () => {
    const result = run(["push"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--track is required");
  });
});
