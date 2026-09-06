import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToManifest, defaultManifestPath, readManifest } from "../src/manifest";
import * as siblingInit from "../src/tracks/sibling/init";
import * as siblingPush from "../src/tracks/sibling/push";
import * as siblingPull from "../src/tracks/sibling/pull";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
}

/**
 * Feature: the manifest itself now travels as part of the sync payload, so
 * a second machine's `pull` can recover the scope list, not just file
 * content — following the fixture style established in
 * test/tracks-sibling-pull.test.ts.
 */
describe("sibling track: manifest travels with the sync payload", () => {
  let tmpRoot: string;
  let remoteBareDir: string;
  let anchorA: string;
  let cloneA: string;
  let anchorB: string;
  let cloneB: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-sibling-manifest-"));
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

  it("push commits the manifest itself alongside the listed files, and a fresh machine's pull delivers both the file content and the union-merged manifest", () => {
    // --- Machine A: init, allow two files, push. ---
    process.chdir(anchorA);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneA]);
    fs.writeFileSync(path.join(anchorA, ".omc", "one.md"), "first file\n");
    fs.writeFileSync(path.join(anchorA, ".omc", "two.md"), "second file\n");
    addToManifest(defaultManifestPath(anchorA), "one.md");
    addToManifest(defaultManifestPath(anchorA), "two.md");
    siblingPush.run([]);

    // The manifest itself was committed into the clone, not just the two
    // listed files.
    expect(fs.existsSync(path.join(cloneA, ".sync-manifest"))).toBe(true);
    const trackedFiles = git(["ls-tree", "-r", "--name-only", "HEAD"], cloneA)
      .trim()
      .split("\n")
      .sort();
    expect(trackedFiles).toEqual([".sync-manifest", "one.md", "two.md"]);

    // --- Machine B: a simulated fresh machine — init only (empty local
    // manifest, no `allow` calls at all). A single pull must deliver both
    // the file content and the manifest (union-merged into the, here,
    // empty local manifest). ---
    process.chdir(anchorB);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneB]);
    expect(readManifest(defaultManifestPath(anchorB))).toEqual([]);

    siblingPull.run([]);

    expect(fs.readFileSync(path.join(anchorB, ".omc", "one.md"), "utf8")).toBe(
      "first file\n",
    );
    expect(fs.readFileSync(path.join(anchorB, ".omc", "two.md"), "utf8")).toBe(
      "second file\n",
    );
    expect(readManifest(defaultManifestPath(anchorB)).sort()).toEqual([
      "one.md",
      "two.md",
    ]);
  });

  it("a pre-existing local-only manifest entry (already pushed by this same machine) survives a later pull's manifest merge, union not overwrite", () => {
    // --- Machine B establishes its OWN entry first, genuinely pushing it
    // (so it really exists in the shared clone), independent of machine A. ---
    process.chdir(anchorB);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneB]);
    fs.writeFileSync(
      path.join(anchorB, ".omc", "local-only.md"),
      "only known to machine B\n",
    );
    addToManifest(defaultManifestPath(anchorB), "local-only.md");
    siblingPush.run([]);

    // --- Machine A: joins later, with no knowledge of "local-only.md" —
    // its own local manifest only ever lists its own two files. Pushing
    // overwrites the shared ".sync-manifest" blob with A's list (it doesn't
    // merge), but never touches "local-only.md" itself (A's copy loop only
    // ever touches paths in ITS OWN manifest). ---
    process.chdir(anchorA);
    siblingInit.run(["--remote", remoteBareDir, "--clone-path", cloneA]);
    fs.writeFileSync(path.join(anchorA, ".omc", "one.md"), "first file\n");
    addToManifest(defaultManifestPath(anchorA), "one.md");
    siblingPush.run([]);

    const remoteManifestAfterA = git(
      ["show", "HEAD:.sync-manifest"],
      cloneA,
    ).trim();
    expect(remoteManifestAfterA).toBe("one.md");

    // --- Machine B pulls A's update. The incoming manifest (["one.md"])
    // must be UNION-merged into B's local manifest, not used to overwrite
    // it — B's own "local-only.md" entry (and its file, still genuinely
    // present in the clone) must survive. ---
    process.chdir(anchorB);
    siblingPull.run([]);

    expect(fs.readFileSync(path.join(anchorB, ".omc", "one.md"), "utf8")).toBe(
      "first file\n",
    );
    expect(
      fs.readFileSync(path.join(anchorB, ".omc", "local-only.md"), "utf8"),
    ).toBe("only known to machine B\n");

    const mergedManifest = readManifest(defaultManifestPath(anchorB)).sort();
    expect(mergedManifest).toEqual(["local-only.md", "one.md"]);
  });
});
