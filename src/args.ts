export type Track = "sibling" | "shadow";

const VALID_TRACKS: Track[] = ["sibling", "shadow"];

export function parseTrack(args: string[]): { track: Track; rest: string[] } {
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
