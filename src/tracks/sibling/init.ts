import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parseFlag } from "../../args";
import { resolveRepoRoot } from "../../repo-root";

export interface SiblingConfig {
  clonePath: string;
  remote: string;
}

interface SyncConfig {
  sibling?: SiblingConfig;
  [key: string]: unknown;
}

const CONFIG_DIR = ".omc";
const CONFIG_FILE = ".sync-config.json";
const EXCLUDE_ENTRY = ".omc/";

/**
 * Path to the local (untracked) tool-config file that persists sibling-track
 * settings (clone path, remote) so `push`/`pull` don't need `--clone-path`
 * re-passed on every invocation. This file is intentionally never added to
 * the sync manifest — it's tool config, not synced content.
 */
export function siblingConfigPath(repoRoot: string = resolveRepoRoot()): string {
  return path.join(repoRoot, CONFIG_DIR, CONFIG_FILE);
}

/**
 * Resolves the anchor repo's `info/exclude` path via `git rev-parse
 * --git-path info/exclude` rather than hardcoding
 * `path.join(repoRoot, ".git", "info", "exclude")`, so this works correctly
 * when `.git` is a file rather than a directory (e.g. a linked git
 * worktree, where `git rev-parse --git-path` correctly resolves to the
 * shared main repo's `info/exclude`). The result may come back relative to
 * `repoRoot` or already absolute depending on git version/context, so it's
 * resolved against `repoRoot` when not already absolute.
 */
function resolveGitExcludePath(repoRoot: string): string {
  const result = execFileSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--git-path", "info/exclude"],
    { encoding: "utf8" },
  ).trim();
  return path.isAbsolute(result) ? result : path.resolve(repoRoot, result);
}

function ensureOmcExcluded(repoRoot: string): void {
  const excludePath = resolveGitExcludePath(repoRoot);
  const existing = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, "utf8")
    : "";

  const alreadyPresent = existing
    .split("\n")
    .some((line) => line.trim() === EXCLUDE_ENTRY);
  if (alreadyPresent) return;

  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  fs.appendFileSync(
    excludePath,
    `${needsLeadingNewline ? "\n" : ""}${EXCLUDE_ENTRY}\n`,
  );
}

function ensureClone(remote: string, clonePath: string): void {
  if (fs.existsSync(clonePath)) {
    const gitDir = path.join(clonePath, ".git");
    if (!fs.existsSync(gitDir)) {
      throw new Error(
        `init --track sibling: clone-path already exists but is not a git repository: ${clonePath}`,
      );
    }
    // Already a clone — idempotent init, leave it as-is.
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(clonePath)), { recursive: true });
  execFileSync("git", ["clone", remote, clonePath], { stdio: "pipe" });
}

function persistConfig(
  repoRoot: string,
  remote: string,
  clonePath: string,
): void {
  const configPath = siblingConfigPath(repoRoot);
  let config: SyncConfig = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as SyncConfig;
  }

  config.sibling = { clonePath: path.resolve(clonePath), remote };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function run(args: string[]): void {
  const { value: remote, rest: rest1 } = parseFlag(args, "remote");
  const { value: clonePath } = parseFlag(rest1, "clone-path");

  if (!remote) {
    throw new Error("init --track sibling: --remote <url> is required");
  }
  if (!clonePath) {
    throw new Error("init --track sibling: --clone-path <path> is required");
  }

  const repoRoot = resolveRepoRoot();

  ensureOmcExcluded(repoRoot);
  ensureClone(remote, clonePath);
  persistConfig(repoRoot, remote, clonePath);
}
