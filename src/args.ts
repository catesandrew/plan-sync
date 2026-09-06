export type Track = "sibling" | "shadow";

/**
 * Checks whether `--help`/`-h` appears anywhere in `args`. Commands must
 * call this FIRST, before any other flag parsing or validation, so that
 * `--help` works regardless of its position in the argument list and never
 * triggers the command's real side effects or "argument required" errors.
 */
export function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

const VALID_TRACKS: Track[] = ["sibling", "shadow"];

/**
 * Parses `--track <sibling|shadow>` out of `args`. When `--track` isn't
 * given at all and `defaultTrack` is provided (typically the persisted
 * default from `.omc/.sync-config.json`, via `getDefaultTrack()`), falls
 * back to `defaultTrack` instead of throwing — letting multi-track commands
 * work without repeating `--track` on every invocation once one has been
 * initialized. An explicitly passed `--track` always overrides the default.
 */
export function parseTrack(
  args: string[],
  defaultTrack?: Track,
): { track: Track; rest: string[] } {
  const rest: string[] = [];
  let track: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--track") {
      track = args[i + 1];
      i++;
    } else if (arg?.startsWith("--track=")) {
      track = arg.slice("--track=".length);
    } else {
      rest.push(arg);
    }
  }

  if (!track && defaultTrack) {
    return { track: defaultTrack, rest };
  }

  if (!track || !VALID_TRACKS.includes(track as Track)) {
    throw new Error(
      `--track is required and must be one of: ${VALID_TRACKS.join(", ")} (got: ${track ?? "<none>"})`,
    );
  }

  return { track: track as Track, rest };
}

export function parseFlag(args: string[], name: string): { value: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  const flag = `--${name}`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      value = args[i + 1];
      i++;
    } else if (arg?.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1);
    } else {
      rest.push(arg);
    }
  }

  return { value, rest };
}
