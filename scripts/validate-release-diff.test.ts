import { describe, expect, test } from "bun:test";
import {
  ReleaseDiffError,
  validateReleaseDiff,
  type ReleaseDiffSnapshot,
} from "./validate-release-diff";

const MANIFESTS = [
  "atlas/.claude-plugin/plugin.json",
  "atlas/.codex-plugin/plugin.json",
  "atlas/.cursor-plugin/plugin.json",
] as const;

function snapshot(
  version: string,
  options: {
    changelogVersion?: string;
    pinState?: "bootstrap" | "pinned";
    pinPolicyMissing?: boolean;
    driftPath?: (typeof MANIFESTS)[number];
  } = {},
): ReleaseDiffSnapshot {
  const manifests = Object.fromEntries(
    MANIFESTS.map((path) => [
      path,
      JSON.stringify({
        name: "atlas",
        version: path === options.driftPath ? "9.9.9" : version,
      }),
    ]),
  ) as Record<(typeof MANIFESTS)[number], string>;
  return {
    manifests,
    changelog: `# Changelog\n\n## ${options.changelogVersion ?? version} - 2026-07-23\n\n- Test release.\n`,
    pinPolicy: options.pinPolicyMissing
      ? null
      : JSON.stringify({
        schemaVersion: 1,
        state: options.pinState ?? "pinned",
      }),
  };
}

function failureCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ReleaseDiffError) return error.code;
    throw error;
  }
  throw new Error("expected release diff validation to fail");
}

describe("validateReleaseDiff", () => {
  test("does not demand a release bump for non-shipped script changes", () => {
    expect(
      validateReleaseDiff(
        ["scripts/validate-release-diff.ts"],
        snapshot("1.2.3"),
        snapshot("1.2.3"),
      ),
    ).toEqual({ atlasChanged: false });
  });

  for (const headVersion of ["1.2.3", "1.2.2", "0.99.99"]) {
    test(`rejects shipped content at non-increasing version ${headVersion}`, () => {
      expect(
        failureCode(() =>
          validateReleaseDiff(
            ["atlas/skills/setup/SKILL.md", "atlas/CHANGELOG.md"],
            snapshot("1.2.3"),
            snapshot(headVersion),
          )
        ),
      ).toBe("plugin_version_not_increased");
    });
  }

  test("requires changelog to be part of the exact base diff", () => {
    expect(
      failureCode(() =>
        validateReleaseDiff(
          ["atlas/bin/atlas-forwarder"],
          snapshot("1.2.3"),
          snapshot("1.2.4"),
        )
      ),
    ).toBe("changelog_not_changed");
  });

  test("requires the new heading to match the increased plugin version", () => {
    expect(
      failureCode(() =>
        validateReleaseDiff(
          ["atlas/bin/atlas-forwarder", "atlas/CHANGELOG.md"],
          snapshot("1.2.3"),
          snapshot("1.2.4", { changelogVersion: "1.2.3" }),
        )
      ),
    ).toBe("head_changelog_version_mismatch");
  });

  test("rejects manifest drift in either tree", () => {
    expect(
      failureCode(() =>
        validateReleaseDiff(
          ["atlas/bin/atlas-forwarder", "atlas/CHANGELOG.md"],
          snapshot("1.2.3"),
          snapshot("1.2.4", { driftPath: MANIFESTS[2] }),
        )
      ),
    ).toBe("plugin_manifest_version_drift");
  });

  test("never allows pinned checksum policy to regress to bootstrap", () => {
    expect(
      failureCode(() =>
        validateReleaseDiff(
          ["atlas/bin/cli-pin-policy.json", "atlas/CHANGELOG.md"],
          snapshot("1.2.3", { pinState: "pinned" }),
          snapshot("1.2.4", { pinState: "bootstrap" }),
        )
      ),
    ).toBe("cli_pin_policy_regression");
  });

  test("allows the guard rollout to replace legacy implicit state once", () => {
    expect(
      validateReleaseDiff(
        ["atlas/bin/cli-pin-policy.json", "atlas/CHANGELOG.md"],
        snapshot("1.2.3", { pinPolicyMissing: true }),
        snapshot("1.2.4", { pinState: "bootstrap" }),
      ),
    ).toEqual({
      atlasChanged: true,
      baseVersion: "1.2.3",
      headVersion: "1.2.4",
    });
  });

  test("rejects a legacy base unless the exact policy file is introduced", () => {
    expect(
      failureCode(() =>
        validateReleaseDiff(
          ["atlas/bin/atlas-forwarder", "atlas/CHANGELOG.md"],
          snapshot("1.2.3", { pinPolicyMissing: true }),
          snapshot("1.2.4", { pinState: "bootstrap" }),
        )
      ),
    ).toBe("missing_base_cli_pin_policy");
  });

  test("accepts one strict bump, matching changelog, and first pin transition", () => {
    expect(
      validateReleaseDiff(
        [
          "atlas/bin/cli-checksums",
          "atlas/bin/cli-pin-policy.json",
          "atlas/CHANGELOG.md",
        ],
        snapshot("1.2.3", { pinState: "bootstrap" }),
        snapshot("1.2.4", { pinState: "pinned" }),
      ),
    ).toEqual({
      atlasChanged: true,
      baseVersion: "1.2.3",
      headVersion: "1.2.4",
    });
  });
});
