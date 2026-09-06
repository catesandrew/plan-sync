import * as fs from "node:fs";
import * as path from "node:path";

const GLOB_META = /[*?[]/;

/** Returns true if `pattern` contains any glob metacharacter (`*`, `?`, `[`). */
export function hasGlobMeta(pattern: string): boolean {
  return GLOB_META.test(pattern);
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
export function globToRegExp(pattern: string): RegExp {
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

/**
 * Expands `pattern` against every regular file's path (relative to `root`)
 * found by walking the filesystem starting at `root`. Returns the sorted
 * list of matching relative paths.
 *
 * Shared symlink-safe expansion logic used by both `allow` (one-time glob
 * expansion into literal manifest entries) and `resolveManifestPaths` in
 * `src/manifest.ts` (live-rule expansion performed at push/status time) —
 * previously duplicated as a private `walkFiles` inside `src/commands/allow.ts`.
 */
export function expandGlobUnderRoot(root: string, pattern: string): string[] {
  const allFiles: string[] = [];
  walkFiles(root, "", allFiles);

  const regex = globToRegExp(pattern);
  return allFiles.filter((relPath) => regex.test(relPath)).sort();
}

/**
 * Recursively collects every regular file's path (relative to `root`) under
 * `root`/`relDir`. Confines the walk to real, non-symlinked directories:
 * every entry is `lstat`-ed before being recursed into or collected, so a
 * symlinked directory component is never descended into, and a symlinked
 * file is never collected.
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
