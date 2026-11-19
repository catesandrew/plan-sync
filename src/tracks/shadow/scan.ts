/**
 * Advisory secret-shape scan (Part B, Architecture step 4 of
 * .omc/plans/shadow-ref-git-sync-for-omc-artifacts.md).
 *
 * This is a lightweight, shape-based heuristic backstop — NOT a validated
 * secret detector and NOT the sole confidentiality control for this track.
 * It exists to catch obviously-shaped secrets before they leave the
 * developer's machine; anything genuinely sensitive should go through
 * ordinary host governance (§Part A) or nowhere, per the plan's Risks &
 * Mitigations table.
 */

interface PatternClass {
  label: string;
  pattern: RegExp;
}

const PATTERN_CLASSES: PatternClass[] = [
  // JWT shape: header.payload.signature, each segment base64url-ish.
  {
    label: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  // PEM shape: a "-----BEGIN <TYPE>-----" line, optional RFC 1421 header
  // lines (e.g. Proc-Type), then a base64 body line. Requiring the body keeps
  // prose or regexes that merely mention the header from matching.
  {
    label: "pem",
    pattern: /-----BEGIN [A-Z0-9 ]+-----\r?\n(?:[A-Za-z-]+: .*\r?\n)*\r?\n?[A-Za-z0-9+/=]{16,}\r?\n/,
  },
  // SSN shape: NNN-NN-NNNN. A shape match only — not validated against
  // actual SSA allocation rules.
  {
    label: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  // API-key shape: a common sk-/pk-/api_key- style prefix followed by a
  // long alphanumeric token. A heuristic shape match, not a
  // provider-validated detector.
  {
    label: "api-key",
    pattern: /\b(sk|pk|api[_-]?key)[_-][A-Za-z0-9]{16,}\b/i,
  },
];

/**
 * True when `content` holds the unresolved `git merge-file` markers that
 * pull writes (labels `local`/`remote`). Matching the labels, not bare
 * `<<<<<<<`, keeps docs that merely discuss conflict markers syncable.
 */
export function hasConflictMarkers(content: string | Buffer): boolean {
  const text = content.toString("utf8");
  return /^<<<<<<< local$/m.test(text) && /^>>>>>>> remote$/m.test(text);
}

/**
 * Scans `content` for any of the advisory secret-shape pattern classes
 * (JWT, PEM header, SSN, API-key) and returns the list of human-readable
 * class labels that matched (e.g. `["jwt", "pem"]`), or `[]` if none
 * matched.
 */
export function scanForSecrets(content: string): string[] {
  const matches: string[] = [];
  for (const { label, pattern } of PATTERN_CLASSES) {
    if (pattern.test(content)) {
      matches.push(label);
    }
  }
  return matches;
}
