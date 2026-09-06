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
