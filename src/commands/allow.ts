import * as fs from "node:fs";
import * as path from "node:path";
import { addToManifest, defaultManifestPath, readManifest } from "../manifest";
import { hasGlobMeta, globToRegExp } from "../glob";

/**
 * `omc-sync allow <path-or-glob> [<path-or-glob> ...]`
 *
 * Accepts one or more targets in a single call. Each is processed
 * independently, in order:
 *
 * A literal target (no glob metacharacters) is added to the manifest
 * exactly as before — unchanged, backward-compatible behavior.
 *
 * A pattern containing `*`, `?`, or `[` is instead expanded by walking the
 * filesystem under `.omc/` (the manifest's own root) and matching relative
 * paths against the pattern, then calling the existing `addToManifest` for
 * each match. The walk never descends through a symlinked directory
 * component, and only regular files (never directories or symlinks) are
 * ever matched — the same symlink-skip posture used everywhere else in this
 * tool.
 */
export function run(args: string[]): void {
  if (args.length === 0) {
    throw new Error("allow: <path> argument is required");
  }

  const manifestPath = defaultManifestPath();

  for (const target of args) {
    processTarget(manifestPath, target);
  }
}

function processTarget(manifestPath: string, target: string): void {
  if (!hasGlobMeta(target)) {
    addToManifest(manifestPath, target);
    return;
  }

  const omcRoot = path.dirname(manifestPath);
  const allFiles: string[] = [];
  walkFiles(omcRoot, "", allFiles);

  const pattern = globToRegExp(target);
  const matches = allFiles.filter((relPath) => pattern.test(relPath)).sort();

  if (matches.length === 0) {
    process.stderr.write(
      `omc-sync: allow: pattern '${target}' matched no files under .omc/\n`,
    );
    return;
  }

  const existingBefore = new Set(readManifest(manifestPath));
  let added = 0;
  let alreadyPresent = 0;

  for (const relPath of matches) {
    if (existingBefore.has(relPath)) {
      alreadyPresent++;
    } else {
      added++;
    }
    addToManifest(manifestPath, relPath);
  }

  process.stdout.write(
    `omc-sync: allow: pattern '${target}' matched ${matches.length} file(s) — ${added} newly added, ${alreadyPresent} already present\n`,
  );
}

/**
 * Recursively collects every regular file's path (relative to `root`) under
 * `root`/`relDir`. Confines the walk to real, non-symlinked directories:
 * every entry is `lstat`-ed before being recursed into or collected, so a
 * symlinked directory component is never descended into, and a symlinked
 * file is never collected — the same escape class already hardened against
 * elsewhere in this tool.
 */
function walkFiles(root: string, relDir: string, out: string[]): void {
  const dirPath = path.join(root, relDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const entryFull = path.join(root, entryRel);

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryFull);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      walkFiles(root, entryRel, out);
    } else if (stat.isFile()) {
      out.push(entryRel);
    }
  }
}
