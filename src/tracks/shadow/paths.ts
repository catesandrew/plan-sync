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

  let cacheHome = env.XDG_CACHE_HOME;
  if (!cacheHome) {
    const home = homedir();
    if (!home) {
      // `os.homedir()` returns "" when `$HOME` is set-but-empty (it only
      // falls back to a passwd lookup when `$HOME` is unset entirely) —
      // silently joining "" here would build a repo-relative shadow-repo
      // path (`.cache/...`) instead of failing loudly. Fail closed instead,
      // matching the Go port's behavior for the same case.
      throw new Error(
        "could not resolve a home directory to derive the shadow-repo cache path — set XDG_CACHE_HOME or PLAN_SYNC_STATE_DIR explicitly",
      );
    }
    cacheHome = path.join(home, ".cache");
  }
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

const PROJECT_ID_LENGTH = 12;

/**
 * Derives a stable, deterministic project id for `repoRoot` (default: the
 * git repository top level containing `process.cwd()`, via
 * `resolveRepoRoot()`): the first 12 hex characters of the repo's root
 * commit hash (`git rev-list --max-parents=0 HEAD`) — git's own
 * content-addressed identity for "this is the same repository history".
 *
 * This is intentionally independent of the `origin` remote URL: renaming
 * the remote, renaming the repo on its host, switching between SSH/HTTPS
 * remotes, or moving to a different host entirely all leave the root
 * commit (and therefore the project id) unchanged. It's also independently
 * computable on every machine/clone of the repo without needing to already
 * know a ref name.
 *
 * A repo can have more than one root commit (e.g. histories joined via
 * `git merge --allow-unrelated-histories`); when `rev-list` reports
 * multiple, they're sorted lexically and the first is used, so every
 * clone/machine deterministically picks the same one regardless of commit
 * order.
 */
export function resolveProjectId(
  repoRoot: string = resolveRepoRoot(),
  options: ResolveProjectIdOptions = {},
): string {
  const run = options.execFileSyncFn ?? execFileSync;

  const output = run("git", ["-C", repoRoot, "rev-list", "--max-parents=0", "HEAD"], {
    encoding: "utf8",
  });

  const rootHashes = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();

  const rootHash = rootHashes[0];
  if (!rootHash) {
    throw new Error(`no root commit found for repository at '${repoRoot}'`);
  }

  return rootHash.slice(0, PROJECT_ID_LENGTH);
}
