import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as pullRun } from "../src/commands/pull";
import { run as shadowInit } from "../src/tracks/shadow/init";
import { run as shadowPush } from "../src/tracks/shadow/push";
import { resolveProjectId, resolveShadowRepoPath } from "../src/tracks/shadow/paths";
import { defaultManifestPath, readManifest } from "../src/manifest";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * `pull --track shadow` now absorbs what used to be the separate top-level
 * `restore` command (see src/commands/pull.ts, which routes `--track shadow`
 * straight into the unchanged src/tracks/shadow/restore.ts implementation).
 * These tests exercise that routing through the `pull` command wrapper
 * itself (not the track module directly), adapted from the equivalent
 * restore-focused coverage in test/tracks/shadow/restore.test.ts and
 * test/tracks/shadow/manifest-travel.test.ts.
 */
describe("pull --track shadow (command wrapper)", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalPlanSyncStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-pull-shadow-"));
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

  function switchToFreshMachine(): void {
    const freshStateDir = path.join(tmpDir, `state-dir-fresh-${crypto.randomUUID()}`);
    process.env.PLAN_SYNC_STATE_DIR = freshStateDir;
    shadowInit([]);
  }

  it("materializes the target ref's tree and deletes genuinely-removed paths, identical to the old 'restore --track shadow' behavior", () => {
    shadowInit([]);
    writeManifest(["keep.md", "gone.md"]);
    writeOmcFile("keep.md", "keep me\n");
    writeOmcFile("gone.md", "delete me\n");
    shadowPush([]);

    // Ordinary deletion workflow: manifest still lists "gone.md" even though
    // the file is gone locally; push must still commit its genuine absence.
    fs.rmSync(path.join(anchorRepo, ".omc", "gone.md"));
    shadowPush([]);

    switchToFreshMachine();

    // Pre-existing stale local copy proves pull actively deletes it.
    writeOmcFile("gone.md", "stale copy that pull should delete\n");

    pullRun(["--track", "shadow"]);

    expect(fs.existsSync(path.join(anchorRepo, ".omc", "keep.md"))).toBe(true);
    expect(fs.existsSync(path.join(anchorRepo, ".omc", "gone.md"))).toBe(false);
  });

  it("merges the incoming manifest into a pre-existing local-only manifest (union, not overwrite), identical to the old restore behavior", () => {
    shadowInit([]);
    writeManifest(["one.md", "two.md"]);
    writeOmcFile("one.md", "first file\n");
    writeOmcFile("two.md", "second file\n");
    shadowPush([]);

    switchToFreshMachine();
    writeManifest(["local-only.md"]);
    writeOmcFile("local-only.md", "only known locally\n");

    pullRun(["--track", "shadow"]);

    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "one.md"), "utf8")).toBe(
      "first file\n",
    );
    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "two.md"), "utf8")).toBe(
      "second file\n",
    );

    const mergedManifest = readManifest(defaultManifestPath(anchorRepo)).sort();
    expect(mergedManifest).toEqual(["local-only.md", "one.md", "two.md"]);
    expect(
      fs.readFileSync(path.join(anchorRepo, ".omc", "local-only.md"), "utf8"),
    ).toBe("only known locally\n");
  });

  it("supports a --ref override pointing at an explicit sha, exactly as 'restore --track shadow --ref <sha>' used to", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "version one\n");
    shadowPush([]);

    const projectId = resolveProjectId(anchorRepo);
    const shadowRepoPath = resolveShadowRepoPath(projectId, ".omc", {
      env: { PLAN_SYNC_STATE_DIR: stateDir },
    });
    const refName = `refs/plan-sync/${projectId}/omc/data`;
    const firstSha = execFileSync(
      "git",
      [`--git-dir=${shadowRepoPath}`, "rev-parse", refName],
      { encoding: "utf8" },
    ).trim();

    writeOmcFile("a.md", "version two\n");
    shadowPush([]);

    fs.rmSync(path.join(anchorRepo, ".omc", "a.md"));
    pullRun(["--track", "shadow", "--ref", firstSha]);

    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "a.md"), "utf8")).toBe(
      "version one\n",
    );
  });
});
