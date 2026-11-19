import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkShadowOwner } from "../../../src/tracks/shadow/owner";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("checkShadowOwner", () => {
  let tmpDir: string;
  let shadow: string;
  let repoA: string;
  let repoB: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-owner-")));
    shadow = path.join(tmpDir, "shadow.git");
    execFileSync("git", ["init", "--bare", "--quiet", shadow]);
    for (const name of ["a", "b"]) {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir);
      git(dir, ["init", "--quiet"]);
    }
    repoA = path.join(tmpDir, "a");
    repoB = path.join(tmpDir, "b");
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("claims an unowned shadow repo, then refuses a different repo (the cates-works/line-os incident)", () => {
    checkShadowOwner(shadow, repoA, true);

    expect(() => checkShadowOwner(shadow, repoB, true)).toThrow(/belongs to .*\/a\/\.git, not .*\/b\/\.git/);
    expect(() => checkShadowOwner(shadow, repoB, false)).toThrow(/belongs to/);
    expect(() => checkShadowOwner(shadow, repoA, true)).not.toThrow();
  });

  it("lets a linked worktree of the owning repo share the shadow repo", () => {
    git(repoA, ["-c", "user.name=t", "-c", "user.email=t@e.co", "commit", "--allow-empty", "--quiet", "-m", "x"]);
    const worktree = path.join(tmpDir, "wt");
    git(repoA, ["worktree", "add", "--quiet", worktree]);
    checkShadowOwner(shadow, repoA, true);

    expect(() => checkShadowOwner(shadow, worktree, true)).not.toThrow();
  });

  it("reclaims a shadow repo whose owning directory no longer exists", () => {
    checkShadowOwner(shadow, repoA, true);
    fs.rmSync(repoA, { recursive: true, force: true });

    expect(() => checkShadowOwner(shadow, repoB, true)).not.toThrow();
  });

  it("read-only status never claims", () => {
    checkShadowOwner(shadow, repoA, false);

    expect(() => checkShadowOwner(shadow, repoB, true)).not.toThrow();
  });
});
