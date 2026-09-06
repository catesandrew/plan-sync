import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as shadowInit } from "../../../src/tracks/shadow/init";
import { resolveProjectId, resolveShadowRepoPath } from "../../../src/tracks/shadow/paths";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("init --track shadow (integration)", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-shadow-init-"));
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

  it("creates the shadow bare repo, configures it, and wires the anchor's origin, without dirtying the anchor repo", () => {
    shadowInit([]);

    const projectId = resolveProjectId(anchorRepo);
    const shadowRepoPath = resolveShadowRepoPath(projectId, {
      env: { OMC_STATE_DIR: stateDir },
    });

    expect(shadowRepoPath).toBe(
      path.join(stateDir, projectId, "omc-shadow.git"),
    );
    expect(fs.existsSync(shadowRepoPath)).toBe(true);
    expect(fs.statSync(path.join(shadowRepoPath, "HEAD")).isFile()).toBe(true);

    const gitDirFlag = `--git-dir=${shadowRepoPath}`;

    expect(
      execFileSync("git", [gitDirFlag, "config", "core.autocrlf"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("false");

    const attributesPath = path.join(shadowRepoPath, "info", "attributes");
    expect(fs.existsSync(attributesPath)).toBe(true);
    expect(fs.readFileSync(attributesPath, "utf8")).toContain("-text");

    expect(
      execFileSync("git", [gitDirFlag, "remote", "get-url", "origin"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(originRemote);

    const excludeContents = fs.readFileSync(
      path.join(anchorRepo, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludeContents.split("\n")).toContain(".omc/");

    expect(git(anchorRepo, ["status", "--short"])).toBe("");
  });

  it("is idempotent: running init twice does not duplicate the exclude entry or fail", () => {
    shadowInit([]);
    shadowInit([]);

    const excludeContents = fs.readFileSync(
      path.join(anchorRepo, ".git", "info", "exclude"),
      "utf8",
    );
    const excludeLines = excludeContents
      .split("\n")
      .filter((line) => line === ".omc/");
    expect(excludeLines).toHaveLength(1);

    expect(git(anchorRepo, ["status", "--short"])).toBe("");
  });

  it("does not duplicate the exclude entry when .omc/ was already added by a prior (e.g. Part A) init", () => {
    const excludePath = path.join(anchorRepo, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.writeFileSync(excludePath, "some-other-local-only-file\n.omc/\n");

    shadowInit([]);

    const excludeContents = fs.readFileSync(excludePath, "utf8");
    const excludeLines = excludeContents
      .split("\n")
      .filter((line) => line === ".omc/");
    expect(excludeLines).toHaveLength(1);
  });

  it("uses an explicit --remote flag instead of the anchor's origin when given", () => {
    const explicitRemote = path.join(tmpDir, "explicit-remote.git");
    execFileSync("git", ["init", "--bare", explicitRemote]);

    shadowInit(["--remote", explicitRemote]);

    const projectId = resolveProjectId(anchorRepo);
    const shadowRepoPath = resolveShadowRepoPath(projectId, {
      env: { OMC_STATE_DIR: stateDir },
    });

    expect(
      execFileSync(
        "git",
        [`--git-dir=${shadowRepoPath}`, "remote", "get-url", "origin"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe(explicitRemote);
  });

  it("US-010: succeeds when run inside a linked git worktree, where .git is a file, not a directory", () => {
    const worktreePath = path.join(tmpDir, "anchor-worktree");
    execFileSync(
      "git",
      ["worktree", "add", "-b", "wt-branch", worktreePath],
      { cwd: anchorRepo, stdio: "pipe" },
    );

    // Confirm the fixture actually exercises the case under test: .git in
    // the linked worktree is a file (a "gitdir:" pointer), not a directory.
    expect(fs.statSync(path.join(worktreePath, ".git")).isFile()).toBe(true);

    process.chdir(worktreePath);
    expect(() => shadowInit([])).not.toThrow();

    // info/exclude is shared repo-wide (not per-worktree) — the entry must
    // land in the main repo's shared .git/info/exclude, correctly resolved
    // via `git rev-parse --git-path info/exclude` rather than a hardcoded
    // `path.join(repoRoot, ".git", "info", "exclude")`, which would resolve
    // to a nonexistent path since `repoRoot` here is the worktree and its
    // `.git` is a file, not a directory.
    const excludeContents = fs.readFileSync(
      path.join(anchorRepo, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludeContents.split("\n")).toContain(".omc/");

    const projectId = resolveProjectId(worktreePath);
    const shadowRepoPath = resolveShadowRepoPath(projectId, {
      env: { OMC_STATE_DIR: stateDir },
    });
    expect(fs.existsSync(shadowRepoPath)).toBe(true);
  });
});
