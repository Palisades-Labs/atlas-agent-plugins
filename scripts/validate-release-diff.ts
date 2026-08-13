#!/usr/bin/env bun
/**
 * PR-base guard for shipped atlas/** changes.
 *
 * Head-only validation can prove manifest lockstep but cannot prove that a
 * release version increased. This guard compares the exact PR base tree with
 * HEAD and requires every shipped Atlas change to carry one strictly greater
 * X.Y.Z plugin version plus a matching new changelog heading.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCliPinPolicy } from "./cli-pin-policy";

const MANIFEST_PATHS = [
  "atlas/.claude-plugin/plugin.json",
  "atlas/.codex-plugin/plugin.json",
  "atlas/.cursor-plugin/plugin.json",
] as const;
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ReleaseDiffSnapshot {
  manifests: Readonly<Record<(typeof MANIFEST_PATHS)[number], string>>;
  changelog: string;
  pinPolicy: string | null;
}

export interface ReleaseDiffResult {
  atlasChanged: boolean;
  baseVersion?: string;
  headVersion?: string;
}

export class ReleaseDiffError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "ReleaseDiffError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseDiffError(code, message);
}

function parseManifestVersion(raw: string, label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("invalid_manifest_json", `${label} is not valid JSON`);
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || typeof (parsed as Record<string, unknown>).version !== "string"
  ) {
    fail("invalid_manifest_version", `${label} has no string version`);
  }
  const version = (parsed as Record<string, unknown>).version as string;
  if (!STRICT_SEMVER.test(version)) {
    fail(
      "invalid_manifest_version",
      `${label} version must be strict X.Y.Z semver`,
    );
  }
  return version;
}

function snapshotVersion(
  snapshot: ReleaseDiffSnapshot,
  label: string,
): string {
  const versions = MANIFEST_PATHS.map((path) =>
    parseManifestVersion(snapshot.manifests[path], `${label}:${path}`)
  );
  if (new Set(versions).size !== 1) {
    fail(
      "plugin_manifest_version_drift",
      `${label} plugin manifests are not version-locked`,
    );
  }
  return versions[0] as string;
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => BigInt(part));
  const rightParts = right.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] as bigint;
    const rightPart = rightParts[index] as bigint;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function latestChangelogVersion(raw: string, label: string): string {
  const match = /^##\s+(\d+\.\d+\.\d+)(?:\s+-\s+\d{4}-\d{2}-\d{2})?\s*$/m.exec(
    raw,
  );
  if (!match?.[1]) {
    fail("missing_changelog_version", `${label} has no release heading`);
  }
  return match[1];
}

export function validateReleaseDiff(
  changedPaths: readonly string[],
  base: ReleaseDiffSnapshot,
  head: ReleaseDiffSnapshot,
): ReleaseDiffResult {
  const atlasChanges = changedPaths.filter(
    (path) => path === "atlas" || path.startsWith("atlas/"),
  );
  if (atlasChanges.length === 0) return { atlasChanged: false };

  const baseVersion = snapshotVersion(base, "base");
  const headVersion = snapshotVersion(head, "head");
  if (compareSemver(headVersion, baseVersion) <= 0) {
    fail(
      "plugin_version_not_increased",
      `shipped atlas/** changed but plugin version ${headVersion} is not greater than base ${baseVersion}`,
    );
  }

  if (!atlasChanges.includes("atlas/CHANGELOG.md")) {
    fail(
      "changelog_not_changed",
      "shipped atlas/** changed but atlas/CHANGELOG.md is absent from the base diff",
    );
  }
  const baseChangelogVersion = latestChangelogVersion(
    base.changelog,
    "base changelog",
  );
  if (baseChangelogVersion !== baseVersion) {
    fail(
      "base_changelog_version_mismatch",
      `base changelog ${baseChangelogVersion} does not match base plugin ${baseVersion}`,
    );
  }
  const headChangelogVersion = latestChangelogVersion(
    head.changelog,
    "head changelog",
  );
  if (headChangelogVersion !== headVersion) {
    fail(
      "head_changelog_version_mismatch",
      `head changelog ${headChangelogVersion} does not match head plugin ${headVersion}`,
    );
  }

  if (head.pinPolicy === null) {
    fail(
      "missing_head_cli_pin_policy",
      "the shipped Atlas tree must carry explicit CLI pin policy state",
    );
  }
  const headPinState = parseCliPinPolicy(head.pinPolicy).state;
  if (base.pinPolicy === null) {
    if (!atlasChanges.includes("atlas/bin/cli-pin-policy.json")) {
      fail(
        "missing_base_cli_pin_policy",
        "the legacy base has no CLI pin policy and this diff does not introduce one",
      );
    }
  } else if (
    parseCliPinPolicy(base.pinPolicy).state === "pinned"
    && headPinState === "bootstrap"
  ) {
    fail(
      "cli_pin_policy_regression",
      "a pinned distribution cannot return to bootstrap checksum policy",
    );
  }

  return { atlasChanged: true, baseVersion, headVersion };
}

function runGit(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new ReleaseDiffError(
      "git_command_failed",
      result.stderr.toString().trim() || `git ${args[0]} failed`,
    );
  }
  return result.stdout.toString();
}

function readHeadSnapshot(root: string): ReleaseDiffSnapshot {
  return {
    manifests: Object.fromEntries(
      MANIFEST_PATHS.map((path) => [path, readFileSync(join(root, path), "utf8")]),
    ) as Record<(typeof MANIFEST_PATHS)[number], string>,
    changelog: readFileSync(join(root, "atlas/CHANGELOG.md"), "utf8"),
    pinPolicy: readFileSync(
      join(root, "atlas/bin/cli-pin-policy.json"),
      "utf8",
    ),
  };
}

function readBaseSnapshot(root: string, base: string): ReleaseDiffSnapshot {
  const show = (path: string): string =>
    runGit(root, ["show", `${base}:${path}`]);
  const policyPath = "atlas/bin/cli-pin-policy.json";
  const basePolicyPaths = runGit(root, [
    "ls-tree",
    "--name-only",
    base,
    "--",
    policyPath,
  ]).split(/\r?\n/).filter(Boolean);
  if (
    basePolicyPaths.length > 1
    || (basePolicyPaths.length === 1 && basePolicyPaths[0] !== policyPath)
  ) {
    fail(
      "ambiguous_base_cli_pin_policy",
      "could not resolve the base CLI pin policy unambiguously",
    );
  }
  return {
    manifests: Object.fromEntries(
      MANIFEST_PATHS.map((path) => [path, show(path)]),
    ) as Record<(typeof MANIFEST_PATHS)[number], string>,
    changelog: show("atlas/CHANGELOG.md"),
    // The first guard rollout compares against the legacy implicit-placeholder
    // tree. Absence is accepted only when this same diff introduces the new
    // explicit policy; every later base must carry machine-readable state.
    pinPolicy: basePolicyPaths.length === 1 ? show(policyPath) : null,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (
    args.length !== 2
    || args[0] !== "--base"
    || !/^[0-9a-fA-F]{7,64}$/.test(args[1] as string)
  ) {
    console.error(
      "usage: bun scripts/validate-release-diff.ts --base <git-commit>",
    );
    process.exit(2);
  }
  const base = args[1] as string;
  const root = resolve(import.meta.dir, "..");
  runGit(root, ["rev-parse", "--verify", `${base}^{commit}`]);
  const changedPaths = runGit(root, [
    "diff",
    "--name-only",
    "--diff-filter=ACDMRTUXB",
    `${base}...HEAD`,
    "--",
    "atlas",
  ]).split(/\r?\n/).filter(Boolean);
  const result = validateReleaseDiff(
    changedPaths,
    readBaseSnapshot(root, base),
    readHeadSnapshot(root),
  );
  if (!result.atlasChanged) {
    console.log("validate-release-diff: OK (no shipped atlas/** changes)");
    return;
  }
  console.log(
    `validate-release-diff: OK (atlas ${result.baseVersion} -> ${result.headVersion})`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`validate-release-diff: ${message}`);
    process.exit(1);
  }
}
