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

function gitDirArgs(gitDir: string, args: string[]): string {
  return execFileSync("git", [`--git-dir=${gitDir}`, ...args], {
    encoding: "utf8",
  }).trim();
}

const JWT_FIXTURE =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("push --track shadow (integration)", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-shadow-push-"));
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

  function projectRef(): { projectId: string; shadowRepoPath: string; refName: string } {
    const projectId = resolveProjectId(anchorRepo);
    const shadowRepoPath = resolveShadowRepoPath(projectId, {
      env: { OMC_STATE_DIR: stateDir },
    });
    return { projectId, shadowRepoPath, refName: `refs/omc/${projectId}/data` };
  }

  /**
   * Simulates restoring on a fresh machine: points OMC_STATE_DIR at a brand
   * new temp dir, then re-runs `init --track shadow` against the *same*
   * remote so the local shadow repo is a fresh clone-equivalent rather than
   * the same on-disk repo that pushed. Mirrors restore.test.ts's helper of
   * the same name.
   */
  function switchToFreshMachine(): void {
    const freshStateDir = path.join(tmpDir, `state-dir-fresh-${crypto.randomUUID()}`);
    process.env.OMC_STATE_DIR = freshStateDir;
    shadowInit([]);
  }

  it("throws a clear error when the shadow repo hasn't been initialized", () => {
    expect(() => shadowPush([])).toThrow(/init --track shadow/);
  });

  it("skips files matching an advisory scan class, logs a warning, and syncs the rest (AC-B4)", () => {
    shadowInit([]);
    writeManifest(["clean1.md", "secret.md", "clean2.md"]);
    writeOmcFile("clean1.md", "just some clean planning notes\n");
    writeOmcFile("secret.md", `here is a token: ${JWT_FIXTURE}\n`);
    writeOmcFile("clean2.md", "more clean notes\n");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    shadowPush([]);

    const { shadowRepoPath, refName } = projectRef();
    const tree = gitDirArgs(shadowRepoPath, ["ls-tree", "-r", "--name-only", refName])
      .split("\n")
      .filter(Boolean)
      .sort();

    expect(tree).toEqual(["clean1.md", "clean2.md"]);

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(warnings).toContain("secret.md");
    expect(warnings).toContain("jwt");

    stderrSpy.mockRestore();
  });

  it("skips the commit/push entirely when nothing survives the scan", () => {
    shadowInit([]);
    writeManifest(["secret.md"]);
    writeOmcFile("secret.md", `here is a token: ${JWT_FIXTURE}\n`);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    shadowPush([]);

    const { refName } = projectRef();
    expect(() => gitDirArgs(originRemote, ["rev-parse", "--verify", refName])).toThrow();

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(warnings).toContain("nothing to push");

    stderrSpy.mockRestore();
  });

  it("commits via commit-tree against the previous tip across sequential pushes", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "first version\n");
    shadowPush([]);

    const { refName } = projectRef();
    const firstSha = gitDirArgs(originRemote, ["rev-parse", refName]);

    writeOmcFile("a.md", "second version\n");
    shadowPush([]);

    const secondParents = gitDirArgs(originRemote, ["log", "--format=%P", "-1", refName]);
    expect(secondParents).toBe(firstSha);
  });

  it("retains a scan-matched file's prior content in the new tree rather than dropping it (non-destructive scan-skip)", () => {
    shadowInit([]);
    writeManifest(["notes.md"]);
    writeOmcFile("notes.md", "clean planning notes\n");
    shadowPush([]);

    const { shadowRepoPath, refName } = projectRef();
    const firstTree = gitDirArgs(shadowRepoPath, ["ls-tree", "-r", "--name-only", refName])
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(firstTree).toEqual(["notes.md"]);

    // Edit the clean, already-synced file so it now trips the advisory
    // SSN-shape scan.
    writeOmcFile("notes.md", "my ssn is 123-45-6789\n");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    shadowPush([]);
    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    stderrSpy.mockRestore();

    const secondTree = gitDirArgs(shadowRepoPath, ["ls-tree", "-r", "--name-only", refName])
      .split("\n")
      .filter(Boolean)
      .sort();
    // Still present — a scan match must never cause the path to disappear
    // from the tree.
    expect(secondTree).toEqual(["notes.md"]);

    const content = gitDirArgs(shadowRepoPath, ["show", `${refName}:notes.md`]);
    expect(content).toBe("clean planning notes");

    expect(warnings).toContain("notes.md");
    expect(warnings).toContain("retaining previous synced version");
  });

  it("skips a manifest-listed path whose file was deleted (manifest unchanged), without crashing, and leaves it out of the new tree", () => {
    shadowInit([]);
    writeManifest(["keep.md", "gone.md"]);
    writeOmcFile("keep.md", "keep me\n");
    writeOmcFile("gone.md", "delete me\n");
    shadowPush([]);

    fs.rmSync(path.join(anchorRepo, ".omc", "gone.md"));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => shadowPush([])).not.toThrow();
    stderrSpy.mockRestore();

    const { shadowRepoPath, refName } = projectRef();
    const tree = gitDirArgs(shadowRepoPath, ["ls-tree", "-r", "--name-only", refName])
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(tree).toEqual(["keep.md"]);
  });

  it("N1: deleting EVERY manifest-listed file and pushing genuinely commits the (now-different) tree, and restore does not resurrect them", () => {
    shadowInit([]);
    writeManifest(["one.md", "two.md"]);
    writeOmcFile("one.md", "first file\n");
    writeOmcFile("two.md", "second file\n");
    shadowPush([]);

    const { shadowRepoPath, refName } = projectRef();
    const firstTree = gitDirArgs(shadowRepoPath, ["ls-tree", "-r", "--name-only", refName])
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(firstTree).toEqual(["one.md", "two.md"]);
    const firstTreeSha = gitDirArgs(shadowRepoPath, ["rev-parse", `${refName}^{tree}`]);

    // Delete BOTH manifest-listed files locally, manifest left unchanged —
    // the ordinary deletion workflow (no `unallow`).
    fs.rmSync(path.join(anchorRepo, ".omc", "one.md"));
    fs.rmSync(path.join(anchorRepo, ".omc", "two.md"));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    shadowPush([]);
    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    stderrSpy.mockRestore();

    // The push must NOT have returned early via the old "nothing to push"
    // short-circuit — it must have genuinely committed the now-empty tree.
    expect(warnings).not.toContain("nothing to push");

    const secondTree = gitDirArgs(shadowRepoPath, ["ls-tree", "-r", "--name-only", refName])
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(secondTree).toEqual([]);
    const secondTreeSha = gitDirArgs(shadowRepoPath, ["rev-parse", `${refName}^{tree}`]);
    expect(secondTreeSha).not.toBe(firstTreeSha);

    // Restore against a FRESH shadow clone (simulating a new machine) must
    // not resurrect either deleted file.
    switchToFreshMachine();
    writeOmcFile("one.md", "stale copy that restore should delete\n");
    writeOmcFile("two.md", "stale copy that restore should delete\n");

    shadowRestore([]);

    expect(fs.existsSync(path.join(anchorRepo, ".omc", "one.md"))).toBe(false);
    expect(fs.existsSync(path.join(anchorRepo, ".omc", "two.md"))).toBe(false);
  });

  it("rejects a concurrent same-machine push via git's plain non-fast-forward check, not a custom lock (AC concurrent-race)", () => {
    // "Process A": a shadow repo under stateDirA pushes first, establishing
    // the tip on origin.
    const stateDirA = path.join(tmpDir, "state-dir-a");
    process.env.OMC_STATE_DIR = stateDirA;
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "from process A\n");
    shadowPush([]);

    const { refName } = projectRef();
    const tipAfterA = gitDirArgs(originRemote, ["rev-parse", refName]);

    // "Process B": a separate, independent local shadow repo (simulating a
    // second overlapping process that has not observed A's push — e.g. it
    // read/started before A's push landed) wired to the *same* origin.
    // Its local rev-parse of the previous tip comes back empty (its own
    // shadow repo is fresh), so it builds its next commit with no parent —
    // exactly the "built against a now-stale view of the tip" scenario.
    const stateDirB = path.join(tmpDir, "state-dir-b");
    process.env.OMC_STATE_DIR = stateDirB;
    shadowInit([]);
    writeManifest(["b.md"]);
    writeOmcFile("b.md", "from process B\n");

    expect(() => shadowPush([])).toThrow(/rejected/);

    // The origin ref must be unchanged by the rejected push — no force,
    // no silent overwrite.
    const tipAfterRejectedB = gitDirArgs(originRemote, ["rev-parse", refName]);
    expect(tipAfterRejectedB).toBe(tipAfterA);
  });

  it("US-010: running push from a subdirectory of the anchor repo resolves the identical project-id (and ref) as running it from the repo root", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "from root\n");
    shadowPush([]);

    const { projectId: projectIdFromRoot, shadowRepoPath, refName } = projectRef();
    const shaAfterRootPush = gitDirArgs(shadowRepoPath, ["rev-parse", refName]);

    const subDir = path.join(anchorRepo, "nested", "sub");
    fs.mkdirSync(subDir, { recursive: true });
    process.chdir(subDir);

    // Content is still written via the absolute anchorRepo-relative path
    // (a test-helper convenience) — what matters is that `push`, run with
    // cwd inside the subdirectory, resolves the SAME repo root, manifest,
    // and shadow ref as it did from the repo root, rather than looking for
    // (and failing to find) a `.omc/` under the subdirectory itself.
    writeOmcFile("a.md", "from subdirectory\n");

    expect(() => shadowPush([])).not.toThrow();

    const projectIdFromSubdir = resolveProjectId();
    expect(projectIdFromSubdir).toBe(projectIdFromRoot);

    const shaAfterSubdirPush = gitDirArgs(shadowRepoPath, ["rev-parse", refName]);
    expect(shaAfterSubdirPush).not.toBe(shaAfterRootPush);

    const content = gitDirArgs(shadowRepoPath, ["show", `${refName}:a.md`]);
    expect(content).toBe("from subdirectory");
  });

  it("US-010: refuses to push when the manifest file is missing entirely (not just empty) while a previous tip exists, rather than committing an empty tree", () => {
    shadowInit([]);
    writeManifest(["a.md"]);
    writeOmcFile("a.md", "first version\n");
    shadowPush([]);

    const { shadowRepoPath, refName } = projectRef();
    const treeBefore = gitDirArgs(shadowRepoPath, ["ls-tree", "-r", "--name-only", refName])
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(treeBefore).toEqual(["a.md"]);

    // Delete the manifest FILE ENTIRELY (not merely emptying its contents)
    // while a real previous tip already exists on the ref.
    fs.rmSync(path.join(anchorRepo, ".omc", ".sync-manifest"));

    expect(() => shadowPush([])).toThrow(/manifest file is missing/);

    // The ref must be completely unchanged — no empty tree was committed.
    const treeAfter = gitDirArgs(shadowRepoPath, ["ls-tree", "-r", "--name-only", refName])
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(treeAfter).toEqual(["a.md"]);

    // A subsequent restore elsewhere (fresh clone) must still have the
    // previously-synced file intact — not deleted.
    switchToFreshMachine();
    shadowRestore([]);

    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "a.md"), "utf8")).toBe(
      "first version\n",
    );
  });

  it("a symlink under .omc/ pointing outside the repo is skipped, not dereferenced, by push", () => {
    shadowInit([]);

    const secretTarget = path.join(tmpDir, "outside-secret.txt");
    fs.writeFileSync(secretTarget, "super secret content\n");

    writeManifest(["linked.md", "clean.md"]);
    writeOmcFile("clean.md", "just some clean notes\n");
    const linkedPath = path.join(anchorRepo, ".omc", "linked.md");
    fs.mkdirSync(path.dirname(linkedPath), { recursive: true });
    fs.symlinkSync(secretTarget, linkedPath);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    shadowPush([]);

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(warnings).toContain("linked.md");
    stderrSpy.mockRestore();

    const { shadowRepoPath, refName } = projectRef();
    const tree = gitDirArgs(shadowRepoPath, ["ls-tree", "-r", "--name-only", refName])
      .split("\n")
      .filter(Boolean)
      .sort();

    expect(tree).toEqual(["clean.md"]);
  });
});
