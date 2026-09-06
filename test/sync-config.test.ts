import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDefaultTrack,
  readSyncConfig,
  syncConfigPath,
  writeDefaultTrack,
  writeSyncConfig,
} from "../src/sync-config";

describe("sync-config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-sync-syncconfig-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("syncConfigPath resolves to .omc/.sync-config.json under the given repo root", () => {
    expect(syncConfigPath(tmpDir)).toBe(
      path.join(tmpDir, ".omc", ".sync-config.json"),
    );
  });

  it("readSyncConfig returns {} when the file doesn't exist yet", () => {
    expect(readSyncConfig(tmpDir)).toEqual({});
  });

  it("getDefaultTrack returns undefined when nothing has been persisted", () => {
    expect(getDefaultTrack(tmpDir)).toBeUndefined();
  });

  it("writeDefaultTrack persists a default track that getDefaultTrack then reads back", () => {
    writeDefaultTrack(tmpDir, "shadow");
    expect(getDefaultTrack(tmpDir)).toBe("shadow");

    writeDefaultTrack(tmpDir, "sibling");
    expect(getDefaultTrack(tmpDir)).toBe("sibling");
  });

  it("writeSyncConfig merges into the existing file, preserving other top-level keys", () => {
    writeSyncConfig(tmpDir, { sibling: { clonePath: "/x", remote: "git@x" } });
    writeDefaultTrack(tmpDir, "sibling");

    const config = readSyncConfig(tmpDir);
    expect(config.sibling).toEqual({ clonePath: "/x", remote: "git@x" });
    expect(config.defaultTrack).toBe("sibling");

    // Writing the default track again must not clobber the sibling entry.
    writeDefaultTrack(tmpDir, "shadow");
    const configAfter = readSyncConfig(tmpDir);
    expect(configAfter.sibling).toEqual({ clonePath: "/x", remote: "git@x" });
    expect(configAfter.defaultTrack).toBe("shadow");
  });
});
