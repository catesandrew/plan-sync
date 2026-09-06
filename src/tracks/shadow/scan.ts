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
  // PEM header shape: a "-----BEGIN" marker followed eventually by a
  // closing "-----" (either the matching END marker or another dashed
  // marker) somewhere later in the content.
  {
    label: "pem",
    pattern: /-----BEGIN[\s\S]*?-----/,
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
