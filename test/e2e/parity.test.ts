import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveProjectId, resolveShadowRepoPath } from "../../src/tracks/shadow/paths";

/**
 * Cross-implementation parity harness (Tier 1 + Tier 2 of
 * .omc/plans/go-port.md's Parity Tiers).
 *
 * Unlike every other file in test/e2e/, this one does NOT import
 * `dispatch` and run it in-process: it builds BOTH shipping artifacts —
 * the TypeScript `dist/cli.js` and the Go `plan-sync-go` binary — and execs
 * each as a real subprocess against its own private, byte-identical
 * throwaway git fixture, then diffs the outcomes. That subprocess harness
 * is the net-new infrastructure the plan calls for; in-process dispatch
 * cannot reach a compiled Go binary at all, and comparing the two
 * implementations is the whole point.
 *
 * What is compared, and at which tier:
 *
 *   Tier 1 (strict, byte-identical, gating)
 *     - `.sync-manifest` bytes
 *     - `.sync-config.json` bytes (see NORMALIZATION below)
 *     - exit code of every step
 *     - synced file content in the sibling clone (path set + bytes)
 *     - the shadow track's project-id, ref name, and local shadow-repo path
 *     - shadow-`pull`-materialized file bytes and merged-manifest bytes
 *
 *   Tier 2 (structural, with NAMED exclusions)
 *     - stdout of every step, and stderr with the exclusions below
 *
 * NORMALIZATION (the complete, deliberately short list of what is
 * normalized out, and why each one is inherently non-comparable rather
 * than merely inconvenient):
 *
 *   1. Each implementation's own fixture base directory. The two runs MUST
 *      operate on two separate repos — running both binaries against one
 *      repo would make each one's result depend on the other's writes and
 *      test nothing — so any absolute path that appears in output or in
 *      `.sync-config.json` necessarily differs by exactly that prefix. The
 *      two base directory names are chosen to be the same length ("ts" /
 *      "go") so a length-sensitive diff is still meaningful.
 *   2. The stderr identity marker line itself (`plan-sync: ts/0.1.0 (...)`
 *      vs. `plan-sync: go/0.1.0 (...)`), which exists precisely BECAUSE the
 *      two implementations must be distinguishable. It is asserted
 *      explicitly, per implementation, rather than diffed.
 *   3. Nothing else. In particular, the sibling track has no wall-clock
 *      output to normalize: `status --track sibling`
 *      (src/tracks/sibling/status.ts:94,97) prints only repo-relative paths,
 *      one of four fixed state strings, and integer counts. The `formatAge`
 *      human-readable age token that Tier 2 names as an exclusion is
 *      shadow-track-only (src/tracks/shadow/status.ts), and shadow `status`
 *      is Phase 2 in the Go binary, so it is not exercised here.
 */

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const TS_IMPL_MARKER = "ts/0.1.0";
const GO_IMPL_MARKER = "go/0.1.0";
const MANIFEST_FILENAME = ".sync-manifest";
const CONFIG_FILENAME = ".sync-config.json";
const ROOT_DIR = ".omc";

/** Fixed identity + timestamps, so both fixtures' root commits — and
 * therefore the shadow track's root-commit-derived project-id — are
 * byte-identical rather than merely "shaped the same". */
const FIXED_GIT_ENV = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_AUTHOR_DATE: "2024-01-01T00:00:00+0000",
  GIT_COMMITTER_DATE: "2024-01-01T00:00:00+0000",
};

const GO_AVAILABLE = spawnSync("go", ["version"], { stdio: "pipe" }).status === 0;
if (!GO_AVAILABLE) {
  console.warn(
    "[parity] `go` is not on $PATH — the cross-implementation parity suite " +
      "is being SKIPPED. It is a gating Phase 1 acceptance criterion, so a " +
      "run without Go installed does not satisfy it.",
  );
}

interface Impl {
  /** Short id, also the fixture directory name — same length for both. */
  id: string;
  /** `<impl>/<version>` half of the stderr identity marker. */
  marker: string;
  argv: string[];
}

interface StepResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(
  impl: Impl,
  argv: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): StepResult {
  const [command, ...baseArgs] = impl.argv;
  const result = spawnSync(command, [...baseArgs, ...argv], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...FIXED_GIT_ENV,
      // Hermetic git: no user/system config bleeds in, and no credential
      // prompt can hang a subprocess against an unreachable remote.
      GIT_CONFIG_GLOBAL: path.join(cwd, "no-such-gitconfig"),
      GIT_CONFIG_SYSTEM: path.join(cwd, "no-such-gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnv,
    },
  });
  if (result.error) {
    throw new Error(`failed to exec ${impl.id} binary: ${result.error.message}`);
  }
  return {
    // A signal-killed subprocess has status === null; surface it as a
    // distinct, obviously-wrong code rather than silently coercing to 0.
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...FIXED_GIT_ENV },
  }).trim();
}

function gitStdin(cwd: string, stdin: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, ...FIXED_GIT_ENV },
  }).trim();
}

/** Normalization #1: strip an implementation's own fixture base path. */
function normalizePaths(text: string, base: string): string {
  return text.split(base).join("<BASE>");
}

/** Normalization #2: drop the identity-marker line (asserted separately). */
function stripIdentityMarker(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !/^plan-sync: (?:ts|go)\/\d+\.\d+\.\d+ \(/.test(line))
    .join("\n");
}

/** Recursive path->bytes snapshot of a directory, excluding `.git/`. */
function snapshotDir(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.set(rel, fs.readFileSync(abs));
      } else {
        // A symlink (or anything else) in the clone would be a finding in
        // its own right — record its kind so a diff surfaces it instead of
        // silently ignoring it.
        out.set(rel, Buffer.from(`<non-regular-file:${entry.name}>`));
      }
    }
  };
  walk(dir, "");
  return out;
}

function readBytes(p: string): Buffer {
  return fs.readFileSync(p);
}

describe.skipIf(!GO_AVAILABLE)(
  "e2e: cross-implementation parity (real TS and Go binaries, subprocess-exec)",
  () => {
    let tmpRoot: string;
    let impls: Impl[];

    beforeAll(() => {
      // Both artifacts are built FRESH here, so the suite can never pass
      // against a stale `dist/` or a stale Go binary from an earlier tree.
      execFileSync("npm", ["run", "build"], {
        cwd: PROJECT_ROOT,
        stdio: "pipe",
      });
      const tsCli = path.join(PROJECT_ROOT, "dist", "cli.js");
      if (!fs.existsSync(tsCli)) {
        throw new Error(`npm run build did not produce ${tsCli}`);
      }

      tmpRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-parity-")),
      );
      const goBin = path.join(tmpRoot, "plan-sync-go");
      execFileSync("go", ["build", "-o", goBin, "./cmd/plan-sync-go"], {
        cwd: path.join(PROJECT_ROOT, "go"),
        stdio: "pipe",
      });

      impls = [
        { id: "ts", marker: TS_IMPL_MARKER, argv: [process.execPath, tsCli] },
        { id: "go", marker: GO_IMPL_MARKER, argv: [goBin] },
      ];
      expect(impls[0].id.length).toBe(impls[1].id.length);
    }, 300_000);

    afterAll(() => {
      if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it(
      "Tier 1 + Tier 2: sibling-track init -> allow -> push -> status is identical across implementations",
      () => {
        // Two separate, byte-identical starting repos, one per binary.
        const runs = impls.map((impl) => {
          const base = path.join(tmpRoot, impl.id);
          const anchor = path.join(base, "anchor");
          const remote = path.join(base, "remote.git");
          const clone = path.join(base, "clone");

          fs.mkdirSync(anchor, { recursive: true });
          git(base, ["init", "--quiet", "--bare", remote]);
          git(anchor, ["init", "--quiet"]);
          git(anchor, ["config", "user.name", "Test User"]);
          git(anchor, ["config", "user.email", "test@example.com"]);

          // Identical starting content in both repos, created before init so
          // both resolve the same root dir (.omc).
          const omc = path.join(anchor, ROOT_DIR);
          fs.mkdirSync(path.join(omc, "docs"), { recursive: true });
          fs.writeFileSync(path.join(omc, "file1.md"), "content one\n");
          fs.writeFileSync(path.join(omc, "docs", "a.md"), "doc a\n");
          // CRLF, to catch any line-ending mangling on either side.
          fs.writeFileSync(path.join(omc, "docs", "b.md"), "doc b\r\nwith crlf\r\n");

          const steps: string[][] = [
            ["init", "--track", "sibling", "--remote", remote, "--clone-path", clone],
            ["allow", "file1.md"],
            ["allow", "docs/*.md"],
            ["push", "--track", "sibling"],
            ["status", "--track", "sibling"],
          ];
          const results = steps.map((argv) => run(impl, argv, anchor));

          return { impl, base, anchor, clone, omc, steps, results };
        });

        const [ts, go] = runs;

        // --- Tier 1: exit codes, step by step. ---
        for (let i = 0; i < ts.steps.length; i++) {
          const label = ts.steps[i].join(" ");
          expect(
            ts.results[i].exitCode,
            `TS step \`${label}\` failed: ${ts.results[i].stderr}`,
          ).toBe(0);
          expect(
            go.results[i].exitCode,
            `Go step \`${label}\` failed: ${go.results[i].stderr}`,
          ).toBe(0);
          expect(go.results[i].exitCode, `exit code mismatch on \`${label}\``).toBe(
            ts.results[i].exitCode,
          );
        }

        // --- Tier 1: manifest bytes. Manifest entries are repo-relative, so
        // this comparison needs no normalization at all. ---
        const tsManifest = readBytes(path.join(ts.omc, MANIFEST_FILENAME));
        const goManifest = readBytes(path.join(go.omc, MANIFEST_FILENAME));
        expect(goManifest.equals(tsManifest)).toBe(true);
        expect(tsManifest.toString("utf8")).toBe("file1.md\ndocs/*.md\n");

        // --- Tier 1: .sync-config.json bytes (normalization #1 only: the
        // config legitimately stores this fixture's own absolute clonePath
        // and remote). ---
        const tsConfig = normalizePaths(
          fs.readFileSync(path.join(ts.omc, CONFIG_FILENAME), "utf8"),
          ts.base,
        );
        const goConfig = normalizePaths(
          fs.readFileSync(path.join(go.omc, CONFIG_FILENAME), "utf8"),
          go.base,
        );
        expect(goConfig).toBe(tsConfig);
        // Guard the normalization itself: if it silently matched nothing,
        // the comparison above would be vacuous for these two keys.
        expect(tsConfig).toContain("<BASE>");
        // The trailing-newline + key-order shape the plan gates on.
        expect(tsConfig.endsWith("}\n")).toBe(true);

        // --- Tier 1: synced content in each clone (path set + bytes). ---
        const tsClone = snapshotDir(ts.clone);
        const goClone = snapshotDir(go.clone);
        expect([...goClone.keys()].sort()).toEqual([...tsClone.keys()].sort());
        expect(tsClone.size).toBeGreaterThan(0);
        for (const [rel, tsBytes] of tsClone) {
          const goBytes = goClone.get(rel);
          expect(goBytes, `${rel} missing from the Go clone`).toBeDefined();
          expect(
            (goBytes as Buffer).equals(tsBytes),
            `${rel} differs between clones`,
          ).toBe(true);
        }
        // The push must actually have synced the manifest-listed content,
        // otherwise "both clones are identical" is trivially true of two
        // empty clones.
        expect([...tsClone.keys()].sort()).toEqual([
          ".sync-manifest",
          "docs/a.md",
          "docs/b.md",
          "file1.md",
        ]);

        // --- Tier 2: stdout, and stderr with the two named exclusions. ---
        for (let i = 0; i < ts.steps.length; i++) {
          const label = ts.steps[i].join(" ");
          expect(
            normalizePaths(go.results[i].stdout, go.base),
            `stdout mismatch on \`${label}\``,
          ).toBe(normalizePaths(ts.results[i].stdout, ts.base));
          expect(
            normalizePaths(stripIdentityMarker(go.results[i].stderr), go.base),
            `stderr (marker excluded) mismatch on \`${label}\``,
          ).toBe(normalizePaths(stripIdentityMarker(ts.results[i].stderr), ts.base));
        }

        // --- The identity marker itself: asserted per implementation
        // (excluded from the diff above precisely because it must differ). ---
        for (const { impl, steps, results } of runs) {
          for (let i = 0; i < steps.length; i++) {
            const commandName = steps[i][0];
            const marker = `plan-sync: ${impl.marker} (${commandName})`;
            if (commandName === "status") {
              // status is read-only: no marker.
              expect(results[i].stderr).not.toContain(impl.marker);
            } else {
              expect(results[i].stderr).toContain(`${marker}\n`);
              expect(results[i].stderr.split("\n")[0]).toBe(marker);
            }
            // Neither binary may ever claim to be the other one.
            const otherMarker =
              impl.marker === TS_IMPL_MARKER ? GO_IMPL_MARKER : TS_IMPL_MARKER;
            expect(results[i].stderr).not.toContain(otherMarker);
          }
        }
      },
      300_000,
    );

    it(
      "Tier 1: shadow-track init -> pull materializes byte-identical content across implementations",
      () => {
        const refDoc1 = Buffer.from("shadow doc one\n", "utf8");
        const refDoc2 = Buffer.from("shadow doc two\r\nwith crlf\r\n", "utf8");
        const refManifest = Buffer.from("doc1.md\ndoc2.md\n", "utf8");
        // Deliberately NO trailing newline, to exercise addToManifest's
        // `needsLeadingNewline` edge case (src/manifest.ts:138-141) on the
        // manifest-merge path — the byte-level edge case the plan calls out
        // as otherwise uncovered.
        const localManifest = "local-only.md";

        const runs = impls.map((impl) => {
          const base = path.join(tmpRoot, `shadow-${impl.id}`);
          const anchor = path.join(base, "anchor");
          const originRemote = path.join(base, "origin-remote.git");
          const stateDir = path.join(base, "state");
          const freshStateDir = path.join(base, "state-fresh");

          fs.mkdirSync(anchor, { recursive: true });
          fs.mkdirSync(base, { recursive: true });
          git(base, ["init", "--quiet", "--bare", originRemote]);
          git(anchor, ["init", "--quiet"]);
          git(anchor, ["config", "user.name", "Test User"]);
          git(anchor, ["config", "user.email", "test@example.com"]);
          git(anchor, ["remote", "add", "origin", originRemote]);
          fs.writeFileSync(path.join(anchor, "README.md"), "hello\n");
          git(anchor, ["add", "README.md"]);
          git(anchor, ["commit", "--quiet", "-m", "initial commit"]);

          // --- init --track shadow on the "pushing machine". ---
          const initResult = run(impl, ["init", "--track", "shadow"], anchor, {
            PLAN_SYNC_STATE_DIR: stateDir,
          });
          expect(
            initResult.exitCode,
            `${impl.id} init --track shadow failed: ${initResult.stderr}`,
          ).toBe(0);

          // The project-id and shadow-repo path are derived, not reported,
          // so parity is asserted by predicting them with ONE derivation
          // (the TS helper) and requiring the other binary's on-disk result
          // to land exactly there.
          const projectId = resolveProjectId(anchor);
          const shadowRepoPath = resolveShadowRepoPath(projectId, ROOT_DIR, {
            env: { PLAN_SYNC_STATE_DIR: stateDir },
          });
          expect(
            fs.existsSync(shadowRepoPath),
            `${impl.id} did not create the shadow repo at the derived path ${shadowRepoPath}`,
          ).toBe(true);
          const refName = `refs/plan-sync/${projectId}/omc/data`;

          // --- Build the shadow ref directly with git plumbing: `push
          // --track shadow` is Phase 2 in the Go binary, so the ref that
          // command would normally produce is constructed here instead. ---
          const gitDir = `--git-dir=${shadowRepoPath}`;
          const indexFile = path.join(base, "fixture-index");
          const files: Array<[string, Buffer]> = [
            ["doc1.md", refDoc1],
            ["doc2.md", refDoc2],
            [MANIFEST_FILENAME, refManifest],
          ];
          for (const [relPath, content] of files) {
            const blob = gitStdin(shadowRepoPath, content.toString("binary"), [
              gitDir,
              "hash-object",
              "-w",
              "--stdin",
            ]);
            execFileSync(
              "git",
              [gitDir, "update-index", "--add", "--cacheinfo", `100644,${blob},${relPath}`],
              {
                cwd: shadowRepoPath,
                stdio: "pipe",
                env: { ...process.env, ...FIXED_GIT_ENV, GIT_INDEX_FILE: indexFile },
              },
            );
          }
          const tree = execFileSync("git", [gitDir, "write-tree"], {
            cwd: shadowRepoPath,
            encoding: "utf8",
            env: { ...process.env, ...FIXED_GIT_ENV, GIT_INDEX_FILE: indexFile },
          }).trim();
          const commit = git(shadowRepoPath, [
            gitDir,
            "commit-tree",
            tree,
            "-m",
            "fixture commit",
          ]);
          git(shadowRepoPath, [gitDir, "update-ref", refName, commit]);
          git(shadowRepoPath, [gitDir, "push", "--quiet", "origin", `+${refName}:${refName}`]);

          // --- Simulate a fresh machine: brand-new state dir, re-init
          // against the same origin, so pull must fetch the ref rather than
          // read a local one. ---
          const freshInit = run(impl, ["init", "--track", "shadow"], anchor, {
            PLAN_SYNC_STATE_DIR: freshStateDir,
          });
          expect(
            freshInit.exitCode,
            `${impl.id} fresh-machine init failed: ${freshInit.stderr}`,
          ).toBe(0);

          const omc = path.join(anchor, ROOT_DIR);
          fs.mkdirSync(omc, { recursive: true });
          fs.writeFileSync(path.join(omc, MANIFEST_FILENAME), localManifest);

          const pullResult = run(impl, ["pull", "--track", "shadow"], anchor, {
            PLAN_SYNC_STATE_DIR: freshStateDir,
          });

          return { impl, base, anchor, omc, projectId, refName, pullResult };
        });

        const [ts, go] = runs;

        // --- Tier 1: derived identifiers agree. Both fixtures' root commits
        // are byte-identical (fixed content, identity and dates), so the
        // root-commit-derived project-id — and therefore the ref name — must
        // match exactly. ---
        expect(go.projectId).toBe(ts.projectId);
        expect(go.refName).toBe(ts.refName);
        expect(ts.projectId).toMatch(/^[0-9a-f]{12}$/);

        // --- Tier 1: exit codes. ---
        expect(ts.pullResult.exitCode, `TS pull failed: ${ts.pullResult.stderr}`).toBe(0);
        expect(go.pullResult.exitCode, `Go pull failed: ${go.pullResult.stderr}`).toBe(0);

        // --- Tier 1: materialized file bytes. ---
        for (const [rel, want] of [
          ["doc1.md", refDoc1],
          ["doc2.md", refDoc2],
        ] as Array<[string, Buffer]>) {
          const tsBytes = readBytes(path.join(ts.omc, rel));
          const goBytes = readBytes(path.join(go.omc, rel));
          expect(tsBytes.equals(want), `TS ${rel} content differs from the ref blob`).toBe(true);
          expect(goBytes.equals(tsBytes), `${rel} differs between implementations`).toBe(true);
        }

        // --- Tier 1: merged-manifest bytes, including the
        // needsLeadingNewline edge case (the local manifest had no trailing
        // newline, so the merge must insert one before the first incoming
        // entry). ---
        const tsMerged = readBytes(path.join(ts.omc, MANIFEST_FILENAME));
        const goMerged = readBytes(path.join(go.omc, MANIFEST_FILENAME));
        expect(goMerged.equals(tsMerged)).toBe(true);
        expect(tsMerged.toString("utf8")).toBe("local-only.md\ndoc1.md\ndoc2.md\n");

        // --- Tier 2: stdout / stderr with the named exclusions. ---
        expect(normalizePaths(go.pullResult.stdout, go.base)).toBe(
          normalizePaths(ts.pullResult.stdout, ts.base),
        );
        expect(normalizePaths(stripIdentityMarker(go.pullResult.stderr), go.base)).toBe(
          normalizePaths(stripIdentityMarker(ts.pullResult.stderr), ts.base),
        );
        for (const { impl, pullResult } of runs) {
          expect(pullResult.stderr.split("\n")[0]).toBe(
            `plan-sync: ${impl.marker} (pull)`,
          );
        }
      },
      300_000,
    );

    it(
      "Tier 2: the Go binary's shadow push/status stubs exit non-zero with a Phase-2-referencing message",
      () => {
        // Asserted against the Go binary ALONE, deliberately: the TS
        // implementation's shadow push/status are fully implemented, so
        // there is no TS behavior to reach parity with here. What is gated
        // is that the Go stub behaves as designed — non-zero exit, a clear
        // stderr message naming Phase 2 — rather than silently succeeding
        // or crashing opaquely.
        const go = impls.find((impl) => impl.id === "go");
        if (!go) throw new Error("Go implementation was not registered");

        const base = path.join(tmpRoot, "shadow-stub-go");
        const anchor = path.join(base, "anchor");
        const originRemote = path.join(base, "origin-remote.git");
        const stateDir = path.join(base, "state");

        fs.mkdirSync(anchor, { recursive: true });
        git(base, ["init", "--quiet", "--bare", originRemote]);
        git(anchor, ["init", "--quiet"]);
        git(anchor, ["config", "user.name", "Test User"]);
        git(anchor, ["config", "user.email", "test@example.com"]);
        git(anchor, ["remote", "add", "origin", originRemote]);
        fs.writeFileSync(path.join(anchor, "README.md"), "hello\n");
        git(anchor, ["add", "README.md"]);
        git(anchor, ["commit", "--quiet", "-m", "initial commit"]);

        expect(
          run(go, ["init", "--track", "shadow"], anchor, {
            PLAN_SYNC_STATE_DIR: stateDir,
          }).exitCode,
        ).toBe(0);

        for (const command of ["push", "status"]) {
          const result = run(go, [command, "--track", "shadow"], anchor, {
            PLAN_SYNC_STATE_DIR: stateDir,
          });

          expect(result.exitCode, `\`${command} --track shadow\` should fail`).not.toBe(0);
          expect(result.stderr).toContain("Phase 2");
          expect(result.stderr).toContain(`${command} --track shadow`);
          // Usage text would mean "unknown command"; this must be a real,
          // routed command that declines.
          expect(result.stdout).not.toContain("Usage: plan-sync");
        }

        // push mutates (when implemented), so it announces itself; status is
        // read-only and must not.
        expect(
          run(go, ["push", "--track", "shadow"], anchor, {
            PLAN_SYNC_STATE_DIR: stateDir,
          }).stderr.split("\n")[0],
        ).toBe(`plan-sync: ${GO_IMPL_MARKER} (push)`);
        expect(
          run(go, ["status", "--track", "shadow"], anchor, {
            PLAN_SYNC_STATE_DIR: stateDir,
          }).stderr,
        ).not.toContain(GO_IMPL_MARKER);
      },
      300_000,
    );
  },
);
