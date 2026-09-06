import * as fs from "node:fs";
import * as path from "node:path";
import { addToManifest, defaultManifestPath, readManifest } from "../manifest";

const GLOB_META = /[*?[]/;

/**
 * `omc-sync allow <path-or-glob>`
 *
 * A literal `<path>` (no glob metacharacters) is added to the manifest
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
  const [target] = args;
  if (!target) {
    throw new Error("allow: <path> argument is required");
  }

  const manifestPath = defaultManifestPath();

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

function hasGlobMeta(pattern: string): boolean {
  return GLOB_META.test(pattern);
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

/**
 * Converts a simple glob pattern into an anchored `RegExp`, hand-rolled
 * (no new dependency, per repo convention): `*` matches any run of
 * characters except `/`, `?` matches exactly one character except `/`,
 * `**` (optionally followed by `/`) matches any run of characters
 * including `/` — i.e. any depth of subdirectories, including zero — and
 * `[...]`/`[!...]` character classes are passed through as regex character
 * classes.
 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
      continue;
    }

    if (c === "*") {
      re += "[^/]*";
      i += 1;
      continue;
    }

    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }

    if (c === "[") {
      let j = i + 1;
      let negate = false;
      if (pattern[j] === "!") {
        negate = true;
        j++;
      }
      let cls = "";
      while (j < pattern.length && pattern[j] !== "]") {
        cls += pattern[j];
        j++;
      }
      re += `[${negate ? "^" : ""}${cls}]`;
      i = j + 1;
      continue;
    }

    re += escapeRegExpChar(c);
    i += 1;
  }

  return new RegExp(`^${re}$`);
}

function escapeRegExpChar(c: string): string {
  return /[.+^${}()|\\]/.test(c) ? `\\${c}` : c;
}
