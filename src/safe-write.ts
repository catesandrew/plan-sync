import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Shared destination-safety operations used by every track (shadow and
 * sibling) whenever it mutates a destination path derived from the sync
 * manifest — writing, copying-in, or deleting. These are the ONLY way any
 * track is meant to touch such a path: rather than exposing a predicate that
 * call sites must remember to invoke before their own raw `fs.writeFileSync`
 * / `fs.copyFileSync` / `fs.rmSync` call (which is exactly how three
 * unguarded call sites were missed across two prior hardening rounds), each
 * exported function here performs the safety check itself and then performs
 * the operation, atomically from the call site's point of view.
 *
 * The guard refuses (and logs a warning instead of throwing) whenever:
 *
 *   (a) `destPath` itself already exists as a symlink — checked via
 *       `fs.lstatSync(destPath, { throwIfNoEntry: false })`, NOT
 *       `fs.existsSync` + `lstatSync`. `existsSync` follows symlinks, so it
 *       misses a DANGLING symlink (one whose target doesn't resolve to
 *       anything); `lstatSync` with `throwIfNoEntry: false` correctly
 *       returns a stats object for a dangling symlink, revealing that it's
 *       a symlink even though it doesn't resolve anywhere. This case is
 *       unsafe regardless of whether the link target exists.
 *   (b) `destPath`'s nearest ancestor directory that actually exists on
 *       disk — walking UP from `path.dirname(destPath)`, not just the
 *       immediate parent, since `fs.mkdirSync(..., { recursive: true })`
 *       will happily create intermediate directories through an existing
 *       symlinked ancestor several levels up — resolves (via
 *       `fs.realpathSync`) outside `root`.
 *
 * If `destPath` doesn't exist as any kind of entry yet (the ordinary
 * first-write case) and its resolved ancestor chain stays within `root`,
 * there's nothing on disk to escape through, so normal creation is safe.
 *
 * The check itself never throws: any unexpected filesystem error
 * encountered while resolving realpath/lstat during the check (e.g. ENOENT
 * on a dangling-symlink ancestor, ENOTDIR when an ancestor is a regular
 * file, not a directory) is treated as "unsafe, refuse" rather than
 * propagating an uncaught exception that would abort an entire
 * push/pull/restore mid-run.
 */
function isSafeDestination(root: string, destPath: string): boolean {
  try {
    const destStat = fs.lstatSync(destPath, { throwIfNoEntry: false });
    if (destStat && destStat.isSymbolicLink()) {
      return false;
    }

    const realDir = resolveRealPath(path.dirname(destPath));
    const realRoot = resolveRealPath(root);

    return realDir === realRoot || realDir.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/**
 * Resolves `target` to its real, symlink-free absolute path, even when
 * `target` (or some of its ancestors) doesn't exist on disk yet: walks up
 * to the nearest ancestor that does exist, resolves that ancestor via
 * `fs.realpathSync`, then lexically re-appends the not-yet-created
 * remainder — safe, since a path component that doesn't exist yet cannot be
 * a symlink.
 *
 * Not wrapped in its own try/catch: any thrown error here (e.g.
 * `fs.realpathSync` on a dangling-symlink ancestor, or `fs.lstatSync`
 * hitting `ENOTDIR` partway up because an ancestor is a regular file, not a
 * directory) is intentionally allowed to propagate up to `isSafeDestination`,
 * whose try/catch is the single place that turns any such error into
 * "unsafe, refuse".
 */
function resolveRealPath(target: string): string {
  let existing = path.resolve(target);
  const suffix: string[] = [];

  while (fs.lstatSync(existing, { throwIfNoEntry: false }) === undefined) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      // Reached the filesystem root without finding anything that exists.
      break;
    }
    suffix.unshift(path.basename(existing));
    existing = parent;
  }

  const realExisting = fs.realpathSync(existing);
  return suffix.length > 0 ? path.join(realExisting, ...suffix) : realExisting;
}

/**
 * Safely writes `content` to `destPath`, refusing (and logging a warning)
 * rather than writing if `destPath` is unsafe per `isSafeDestination`.
 * Creates any missing intermediate directories first. Returns whether the
 * write actually happened.
 */
export function safeWriteFile(
  root: string,
  destPath: string,
  content: Buffer | string,
): boolean {
  if (!isSafeDestination(root, destPath)) {
    process.stderr.write(
      `omc-sync: refusing to write through symlink at ${destPath}\n`,
    );
    return false;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content);
  return true;
}

/**
 * Safely copies `srcPath` to `destPath`, refusing (and logging a warning)
 * rather than copying if `destPath` is unsafe per `isSafeDestination`.
 * Creates any missing intermediate directories first. Returns whether the
 * copy actually happened.
 */
export function safeCopyFile(
  root: string,
  srcPath: string,
  destPath: string,
): boolean {
  if (!isSafeDestination(root, destPath)) {
    process.stderr.write(
      `omc-sync: refusing to write through symlink at ${destPath}\n`,
    );
    return false;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  return true;
}

/**
 * Safely removes `destPath`, refusing (and logging a warning) rather than
 * removing if `destPath` is unsafe per `isSafeDestination` — checked FIRST,
 * unconditionally, before existence is even considered, so a symlinked
 * ancestor resolving outside `root` is refused the same way the write path
 * refuses it, even when nothing currently exists at `destPath` through it
 * (e.g. the ancestor symlink points at a real but empty outside directory).
 *
 * Once deemed safe, existence is checked via
 * `fs.lstatSync(destPath, { throwIfNoEntry: false })`, NOT `fs.existsSync` —
 * `existsSync` follows symlinks, so it reports a DANGLING symlink as
 * "doesn't exist", which is exactly how a prior hardening round's
 * `restore.ts` bug allowed a stale `existsSync` check to skip a symlinked
 * ancestor escape undetected. A path that genuinely doesn't exist at all
 * (lstat returns `undefined`) is a no-op, returning `true` (nothing to do).
 * Any unexpected filesystem error while resolving that existence check
 * (e.g. `ENOTDIR` when a higher path component is a regular file, not a
 * directory) is also treated as "unsafe, refuse" rather than propagating.
 * Returns whether the path ended up absent (either it never existed, or it
 * was safely removed).
 */
export function safeRemove(root: string, destPath: string): boolean {
  // The safety check runs first (and unconditionally), not gated behind an
  // existence check — a symlinked ancestor that resolves outside `root`
  // must be refused with the same warning the write path gives, even when
  // nothing currently exists at `destPath` through it (e.g. the ancestor
  // symlink points at a real, but empty, outside directory). Checking
  // existence first and only conditionally checking safety would silently
  // no-op that case instead, asymmetric with `safeWriteFile`/`safeCopyFile`.
  if (!isSafeDestination(root, destPath)) {
    process.stderr.write(
      `omc-sync: refusing to remove through symlink at ${destPath}\n`,
    );
    return false;
  }

  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(destPath, { throwIfNoEntry: false });
  } catch {
    return false;
  }

  if (stat === undefined) {
    return true;
  }

  fs.rmSync(destPath, { force: true });
  return true;
}
