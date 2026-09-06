import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../../src/cli";
import { resolveProjectId, resolveShadowRefName, resolveShadowRepoPath } from "../../src/tracks/shadow/paths";

/**
 * Feature: configurable `--root <dir>` flag, generalizing the previously
 * hardcoded `.omc` directory into "one root per invocation" (`.omc`, `.omx`,
 * `.adlc`, ...). Exercised through the real CLI dispatcher, mirroring the
 * other test/e2e/*.test.ts files, to catch wiring gaps a track-module-level
 * unit test wouldn't see.
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

describe("e2e: --root <dir> flag (via CLI dispatch)", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalPlanSyncStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-e2e-root-"));
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
    originalPlanSyncStateDir = process.env.PLAN_SYNC_STATE_DIR;
    process.env.PLAN_SYNC_STATE_DIR = stateDir;
    process.chdir(anchorRepo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalPlanSyncStateDir === undefined) {
      delete process.env.PLAN_SYNC_STATE_DIR;
    } else {
      process.env.PLAN_SYNC_STATE_DIR = originalPlanSyncStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--root .omx works end-to-end for the shadow track, producing files under .omx/ with its own manifest/config", () => {
    expect(run(["init", "--track", "shadow", "--root", ".omx"]).exitCode).toBe(0);

    fs.mkdirSync(path.join(anchorRepo, ".omx"), { recursive: true });
    fs.writeFileSync(path.join(anchorRepo, ".omx", "doc.md"), "hello from omx\n");

    expect(run(["allow", "doc.md", "--root", ".omx"]).exitCode).toBe(0);
    expect(run(["push", "--track", "shadow", "--root", ".omx"]).exitCode).toBe(0);
    expect(run(["status", "--track", "shadow", "--root", ".omx"]).exitCode).toBe(0);

    // Independent manifest/config under .omx/, never under .omc/.
    expect(fs.existsSync(path.join(anchorRepo, ".omx", ".sync-manifest"))).toBe(true);
    expect(fs.existsSync(path.join(anchorRepo, ".omx", ".sync-config.json"))).toBe(true);
    expect(fs.existsSync(path.join(anchorRepo, ".omc"))).toBe(false);

    fs.rmSync(path.join(anchorRepo, ".omx", "doc.md"));
    expect(run(["restore", "--track", "shadow", "--root", ".omx"]).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(anchorRepo, ".omx", "doc.md"), "utf8")).toBe(
      "hello from omx\n",
    );
  });

  it("--root .omx works end-to-end for the sibling track, producing files under .omx/ with its own manifest/config", () => {
    const clonePath = path.join(tmpDir, "sibling-clone-omx");
    expect(
      run([
        "init",
        "--track",
        "sibling",
        "--root",
        ".omx",
        "--remote",
        originRemote,
        "--clone-path",
        clonePath,
      ]).exitCode,
    ).toBe(0);

    fs.mkdirSync(path.join(anchorRepo, ".omx"), { recursive: true });
    fs.writeFileSync(path.join(anchorRepo, ".omx", "file.md"), "sibling omx content\n");

    expect(run(["allow", "file.md", "--root", ".omx"]).exitCode).toBe(0);
    expect(run(["push", "--track", "sibling", "--root", ".omx"]).exitCode).toBe(0);

    expect(fs.readFileSync(path.join(clonePath, "file.md"), "utf8")).toBe(
      "sibling omx content\n",
    );
    expect(fs.existsSync(path.join(anchorRepo, ".omx", ".sync-manifest"))).toBe(true);
    expect(fs.existsSync(path.join(anchorRepo, ".omx", ".sync-config.json"))).toBe(true);
    expect(fs.existsSync(path.join(anchorRepo, ".omc"))).toBe(false);

    expect(run(["status", "--track", "sibling", "--root", ".omx"]).exitCode).toBe(0);
    expect(run(["pull", "--track", "sibling", "--root", ".omx"]).exitCode).toBe(0);
  });

  it("auto-detects .omx when it's the only root with a .sync-config.json present, without any --root flag", () => {
    // Initialize ONLY under .omx — no .omc/ ever created in this repo.
    expect(run(["init", "--track", "shadow", "--root", ".omx"]).exitCode).toBe(0);
    expect(fs.existsSync(path.join(anchorRepo, ".omc"))).toBe(false);

    fs.mkdirSync(path.join(anchorRepo, ".omx"), { recursive: true });
    fs.writeFileSync(path.join(anchorRepo, ".omx", "auto.md"), "auto-detected\n");

    // No --root, no --track anywhere below — must resolve to .omx (the only
    // initialized root) and to "shadow" (the default persisted inside
    // .omx/.sync-config.json).
    expect(run(["allow", "auto.md"]).exitCode).toBe(0);
    expect(run(["push"]).exitCode).toBe(0);
    expect(run(["status"]).exitCode).toBe(0);

    expect(fs.existsSync(path.join(anchorRepo, ".omx", ".sync-manifest"))).toBe(true);
    expect(fs.existsSync(path.join(anchorRepo, ".omc"))).toBe(false);
  });

  it("two roots (.omc and .omx) initialized in the same repo produce distinct shadow refs/local shadow-repo paths and don't collide", () => {
    expect(run(["init", "--track", "shadow"]).exitCode).toBe(0); // default root: .omc
    expect(run(["init", "--track", "shadow", "--root", ".omx"]).exitCode).toBe(0);

    fs.mkdirSync(path.join(anchorRepo, ".omc"), { recursive: true });
    fs.mkdirSync(path.join(anchorRepo, ".omx"), { recursive: true });
    fs.writeFileSync(path.join(anchorRepo, ".omc", "omc-only.md"), "omc content\n");
    fs.writeFileSync(path.join(anchorRepo, ".omx", "omx-only.md"), "omx content\n");

    expect(run(["allow", "omc-only.md", "--root", ".omc"]).exitCode).toBe(0);
    expect(run(["allow", "omx-only.md", "--root", ".omx"]).exitCode).toBe(0);

    expect(run(["push", "--track", "shadow", "--root", ".omc"]).exitCode).toBe(0);
    expect(run(["push", "--track", "shadow", "--root", ".omx"]).exitCode).toBe(0);

    const projectId = resolveProjectId(anchorRepo);
    const omcShadowRepoPath = resolveShadowRepoPath(projectId, ".omc", {
      env: { PLAN_SYNC_STATE_DIR: stateDir },
    });
    const omxShadowRepoPath = resolveShadowRepoPath(projectId, ".omx", {
      env: { PLAN_SYNC_STATE_DIR: stateDir },
    });
    expect(omcShadowRepoPath).not.toBe(omxShadowRepoPath);
    expect(fs.existsSync(omcShadowRepoPath)).toBe(true);
    expect(fs.existsSync(omxShadowRepoPath)).toBe(true);

    const omcRefName = resolveShadowRefName(projectId, ".omc");
    const omxRefName = resolveShadowRefName(projectId, ".omx");
    expect(omcRefName).not.toBe(omxRefName);

    const omcTree = execFileSync(
      "git",
      [`--git-dir=${omcShadowRepoPath}`, "ls-tree", "-r", "--name-only", omcRefName],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .sort();
    const omxTree = execFileSync(
      "git",
      [`--git-dir=${omxShadowRepoPath}`, "ls-tree", "-r", "--name-only", omxRefName],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .sort();

    // Pushing to one root's shadow ref must never affect the other's tree.
    expect(omcTree).toEqual([".sync-manifest", "omc-only.md"]);
    expect(omxTree).toEqual([".sync-manifest", "omx-only.md"]);

    // Both refs are genuinely present on the shared remote, under distinct
    // names.
    expect(
      execFileSync("git", ["ls-remote", originRemote, omcRefName], {
        encoding: "utf8",
      }).trim(),
    ).not.toBe("");
    expect(
      execFileSync("git", ["ls-remote", originRemote, omxRefName], {
        encoding: "utf8",
      }).trim(),
    ).not.toBe("");
  });
});
