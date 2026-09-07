import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeCopyFile, safeRemove, safeWriteFile } from "../src/safe-write";

describe("safe-write", () => {
  let tmpDir: string;
  let root: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-safe-write-"));
    root = path.join(tmpDir, "root");
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("safeWriteFile", () => {
    it("writes, creating missing intermediate directories, and returns true", () => {
      const dest = path.join(root, "a", "b", "file.md");
      expect(safeWriteFile(root, dest, "hello\n")).toBe(true);
      expect(fs.readFileSync(dest, "utf8")).toBe("hello\n");
    });

    it("refuses to write through an existing symlink at the destination", () => {
      const outside = path.join(tmpDir, "outside.txt");
      fs.writeFileSync(outside, "original\n");
      const dest = path.join(root, "linked.md");
      fs.symlinkSync(outside, dest);

      expect(safeWriteFile(root, dest, "attack\n")).toBe(false);
      expect(fs.readFileSync(outside, "utf8")).toBe("original\n");
    });

    it("refuses to write through a symlinked ancestor directory", () => {
      const outsideDir = path.join(tmpDir, "outside-dir-write");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(root, "plans"));
      const dest = path.join(root, "plans", "foo.md");

      expect(safeWriteFile(root, dest, "attack\n")).toBe(false);
      expect(fs.existsSync(path.join(outsideDir, "foo.md"))).toBe(false);
    });

    it("fails closed (never throws) when a dangling symlink is a mid-path ancestor", () => {
      fs.symlinkSync(
        path.join(tmpDir, "does-not-exist"),
        path.join(root, "ghost"),
      );
      const dest = path.join(root, "ghost", "deep", "file.md");

      expect(() => safeWriteFile(root, dest, "x\n")).not.toThrow();
      expect(safeWriteFile(root, dest, "x\n")).toBe(false);
    });

    it("fails closed (never throws) when a regular file is a mid-path ancestor", () => {
      fs.writeFileSync(
        path.join(root, "notadir"),
        "i am a file, not a directory\n",
      );
      const dest = path.join(root, "notadir", "deep", "file.md");

      expect(() => safeWriteFile(root, dest, "x\n")).not.toThrow();
      expect(safeWriteFile(root, dest, "x\n")).toBe(false);
    });

    // Net-new case (e) per .omc/plans/go-port.md: a DANGLING symlink AT the
    // destination path itself, not as a mid-path ancestor. Ported alongside
    // its Go counterpart,
    // TestSafeWriteFileRefusesDanglingSymlinkAtDestinationItself. This is
    // the case fs.existsSync reports as "doesn't exist" because it follows
    // the link (findings 6 and 7 in docs/HARDENING-HISTORY.md) — the guard
    // must see the link via lstat and refuse rather than create the outside
    // target through it.
    it("refuses to write through a DANGLING symlink at the destination itself", () => {
      const outsideTarget = path.join(tmpDir, "outside-not-yet-created.txt");
      const dest = path.join(root, "dangling.md");
      fs.symlinkSync(outsideTarget, dest);

      // Precondition: the follow-the-link view reports the destination as
      // absent, while the lstat view sees the symlink. If this ever stops
      // holding, the guard's choice of lstat is no longer load-bearing.
      expect(fs.existsSync(dest)).toBe(false);
      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);

      expect(safeWriteFile(root, dest, "attack\n")).toBe(false);
      expect(fs.existsSync(outsideTarget)).toBe(false);
    });

    // Net-new case (f) per .omc/plans/go-port.md: a LIVE symlinked ancestor
    // at path depth >= 2 where the destination's IMMEDIATE parent does not
    // exist on disk yet. Ported alongside its Go counterpart,
    // TestSafeWriteFileRefusesLiveSymlinkedAncestorTwoLevelsUp. An
    // implementation that only checked the immediate parent (or only its
    // existence) would miss this and let the mkdir-recursive step walk
    // straight through the symlink — finding 8 in
    // docs/HARDENING-HISTORY.md.
    it("refuses to write through a live symlinked ancestor two levels up when the immediate parent does not exist", () => {
      const outsideDir = path.join(tmpDir, "outside-deep");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(root, "plans"));

      // root/plans/sub does NOT exist (neither does outsideDir/sub), so the
      // destination's immediate parent (root/plans/sub/deep) is two levels
      // below the symlink and three below the nearest existing entry.
      const dest = path.join(root, "plans", "sub", "deep", "file.md");
      expect(fs.existsSync(path.join(outsideDir, "sub"))).toBe(false);

      expect(safeWriteFile(root, dest, "attack\n")).toBe(false);
      expect(fs.existsSync(path.join(outsideDir, "sub"))).toBe(false);
    });
  });

  describe("safeCopyFile", () => {
    it("copies to a safe destination and returns true", () => {
      const src = path.join(tmpDir, "src.md");
      fs.writeFileSync(src, "copied content\n");
      const dest = path.join(root, "dest.md");

      expect(safeCopyFile(root, src, dest)).toBe(true);
      expect(fs.readFileSync(dest, "utf8")).toBe("copied content\n");
    });

    it("refuses to copy through a symlinked ancestor directory", () => {
      const outsideDir = path.join(tmpDir, "outside-dir-copy");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(root, "plans"));
      const src = path.join(tmpDir, "src.md");
      fs.writeFileSync(src, "attack\n");
      const dest = path.join(root, "plans", "foo.md");

      expect(safeCopyFile(root, src, dest)).toBe(false);
      expect(fs.existsSync(path.join(outsideDir, "foo.md"))).toBe(false);
    });

    it("fails closed (never throws) when a regular file is a mid-path ancestor", () => {
      fs.writeFileSync(path.join(root, "notadir"), "i am a file\n");
      const src = path.join(tmpDir, "src.md");
      fs.writeFileSync(src, "content\n");
      const dest = path.join(root, "notadir", "deep", "file.md");

      expect(() => safeCopyFile(root, src, dest)).not.toThrow();
      expect(safeCopyFile(root, src, dest)).toBe(false);
    });
  });

  describe("safeRemove", () => {
    it("is a no-op returning true when the path does not exist at all", () => {
      const dest = path.join(root, "never-existed.md");
      expect(safeRemove(root, dest)).toBe(true);
    });

    it("removes an existing file within root and returns true", () => {
      const dest = path.join(root, "gone.md");
      fs.writeFileSync(dest, "bye\n");
      expect(safeRemove(root, dest)).toBe(true);
      expect(fs.existsSync(dest)).toBe(false);
    });

    it("refuses to remove through a symlinked ancestor directory escaping root", () => {
      const outsideDir = path.join(tmpDir, "outside-dir-rm");
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, "foo.md");
      fs.writeFileSync(outsideFile, "outside content\n");
      fs.symlinkSync(outsideDir, path.join(root, "plans"));
      const dest = path.join(root, "plans", "foo.md");

      expect(safeRemove(root, dest)).toBe(false);
      expect(fs.existsSync(outsideFile)).toBe(true);
    });

    it("fails closed (never throws) when a dangling symlink is a mid-path ancestor", () => {
      fs.symlinkSync(
        path.join(tmpDir, "does-not-exist"),
        path.join(root, "ghost"),
      );
      const dest = path.join(root, "ghost", "deep", "file.md");

      expect(() => safeRemove(root, dest)).not.toThrow();
    });

    it("fails closed (never throws) when a regular file is a mid-path ancestor", () => {
      fs.writeFileSync(path.join(root, "notadir"), "i am a file\n");
      const dest = path.join(root, "notadir", "deep", "file.md");

      expect(() => safeRemove(root, dest)).not.toThrow();
    });
  });
});
