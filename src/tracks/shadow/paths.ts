import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRepoRoot } from "../../repo-root";

const SHADOW_REPO_FILENAME = "omc-shadow.git";

/**
 * Subset of `process.env` this module reads. Accepted as an explicit
 * parameter (defaulting to `process.env`) so tests can exercise both the
 * `OMC_STATE_DIR` and `${XDG_CACHE_HOME:-$HOME/.cache}` branches without
 * mutating real process/env state.
 */
export interface ShadowPathEnv {
  OMC_STATE_DIR?: string;
  XDG_CACHE_HOME?: string;
}

export interface ResolveShadowRepoPathOptions {
  env?: ShadowPathEnv;
  homedir?: () => string;
}

/**
 * Resolves the on-disk path of the (bare) shadow git repo for `projectId`:
 *
 *   - `${OMC_STATE_DIR}/<projectId>/omc-shadow.git` when `OMC_STATE_DIR` is set
 *   - else `${XDG_CACHE_HOME:-<homedir>/.cache}/omc-shadow/<projectId>.git`
 *
 * `env`/`homedir` default to `process.env`/`os.homedir()` but can be
 * overridden for testability.
 */
export function resolveShadowRepoPath(
  projectId: string,
  options: ResolveShadowRepoPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? (() => os.homedir());

  if (env.OMC_STATE_DIR) {
    return path.join(env.OMC_STATE_DIR, projectId, SHADOW_REPO_FILENAME);
  }

  const cacheHome = env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(cacheHome, "omc-shadow", `${projectId}.git`);
}

export interface ResolveProjectIdOptions {
  /** Injectable for tests; defaults to `child_process.execFileSync`. */
  execFileSyncFn?: typeof execFileSync;
}

/**
 * Derives a stable, deterministic project id for `repoRoot` (default: the
 * git repository top level containing `process.cwd()`, via
 * `resolveRepoRoot()`): the slugified `origin` remote URL when one is
 * configured, else the slugified basename of the repo root directory.
 * Calling this repeatedly against the same repo state always yields the
 * same id.
 */
export function resolveProjectId(
  repoRoot: string = resolveRepoRoot(),
  options: ResolveProjectIdOptions = {},
): string {
  const run = options.execFileSyncFn ?? execFileSync;

  let originUrl: string | undefined;
  try {
    originUrl = run("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim();
  } catch {
    originUrl = undefined;
  }

  if (originUrl) {
    return slugify(originUrl);
  }

  return slugify(path.basename(path.resolve(repoRoot)));
}

function slugify(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme://
  s = s.replace(/^git@/, "");
  s = s.replace(/\.git$/, "");
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  return s || "repo";
}
