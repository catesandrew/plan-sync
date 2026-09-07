import * as fs from "node:fs";
import * as path from "node:path";

const GLOB_META = /[*?[]/;

/** Returns true if `pattern` contains any glob metacharacter (`*`, `?`, `[`). */
export function hasGlobMeta(pattern: string): boolean {
  return GLOB_META.test(pattern);
}

/** A compiled glob pattern. Deliberately shaped like the `RegExp` this
 * module used to build, so callers only ever need `.test(value)`. */
export interface GlobMatcher {
  /** Returns true if `value` matches the whole compiled pattern. */
  test(value: string): boolean;
}

type Token =
  /** A single literal code point. */
  | { kind: "literal"; cp: string }
  /** `?` — exactly one code point, not `/`. */
  | { kind: "any" }
  /** `*` — zero or more code points, none of them `/`. */
  | { kind: "star" }
  /** `**` — zero or more code points, `/` included. */
  | { kind: "globstar" }
  /** `**` followed by `/` — nothing, or any run ending in `/`. */
  | { kind: "globstarSlash" }
  /** `[...]` / `[!...]` — exactly one code point in (or not in) the set.
   * Ranges hold numeric code points: comparing the characters as strings
   * would order a non-BMP code point by its leading surrogate instead. */
  | { kind: "class"; negate: boolean; ranges: Array<[number, number]> };

/**
 * Compiles a simple glob pattern into an anchored matcher, hand-rolled (no
 * new dependency, per repo convention): `*` matches any run of characters
 * except `/`, `?` matches exactly one character except `/`, `**`
 * (optionally followed by `/`) matches any run of characters including `/`
 * — i.e. any depth of subdirectories, including zero — and `[...]`/`[!...]`
 * character classes match one character in (or not in) the set, supporting
 * `a-z` ranges.
 *
 * The name predates the implementation and is kept so existing callers
 * compile unchanged; the returned value is intentionally NOT a `RegExp`.
 * A `RegExp` without the `u` flag matches `.`/`?`/`[^/]` against a single
 * UTF-16 code unit, so a non-BMP filename character — an emoji, a CJK
 * Extension-B ideograph — counts as TWO characters, meaning `reports/?.md`
 * would not match `reports/🎉.md` and `[🎉]` would be a broken surrogate
 * class. This matcher walks code points instead (`Array.from`), so "one
 * character" means one Unicode code point, which is also what the Go port
 * in `go/internal/glob` does with runes. Keeping both engines code-point
 * based is what makes them conformant rather than accidentally similar.
 */
export function globToRegExp(pattern: string): GlobMatcher {
  const tokens = compile(pattern);
  return {
    test: (value: string) => matchTokens(tokens, Array.from(value), 0, 0),
  };
}

/**
 * Splits `pattern` into matcher tokens. `**` immediately followed by `/`
 * collapses into a single `globstarSlash` token so that a pattern like
 * `plans/` + `**` + `/*.md` also matches `plans/a.md` (zero intervening
 * directories).
 */
function compile(pattern: string): Token[] {
  const cps = Array.from(pattern);
  const tokens: Token[] = [];
  let i = 0;

  while (i < cps.length) {
    const c = cps[i];

    if (c === "*" && cps[i + 1] === "*") {
      if (cps[i + 2] === "/") {
        tokens.push({ kind: "globstarSlash" });
        i += 3;
      } else {
        tokens.push({ kind: "globstar" });
        i += 2;
      }
      continue;
    }

    if (c === "*") {
      tokens.push({ kind: "star" });
      i += 1;
      continue;
    }

    if (c === "?") {
      tokens.push({ kind: "any" });
      i += 1;
      continue;
    }

    if (c === "[") {
      const { token, next } = compileClass(cps, i);
      tokens.push(token);
      i = next;
      continue;
    }

    tokens.push({ kind: "literal", cp: c });
    i += 1;
  }

  return tokens;
}

/**
 * Parses the `[...]` class starting at `cps[start]` (which is `[`) and
 * returns the token plus the index just past the closing `]`. A leading `!`
 * or `^` negates. Inside the class, `a-z` is a range; a `-` without a code
 * point on both sides is a literal. An unterminated class consumes the rest
 * of the pattern.
 */
function compileClass(
  cps: string[],
  start: number,
): { token: Token; next: number } {
  let i = start + 1;
  let negate = false;
  const ranges: Array<[number, number]> = [];

  if (cps[i] === "!" || cps[i] === "^") {
    negate = true;
    i += 1;
  }

  while (i < cps.length && cps[i] !== "]") {
    if (cps[i + 1] === "-" && i + 2 < cps.length && cps[i + 2] !== "]") {
      ranges.push([codePointOf(cps[i]), codePointOf(cps[i + 2])]);
      i += 3;
      continue;
    }
    ranges.push([codePointOf(cps[i]), codePointOf(cps[i])]);
    i += 1;
  }

  if (i < cps.length) {
    i += 1; // consume the closing `]`
  }

  return { token: { kind: "class", negate, ranges }, next: i };
}

/** `Array.from` yields whole code points, so index 0 is never a lone
 * surrogate and `codePointAt(0)` is always defined for a non-empty string. */
function codePointOf(cp: string): number {
  return cp.codePointAt(0) as number;
}

function classMatches(
  token: Extract<Token, { kind: "class" }>,
  cp: string,
): boolean {
  const value = codePointOf(cp);
  const inSet = token.ranges.some(([lo, hi]) => value >= lo && value <= hi);
  return inSet !== token.negate;
}

/**
 * Anchors `tokens[ti:]` against `cps[si:]`, backtracking over the wildcard
 * tokens. Every advance consumes exactly one code point.
 */
function matchTokens(
  tokens: Token[],
  cps: string[],
  ti: number,
  si: number,
): boolean {
  for (;;) {
    if (ti === tokens.length) {
      return si === cps.length;
    }

    const token = tokens[ti];

    switch (token.kind) {
      case "literal":
        if (si >= cps.length || cps[si] !== token.cp) {
          return false;
        }
        ti += 1;
        si += 1;
        break;

      case "any":
        if (si >= cps.length || cps[si] === "/") {
          return false;
        }
        ti += 1;
        si += 1;
        break;

      case "class":
        if (si >= cps.length || !classMatches(token, cps[si])) {
          return false;
        }
        ti += 1;
        si += 1;
        break;

      case "star": {
        for (let k = si; ; k += 1) {
          if (matchTokens(tokens, cps, ti + 1, k)) {
            return true;
          }
          if (k >= cps.length || cps[k] === "/") {
            return false;
          }
        }
      }

      case "globstar": {
        for (let k = si; k <= cps.length; k += 1) {
          if (matchTokens(tokens, cps, ti + 1, k)) {
            return true;
          }
        }
        return false;
      }

      case "globstarSlash": {
        if (matchTokens(tokens, cps, ti + 1, si)) {
          return true;
        }
        for (let k = si; k < cps.length; k += 1) {
          if (cps[k] === "/" && matchTokens(tokens, cps, ti + 1, k + 1)) {
            return true;
          }
        }
        return false;
      }
    }
  }
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

  const matcher = globToRegExp(pattern);
  return allFiles.filter((relPath) => matcher.test(relPath)).sort();
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
