import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveLegacyProjectId,
  resolveProjectId,
  resolveShadowRefName,
  resolveShadowRepoPath,
} from "../../../src/tracks/shadow/paths";

describe("resolveShadowRepoPath", () => {
  it("falls back to <homedir>/.cache/plan-sync-shadow/<projectId>/omc.git when PLAN_SYNC_STATE_DIR and XDG_CACHE_HOME are both unset", () => {
    const fakeHomedir = "/fake/home/testuser";

    const resolved = resolveShadowRepoPath("my-project", ".omc", {
      env: {},
      homedir: () => fakeHomedir,
    });

    expect(resolved).toBe(
      path.join(fakeHomedir, ".cache", "plan-sync-shadow", "my-project", "omc.git"),
    );
  });

  it("uses XDG_CACHE_HOME when set and PLAN_SYNC_STATE_DIR is unset", () => {
    const resolved = resolveShadowRepoPath("my-project", ".omc", {
      env: { XDG_CACHE_HOME: "/custom/cache" },
      homedir: () => "/fake/home/testuser",
    });

    expect(resolved).toBe(
      path.join("/custom/cache", "plan-sync-shadow", "my-project", "omc.git"),
    );
  });

  it("resolves under ${PLAN_SYNC_STATE_DIR}/<projectId>/<root>/plan-sync-shadow.git when PLAN_SYNC_STATE_DIR is set", () => {
    const resolved = resolveShadowRepoPath("my-project", ".omc", {
      env: { PLAN_SYNC_STATE_DIR: "/state/dir" },
      homedir: () => "/fake/home/testuser",
    });

    expect(resolved).toBe(
      path.join("/state/dir", "my-project", "omc", "plan-sync-shadow.git"),
    );
  });

  it("prefers PLAN_SYNC_STATE_DIR over XDG_CACHE_HOME when both are set", () => {
    const resolved = resolveShadowRepoPath("my-project", ".omc", {
      env: { PLAN_SYNC_STATE_DIR: "/state/dir", XDG_CACHE_HOME: "/custom/cache" },
      homedir: () => "/fake/home/testuser",
    });

    expect(resolved).toBe(
      path.join("/state/dir", "my-project", "omc", "plan-sync-shadow.git"),
    );
  });

  it("fails closed with a clear error when no home directory can be resolved, rather than silently building a repo-relative path (regression test)", () => {
    expect(() =>
      resolveShadowRepoPath("my-project", ".omc", {
        env: {},
        homedir: () => "",
      }),
    ).toThrow(/could not resolve a home directory/);
  });

  it("strips the leading dot from rootDir so two roots on the same project never collide", () => {
    const omcPath = resolveShadowRepoPath("my-project", ".omc", {
      env: { PLAN_SYNC_STATE_DIR: "/state/dir" },
    });
    const omxPath = resolveShadowRepoPath("my-project", ".omx", {
      env: { PLAN_SYNC_STATE_DIR: "/state/dir" },
    });

    expect(omcPath).toBe(path.join("/state/dir", "my-project", "omc", "plan-sync-shadow.git"));
    expect(omxPath).toBe(path.join("/state/dir", "my-project", "omx", "plan-sync-shadow.git"));
    expect(omcPath).not.toBe(omxPath);
  });
});

describe("resolveShadowRefName", () => {
  it("bakes the (dot-stripped) root segment into the ref name", () => {
    expect(resolveShadowRefName("my-project", ".omc")).toBe(
      "refs/plan-sync/my-project/omc/data",
    );
    expect(resolveShadowRefName("my-project", ".omx")).toBe(
      "refs/plan-sync/my-project/omx/data",
    );
  });
});

describe("resolveProjectId", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-projectid-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  function gitOut(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  function initRepoWithCommit(dir: string, message = "root"): void {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ["init", "--quiet"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    git(dir, ["commit", "--allow-empty", "--quiet", "-m", message]);
  }

  it("derives an id from the repo's root commit hash", () => {
    const id = resolveProjectId("/anchor/repo", {
      execFileSyncFn: ((_cmd: string, cliArgs: readonly string[]) => {
        if (cliArgs.includes("rev-list")) {
          return "abcdef0123456789abcdef0123456789abcdef01\n";
        }
        throw new Error("unexpected git invocation");
      }) as typeof import("node:child_process").execFileSync,
    });

    expect(id).toBe("abcdef012345");
  });

  it("is deterministic across repeated calls for the same repo", () => {
    const execFileSyncFn = ((_cmd: string, cliArgs: readonly string[]) => {
      if (cliArgs.includes("rev-list")) {
        return "111111111111111111111111111111111111111a\n";
      }
      throw new Error("unexpected git invocation");
    }) as typeof import("node:child_process").execFileSync;

    const first = resolveProjectId("/anchor/repo", { execFileSyncFn });
    const second = resolveProjectId("/anchor/repo", { execFileSyncFn });

    expect(first).toBe(second);
  });

  it("does NOT change when the origin remote URL is renamed (regression test)", () => {
    const repoRoot = path.join(tmpDir, "repo");
    initRepoWithCommit(repoRoot);
    git(repoRoot, ["remote", "add", "origin", "https://example.com/old/name.git"]);

    const idBefore = resolveProjectId(repoRoot);

    git(repoRoot, ["remote", "set-url", "origin", "https://example.com/new/renamed-repo.git"]);

    const idAfter = resolveProjectId(repoRoot);

    expect(idAfter).toBe(idBefore);
  });

  it("resolves to the identical project id for two separate clones of the same repo", () => {
    const sourceRepo = path.join(tmpDir, "source");
    initRepoWithCommit(sourceRepo);

    const clone1 = path.join(tmpDir, "clone1");
    const clone2 = path.join(tmpDir, "clone2");
    execFileSync("git", ["clone", "--quiet", sourceRepo, clone1], { encoding: "utf8" });
    execFileSync("git", ["clone", "--quiet", sourceRepo, clone2], { encoding: "utf8" });

    const id1 = resolveProjectId(clone1);
    const id2 = resolveProjectId(clone2);

    expect(id1).toBe(id2);
  });

  it("keeps a multi-root repo apart from a sibling that shares only some of its roots", () => {
    const repoA = path.join(tmpDir, "repo-a");
    const repoB = path.join(tmpDir, "repo-b");
    initRepoWithCommit(repoA);
    initRepoWithCommit(repoB, "other root");

    const roots = [
      gitOut(repoA, ["rev-list", "--max-parents=0", "HEAD"]),
      gitOut(repoB, ["rev-list", "--max-parents=0", "HEAD"]),
    ].sort();

    // A sibling clone of repoB: single root, so it keeps the legacy id.
    const sibling = path.join(tmpDir, "sibling");
    git(tmpDir, ["clone", "--quiet", repoB, sibling]);
    // Merge repoB into repoA: repoA now has both roots.
    git(repoA, ["fetch", "--quiet", repoB]);
    git(repoA, ["merge", "--allow-unrelated-histories", "--quiet", "-m", "merge", "FETCH_HEAD"]);

    const merged = resolveProjectId(repoA);
    expect(resolveLegacyProjectId(repoA)).toBe((roots[0] as string).slice(0, 12));
    expect(resolveProjectId(sibling)).toBe(gitOut(sibling, ["rev-list", "--max-parents=0", "HEAD"]).slice(0, 12));
    expect(merged).not.toBe(resolveProjectId(sibling));
    expect(resolveProjectId(repoA)).toBe(merged);
  });
});
