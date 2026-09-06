import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRepoRoot } from "../../repo-root";
import { rootSegment } from "../../root";

const SHADOW_REPO_FILENAME = "plan-sync-shadow.git";

/**
 * Subset of `process.env` this module reads. Accepted as an explicit
 * parameter (defaulting to `process.env`) so tests can exercise both the
 * `PLAN_SYNC_STATE_DIR` and `${XDG_CACHE_HOME:-$HOME/.cache}` branches
 * without mutating real process/env state.
 */
export interface ShadowPathEnv {
  PLAN_SYNC_STATE_DIR?: string;
  XDG_CACHE_HOME?: string;
}

export interface ResolveShadowRepoPathOptions {
  env?: ShadowPathEnv;
  homedir?: () => string;
}

/**
 * Resolves the on-disk path of the (bare) shadow git repo for `projectId`,
 * scoped under `rootDir` (e.g. `.omc`, `.omx`) so two roots tracked against
 * the same repo/remote never collide:
 *
 *   - `${PLAN_SYNC_STATE_DIR}/<projectId>/<root-without-leading-dot>/plan-sync-shadow.git`
 *     when `PLAN_SYNC_STATE_DIR` is set
 *   - else `${XDG_CACHE_HOME:-<homedir>/.cache}/plan-sync-shadow/<projectId>/<root-without-leading-dot>.git`
 *
 * `env`/`homedir` default to `process.env`/`os.homedir()` but can be
 * overridden for testability.
 */
export function resolveShadowRepoPath(
  projectId: string,
  rootDir: string,
  options: ResolveShadowRepoPathOptions = {},
): string {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? (() => os.homedir());
  const segment = rootSegment(rootDir);

  if (env.PLAN_SYNC_STATE_DIR) {
    return path.join(env.PLAN_SYNC_STATE_DIR, projectId, segment, SHADOW_REPO_FILENAME);
  }

  const cacheHome = env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(cacheHome, "plan-sync-shadow", projectId, `${segment}.git`);
}

/**
 * Resolves the shadow-track ref name for `projectId`/`rootDir`: outside
 * `refs/heads/*`/`refs/tags/*` (so it's invisible to `git branch
 * -a`/`git log --all`), and includes `rootDir`'s (dot-stripped) segment so
 * two roots tracked against the same repo/remote push to distinct refs.
 */
export function resolveShadowRefName(projectId: string, rootDir: string): string {
  return `refs/plan-sync/${projectId}/${rootSegment(rootDir)}/data`;
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
