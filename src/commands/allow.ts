import { addToManifest, defaultManifestPath } from "../manifest";

export function run(args: string[]): void {
  const [target] = args;
  if (!target) {
    throw new Error("allow: <path> argument is required");
  }

  addToManifest(defaultManifestPath(), target);
}
