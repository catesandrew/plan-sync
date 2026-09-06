import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../../src/cli";

/**
 * US-008 (AC-1): exercises the full Part A (sibling track) lifecycle through
 * the real CLI dispatcher (`dispatch()` from src/cli.ts) rather than calling
 * the individual track modules directly, to catch wiring gaps between
 * `omc-sync <command> --track sibling ...` and the underlying track modules
 * that per-story unit/integration tests (test/tracks-sibling*.test.ts) don't
 * exercise.
 */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
}

const GIT_IDENTITY_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "omc-sync",
  GIT_AUTHOR_EMAIL: "omc-sync@localhost",
  GIT_COMMITTER_NAME: "omc-sync",
  GIT_COMMITTER_EMAIL: "omc-sync@localhost",
};

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

describe("e2e: sibling track full lifecycle (via CLI dispatch)", () => {
  let tmpRoot: string;
  let remoteBareDir: string;
  let anchorA: string;
  let cloneA: string;
  let anchorB: string;
  let cloneB: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-e2e-sibling-"));
    remoteBareDir = path.join(tmpRoot, "remote.git");
    anchorA = path.join(tmpRoot, "machine-a");
    cloneA = path.join(tmpRoot, "machine-a-clone");
    anchorB = path.join(tmpRoot, "machine-b");
    cloneB = path.join(tmpRoot, "machine-b-clone");

    git(["init", "--quiet", "--bare", remoteBareDir], tmpRoot);

    fs.mkdirSync(anchorA, { recursive: true });
    git(["init", "--quiet"], anchorA);
    git(["config", "user.name", "Test User"], anchorA);
    git(["config", "user.email", "test@example.com"], anchorA);

    fs.mkdirSync(anchorB, { recursive: true });
    git(["init", "--quiet"], anchorB);
    git(["config", "user.name", "Test User"], anchorB);
    git(["config", "user.email", "test@example.com"], anchorB);

    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("init -> allow -> push -> pull -> concurrent-edit conflict -> delete propagation, all through dispatch()", () => {
    // --- Machine A: init, allow two files, push. ---
    process.chdir(anchorA);
    expect(
      run([
        "init",
        "--track",
        "sibling",
        "--remote",
        remoteBareDir,
        "--clone-path",
        cloneA,
      ]).exitCode,
    ).toBe(0);

    fs.mkdirSync(path.join(anchorA, ".omc"), { recursive: true });
    fs.writeFileSync(path.join(anchorA, ".omc", "file1.md"), "content one\n");
    fs.writeFileSync(path.join(anchorA, ".omc", "file2.md"), "content two\n");

    expect(run(["allow", "file1.md"]).exitCode).toBe(0);
    expect(run(["allow", "file2.md"]).exitCode).toBe(0);
    expect(run(["push", "--track", "sibling"]).exitCode).toBe(0);

    // --- Machine B: init against the same remote, allow the same paths, pull. ---
    process.chdir(anchorB);
    expect(
      run([
        "init",
        "--track",
        "sibling",
        "--remote",
        remoteBareDir,
        "--clone-path",
        cloneB,
      ]).exitCode,
    ).toBe(0);
    expect(run(["allow", "file1.md"]).exitCode).toBe(0);
    expect(run(["allow", "file2.md"]).exitCode).toBe(0);
    expect(run(["pull", "--track", "sibling"]).exitCode).toBe(0);

    expect(fs.readFileSync(path.join(anchorB, ".omc", "file1.md"), "utf8")).toBe(
      "content one\n",
    );
    expect(fs.readFileSync(path.join(anchorB, ".omc", "file2.md"), "utf8")).toBe(
      "content two\n",
    );

    // --- Concurrent-edit conflict on a third, shared manifest entry. ---
    process.chdir(anchorA);
    fs.writeFileSync(path.join(anchorA, ".omc", "shared.md"), "base\n");
    expect(run(["allow", "shared.md"]).exitCode).toBe(0);
    expect(run(["push", "--track", "sibling"]).exitCode).toBe(0);

    process.chdir(anchorB);
    expect(run(["allow", "shared.md"]).exitCode).toBe(0);
    expect(run(["pull", "--track", "sibling"]).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(anchorB, ".omc", "shared.md"), "utf8")).toBe(
      "base\n",
    );

    process.chdir(anchorA);
    fs.writeFileSync(path.join(anchorA, ".omc", "shared.md"), "edited on A\n");
    expect(run(["push", "--track", "sibling"]).exitCode).toBe(0);

    process.chdir(anchorB);
    fs.writeFileSync(path.join(anchorB, ".omc", "shared.md"), "edited on B\n");
    fs.copyFileSync(
      path.join(anchorB, ".omc", "shared.md"),
      path.join(cloneB, "shared.md"),
    );
    execFileSync("git", ["add", "--", "shared.md"], { cwd: cloneB, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "B's local edit"], {
      cwd: cloneB,
      stdio: "pipe",
      env: GIT_IDENTITY_ENV,
    });

    const conflictResult = run(["pull", "--track", "sibling"]);
    expect(conflictResult.exitCode).not.toBe(0);
    expect(conflictResult.stderr).toMatch(/merge conflict/i);

    const conflictedContent = fs.readFileSync(
      path.join(cloneB, "shared.md"),
      "utf8",
    );
    expect(conflictedContent).toContain("<<<<<<<");
    expect(conflictedContent).toContain("=======");
    expect(conflictedContent).toContain(">>>>>>>");
    expect(conflictedContent).toContain("edited on A");
    expect(conflictedContent).toContain("edited on B");

    const conflictStatus = git(["status", "--short"], cloneB);
    expect(conflictStatus).toMatch(/rebase|UU|both modified/i);

    // --- Resolve/reset directly in the clone (plain git, not part of the
    // CLI surface under test): abort the failed rebase and discard B's
    // divergent local commit entirely by hard-resetting to match origin
    // (A's version wins) so B's clone is clean again and further push/pull
    // calls through the CLI don't keep hitting the same unresolved state. ---
    execFileSync("git", ["rebase", "--abort"], { cwd: cloneB, stdio: "pipe" });
    const cloneBBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], cloneB).trim();
    execFileSync("git", ["fetch", "origin"], { cwd: cloneB, stdio: "pipe" });
    execFileSync("git", ["reset", "--hard", `origin/${cloneBBranch}`], {
      cwd: cloneB,
      stdio: "pipe",
    });
    expect(git(["status", "--short"], cloneB).trim()).toBe("");

    // --- Delete propagation: delete file1.md on A, push, B pulls, confirms absence. ---
    process.chdir(anchorA);
    fs.rmSync(path.join(anchorA, ".omc", "file1.md"));
    expect(run(["push", "--track", "sibling"]).exitCode).toBe(0);
    expect(fs.existsSync(path.join(cloneA, "file1.md"))).toBe(false);

    process.chdir(anchorB);
    expect(run(["pull", "--track", "sibling"]).exitCode).toBe(0);
    expect(fs.existsSync(path.join(anchorB, ".omc", "file1.md"))).toBe(false);
    expect(fs.existsSync(path.join(cloneB, "file1.md"))).toBe(false);

    // B's own next push must not resurrect the deleted file, nor throw.
    const bPushResult = run(["push", "--track", "sibling"]);
    expect(bPushResult.exitCode).toBe(0);
    expect(fs.existsSync(path.join(anchorB, ".omc", "file1.md"))).toBe(false);
    expect(fs.existsSync(path.join(cloneB, "file1.md"))).toBe(false);
  });
});
