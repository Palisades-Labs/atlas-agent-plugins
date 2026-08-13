import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliPinPolicyError,
  parseCliPinPolicy,
  transitionCliPinPolicy,
} from "./cli-pin-policy";

const fixtures = new Set<string>();

afterEach(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
  fixtures.clear();
});

function fixture(state: "bootstrap" | "pinned"): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-cli-pin-policy-"));
  fixtures.add(root);
  const bin = join(root, "atlas/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "cli-pin-policy.json"),
    `${JSON.stringify({ schemaVersion: 1, state }, null, 2)}\n`,
  );
  return root;
}

describe("parseCliPinPolicy", () => {
  test("accepts the two exact machine states", () => {
    expect(
      parseCliPinPolicy('{"schemaVersion":1,"state":"bootstrap"}'),
    ).toEqual({ schemaVersion: 1, state: "bootstrap" });
    expect(
      parseCliPinPolicy('{"schemaVersion":1,"state":"pinned"}'),
    ).toEqual({ schemaVersion: 1, state: "pinned" });
  });

  test("rejects malformed, unknown, and extensible-looking policies", () => {
    for (const raw of [
      "{broken",
      "[]",
      '{"schemaVersion":2,"state":"bootstrap"}',
      '{"schemaVersion":1,"state":"future"}',
      '{"schemaVersion":1,"state":"bootstrap","allowAnyway":true}',
    ]) {
      expect(() => parseCliPinPolicy(raw)).toThrow(CliPinPolicyError);
    }
  });
});

describe("transitionCliPinPolicy", () => {
  test("atomically disables the one-time bootstrap allowance", () => {
    const root = fixture("bootstrap");
    expect(transitionCliPinPolicy(root, "pinned")).toEqual({
      schemaVersion: 1,
      state: "pinned",
    });
    expect(
      JSON.parse(
        readFileSync(join(root, "atlas/bin/cli-pin-policy.json"), "utf8"),
      ),
    ).toEqual({ schemaVersion: 1, state: "pinned" });
  });

  test("is idempotent when an interrupted release workflow resumes", () => {
    const root = fixture("pinned");
    expect(transitionCliPinPolicy(root, "pinned").state).toBe("pinned");
  });

  test("never transitions a pinned distribution back to bootstrap", () => {
    const root = fixture("pinned");
    expect(() => transitionCliPinPolicy(root, "bootstrap")).toThrow(
      "cannot transition back to bootstrap",
    );
  });
});
