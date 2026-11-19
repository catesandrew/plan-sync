import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptLegacyShadow } from "../../../src/tracks/shadow/migrate";
import {
  resolveLegacyProjectId,
  resolveProjectId,
  resolveShadowRefName,
  resolveShadowRepoPath,
} from "../../../src/tracks/shadow/paths";

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input }).trim();
}

describe("legacy shadow-id migration", () => {
  let tmpDir: string;
  let anchor: string;
  let origin: string;
  let originalCwd: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-migrate-"));
    anchor = path.join(tmpDir, "anchor");
    origin = path.join(tmpDir, "origin.git");
    const other = path.join(tmpDir, "other");
    execFileSync("git", ["init", "--bare", "--quiet", origin]);
    for (const [dir, msg] of [[anchor, "root a"], [other, "root b"]] as const) {
      fs.mkdirSync(dir, { recursive: true });
      git(dir, ["init", "--quiet"]);
      git(dir, ["config", "user.name", "T"]);
      git(dir, ["config", "user.email", "t@example.com"]);
      git(dir, ["commit", "--allow-empty", "--quiet", "-m", msg]);
    }
    // Two roots: the id now differs from the legacy (smallest-root) id.
    git(anchor, ["fetch", "--quiet", other]);
    git(anchor, ["merge", "--allow-unrelated-histories", "--quiet", "-m", "merge", "FETCH_HEAD"]);
    git(anchor, ["remote", "add", "origin", origin]);

    originalCwd = process.cwd();
    originalStateDir = process.env.PLAN_SYNC_STATE_DIR;
    process.env.PLAN_SYNC_STATE_DIR = path.join(tmpDir, "state");
    process.chdir(anchor);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalStateDir === undefined) delete process.env.PLAN_SYNC_STATE_DIR;
    else process.env.PLAN_SYNC_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A shadow repo as the old tool left it: legacy path, legacy ref, pushed to origin. */
  function seedLegacyShadow(): { legacyPath: string; legacyTip: string } {
    const legacyPath = resolveShadowRepoPath(resolveLegacyProjectId(anchor), ".omc");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    execFileSync("git", ["init", "--bare", "--quiet", legacyPath]);
    const g = `--git-dir=${legacyPath}`;
    const blob = git(anchor, [g, "hash-object", "-w", "--stdin"], "v1\n");
    const tree = git(anchor, [g, "mktree"], `100644 blob ${blob}\ta.md\n`);
    const tip = git(anchor, [g, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit-tree", tree, "-m", "legacy"]);
    const ref = resolveShadowRefName(resolveLegacyProjectId(anchor), ".omc");
    git(anchor, [g, "update-ref", ref, tip]);
    git(anchor, [g, "push", origin, `${ref}:${ref}`]);
    return { legacyPath, legacyTip: tip };
  }

  it("gives a fresh shadow repo for the new id, seeded from this origin's legacy ref", () => {
    const { legacyPath, legacyTip } = seedLegacyShadow();
    expect(resolveProjectId(anchor)).not.toBe(resolveLegacyProjectId(anchor));

    adoptLegacyShadow(anchor, ".omc");

    const id = resolveProjectId(anchor);
    const newPath = resolveShadowRepoPath(id, ".omc");
    expect(fs.existsSync(newPath)).toBe(true);
    expect(git(anchor, [`--git-dir=${newPath}`, "rev-parse", resolveShadowRefName(id, ".omc")])).toBe(legacyTip);
    // The legacy dir is left alone: a sibling repo may still be using it.
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("does nothing when the repo was never initialised under the legacy id", () => {
    adoptLegacyShadow(anchor, ".omc");

    expect(fs.existsSync(resolveShadowRepoPath(resolveProjectId(anchor), ".omc"))).toBe(false);
  });
});
