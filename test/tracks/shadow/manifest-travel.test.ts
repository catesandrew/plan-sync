import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as shadowInit } from "../../../src/tracks/shadow/init";
import { run as shadowPush } from "../../../src/tracks/shadow/push";
import { run as shadowRestore } from "../../../src/tracks/shadow/restore";
import { defaultManifestPath, readManifest } from "../../../src/manifest";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Feature: the manifest itself now travels as part of the shadow-ref sync
 * payload, so a fresh machine's `restore` can recover the scope list, not
 * just file content.
 */
describe("shadow track: manifest travels with the sync payload", () => {
  let tmpDir: string;
  let anchorRepo: string;
  let originRemote: string;
  let stateDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-shadow-manifest-"));
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
    originalOmcStateDir = process.env.PLAN_SYNC_STATE_DIR;
    process.env.PLAN_SYNC_STATE_DIR = stateDir;
    process.chdir(anchorRepo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalOmcStateDir === undefined) {
      delete process.env.PLAN_SYNC_STATE_DIR;
    } else {
      process.env.PLAN_SYNC_STATE_DIR = originalOmcStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function manifestFilePath(): string {
    return path.join(anchorRepo, ".omc", ".sync-manifest");
  }

  function writeManifest(entries: string[]): void {
    fs.mkdirSync(path.dirname(manifestFilePath()), { recursive: true });
    fs.writeFileSync(manifestFilePath(), entries.join("\n") + "\n");
  }

  function writeOmcFile(relPath: string, content: string): void {
    const filePath = path.join(anchorRepo, ".omc", relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  function switchToFreshMachine(): void {
    const freshStateDir = path.join(tmpDir, `state-dir-fresh-${crypto.randomUUID()}`);
    process.env.PLAN_SYNC_STATE_DIR = freshStateDir;
    shadowInit([]);
  }

  it("push commits the manifest itself alongside the listed files, and restore on a fresh machine (with a pre-existing local-only manifest entry) merges it in (union, not overwrite)", () => {
    shadowInit([]);
    writeManifest(["one.md", "two.md"]);
    writeOmcFile("one.md", "first file\n");
    writeOmcFile("two.md", "second file\n");
    shadowPush([]);

    switchToFreshMachine();

    // Simulate a fresh machine whose local manifest already independently
    // lists a path the incoming (pushed) manifest never mentions, and whose
    // previously-synced files are locally absent.
    writeManifest(["local-only.md"]);
    writeOmcFile("local-only.md", "only known locally\n");

    shadowRestore([]);

    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "one.md"), "utf8")).toBe(
      "first file\n",
    );
    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "two.md"), "utf8")).toBe(
      "second file\n",
    );

    const mergedManifest = readManifest(defaultManifestPath(anchorRepo)).sort();
    expect(mergedManifest).toEqual(["local-only.md", "one.md", "two.md"]);

    // The pre-existing local-only entry's file survives untouched — the
    // merge is additive, never a wholesale overwrite of the local manifest.
    expect(
      fs.readFileSync(path.join(anchorRepo, ".omc", "local-only.md"), "utf8"),
    ).toBe("only known locally\n");
  });

  it("a pattern manifest line travels verbatim — it is never expanded into its matches before being staged, pushed, or merged on restore", () => {
    shadowInit([]);
    writeManifest(["plans/*.md"]);
    writeOmcFile("plans/a.md", "a\n");
    writeOmcFile("plans/b.md", "b\n");
    shadowPush([]);

    switchToFreshMachine();
    shadowRestore([]);

    // The raw manifest entry is still the pattern string itself, not one
    // line per matched file.
    expect(readManifest(defaultManifestPath(anchorRepo))).toEqual(["plans/*.md"]);

    // Restore materialized the files the pattern currently resolves to,
    // even though only the pattern string (never the individual matches)
    // ever traveled as a manifest line.
    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "plans", "a.md"), "utf8")).toBe(
      "a\n",
    );
    expect(fs.readFileSync(path.join(anchorRepo, ".omc", "plans", "b.md"), "utf8")).toBe(
      "b\n",
    );
  });
});
