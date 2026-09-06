import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, COMMANDS, USAGE } from "../src/cli";

function captureOutput(fn: () => number) {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });

  const exitCode = fn();

  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();

  return { exitCode, stdout, stderr };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("plan-sync CLI dispatch", () => {
  // Every dispatch call below resolves repoRoot/default-track from
  // process.cwd() (see src/repo-root.ts / src/sync-config.ts). Running these
  // tests from this project's own real repo root would read this project's
  // ACTUAL .omc/.sync-config.json (if one exists, e.g. from manual CLI
  // testing) and could execute REAL push/restore/status/uninstall against
  // real remote state — which is exactly what happened once, deleting a
  // real shadow-track setup. Every test here MUST run inside its own
  // fresh, isolated, no-config git repo.
  let tmpRoot: string;
  let anchorDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-cli-"));
    anchorDir = path.join(tmpRoot, "anchor");
    fs.mkdirSync(anchorDir, { recursive: true });
    git(anchorDir, ["init", "--quiet"]);

    originalCwd = process.cwd();
    process.chdir(anchorDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("prints usage listing all 8 subcommands and exits non-zero when given no args", () => {
    const { exitCode, stdout } = captureOutput(() => dispatch([]));

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain(USAGE);
    for (const name of [
      "init",
      "allow",
      "unallow",
      "push",
      "pull",
      "restore",
      "status",
      "uninstall",
    ]) {
      expect(stdout).toContain(name);
    }
  });

  it("prints usage and exits non-zero for an unrecognized command", () => {
    const { exitCode, stdout } = captureOutput(() =>
      dispatch(["not-a-real-command"]),
    );

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain(USAGE);
  });

  it.each(["init", "allow", "unallow", "push", "pull", "restore", "status", "uninstall"])(
    "routes %s to its own command module (real error, not an unknown-command error)",
    (name) => {
      expect(COMMANDS).toHaveProperty(name);

      const { exitCode, stdout, stderr } = captureOutput(() =>
        dispatch([name]),
      );

      // With no --track, no persisted default track (fresh repo, no
      // .omc/.sync-config.json), and no prior init, every command is
      // expected to fail with a command-specific error — but it must NOT
      // be treated as an unrecognized command (no usage text), and the
      // error message should reference this specific command.
      expect(exitCode).not.toBe(0);
      expect(stdout).not.toContain(USAGE);
      expect(stderr).toContain(name);
    },
  );
});
