import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFlag } from "../../args";
import { resolveRepoRoot } from "../../repo-root";
import { resolveProjectId, resolveShadowRepoPath } from "./paths";

const EXCLUDE_LINE = ".omc/";

/**
 * `omc-sync init --track shadow [--remote <url>]`
 *
 * Bootstraps the shadow-ref track (Part B, Architecture steps 0-2 of
 * .omc/plans/shadow-ref-git-sync-for-omc-artifacts.md):
 *   0. ensure `.omc/` is excluded via the anchor repo's `.git/info/exclude`
 *      (untracked, idempotent, shared bootstrap with Part A)
 *   1. create the bare shadow git repo (if missing) and pin
 *      `core.autocrlf=false`, explicit `user.name`/`user.email`, and a
 *      `-text` attributes rule at `<shadowRepoPath>/info/attributes`
 *   2. wire an `origin` remote on the shadow repo, from `--remote` or the
 *      anchor repo's own `origin`
 */
export function run(args: string[]): void {
  const { value: remoteFlag } = parseFlag(args, "remote");
  const repoRoot = resolveRepoRoot();

  ensureExcludeEntry(repoRoot);

  const projectId = resolveProjectId(repoRoot);
  const shadowRepoPath = resolveShadowRepoPath(projectId);

  ensureBareRepo(shadowRepoPath);
  configureShadowRepo(shadowRepoPath, repoRoot);
  wireOrigin(shadowRepoPath, repoRoot, remoteFlag);
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

function ensureExcludeEntry(repoRoot: string): void {
  const excludePath = resolveGitExcludePath(repoRoot);
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });

  const existing = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, "utf8")
    : "";
  const lines = existing.split("\n");
  if (lines.includes(EXCLUDE_LINE)) {
    return;
  }

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  fs.appendFileSync(
    excludePath,
    `${needsLeadingNewline ? "\n" : ""}${EXCLUDE_LINE}\n`,
  );
}

function ensureBareRepo(shadowRepoPath: string): void {
  if (fs.existsSync(shadowRepoPath)) {
    return;
  }
  fs.mkdirSync(path.dirname(shadowRepoPath), { recursive: true });
  execFileSync("git", ["init", "--bare", shadowRepoPath], { stdio: "ignore" });
}

function configureShadowRepo(shadowRepoPath: string, repoRoot: string): void {
  const gitDir = `--git-dir=${shadowRepoPath}`;

  execFileSync("git", [gitDir, "config", "core.autocrlf", "false"]);

  const { name, email } = resolveGitIdentity(repoRoot);
  execFileSync("git", [gitDir, "config", "user.name", name]);
  execFileSync("git", [gitDir, "config", "user.email", email]);

  // A bare repo has no working tree, so a `.gitattributes` there would never
  // be read. Git's standard location for repo-local attributes that work
  // without a working tree is `$GIT_DIR/info/attributes`.
  const attributesPath = path.join(shadowRepoPath, "info", "attributes");
  fs.mkdirSync(path.dirname(attributesPath), { recursive: true });
  fs.writeFileSync(attributesPath, "* -text\n");
  execFileSync("git", [gitDir, "config", "core.attributesFile", attributesPath]);
}

/**
 * Reads `user.name`/`user.email` from the anchor repo's own git config
 * (local or global, whichever `git config` resolves) so the shadow repo's
 * commits are attributable to the same person. Falls back to a placeholder
 * identity when the anchor repo has neither configured, since a fresh bare
 * repo has no identity of its own and the first commit against it would
 * otherwise fail.
 */
function resolveGitIdentity(repoRoot: string): { name: string; email: string } {
  const name = tryGitConfig(repoRoot, "user.name") ?? "omc-sync";
  const email = tryGitConfig(repoRoot, "user.email") ?? "omc-sync@localhost";
  return { name, email };
}

function tryGitConfig(repoRoot: string, key: string): string | undefined {
  try {
    const value = execFileSync("git", ["-C", repoRoot, "config", key], {
      encoding: "utf8",
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function wireOrigin(
  shadowRepoPath: string,
  repoRoot: string,
  remoteFlag: string | undefined,
): void {
  const url = remoteFlag ?? getAnchorOriginUrl(repoRoot);
  if (!url) {
    throw new Error(
      "init --track shadow: no --remote given and the anchor repo has no 'origin' remote to infer one from",
    );
  }

  const gitDir = `--git-dir=${shadowRepoPath}`;
  if (getShadowOriginUrl(shadowRepoPath)) {
    execFileSync("git", [gitDir, "remote", "set-url", "origin", url]);
  } else {
    execFileSync("git", [gitDir, "remote", "add", "origin", url]);
  }
}

function getAnchorOriginUrl(repoRoot: string): string | undefined {
  try {
    const url = execFileSync(
      "git",
      ["-C", repoRoot, "remote", "get-url", "origin"],
      { encoding: "utf8" },
    ).trim();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

function getShadowOriginUrl(shadowRepoPath: string): string | undefined {
  try {
    const url = execFileSync(
      "git",
      [`--git-dir=${shadowRepoPath}`, "remote", "get-url", "origin"],
      { encoding: "utf8" },
    ).trim();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}
