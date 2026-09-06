import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as shadowInit } from "../../../src/tracks/shadow/init";
import { run as shadowPush } from "../../../src/tracks/shadow/push";
import { run as shadowRestore } from "../../../src/tracks/shadow/restore";
import { resolveProjectId, resolveShadowRepoPath } from "../../../src/tracks/shadow/paths";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("restore --track shadow (integration)", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-shadow-restore-"));
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

  function writeOmcFileBuffer(relPath: string, content: Buffer): void {
    const filePath = path.join(anchorRepo, ".omc", relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  function writeOmcFile(relPath: string, content: string): void {
    writeOmcFileBuffer(relPath, Buffer.from(content, "utf8"));
  }

  /**
   * Simulates restoring on a fresh machine: points OMC_STATE_DIR at a brand
   * new temp dir, then re-runs `init --track shadow` against the *same*
   * remote so the local shadow repo is a fresh clone-equivalent rather than
   * the same on-disk repo that pushed.
   */
  function switchToFreshMachine(): void {
    const freshStateDir = path.join(tmpDir, `state-dir-fresh-${crypto.randomUUID()}`);
    process.env.OMC_STATE_DIR = freshStateDir;
    shadowInit([]);
  }

  it("throws a clear error when the shadow repo hasn't been initialized", () => {
    expect(() => shadowRestore([])).toThrow(/init --track shadow/);
  });

  it("AC-B2 (genuine): a file deleted locally (manifest left unchanged) then pushed is absent after restore against a fresh shadow clone", () => {
    shadowInit([]);
    writeManifest(["keep.md", "gone.md"]);
    writeOmcFile("keep.md", "keep me\n");
    writeOmcFile("gone.md", "delete me\n");
    shadowPush([]);

    // Delete locally WITHOUT touching the manifest — this is the real,
    // ordinary deletion workflow (there's no `unallow` command): the
    // manifest still lists "gone.md" even though the file is gone. push.ts
    // must skip it gracefully (not crash) and genuinely leave it out of the
    // new tree.
    fs.rmSync(path.join(anchorRepo, ".omc", "gone.md"));
    shadowPush([]);

    switchToFreshMachine();

    // Simulate a pre-existing local copy on this "fresh machine" (e.g. left
    // over from an earlier restore), so this assertion proves restore
    // actively deletes it rather than merely observing it was already gone.
    writeOmcFile("gone.md", "stale copy that restore should delete\n");

    shadowRestore([]);

    expect(fs.existsSync(path.join(anchorRepo, ".omc", "keep.md"))).toBe(true);
    expect(fs.existsSync(path.join(anchorRepo, ".omc", "gone.md"))).toBe(false);
  });

  it("does not delete a local file that was never successfully synced (always scan-matched), even though absent from the target tree", () => {
    shadowInit([]);
    writeManifest(["keep.md", "secret.md"]);
    writeOmcFile("keep.md", "keep me\n");
    // Always trips the advisory SSN-shape scan, so it never enters any
    // commit in the shadow ref's history.
    writeOmcFile("secret.md", "my ssn is 123-45-6789\n");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    shadowPush([]);
    stderrSpy.mockRestore();

    // Restore on the SAME machine (no fresh clone): secret.md is still on
    // disk, untouched by the never-synced scan-skip. Restore must not
    // delete it merely because it's absent from the target tree and
    // present in the manifest.
    shadowRestore([]);

    expect(fs.existsSync(path.join(anchorRepo, ".omc", "keep.md"))).toBe(true);
    expect(fs.existsSync(path.join(anchorRepo, ".omc", "secret.md"))).toBe(true);
    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "secret.md"), "utf8")).toBe(
      "my ssn is 123-45-6789\n",
    );
  });

  it("AC-B3: push/restore round-trip is byte-for-byte identical for CRLF content", () => {
    shadowInit([]);
    writeManifest(["crlf.md"]);
    const original = Buffer.from("line one\r\nline two\r\nline three\r\n", "utf8");
    writeOmcFileBuffer("crlf.md", original);
    const originalHash = crypto.createHash("sha256").update(original).digest("hex");
    shadowPush([]);

    // Remove locally to prove restore rewrites it (not merely "already
    // there"), then restore from a fresh clone.
    fs.rmSync(path.join(anchorRepo, ".omc", "crlf.md"));
    switchToFreshMachine();
    shadowRestore([]);

    const restored = fs.readFileSync(path.join(anchorRepo, ".omc", "crlf.md"));
    const restoredHash = crypto.createHash("sha256").update(restored).digest("hex");
    expect(restoredHash).toBe(originalHash);
    expect(restored.equals(original)).toBe(true);
  });

  it("supports a --ref override pointing at an explicit sha", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "version one\n");
    shadowPush([]);

    const projectId = resolveProjectId(anchorRepo);
    const shadowRepoPath = resolveShadowRepoPath(projectId, {
      env: { OMC_STATE_DIR: stateDir },
    });
    const refName = `refs/omc/${projectId}/data`;
    const firstSha = execFileSync(
      "git",
      [`--git-dir=${shadowRepoPath}`, "rev-parse", refName],
      { encoding: "utf8" },
    ).trim();

    writeOmcFile("a.md", "version two\n");
    shadowPush([]);

    fs.rmSync(path.join(anchorRepo, ".omc", "a.md"));
    shadowRestore(["--ref", firstSha]);

    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "a.md"), "utf8")).toBe(
      "version one\n",
    );
  });

  it("N2: a symlink at a manifest-listed destination path is not clobbered by restore", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "repo content\n");
    shadowPush([]);

    const outsideFile = path.join(tmpDir, "OUTSIDE.txt");
    fs.writeFileSync(outsideFile, "original outside content\n");

    // Replace the local file with a symlink pointing outside the repo,
    // simulating an attacker (or a bad merge) having swapped it out before
    // restore runs.
    fs.rmSync(path.join(anchorRepo, ".omc", "a.md"));
    fs.symlinkSync(outsideFile, path.join(anchorRepo, ".omc", "a.md"));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    shadowRestore([]);
    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    stderrSpy.mockRestore();

    expect(warnings).toContain("a.md");
    // The outside file's content must be untouched — restore must refuse to
    // write through the symlink rather than following it.
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("original outside content\n");
    expect(fs.lstatSync(path.join(anchorRepo, ".omc", "a.md")).isSymbolicLink()).toBe(true);
  });

  it("N2: a symlinked directory component under .omc/ does not allow restore to write outside the repo", () => {
    shadowInit([]);
    writeManifest(["plans/foo.md"]);
    writeOmcFile("plans/foo.md", "plan content\n");
    shadowPush([]);

    // Replace the local `.omc/plans` directory with a symlink pointing at a
    // directory outside the repo.
    fs.rmSync(path.join(anchorRepo, ".omc", "plans"), { recursive: true, force: true });
    const outsideDir = path.join(tmpDir, "outside-plans");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(anchorRepo, ".omc", "plans"));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    shadowRestore([]);
    stderrSpy.mockRestore();

    // The file must never have been written through the symlinked
    // directory component into the outside directory.
    expect(fs.existsSync(path.join(outsideDir, "foo.md"))).toBe(false);
  });

  it("N3: a DANGLING symlink at a manifest-listed destination path is not silently created-through by restore", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "repo content\n");
    shadowPush([]);

    // Replace the local file with a symlink pointing at a target that does
    // not exist anywhere — `fs.existsSync` follows symlinks and would
    // report this path as "not existing" (since the target is missing),
    // which could cause a naive existsSync-based guard to treat it as a
    // fresh, safe write target and create straight through it.
    fs.rmSync(path.join(anchorRepo, ".omc", "a.md"));
    const danglingTarget = path.join(tmpDir, "does-not-exist.txt");
    fs.symlinkSync(danglingTarget, path.join(anchorRepo, ".omc", "a.md"));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    shadowRestore([]);
    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    stderrSpy.mockRestore();

    expect(warnings).toContain("a.md");
    // The dangling symlink itself must be left exactly as-is — restore must
    // refuse to write through it rather than silently creating a real file
    // at that path (which would follow the dangling link and land nowhere,
    // or clobber it).
    expect(fs.lstatSync(path.join(anchorRepo, ".omc", "a.md")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(danglingTarget)).toBe(false);
  });

  it("N3: a symlinked directory ancestor at depth >=2 below the write target still does not allow restore to escape", () => {
    shadowInit([]);
    writeManifest(["a/b/c/deep.md"]);
    writeOmcFile("a/b/c/deep.md", "deep content\n");
    shadowPush([]);

    // Replace the local `.omc/a` directory (two levels above the write
    // target `.omc/a/b/c/deep.md`) with a symlink pointing outside the
    // repo. The immediate parent (`.omc/a/b/c`) does NOT exist on disk at
    // all, so a guard that only checks the immediate parent would see
    // "doesn't exist yet" and treat this as a safe, ordinary first write —
    // missing the symlinked ancestor two levels up entirely.
    fs.rmSync(path.join(anchorRepo, ".omc", "a"), { recursive: true, force: true });
    const outsideDir = path.join(tmpDir, "outside-deep-a");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(anchorRepo, ".omc", "a"));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    shadowRestore([]);
    stderrSpy.mockRestore();

    // The file must never have been written through the symlinked
    // ancestor, at any depth below it, into the outside directory.
    expect(fs.existsSync(path.join(outsideDir, "b", "c", "deep.md"))).toBe(false);
  });

  it("US-010: a symlinked directory component under .omc/ does not allow restore's DELETE path to remove a file outside the repo", () => {
    shadowInit([]);
    writeManifest(["plans/foo.md"]);
    writeOmcFile("plans/foo.md", "plan content\n");
    shadowPush([]);

    // Delete locally (manifest left unchanged, the ordinary deletion
    // workflow) and push again, so the shadow ref's own history shows this
    // path was genuinely synced then genuinely removed — restore's delete
    // loop will therefore attempt to remove it.
    fs.rmSync(path.join(anchorRepo, ".omc", "plans", "foo.md"));
    shadowPush([]);

    // Replace the local `.omc/plans` directory with a symlink pointing at a
    // directory outside the repo, containing a same-named file that must
    // never be touched.
    fs.rmSync(path.join(anchorRepo, ".omc", "plans"), { recursive: true, force: true });
    const outsideDir = path.join(tmpDir, "outside-plans-delete");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "foo.md");
    fs.writeFileSync(outsideFile, "outside content that must survive\n");
    fs.symlinkSync(outsideDir, path.join(anchorRepo, ".omc", "plans"));

    switchToFreshMachine();
    shadowRestore([]);

    // The delete path must never have followed the symlinked directory
    // component to remove the file outside the repo.
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe(
      "outside content that must survive\n",
    );
  });

  it("does not touch manifest-scoped files that are still present in the target tree", () => {
    shadowInit([]);
    writeManifest(["a.md", "b.md"]);
    writeOmcFile("a.md", "a content\n");
    writeOmcFile("b.md", "b content\n");
    shadowPush([]);

    switchToFreshMachine();
    shadowRestore([]);

    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "a.md"), "utf8")).toBe(
      "a content\n",
    );
    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "b.md"), "utf8")).toBe(
      "b content\n",
    );
  });
});
