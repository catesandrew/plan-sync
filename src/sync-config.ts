import * as fs from "node:fs";
import * as path from "node:path";
import type { Track } from "./args";
import { resolveRepoRoot } from "./repo-root";
import { DEFAULT_ROOT } from "./root";

/**
 * Shared local (untracked) tool-config file at `.omc/.sync-config.json`,
 * consolidated from what used to be sibling-track-only logic in
 * `src/tracks/sibling/init.ts`. Both tracks read/write this same file:
 * sibling-track settings live under the `"sibling"` key (untouched by this
 * module's shape beyond that), and the persisted default track lives under
 * `"defaultTrack"`. Consumers merge into this file rather than overwrite it
 * wholesale, so one track's settings never clobber the other's.
 */

const CONFIG_FILE = ".sync-config.json";

export interface SiblingSyncConfig {
  clonePath: string;
  remote: string;
}

export interface SyncConfig {
  defaultTrack?: Track;
  sibling?: SiblingSyncConfig;
  [key: string]: unknown;
}

/**
 * Path to the local (untracked) tool-config file, defaulting to the git
 * repository top level containing the current working directory (via
 * `resolveRepoRoot()`). This file is intentionally never added to the sync
 * manifest — it's tool config, not synced content.
 */
export function syncConfigPath(
  repoRoot: string = resolveRepoRoot(),
  rootDir: string = DEFAULT_ROOT,
): string {
  return path.join(repoRoot, rootDir, CONFIG_FILE);
}

/**
 * Reads the full sync-config object, returning `{}` if the file doesn't
 * exist yet (rather than throwing) — every caller here treats a missing
 * config file as "nothing configured yet", not an error.
 */
export function readSyncConfig(
  repoRoot: string = resolveRepoRoot(),
  rootDir: string = DEFAULT_ROOT,
): SyncConfig {
  const configPath = syncConfigPath(repoRoot, rootDir);
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as SyncConfig;
}

/**
 * Merges `updates` into the existing sync-config file (read-merge-write),
 * preserving any other top-level keys already present (e.g. a `sibling`
 * entry written by a prior `init --track sibling`). Creates the file and its
 * parent directory if they don't exist yet.
 */
export function writeSyncConfig(
  repoRoot: string,
  updates: Partial<SyncConfig>,
  rootDir: string = DEFAULT_ROOT,
): void {
  const configPath = syncConfigPath(repoRoot, rootDir);
  let config: SyncConfig = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as SyncConfig;
  }

  Object.assign(config, updates);

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Persists `track` as the default track for subsequent multi-track commands
 * (`push`/`pull`/`restore`/`status`/`uninstall`) that omit an explicit
 * `--track` flag. Always overwrites any previously persisted default — "most
 * recently initialized track wins" is the intended semantics.
 */
export function writeDefaultTrack(
  repoRoot: string,
  track: Track,
  rootDir: string = DEFAULT_ROOT,
): void {
  writeSyncConfig(repoRoot, { defaultTrack: track }, rootDir);
}

/**
 * Returns the persisted default track, or `undefined` if none has been
 * persisted yet (e.g. `init` was never run, or the config file predates this
 * feature).
 */
export function getDefaultTrack(
  repoRoot: string = resolveRepoRoot(),
  rootDir: string = DEFAULT_ROOT,
): Track | undefined {
  return readSyncConfig(repoRoot, rootDir).defaultTrack;
}
