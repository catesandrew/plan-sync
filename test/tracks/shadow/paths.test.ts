import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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

  it("derives an id from the origin remote URL when one is configured", () => {
    const id = resolveProjectId("/anchor/repo", {
      execFileSyncFn: ((_cmd: string, cliArgs: readonly string[]) => {
        if (cliArgs.includes("get-url")) {
          return "git@github.com:some-org/some-repo.git\n";
        }
        throw new Error("unexpected git invocation");
      }) as typeof import("node:child_process").execFileSync,
    });

    expect(id).toBe("github-com-some-org-some-repo");
  });

  it("is deterministic across repeated calls for the same repo", () => {
    const execFileSyncFn = ((_cmd: string, cliArgs: readonly string[]) => {
      if (cliArgs.includes("get-url")) {
        return "https://example.com/team/proj.git\n";
      }
      throw new Error("unexpected git invocation");
    }) as typeof import("node:child_process").execFileSync;

    const first = resolveProjectId("/anchor/repo", { execFileSyncFn });
    const second = resolveProjectId("/anchor/repo", { execFileSyncFn });

    expect(first).toBe(second);
  });

  it("falls back to the basename of the repo root when there is no origin remote", () => {
    const repoRoot = path.join(tmpDir, "my-repo-dir");
    fs.mkdirSync(repoRoot, { recursive: true });

    const id = resolveProjectId(repoRoot, {
      execFileSyncFn: (() => {
        throw new Error("fatal: no such remote 'origin'");
      }) as unknown as typeof import("node:child_process").execFileSync,
    });

    expect(id).toBe("my-repo-dir");
  });
});
