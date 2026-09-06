import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToManifest, readManifest } from "../src/manifest";

describe("manifest", () => {
  let tmpDir: string;
  let manifestPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-manifest-"));
    manifestPath = path.join(tmpDir, ".omc", ".sync-manifest");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reading a nonexistent manifest returns []", () => {
    expect(readManifest(manifestPath)).toEqual([]);
  });

  it("reading an empty manifest returns []", () => {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, "");

    expect(readManifest(manifestPath)).toEqual([]);
  });

  it("reading a populated manifest returns exactly its listed paths, ignoring blank lines and comments", () => {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      [
        "# this is a comment",
        "notes.md",
        "",
        "  ",
        "plans/foo.md",
        "# another comment",
      ].join("\n"),
    );

    expect(readManifest(manifestPath)).toEqual(["notes.md", "plans/foo.md"]);
  });

  it("adds a new path to the manifest, creating the file and parent directory", () => {
    expect(fs.existsSync(manifestPath)).toBe(false);

    addToManifest(manifestPath, "notes.md");

    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(readManifest(manifestPath)).toEqual(["notes.md"]);
  });

  it("adding a duplicate path is idempotent (no duplicate line written)", () => {
    addToManifest(manifestPath, "notes.md");
    addToManifest(manifestPath, "notes.md");

    expect(readManifest(manifestPath)).toEqual(["notes.md"]);

    const rawLines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(rawLines).toEqual(["notes.md"]);
  });

  it("adds multiple distinct paths across separate calls", () => {
    addToManifest(manifestPath, "notes.md");
    addToManifest(manifestPath, "plans/foo.md");

    expect(readManifest(manifestPath)).toEqual(["notes.md", "plans/foo.md"]);
  });

  it("allow rejects a '../' traversal path with a clear error, without writing anything", () => {
    expect(() => addToManifest(manifestPath, "../../etc/passwd")).toThrow(
      /resolves outside \.omc\//,
    );
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it("allow rejects an absolute path with a clear error, without writing anything", () => {
    expect(() => addToManifest(manifestPath, "/etc/passwd")).toThrow(
      /absolute paths are not allowed/,
    );
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it("readManifest skips an out-of-bounds hand-edited entry with a warning, but still returns the other valid entries", () => {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      ["notes.md", "../../etc/passwd", "/etc/shadow", "plans/foo.md"].join(
        "\n",
      ),
    );

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    expect(readManifest(manifestPath)).toEqual(["notes.md", "plans/foo.md"]);

    const warnings = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(warnings).toContain("../../etc/passwd");
    expect(warnings).toContain("/etc/shadow");

    stderrSpy.mockRestore();
  });
});
