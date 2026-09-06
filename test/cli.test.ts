import { describe, expect, it, vi } from "vitest";
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

describe("omc-sync CLI dispatch", () => {
  it("prints usage listing all 7 subcommands and exits non-zero when given no args", () => {
    const { exitCode, stdout } = captureOutput(() => dispatch([]));

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain(USAGE);
    for (const name of [
      "init",
      "allow",
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

  it.each(["init", "allow", "push", "pull", "restore", "status", "uninstall"])(
    "routes %s to its own command module (stub, not an unknown-command error)",
    (name) => {
      expect(COMMANDS).toHaveProperty(name);

      const { exitCode, stdout, stderr } = captureOutput(() =>
        dispatch([name]),
      );

      // Stub commands are expected to fail (not implemented yet), but they
      // must NOT be treated as an unrecognized command — i.e. no usage text,
      // and the error message should reference this specific command.
      expect(exitCode).not.toBe(0);
      expect(stdout).not.toContain(USAGE);
      expect(stderr).toContain(name);
    },
  );
});
