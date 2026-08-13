#!/usr/bin/env bun
/**
 * Fail-closed contract verifier for an immutable Atlas plugin release.
 *
 * This script is deliberately network- and credential-free. The release
 * workflow normalizes GitHub API responses into one bounded JSON file and
 * downloads the referenced CLI release's checksums.txt. This verifier then
 * proves that the native plugin tag, all three manifests, launcher pins, CLI
 * release metadata/assets, remote checksums, and any existing plugin release
 * describe one exact immutable release pair.
 */
import {
  appendFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  CliPinPolicyError,
  parseCliPinPolicy,
} from "./cli-pin-policy";

const PLUGIN_TAG_PREFIX = "atlas--v";
const CLI_TAG_PREFIX = "atlas-cli-v";
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 1_000_000;
const MAX_TEXT_BYTES = 64_000;
const MAX_DIAGNOSTIC_VALUE = 120;

const MANIFEST_PATHS = [
  "atlas/.claude-plugin/plugin.json",
  "atlas/.codex-plugin/plugin.json",
  "atlas/.cursor-plugin/plugin.json",
] as const;

const CLI_TARGETS = [
  "atlas-darwin-arm64",
  "atlas-darwin-x64",
  "atlas-linux-arm64",
  "atlas-linux-x64",
] as const;
const CLI_TARGET_SET = new Set<string>(CLI_TARGETS);

const EXPECTED_CLI_ASSETS = [
  ...CLI_TARGETS,
  "checksums.txt",
  ...CLI_TARGETS.map((target) => `${target}.sigstore.json`),
].sort();

export type ReleaseMode = "create" | "resume";

export interface VerifyPluginReleaseOptions {
  root: string;
  tag: string;
  metadataPath: string;
  releaseChecksumsPath: string;
  githubOutputPath?: string;
}

export interface VerifiedPluginRelease {
  releaseMode: ReleaseMode;
  pluginVersion: string;
  cliVersion: string;
  pluginReleaseTag: string;
  cliReleaseTag: string;
}

interface CliReleaseMetadata {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
  isImmutable: boolean;
  assets: string[];
}

interface ExistingPluginReleaseMetadata {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
  isImmutable: boolean;
}

interface ReleaseMetadata {
  cliRelease: CliReleaseMetadata;
  existingPluginRelease: ExistingPluginReleaseMetadata | null;
}

export class ReleaseContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "ReleaseContractError";
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseContractError(code, message);
}

function preview(value: unknown): string {
  const rendered =
    typeof value === "string"
      ? value
      : value === null
        ? "null"
        : typeof value;
  const bounded =
    rendered.length <= MAX_DIAGNOSTIC_VALUE
      ? rendered
      : `${rendered.slice(0, MAX_DIAGNOSTIC_VALUE)}…`;
  return JSON.stringify(bounded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("invalid_metadata_shape", `${label} must be an object`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  label: string,
  expected: readonly string[],
): void {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0) {
    fail(
      "missing_metadata_field",
      `${label} is missing required field(s): ${missing.join(", ")}`,
    );
  }
  if (extra.length > 0) {
    fail(
      "unknown_metadata_field",
      `${label} has unsupported field(s): ${extra
        .slice(0, 5)
        .map((key) => preview(key))
        .join(", ")}${extra.length > 5 ? ` (+${extra.length - 5} more)` : ""}`,
    );
  }
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    fail(
      "invalid_metadata_type",
      `${label}.${field} must be a non-empty string, got ${preview(candidate)}`,
    );
  }
  if (candidate.length > 200) {
    fail(
      "metadata_value_too_long",
      `${label}.${field} exceeds the 200-character contract limit`,
    );
  }
  return candidate;
}

function requireBoolean(
  value: Record<string, unknown>,
  field: string,
  label: string,
): boolean {
  const candidate = value[field];
  if (typeof candidate !== "boolean") {
    fail(
      "invalid_metadata_type",
      `${label}.${field} must be boolean, got ${preview(candidate)}`,
    );
  }
  return candidate;
}

function readBoundedFile(path: string, label: string, maxBytes: number): string {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) fail("invalid_input_file", `${label} is not a regular file`);
    size = stat.size;
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error;
    fail("input_file_unavailable", `${label} could not be read`);
  }
  if (size > maxBytes) {
    fail(
      "input_file_too_large",
      `${label} is ${size} bytes; maximum is ${maxBytes}`,
    );
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail("input_file_unavailable", `${label} could not be read`);
  }
}

function parseJsonFile(path: string, label: string): unknown {
  const raw = readBoundedFile(path, label, MAX_JSON_BYTES);
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    fail("invalid_json", `${label} is not valid JSON`);
  }
}

function parseCliRelease(value: unknown): CliReleaseMetadata {
  const release = requireRecord(value, "metadata.cliRelease");
  requireExactKeys(release, "metadata.cliRelease", [
    "tagName",
    "isDraft",
    "isPrerelease",
    "isImmutable",
    "assets",
  ]);

  const rawAssets = release.assets;
  if (!Array.isArray(rawAssets)) {
    fail("invalid_metadata_type", "metadata.cliRelease.assets must be an array");
  }
  if (rawAssets.length > 32) {
    fail(
      "too_many_release_assets",
      `metadata.cliRelease.assets has ${rawAssets.length} entries; maximum is 32`,
    );
  }

  const assets: string[] = [];
  for (const [index, rawAsset] of rawAssets.entries()) {
    const asset = requireRecord(rawAsset, `metadata.cliRelease.assets[${index}]`);
    requireExactKeys(asset, `metadata.cliRelease.assets[${index}]`, ["name"]);
    assets.push(
      requireString(asset, "name", `metadata.cliRelease.assets[${index}]`),
    );
  }

  return {
    tagName: requireString(release, "tagName", "metadata.cliRelease"),
    isDraft: requireBoolean(release, "isDraft", "metadata.cliRelease"),
    isPrerelease: requireBoolean(
      release,
      "isPrerelease",
      "metadata.cliRelease",
    ),
    isImmutable: requireBoolean(
      release,
      "isImmutable",
      "metadata.cliRelease",
    ),
    assets,
  };
}

function parseExistingPluginRelease(
  value: unknown,
): ExistingPluginReleaseMetadata | null {
  if (value === null) return null;
  const release = requireRecord(value, "metadata.existingPluginRelease");
  requireExactKeys(release, "metadata.existingPluginRelease", [
    "tagName",
    "isDraft",
    "isPrerelease",
    "isImmutable",
  ]);
  return {
    tagName: requireString(
      release,
      "tagName",
      "metadata.existingPluginRelease",
    ),
    isDraft: requireBoolean(
      release,
      "isDraft",
      "metadata.existingPluginRelease",
    ),
    isPrerelease: requireBoolean(
      release,
      "isPrerelease",
      "metadata.existingPluginRelease",
    ),
    isImmutable: requireBoolean(
      release,
      "isImmutable",
      "metadata.existingPluginRelease",
    ),
  };
}

function parseReleaseMetadata(path: string): ReleaseMetadata {
  const parsed = parseJsonFile(path, "release metadata");
  const metadata = requireRecord(parsed, "metadata");
  requireExactKeys(metadata, "metadata", [
    "cliRelease",
    "existingPluginRelease",
  ]);
  return {
    cliRelease: parseCliRelease(metadata.cliRelease),
    existingPluginRelease: parseExistingPluginRelease(
      metadata.existingPluginRelease,
    ),
  };
}

function parseStrictSemver(value: string, label: string): string {
  if (!STRICT_SEMVER.test(value)) {
    fail(
      "invalid_version",
      `${label} must be strict X.Y.Z semver, got ${preview(value)}`,
    );
  }
  return value;
}

function readPluginVersion(root: string): string {
  let expectedVersion: string | undefined;
  for (const relPath of MANIFEST_PATHS) {
    const manifest = requireRecord(
      parseJsonFile(join(root, relPath), relPath),
      relPath,
    );
    const version = parseStrictSemver(
      requireString(manifest, "version", relPath),
      `${relPath} version`,
    );
    if (expectedVersion === undefined) {
      expectedVersion = version;
    } else if (version !== expectedVersion) {
      fail(
        "plugin_manifest_version_drift",
        `${relPath} version ${version} does not match ${expectedVersion}`,
      );
    }
  }
  if (expectedVersion === undefined) {
    fail("plugin_manifest_missing", "no plugin manifests were found");
  }
  return expectedVersion;
}

function parseChecksumFile(
  raw: string,
  label: string,
  allowComments: boolean,
): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      if (!allowComments) {
        fail(
          "unexpected_checksum_comment",
          `${label} line ${index + 1} contains an unsupported comment`,
        );
      }
      continue;
    }
    const match = /^([0-9a-f]{64})\s+(atlas-(?:darwin|linux)-(?:arm64|x64))$/.exec(
      line,
    );
    if (!match) {
      fail(
        "malformed_checksum_line",
        `${label} line ${index + 1} is not a supported SHA-256 target entry`,
      );
    }
    const digest = match[1];
    const target = match[2];
    if (
      digest === undefined ||
      target === undefined ||
      !SHA256.test(digest) ||
      !CLI_TARGET_SET.has(target)
    ) {
      fail(
        "invalid_checksum_entry",
        `${label} line ${index + 1} has an unsupported target or digest`,
      );
    }
    if (/^0{64}$/.test(digest)) {
      fail(
        "zero_checksum_digest",
        `${label} contains an all-zero digest for ${target}`,
      );
    }
    if (checksums.has(target)) {
      fail(
        "duplicate_checksum_target",
        `${label} contains more than one entry for ${target}`,
      );
    }
    checksums.set(target, digest);
  }

  for (const target of CLI_TARGETS) {
    if (!checksums.has(target)) {
      fail(
        "missing_checksum_target",
        `${label} is missing the pinned digest for ${target}`,
      );
    }
  }
  if (checksums.size !== CLI_TARGETS.length) {
    fail(
      "unexpected_checksum_target",
      `${label} must contain exactly ${CLI_TARGETS.length} supported targets`,
    );
  }
  return checksums;
}

function requireExactAssets(assets: readonly string[]): void {
  const seen = new Set<string>();
  for (const asset of assets) {
    if (seen.has(asset)) {
      fail(
        "duplicate_cli_release_asset",
        `CLI release contains duplicate asset ${preview(asset)}`,
      );
    }
    seen.add(asset);
  }
  const actual = [...seen].sort();
  const missing = EXPECTED_CLI_ASSETS.filter((asset) => !seen.has(asset));
  const extra = actual.filter((asset) => !EXPECTED_CLI_ASSETS.includes(asset));
  if (missing.length > 0) {
    fail(
      "missing_cli_release_asset",
      `CLI release is missing asset(s): ${missing.join(", ")}`,
    );
  }
  if (extra.length > 0) {
    fail(
      "unexpected_cli_release_asset",
      `CLI release has unsupported asset(s): ${extra
        .slice(0, 5)
        .map((asset) => preview(asset))
        .join(", ")}`,
    );
  }
  if (actual.length !== EXPECTED_CLI_ASSETS.length) {
    fail(
      "invalid_cli_release_asset_count",
      `CLI release has ${actual.length} unique assets; expected ${EXPECTED_CLI_ASSETS.length}`,
    );
  }
}

function requirePublishedImmutableRelease(
  release: {
    tagName: string;
    isDraft: boolean;
    isPrerelease: boolean;
    isImmutable: boolean;
  },
  expectedTag: string,
  label: string,
): void {
  if (release.tagName !== expectedTag) {
    fail(
      "release_tag_mismatch",
      `${label} tag ${preview(release.tagName)} does not match ${expectedTag}`,
    );
  }
  if (release.isDraft) fail("draft_release", `${label} must not be a draft`);
  if (release.isPrerelease) {
    fail("prerelease_release", `${label} must not be a prerelease`);
  }
  if (!release.isImmutable) {
    fail("mutable_release", `${label} must be GitHub-immutable`);
  }
}

function writeGithubOutputs(
  path: string,
  result: VerifiedPluginRelease,
): void {
  const output = [
    `release_mode=${result.releaseMode}`,
    `plugin_version=${result.pluginVersion}`,
    `cli_version=${result.cliVersion}`,
    `plugin_release_tag=${result.pluginReleaseTag}`,
    `cli_release_tag=${result.cliReleaseTag}`,
    "",
  ].join("\n");
  try {
    appendFileSync(path, output, "utf8");
  } catch {
    fail("github_output_unavailable", "GitHub output file could not be written");
  }
}

export function verifyPluginRelease(
  options: VerifyPluginReleaseOptions,
): VerifiedPluginRelease {
  const root = resolve(options.root);
  const tagMatch = /^atlas--v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(
    options.tag,
  );
  if (!tagMatch) {
    fail(
      "invalid_plugin_release_tag",
      `plugin tag must match ${PLUGIN_TAG_PREFIX}X.Y.Z`,
    );
  }
  const pluginVersion = tagMatch[1];
  if (pluginVersion === undefined) {
    fail("invalid_plugin_release_tag", "plugin tag did not contain a version");
  }
  const manifestVersion = readPluginVersion(root);
  if (manifestVersion !== pluginVersion) {
    fail(
      "plugin_tag_version_mismatch",
      `plugin tag version ${pluginVersion} does not match manifest version ${manifestVersion}`,
    );
  }

  const cliVersion = parseStrictSemver(
    readBoundedFile(
      join(root, "atlas/bin/cli-version"),
      "atlas/bin/cli-version",
      MAX_TEXT_BYTES,
    ).trim(),
    "atlas/bin/cli-version",
  );
  const pluginReleaseTag = `${PLUGIN_TAG_PREFIX}${pluginVersion}`;
  const cliReleaseTag = `${CLI_TAG_PREFIX}${cliVersion}`;

  let pinPolicy: ReturnType<typeof parseCliPinPolicy>;
  try {
    pinPolicy = parseCliPinPolicy(
      readBoundedFile(
        join(root, "atlas/bin/cli-pin-policy.json"),
        "atlas/bin/cli-pin-policy.json",
        MAX_TEXT_BYTES,
      ),
    );
  } catch (error) {
    if (error instanceof CliPinPolicyError) {
      fail("invalid_cli_pin_policy", error.message);
    }
    throw error;
  }
  if (pinPolicy.state !== "pinned") {
    fail(
      "bootstrap_cli_pin_policy",
      "atlas/bin/cli-pin-policy.json must be pinned before a plugin release",
    );
  }

  const localPinsRaw = readBoundedFile(
    join(root, "atlas/bin/cli-checksums"),
    "atlas/bin/cli-checksums",
    MAX_TEXT_BYTES,
  );
  if (localPinsRaw.includes("TODO(release)")) {
    fail(
      "placeholder_cli_pins",
      "atlas/bin/cli-checksums still contains the pre-release placeholder",
    );
  }
  const generatedVersionMatches = [
    ...localPinsRaw.matchAll(
      /Generated [^\r\n]* for version ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\./g,
    ),
  ];
  if (generatedVersionMatches.length !== 1) {
    fail(
      "generated_pin_header_count",
      "atlas/bin/cli-checksums must contain exactly one generated version header",
    );
  }
  const generatedVersion = generatedVersionMatches[0]?.[1];
  if (generatedVersion !== cliVersion) {
    fail(
      "generated_pin_version_mismatch",
      `atlas/bin/cli-checksums must declare generated version ${cliVersion}`,
    );
  }
  const localPins = parseChecksumFile(
    localPinsRaw,
    "atlas/bin/cli-checksums",
    true,
  );

  const remoteChecksums = parseChecksumFile(
    readBoundedFile(
      options.releaseChecksumsPath,
      "CLI release checksums.txt",
      MAX_TEXT_BYTES,
    ),
    "CLI release checksums.txt",
    false,
  );
  for (const target of CLI_TARGETS) {
    if (localPins.get(target) !== remoteChecksums.get(target)) {
      fail(
        "cli_checksum_mismatch",
        `plugin pin for ${target} does not match the immutable CLI release`,
      );
    }
  }

  const metadata = parseReleaseMetadata(options.metadataPath);
  requirePublishedImmutableRelease(
    metadata.cliRelease,
    cliReleaseTag,
    "CLI release",
  );
  requireExactAssets(metadata.cliRelease.assets);

  let releaseMode: ReleaseMode = "create";
  if (metadata.existingPluginRelease !== null) {
    requirePublishedImmutableRelease(
      metadata.existingPluginRelease,
      pluginReleaseTag,
      "existing plugin release",
    );
    releaseMode = "resume";
  }

  const result: VerifiedPluginRelease = {
    releaseMode,
    pluginVersion,
    cliVersion,
    pluginReleaseTag,
    cliReleaseTag,
  };
  if (options.githubOutputPath) {
    writeGithubOutputs(options.githubOutputPath, result);
  }
  return result;
}

interface ParsedArgs {
  options: VerifyPluginReleaseOptions;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--root",
    "--tag",
    "--metadata",
    "--release-checksums",
    "--github-output",
  ]);
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return {
      help: true,
      options: {
        root: ".",
        tag: "",
        metadataPath: "",
        releaseChecksumsPath: "",
      },
    };
  }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !allowed.has(flag)) {
      fail("unknown_argument", `unsupported argument ${preview(flag)}`);
    }
    if (
      value === undefined ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      fail("missing_argument_value", `${flag} requires a value`);
    }
    if (values.has(flag)) {
      fail("duplicate_argument", `${flag} may be provided only once`);
    }
    values.set(flag, value);
  }
  for (const required of [
    "--root",
    "--tag",
    "--metadata",
    "--release-checksums",
  ]) {
    if (!values.has(required)) {
      fail("missing_argument", `${required} is required`);
    }
  }
  const options: VerifyPluginReleaseOptions = {
    root: values.get("--root") ?? "",
    tag: values.get("--tag") ?? "",
    metadataPath: values.get("--metadata") ?? "",
    releaseChecksumsPath: values.get("--release-checksums") ?? "",
  };
  const githubOutputPath = values.get("--github-output");
  if (githubOutputPath !== undefined) {
    options.githubOutputPath = githubOutputPath;
  }
  return {
    help: false,
    options,
  };
}

function usage(): string {
  return [
    "Usage: bun scripts/verify-plugin-release.ts \\",
    "  --root <distribution-repo-root> \\",
    "  --tag <atlas--vX.Y.Z> \\",
    "  --metadata <normalized-release-metadata.json> \\",
    "  --release-checksums <downloaded-checksums.txt> \\",
    "  [--github-output <path>]",
  ].join("\n");
}

if (import.meta.main) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(usage());
    } else {
      const result = verifyPluginRelease(parsed.options);
      console.log(
        `verify-plugin-release: OK (${result.releaseMode}; plugin ${result.pluginVersion}; CLI ${result.cliVersion})`,
      );
    }
  } catch (error) {
    const message =
      error instanceof ReleaseContractError
        ? error.message
        : "[unexpected_failure] verifier failed without a safe diagnostic";
    console.error(`verify-plugin-release: ERROR ${message}`);
    process.exitCode = 1;
  }
}
