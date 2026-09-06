import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultManifestPath, readManifest } from "../../manifest";
import { resolveRepoRoot } from "../../repo-root";
import { siblingConfigPath, type SiblingConfig } from "./init";

/**
 * `omc-sync status --track sibling`
 *
 * Per-file sync report for the sibling track: for each manifest-listed
 * path, compares `.omc/<path>` (the anchor repo's copy) against
 * `<clonePath>/<path>` (the sibling clone's copy) by content hash. Mirrors
 * the shadow track's per-file report (`../shadow/status.ts`), classifying
 * each path as one of:
 *   - "in sync": present in both, with matching content.
 *   - "pending (local changes)": present in both, but content differs.
 *   - "pending (never synced)": present locally, absent from the clone.
 *   - "missing locally": present in the clone, absent locally.
 */

function readSiblingConfig(repoRoot: string): SiblingConfig {
  const configPath = siblingConfigPath(repoRoot);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `status --track sibling: no sibling config found at ${configPath} — run \`omc-sync init --track sibling\` first`,
    );
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    sibling?: SiblingConfig;
  };
  if (!raw.sibling) {
    throw new Error(
      `status --track sibling: ${configPath} has no "sibling" entry — run \`omc-sync init --track sibling\` first`,
    );
  }

  return raw.sibling;
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function run(_args: string[]): void {
  const repoRoot = resolveRepoRoot();
  const { clonePath } = readSiblingConfig(repoRoot);
  const manifestPaths = readManifest(defaultManifestPath(repoRoot));

  let inSync = 0;
  let pendingLocal = 0;
  let pendingNeverSynced = 0;
  let missingLocally = 0;

  for (const relPath of manifestPaths) {
    const localPath = path.join(repoRoot, ".omc", relPath);
    const clonedPath = path.join(clonePath, relPath);
    const localExists = fs.existsSync(localPath);
    const clonedExists = fs.existsSync(clonedPath);

    let state: string;
    if (localExists && clonedExists) {
      const localHash = sha256(fs.readFileSync(localPath));
      const clonedHash = sha256(fs.readFileSync(clonedPath));
      if (localHash === clonedHash) {
        state = "in sync";
        inSync++;
      } else {
        state = "pending (local changes)";
        pendingLocal++;
      }
    } else if (localExists) {
      state = "pending (never synced)";
      pendingNeverSynced++;
    } else if (clonedExists) {
      state = "missing locally";
      missingLocally++;
    } else {
      // Neither locally present nor ever synced — closest fit of the four
      // reported states is "never synced".
      state = "pending (never synced)";
      pendingNeverSynced++;
    }

    process.stdout.write(`omc-sync: ${relPath}: ${state}\n`);
  }

  process.stdout.write(
    `omc-sync: ${manifestPaths.length} file(s) tracked — ${inSync} in sync, ${pendingLocal} pending (local changes), ${pendingNeverSynced} pending (never synced), ${missingLocally} missing locally\n`,
  );
}
