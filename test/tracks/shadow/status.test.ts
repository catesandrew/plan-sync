import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as shadowInit } from "../../../src/tracks/shadow/init";
import { run as shadowPush } from "../../../src/tracks/shadow/push";
import { run as shadowStatus } from "../../../src/tracks/shadow/status";
import { resolveProjectId, resolveShadowRepoPath } from "../../../src/tracks/shadow/paths";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("status --track shadow (integration)", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-shadow-status-"));
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

  it("reports not-initialized (and throws, signaling a non-zero exit) when there's no shadow repo", () => {
    expect(() => shadowStatus([])).toThrow(/STALE/);
  });

  it("reports OK with a recent timestamp right after a push", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "hello\n");
    shadowPush([]);

    expect(() => shadowStatus([])).not.toThrow();
  });

  it("reports STALE and throws when the last push is older than --stale-after", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "hello\n");
    shadowPush([]);

    // A push that "just happened" is still older than a 0h threshold (any
    // positive elapsed time exceeds a zero-length freshness window), so
    // this deterministically exercises the STALE path without a real
    // sleep().
    expect(() => shadowStatus(["--stale-after", "0h"])).toThrow(/STALE/);
  });

  it("treats a push whose commit timestamp was rewritten into the past as stale", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "hello\n");
    shadowPush([]);

    const projectId = resolveProjectId(anchorRepo);
    const shadowRepoPath = resolveShadowRepoPath(projectId, ".omc", {
      env: { PLAN_SYNC_STATE_DIR: stateDir },
    });
    const gitDir = `--git-dir=${shadowRepoPath}`;
    const refName = `refs/plan-sync/${projectId}/omc/data`;

    // Rewrite the pushed commit's committer date to 2 days ago and move
    // both the local mirror ref and the "origin" ref to point at it.
    const oldSha = execFileSync("git", [gitDir, "rev-parse", refName], {
      encoding: "utf8",
    }).trim();
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const treeSha = execFileSync("git", [gitDir, "rev-parse", `${oldSha}^{tree}`], {
      encoding: "utf8",
    }).trim();
    const rewrittenSha = execFileSync(
      "git",
      [gitDir, "commit-tree", treeSha, "-m", "backdated"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: twoDaysAgo,
          GIT_COMMITTER_DATE: twoDaysAgo,
        },
      },
    ).trim();
    execFileSync("git", [gitDir, "update-ref", refName, rewrittenSha]);
    execFileSync("git", [gitDir, "push", "--force", "origin", `${rewrittenSha}:${refName}`]);

    expect(() => shadowStatus([])).toThrow(/STALE/);
    expect(() => shadowStatus(["--stale-after", "7d"])).not.toThrow();
  });
});
