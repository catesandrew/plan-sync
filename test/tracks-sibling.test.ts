import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToManifest, defaultManifestPath } from "../src/manifest";
import * as siblingInit from "../src/tracks/sibling/init";
import * as siblingPush from "../src/tracks/sibling/push";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
}

describe("sibling track", () => {
  let tmpRoot: string;
  let anchorDir: string;
  let remoteBareDir: string;
  let clonePath: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-sibling-"));
    anchorDir = path.join(tmpRoot, "anchor");
    remoteBareDir = path.join(tmpRoot, "remote.git");
    clonePath = path.join(tmpRoot, "sibling-clone");

    fs.mkdirSync(anchorDir, { recursive: true });
    git(["init", "--quiet"], anchorDir);
    git(["init", "--quiet", "--bare", remoteBareDir], tmpRoot);

    originalCwd = process.cwd();
    process.chdir(anchorDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("AC-A1: init excludes .omc/ via .git/info/exclude and leaves git status clean", () => {
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]);

    const excludeContents = fs.readFileSync(
      path.join(anchorDir, ".git", "info", "exclude"),
      "utf8",
    );
    expect(
      excludeContents.split("\n").map((line) => line.trim()),
    ).toContain(".omc/");

    const status = git(["status", "--short"], anchorDir);
    expect(status.trim()).toBe("");
  });

  it("init throws a clear error naming the missing flag", () => {
    expect(() => siblingInit.run(["--clone-path", clonePath])).toThrow(
      /--remote/,
    );
    expect(() => siblingInit.run(["--remote", remoteBareDir])).toThrow(
      /--clone-path/,
    );
  });

  it("init is idempotent when clone-path already exists as a git repo", () => {
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]);
    expect(() =>
      siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]),
    ).not.toThrow();
  });

  it("US-010: succeeds when run inside a linked git worktree, where .git is a file, not a directory", () => {
    const worktreePath = path.join(tmpRoot, "anchor-worktree");
    execFileSync(
      "git",
      ["worktree", "add", "-b", "wt-branch", worktreePath],
      { cwd: anchorDir, stdio: "pipe" },
    );

    // Confirm the fixture actually exercises the case under test: .git in
    // the linked worktree is a file (a "gitdir:" pointer), not a directory.
    expect(fs.statSync(path.join(worktreePath, ".git")).isFile()).toBe(true);

    process.chdir(worktreePath);
    const worktreeClonePath = path.join(tmpRoot, "sibling-clone-worktree");
    expect(() =>
      siblingInit.run(["--remote", remoteBareDir, "--clone-path", worktreeClonePath]),
    ).not.toThrow();

    // info/exclude is shared repo-wide (not per-worktree) — the entry must
    // land in the main repo's shared .git/info/exclude, correctly resolved
    // via `git rev-parse --git-path info/exclude` rather than a hardcoded
    // `path.join(repoRoot, ".git", "info", "exclude")`, which would resolve
    // to a nonexistent path since `repoRoot` here is the worktree and its
    // `.git` is a file, not a directory.
    const excludeContents = fs.readFileSync(
      path.join(anchorDir, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludeContents.split("\n")).toContain(".omc/");
    expect(fs.existsSync(worktreeClonePath)).toBe(true);
  });

  it("AC-A4: init + allow two files + push results in exactly those files, committed, in the sibling clone", () => {
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]);

    const manifestPath = defaultManifestPath();
    fs.mkdirSync(path.join(anchorDir, ".omc", "plans"), { recursive: true });
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "notes.md"),
      "synced notes\n",
    );
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "plans", "foo.md"),
      "synced plan\n",
    );
    // Not in the manifest — must never be copied or pushed.
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "secret.md"),
      "unlisted\n",
    );

    addToManifest(manifestPath, "notes.md");
    addToManifest(manifestPath, "plans/foo.md");

    siblingPush.run([]);

    expect(fs.readFileSync(path.join(clonePath, "notes.md"), "utf8")).toBe(
      "synced notes\n",
    );
    expect(
      fs.readFileSync(path.join(clonePath, "plans", "foo.md"), "utf8"),
    ).toBe("synced plan\n");
    expect(fs.existsSync(path.join(clonePath, "secret.md"))).toBe(false);

    const trackedFiles = git(["ls-tree", "-r", "--name-only", "HEAD"], clonePath)
      .trim()
      .split("\n")
      .sort();
    expect(trackedFiles).toEqual(["notes.md", "plans/foo.md"]);

    const log = git(["log", "--oneline"], clonePath);
    expect(log.trim().split("\n").length).toBeGreaterThanOrEqual(1);

    // Confirm the push actually reached the remote, not just the local clone.
    const remoteTrackedFiles = execFileSync(
      "git",
      ["--git-dir", remoteBareDir, "ls-tree", "-r", "--name-only", "HEAD"],
      { stdio: "pipe" },
    )
      .toString()
      .trim()
      .split("\n")
      .sort();
    expect(remoteTrackedFiles).toEqual(["notes.md", "plans/foo.md"]);
  });

  it("push is a no-op (no error) when nothing new is staged", () => {
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]);

    const manifestPath = defaultManifestPath();
    fs.writeFileSync(path.join(anchorDir, ".omc", "notes.md"), "v1\n");
    addToManifest(manifestPath, "notes.md");

    siblingPush.run([]);
    expect(() => siblingPush.run([])).not.toThrow();
  });

  it("push throws a clear error when init hasn't been run", () => {
    expect(() => siblingPush.run([])).toThrow(/init --track sibling/);
  });

  it("a symlink under .omc/ pointing outside the repo is skipped, not dereferenced, by push", () => {
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]);

    const manifestPath = defaultManifestPath();
    const secretTarget = path.join(tmpRoot, "outside-secret.txt");
    fs.writeFileSync(secretTarget, "super secret content\n");

    fs.mkdirSync(path.join(anchorDir, ".omc"), { recursive: true });
    fs.symlinkSync(
      secretTarget,
      path.join(anchorDir, ".omc", "linked.md"),
    );
    // A regular, non-symlink manifest entry alongside the symlink, so the
    // push has something legitimate to commit (a manifest containing only a
    // skipped symlink would stage nothing at all, an unrelated pre-existing
    // edge case of pushing to a still-empty remote with no commit yet).
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "clean.md"),
      "clean content\n",
    );

    addToManifest(manifestPath, "linked.md");
    addToManifest(manifestPath, "clean.md");

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    siblingPush.run([]);

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(warnings).toContain("linked.md");
    stderrSpy.mockRestore();

    // The symlink must never have been dereferenced and copied into the
    // clone, so its target's secret content must not appear anywhere in
    // the clone's working tree or committed history.
    expect(fs.existsSync(path.join(clonePath, "linked.md"))).toBe(false);

    const log = git(["log", "-p", "--all"], clonePath);
    expect(log).not.toContain("super secret content");
  });

  it("N2: a symlinked directory component in the clone's destination path does not allow push to write outside the clone", () => {
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]);

    const manifestPath = defaultManifestPath();
    fs.mkdirSync(path.join(anchorDir, ".omc", "plans"), { recursive: true });
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "plans", "foo.md"),
      "plan content\n",
    );
    addToManifest(manifestPath, "plans/foo.md");
    // A regular, non-escaping manifest entry alongside the symlinked
    // directory component, so the push has something legitimate to commit
    // (a manifest containing only a skipped path would stage nothing at
    // all, an unrelated pre-existing edge case of pushing to a still-empty
    // remote with no commit yet).
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "clean.md"),
      "clean content\n",
    );
    addToManifest(manifestPath, "clean.md");

    // The clone's "plans" directory component is itself a symlink pointing
    // outside the clone's working tree.
    const outsideDir = path.join(tmpRoot, "outside-clone-plans");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(clonePath, "plans"));

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    siblingPush.run([]);

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(warnings).toContain("plans");
    stderrSpy.mockRestore();

    // The file content must never have been written through the symlinked
    // directory component into the outside directory.
    expect(fs.existsSync(path.join(outsideDir, "foo.md"))).toBe(false);
  });

  it("N3: a DANGLING symlink at the clone destination path is not silently created-through by push", () => {
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]);

    const manifestPath = defaultManifestPath();
    fs.mkdirSync(path.join(anchorDir, ".omc"), { recursive: true });
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "linked.md"),
      "new content\n",
    );
    // A regular, non-escaping manifest entry alongside the dangling-symlink
    // destination, so the push has something legitimate to commit (a
    // manifest containing only a skipped path would stage nothing at all,
    // an unrelated pre-existing edge case of pushing to a still-empty
    // remote with no commit yet).
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "clean.md"),
      "clean content\n",
    );
    addToManifest(manifestPath, "linked.md");
    addToManifest(manifestPath, "clean.md");

    // The clone's destination path is a symlink pointing at a target that
    // does not exist anywhere. `fs.existsSync` follows symlinks and would
    // report this path as "not existing" (since the target is missing), so
    // a naive existsSync-based guard would treat it as a fresh, safe write
    // target and copy straight through it.
    const danglingTarget = path.join(tmpRoot, "does-not-exist.txt");
    fs.symlinkSync(danglingTarget, path.join(clonePath, "linked.md"));

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    siblingPush.run([]);

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(warnings).toContain("linked.md");
    stderrSpy.mockRestore();

    // The dangling symlink must be left exactly as-is, and its target must
    // never have been created.
    expect(
      fs.lstatSync(path.join(clonePath, "linked.md")).isSymbolicLink(),
    ).toBe(true);
    expect(fs.existsSync(danglingTarget)).toBe(false);
  });

  it("N3: a symlinked directory ancestor at depth >=2 below the clone write target still does not allow push to escape", () => {
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]);

    const manifestPath = defaultManifestPath();
    fs.mkdirSync(path.join(anchorDir, ".omc", "a", "b", "c"), { recursive: true });
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "a", "b", "c", "deep.md"),
      "deep content\n",
    );
    addToManifest(manifestPath, "a/b/c/deep.md");
    // A regular, non-escaping manifest entry alongside the symlinked
    // ancestor, so the push has something legitimate to commit (a manifest
    // containing only a skipped path would stage nothing at all, an
    // unrelated pre-existing edge case of pushing to a still-empty remote
    // with no commit yet).
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "clean.md"),
      "clean content\n",
    );
    addToManifest(manifestPath, "clean.md");

    // The clone's "a" directory (two levels above the write target
    // "a/b/c/deep.md") is itself a symlink pointing outside the clone's
    // working tree. The immediate parent ("a/b/c") does NOT exist on disk
    // at all, so a guard that only checks the immediate parent would treat
    // this as a safe, ordinary first write — missing the symlinked
    // ancestor two levels up entirely.
    const outsideDir = path.join(tmpRoot, "outside-clone-deep-a");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(clonePath, "a"));

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    siblingPush.run([]);

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(warnings).toContain("a/b/c/deep.md");
    stderrSpy.mockRestore();

    // The file content must never have been written through the symlinked
    // ancestor, at any depth below it, into the outside directory.
    expect(fs.existsSync(path.join(outsideDir, "b", "c", "deep.md"))).toBe(false);
  });

  it("US-010: push's DELETION branch is guarded identically to its write branch — a symlinked ancestor in the clone must block the deletion the same way it blocks a write", () => {
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", clonePath]);

    const manifestPath = defaultManifestPath();
    // "plans/foo.md" is manifest-listed but never actually created on the
    // anchor side — its source is already absent, so push's deletion
    // branch is exercised on the very first push, before "plans" has ever
    // been a real, git-tracked directory in the clone (avoiding an
    // unrelated git-level "beyond a symbolic link" error from `git add`
    // trying to stage a path whose ancestor used to be a real tracked
    // directory and is now a symlink).
    addToManifest(manifestPath, "plans/foo.md");
    // A regular, non-escaping manifest entry alongside the deletion-branch
    // case under test, so the push has something legitimate to commit.
    fs.writeFileSync(
      path.join(anchorDir, ".omc", "clean.md"),
      "clean content\n",
    );
    addToManifest(manifestPath, "clean.md");

    // The clone's "plans" path is a symlink pointing outside the clone's
    // working tree, left empty so nothing exists at "plans/foo.md" through
    // it (there is nothing to legitimately stage either way — the point of
    // this test is that the deletion branch must never resolve through the
    // symlink at all, not what it would do to real content there).
    const outsideDir = path.join(tmpRoot, "outside-clone-plans-delete");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(clonePath, "plans"));

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    siblingPush.run([]);

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    stderrSpy.mockRestore();
    expect(warnings).toContain("plans");

    // The deletion branch must never have followed the symlinked ancestor:
    // the symlink itself must be left exactly as-is (not removed, not
    // resolved-through), and the outside directory it points to must
    // remain untouched.
    expect(
      fs.lstatSync(path.join(clonePath, "plans")).isSymbolicLink(),
    ).toBe(true);
    expect(fs.readdirSync(outsideDir)).toEqual([]);

    // The legitimate, non-escaping file must still have been committed.
    expect(fs.readFileSync(path.join(clonePath, "clean.md"), "utf8")).toBe(
      "clean content\n",
    );
  });
});
