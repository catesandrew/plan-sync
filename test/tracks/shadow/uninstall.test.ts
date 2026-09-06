import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as shadowInit } from "../../../src/tracks/shadow/init";
import { run as shadowPush } from "../../../src/tracks/shadow/push";
import { run as shadowUninstall } from "../../../src/tracks/shadow/uninstall";
import { resolveProjectId, resolveShadowRepoPath } from "../../../src/tracks/shadow/paths";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("uninstall --track shadow (integration)", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-shadow-uninstall-"));
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

  it("removes the local shadow repo directory and the remote ref after init + push", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "hello\n");
    shadowPush([]);

    const projectId = resolveProjectId(anchorRepo);
    const shadowRepoPath = resolveShadowRepoPath(projectId, {
      env: { OMC_STATE_DIR: stateDir },
    });
    const refName = `refs/omc/${projectId}/data`;

    expect(fs.existsSync(shadowRepoPath)).toBe(true);
    expect(
      execFileSync("git", ["ls-remote", originRemote, refName], { encoding: "utf8" }).trim(),
    ).not.toBe("");

    shadowUninstall([]);

    expect(fs.existsSync(shadowRepoPath)).toBe(false);
    expect(
      execFileSync("git", ["ls-remote", originRemote, "refs/omc/*"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("");
  });

  it("does not touch the anchor repo's exclude entry or manifest", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "hello\n");
    shadowPush([]);

    const excludeBefore = fs.readFileSync(
      path.join(anchorRepo, ".git", "info", "exclude"),
      "utf8",
    );
    const manifestPath = path.join(anchorRepo, ".omc", ".sync-manifest");
    const manifestBefore = fs.readFileSync(manifestPath, "utf8");

    shadowUninstall([]);

    expect(
      fs.readFileSync(path.join(anchorRepo, ".git", "info", "exclude"), "utf8"),
    ).toBe(excludeBefore);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
    // The manifest-scoped file on disk survives uninstall too — only the
    // shadow track's own state (the bare repo + remote ref) is removed.
    expect(fs.existsSync(path.join(anchorRepo, ".omc", "a.md"))).toBe(true);
  });

  it("is a safe no-op when there is nothing to uninstall", () => {
    expect(() => shadowUninstall([])).not.toThrow();
  });

  it("tolerates the remote ref already being absent (e.g. a second uninstall run)", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "hello\n");
    shadowPush([]);

    shadowUninstall([]);

    // Re-init (so the local shadow repo directory exists again, wired to
    // the same now-ref-less origin) and uninstall again — the remote ref
    // delete should be tolerated as a no-op rather than throwing.
    shadowInit([]);
    expect(() => shadowUninstall([])).not.toThrow();
  });
});
