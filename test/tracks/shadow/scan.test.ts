import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../../../src/tracks/shadow/scan";

describe("scanForSecrets", () => {
  it("flags a JWT-shaped string", () => {
    const content =
      "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\n";
    expect(scanForSecrets(content)).toEqual(["jwt"]);
  });

  it("flags a PEM header", () => {
    const content = "-----BEGIN PRIVATE KEY-----\nMIIBVQ...\n-----END PRIVATE KEY-----\n";
    expect(scanForSecrets(content)).toEqual(["pem"]);
  });

  it("flags an SSN-shaped string", () => {
    const content = "ssn: 123-45-6789\n";
    expect(scanForSecrets(content)).toEqual(["ssn"]);
  });

  it("flags an API-key-shaped string", () => {
    const content = "key: sk_ABCDEFGHIJKLMNOPQRSTUVWX\n";
    expect(scanForSecrets(content)).toEqual(["api-key"]);
  });

  it("returns an empty array for clean content", () => {
    const content = "# Just a normal planning doc\n\nSome notes about the roadmap.\n";
    expect(scanForSecrets(content)).toEqual([]);
  });

  it("returns multiple labels when a file matches more than one class", () => {
    const content =
      "jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\nssn: 123-45-6789\n";
    expect(scanForSecrets(content)).toEqual(["jwt", "ssn"]);
  });
});
