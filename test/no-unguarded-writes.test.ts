import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural regression test: makes a future missed destination-safety call
 * site (the exact failure mode found across four completion-review rounds
 * on US-010) fail CI directly, rather than relying on a reviewer to
 * re-enumerate every mutation site by hand.
 *
 * Scans every `.ts` file under `src/tracks/` for a direct, unguarded call to
 * `fs.rmSync(`, `fs.writeFileSync(`, or `fs.copyFileSync(`. `src/safe-write.ts`
 * itself (outside `src/tracks/`, so never scanned) legitimately calls these
 * raw functions internally — it's the only place allowed to. A small,
 * explicit allowlist below covers the handful of *known*, deliberately
 * reviewed raw calls remaining under `src/tracks/` whose destination is
 * clearly NOT a manifest-derived path (tool-owned metadata/config files, or
 * a track's own temp-directory cleanup) — anything else must route through
 * `safeWriteFile`/`safeCopyFile`/`safeRemove`.
 */

const TRACKS_DIR = path.join(__dirname, "..", "src", "tracks");

const FORBIDDEN_PATTERNS = [
  /fs\.rmSync\(/,
  /fs\.writeFileSync\(/,
  /fs\.copyFileSync\(/,
];

// Each entry: a raw call under src/tracks/ that is deliberately NOT a
// manifest-derived destination mutation, and so is exempt from the guard.
const ALLOWLIST: Array<{ file: string; snippet: string; reason: string }> = [
  {
    file: "shadow/init.ts",
    snippet: 'fs.writeFileSync(attributesPath, "* -text\\n")',
    reason: "writes the shadow bare repo's own git-attributes file, not a manifest path",
  },
  {
    file: "shadow/push.ts",
    snippet: "fs.rmSync(path.dirname(indexFile)",
    reason: "cleans up its own throwaway GIT_INDEX_FILE temp directory, not a manifest path",
  },
  {
    file: "shadow/uninstall.ts",
    snippet: "fs.rmSync(shadowRepoPath",
    reason: "removes the entire shadow repo state directory on uninstall, not a per-file manifest path",
  },
  {
    file: "sibling/init.ts",
    snippet: "fs.writeFileSync(configPath",
    reason: "writes the tool's own local sync-config file, not a manifest path",
  },
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function isAllowed(relFile: string, line: string): boolean {
  return ALLOWLIST.some(
    (entry) => entry.file === relFile && line.includes(entry.snippet),
  );
}

describe("structural regression: no unguarded destination mutations under src/tracks/", () => {
  it("contains no direct fs.rmSync/fs.writeFileSync/fs.copyFileSync calls outside the explicit allowlist", () => {
    const files = listTsFiles(TRACKS_DIR);
    const violations: string[] = [];

    for (const file of files) {
      const relFile = path.relative(TRACKS_DIR, file).split(path.sep).join("/");
      const lines = fs.readFileSync(file, "utf8").split("\n");

      lines.forEach((line, index) => {
        const matchesForbidden = FORBIDDEN_PATTERNS.some((pattern) =>
          pattern.test(line),
        );
        if (matchesForbidden && !isAllowed(relFile, line)) {
          violations.push(`${relFile}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it("the allowlist itself only references lines that still exist verbatim (catches stale entries)", () => {
    for (const entry of ALLOWLIST) {
      const full = path.join(TRACKS_DIR, entry.file);
      const contents = fs.readFileSync(full, "utf8");
      expect(contents).toContain(entry.snippet);
    }
  });
});
