import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToManifest, defaultManifestPath } from "../src/manifest";
import * as siblingInit from "../src/tracks/sibling/init";
import * as siblingPush from "../src/tracks/sibling/push";
import * as siblingPull from "../src/tracks/sibling/pull";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
}

/**
 * Simulates two machines (A and B), each with their own anchor repo and
 * their own sibling clone, both pointed at the same bare "remote" repo —
 * following the fixture style established in test/tracks-sibling.test.ts.
 */
describe("sibling track: pull", () => {
  let tmpRoot: string;
  let remoteBareDir: string;
  let anchorA: string;
  let cloneA: string;
  let anchorB: string;
  let cloneB: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-sibling-pull-"));
    remoteBareDir = path.join(tmpRoot, "remote.git");
    anchorA = path.join(tmpRoot, "machine-a");
    cloneA = path.join(tmpRoot, "machine-a-clone");
    anchorB = path.join(tmpRoot, "machine-b");
    cloneB = path.join(tmpRoot, "machine-b-clone");

    git(["init", "--quiet", "--bare", remoteBareDir], tmpRoot);

    fs.mkdirSync(anchorA, { recursive: true });
    git(["init", "--quiet"], anchorA);

    fs.mkdirSync(anchorB, { recursive: true });
    git(["init", "--quiet"], anchorB);

    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("AC-A2: deletion propagation — file added+pushed from A appears on B after pull, then deleted+re-pushed from A disappears from B after pull, and stays absent after B's own next push", () => {
    // --- Machine A: init, add a manifest-listed file, push. ---
    process.chdir(anchorA);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneA]);
    fs.writeFileSync(path.join(anchorA, ".omc", "notes.md"), "hello from A\n");
    addToManifest(defaultManifestPath(), "notes.md");
    siblingPush.run([]);

    // --- Machine B: init (clones remote, which already has notes.md committed),
    // allow the same path, pull, confirm the file lands in B's .omc/. ---
    process.chdir(anchorB);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneB]);
    addToManifest(defaultManifestPath(), "notes.md");
    siblingPull.run([]);

    expect(fs.readFileSync(path.join(anchorB, ".omc", "notes.md"), "utf8")).toBe(
      "hello from A\n",
    );

    // --- Machine A: delete the file from .omc/ and push again. ---
    process.chdir(anchorA);
    fs.rmSync(path.join(anchorA, ".omc", "notes.md"));
    siblingPush.run([]);

    expect(fs.existsSync(path.join(cloneA, "notes.md"))).toBe(false);

    // --- Machine B: pull again — file should now be absent from .omc/. ---
    process.chdir(anchorB);
    siblingPull.run([]);

    expect(fs.existsSync(path.join(anchorB, ".omc", "notes.md"))).toBe(false);
    expect(fs.existsSync(path.join(cloneB, "notes.md"))).toBe(false);

    // --- Machine B's own next push must not resurrect the file or throw. ---
    expect(() => siblingPush.run([])).not.toThrow();
    expect(fs.existsSync(path.join(anchorB, ".omc", "notes.md"))).toBe(false);
    expect(fs.existsSync(path.join(cloneB, "notes.md"))).toBe(false);
  });

  it("AC-A3: concurrent edits to the same manifest-listed file produce a real rebase conflict on pull, with no silent discard", () => {
    // --- Machine A: init, seed the manifest-listed file, push a baseline. ---
    process.chdir(anchorA);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneA]);
    fs.writeFileSync(path.join(anchorA, ".omc", "shared.md"), "base\n");
    addToManifest(defaultManifestPath(), "shared.md");
    siblingPush.run([]);

    // --- Machine B: init (clones the baseline), allow the same path, pull to sync. ---
    process.chdir(anchorB);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneB]);
    addToManifest(defaultManifestPath(), "shared.md");
    siblingPull.run([]);
    expect(fs.readFileSync(path.join(anchorB, ".omc", "shared.md"), "utf8")).toBe(
      "base\n",
    );

    // --- Machine A edits the file differently and pushes first. ---
    process.chdir(anchorA);
    fs.writeFileSync(path.join(anchorA, ".omc", "shared.md"), "edited on A\n");
    siblingPush.run([]);

    // --- Machine B edits the same file differently and commits it locally in
    // its own clone *without* pushing (simulating a commit made before B ever
    // attempted to sync with the now-diverged remote) — setting up a real
    // rebase conflict for `pull` to hit. ---
    process.chdir(anchorB);
    fs.writeFileSync(path.join(anchorB, ".omc", "shared.md"), "edited on B\n");
    fs.copyFileSync(
      path.join(anchorB, ".omc", "shared.md"),
      path.join(cloneB, "shared.md"),
    );
    execFileSync("git", ["add", "--", "shared.md"], {
      cwd: cloneB,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "-m", "B's local edit"], {
      cwd: cloneB,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "omc-sync",
        GIT_AUTHOR_EMAIL: "omc-sync@localhost",
        GIT_COMMITTER_NAME: "omc-sync",
        GIT_COMMITTER_EMAIL: "omc-sync@localhost",
      },
    });

    expect(() => siblingPull.run([])).toThrow(/merge conflict/i);

    // Inspect the clone directory: real git rebase-conflict state, with
    // actual conflict markers in the conflicted file — not a mocked outcome.
    const conflicted = fs.readFileSync(path.join(cloneB, "shared.md"), "utf8");
    expect(conflicted).toContain("<<<<<<<");
    expect(conflicted).toContain("=======");
    expect(conflicted).toContain(">>>>>>>");

    // Neither side's content was silently discarded — both versions appear
    // somewhere in the conflict markers.
    expect(conflicted).toContain("edited on A");
    expect(conflicted).toContain("edited on B");

    const status = git(["status", "--short"], cloneB);
    expect(status).toMatch(/rebase|UU|both modified/i);
  });

  it("US-010: a symlinked directory component under .omc/ does not allow pull's COPY-IN path to write outside the repo", () => {
    // --- Machine A: init, add a manifest-listed file under a subdirectory, push. ---
    process.chdir(anchorA);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneA]);
    fs.mkdirSync(path.join(anchorA, ".omc", "plans"), { recursive: true });
    fs.writeFileSync(
      path.join(anchorA, ".omc", "plans", "foo.md"),
      "plan content\n",
    );
    addToManifest(defaultManifestPath(), "plans/foo.md");
    siblingPush.run([]);

    // --- Machine B: init (clones remote, which has plans/foo.md), allow the
    // same path, but first replace B's local `.omc/plans` with a symlink
    // pointing outside the repo. ---
    process.chdir(anchorB);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneB]);
    addToManifest(defaultManifestPath(), "plans/foo.md");

    const outsideDir = path.join(tmpRoot, "outside-plans-copyin");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(path.join(anchorB, ".omc"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(anchorB, ".omc", "plans"));

    siblingPull.run([]);

    // The copy-in path must never have followed the symlinked directory
    // component to write into the outside directory.
    expect(fs.existsSync(path.join(outsideDir, "foo.md"))).toBe(false);
  });

  it("US-010: a symlinked directory component under .omc/ does not allow pull's DELETE-PROPAGATION path to remove a file outside the repo", () => {
    // --- Machine A: init, add a manifest-listed file, push, then delete +
    // re-push so the clone no longer has it (deletion-propagation source). ---
    process.chdir(anchorA);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneA]);
    fs.mkdirSync(path.join(anchorA, ".omc", "plans"), { recursive: true });
    fs.writeFileSync(
      path.join(anchorA, ".omc", "plans", "foo.md"),
      "plan content\n",
    );
    addToManifest(defaultManifestPath(), "plans/foo.md");
    siblingPush.run([]);

    fs.rmSync(path.join(anchorA, ".omc", "plans", "foo.md"));
    siblingPush.run([]);

    // --- Machine B: init (clones remote — plans/foo.md is already absent
    // there), allow the same path. Replace B's local `.omc/plans` with a
    // symlink to an outside directory containing a same-named file that
    // must never be touched by pull's delete-propagation. ---
    process.chdir(anchorB);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneB]);
    addToManifest(defaultManifestPath(), "plans/foo.md");

    const outsideDir = path.join(tmpRoot, "outside-plans-delete");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "foo.md");
    fs.writeFileSync(outsideFile, "outside content that must survive\n");
    fs.mkdirSync(path.join(anchorB, ".omc"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(anchorB, ".omc", "plans"));

    siblingPull.run([]);

    // The delete-propagation path must never have followed the symlinked
    // directory component to remove the file outside the repo.
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe(
      "outside content that must survive\n",
    );
  });

  it("US-010: a symlink under .omc/ pointing outside the repo is not dereferenced (not copied from) by pull", () => {
    // --- Machine A: init, then directly commit+push a symlink into the
    // clone — simulating content that ended up there some other way (the
    // tool's own `push` never commits symlinks itself, per the existing
    // push-side symlink-skip tests), so pull must defend against one being
    // present in the clone regardless of how it got there. ---
    process.chdir(anchorA);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneA]);

    const secretTarget = path.join(tmpRoot, "outside-secret.txt");
    fs.writeFileSync(secretTarget, "super secret content\n");
    fs.symlinkSync(secretTarget, path.join(cloneA, "notes.md"));

    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "omc-sync",
      GIT_AUTHOR_EMAIL: "omc-sync@localhost",
      GIT_COMMITTER_NAME: "omc-sync",
      GIT_COMMITTER_EMAIL: "omc-sync@localhost",
    };
    execFileSync("git", ["add", "--", "notes.md"], { cwd: cloneA, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "commit a symlink directly"], {
      cwd: cloneA,
      stdio: "pipe",
      env: commitEnv,
    });
    execFileSync("git", ["push", "-u", "origin", "HEAD"], {
      cwd: cloneA,
      stdio: "pipe",
    });

    // --- Machine B: init (clones remote, which now has notes.md committed
    // as a real symlink), allow the same path, pull. ---
    process.chdir(anchorB);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneB]);
    addToManifest(defaultManifestPath(), "notes.md");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    siblingPull.run([]);
    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    stderrSpy.mockRestore();

    expect(warnings).toContain("notes.md");
    // The symlink must never have been dereferenced and copied into the
    // anchor repo's .omc/ — the secret content must not appear there.
    expect(fs.existsSync(path.join(anchorB, ".omc", "notes.md"))).toBe(false);
  });
});
