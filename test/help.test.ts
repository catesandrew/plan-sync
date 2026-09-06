import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, USAGE } from "../src/cli";
import { defaultManifestPath, readManifest } from "../src/manifest";

/**
 * Covers the `--help`/`-h` fix: every command must recognize `--help`/`-h`
 * anywhere in its argument list, print command-specific help, exit 0, and
 * never perform its real side effects — as opposed to the bug this closes,
 * where e.g. `plan-sync allow --help` literally added the string `--help`
 * to the manifest as a target.
 */

function captureOutput(fn: () => number) {
  let stdout = "";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });

  const exitCode = fn();

  stdoutSpy.mockRestore();

  return { exitCode, stdout };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("plan-sync --help / -h", () => {
  // Isolated fresh git repo per test, same rationale as test/cli.test.ts:
  // dispatch() resolves repoRoot/default-track from process.cwd(), and
  // command help-paths must never touch real shadow/sibling state.
  let tmpRoot: string;
  let anchorDir: string;
  let originalCwd: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-help-"));
    anchorDir = path.join(tmpRoot, "anchor");
    fs.mkdirSync(anchorDir, { recursive: true });
    git(anchorDir, ["init", "--quiet"]);

    originalCwd = process.cwd();
    originalStateDir = process.env.PLAN_SYNC_STATE_DIR;
    process.env.PLAN_SYNC_STATE_DIR = path.join(tmpRoot, "state-dir");
    process.chdir(anchorDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalStateDir === undefined) {
      delete process.env.PLAN_SYNC_STATE_DIR;
    } else {
      process.env.PLAN_SYNC_STATE_DIR = originalStateDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("top-level 'plan-sync --help' prints USAGE and exits 0", () => {
    const { exitCode, stdout } = captureOutput(() => dispatch(["--help"]));
    expect(exitCode).toBe(0);
    expect(stdout).toBe(USAGE);
  });

  it("top-level 'plan-sync -h' prints USAGE and exits 0", () => {
    const { exitCode, stdout } = captureOutput(() => dispatch(["-h"]));
    expect(exitCode).toBe(0);
    expect(stdout).toBe(USAGE);
  });

  it.each(["--help", "-h"])(
    "'plan-sync init %s' prints init help, exits 0, and creates no .omc state",
    (flag) => {
      const { exitCode, stdout } = captureOutput(() =>
        dispatch(["init", flag]),
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: plan-sync init");
      expect(fs.existsSync(path.join(anchorDir, ".omc"))).toBe(false);
    },
  );

  it.each(["--help", "-h"])(
    "'plan-sync allow %s' prints allow help, exits 0, and adds nothing to the manifest",
    (flag) => {
      const { exitCode, stdout } = captureOutput(() =>
        dispatch(["allow", flag]),
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: plan-sync allow");
      expect(fs.existsSync(defaultManifestPath(anchorDir))).toBe(false);
    },
  );

  it("'plan-sync allow --help' does not add '--help' as a manifest target (the reported bug)", () => {
    const { exitCode } = captureOutput(() => dispatch(["allow", "--help"]));
    expect(exitCode).toBe(0);
    expect(fs.existsSync(defaultManifestPath(anchorDir))).toBe(false);
  });

  it.each(["--help", "-h"])(
    "'plan-sync unallow %s' prints unallow help, exits 0, and leaves the manifest untouched",
    (flag) => {
      fs.mkdirSync(path.join(anchorDir, ".omc"), { recursive: true });
      const manifestPath = defaultManifestPath(anchorDir);
      fs.writeFileSync(manifestPath, "notes.md\n");

      const { exitCode, stdout } = captureOutput(() =>
        dispatch(["unallow", flag]),
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: plan-sync unallow");
      expect(readManifest(manifestPath)).toEqual(["notes.md"]);
    },
  );

  it.each(["--help", "-h"])(
    "'plan-sync push %s' prints push help, exits 0, and does not attempt a real push",
    (flag) => {
      const { exitCode, stdout } = captureOutput(() =>
        dispatch(["push", flag]),
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: plan-sync push");
    },
  );

  it("'plan-sync push --track shadow --help' triggers help regardless of flag position", () => {
    const { exitCode, stdout } = captureOutput(() =>
      dispatch(["push", "--track", "shadow", "--help"]),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: plan-sync push");
  });

  it("'plan-sync push --help --track shadow' triggers help regardless of flag position", () => {
    const { exitCode, stdout } = captureOutput(() =>
      dispatch(["push", "--help", "--track", "shadow"]),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: plan-sync push");
  });

  it.each(["--help", "-h"])(
    "'plan-sync pull %s' prints pull help, exits 0, and does not attempt a real pull",
    (flag) => {
      const { exitCode, stdout } = captureOutput(() =>
        dispatch(["pull", flag]),
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: plan-sync pull");
    },
  );

  it.each(["--help", "-h"])(
    "'plan-sync status %s' prints status help, exits 0, and does not attempt a real status check",
    (flag) => {
      const { exitCode, stdout } = captureOutput(() =>
        dispatch(["status", flag]),
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: plan-sync status");
    },
  );

  it.each(["--help", "-h"])(
    "'plan-sync uninstall %s' prints uninstall help, exits 0, and performs no teardown",
    (flag) => {
      const { exitCode, stdout } = captureOutput(() =>
        dispatch(["uninstall", flag]),
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: plan-sync uninstall");
    },
  );

  it("help never hits a command's 'argument required'-style validation error (e.g. bare 'allow' throws, 'allow --help' must not)", () => {
    const bare = captureOutput(() => dispatch(["allow"]));
    expect(bare.exitCode).not.toBe(0);

    const withHelp = captureOutput(() => dispatch(["allow", "--help"]));
    expect(withHelp.exitCode).toBe(0);
  });
});
