#!/usr/bin/env bun
/**
 * Credential-redacting public distribution smoke.
 *
 * Live mode uses isolated Claude, Codex, Atlas, and CLI cache roots; checks
 * public releases and the exact application deployment before reading the
 * Atlas key; captures no command transcript; and writes only strict,
 * secret-free evidence. Fixture mode exercises the same state machine without
 * a network call or credential.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export const DISTRIBUTION_SMOKE_SCHEMA = "atlas-distribution-smoke/v1";
const CHECK_IDS = [
  "public_release_preflight",
  "application_health",
  "claude_clean_install",
  "claude_auth",
  "claude_tool_discovery",
  "claude_upgrade",
  "claude_rollback",
  "codex_clean_install",
  "codex_auth",
  "codex_tool_discovery",
  "codex_upgrade",
  "codex_rollback",
  "checksum_refusal",
  "cosign_attestation",
] as const;
export type DistributionCheckId = (typeof CHECK_IDS)[number];
type SmokeHost = "shared" | "claude" | "codex";
type SmokeMode = "fixture" | "live";
const CHECK_HOST: Readonly<Record<DistributionCheckId, SmokeHost>> = {
  public_release_preflight: "shared",
  application_health: "shared",
  claude_clean_install: "claude",
  claude_auth: "claude",
  claude_tool_discovery: "claude",
  claude_upgrade: "claude",
  claude_rollback: "claude",
  codex_clean_install: "codex",
  codex_auth: "codex",
  codex_tool_discovery: "codex",
  codex_upgrade: "codex",
  codex_rollback: "codex",
  checksum_refusal: "shared",
  cosign_attestation: "shared",
};
const VERSION_CHECKS = new Set<DistributionCheckId>([
  "claude_clean_install",
  "claude_upgrade",
  "claude_rollback",
  "codex_clean_install",
  "codex_upgrade",
  "codex_rollback",
]);
const STRICT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GITHUB_OWNER =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_COMMAND_OUTPUT = 1_048_576;
const COMMAND_TIMEOUT_MS = 180_000;

export interface DistributionSmokeConfig {
  mode: SmokeMode;
  repositoryUrl: string;
  nMinusOneTag: string;
  nTag: string;
  cliReleaseTag: string;
  signerIdentity: string;
  apiOrigin: string;
  expectedApplicationSha: string;
  cursorEvidenceSha256: string;
  evidenceOut: string;
  overwriteEvidence: boolean;
}

export interface ApplicationEvidence {
  apiOrigin: string;
  expectedSha: string;
  healthSourceSha: string;
  healthGitSha: string;
  deploymentId: string;
}

export interface DistributionSmokeCheck {
  id: DistributionCheckId;
  host: SmokeHost;
  status: "passed" | "failed";
  observedVersion?: string;
}

export interface DistributionSmokeEvidence {
  schemaVersion: typeof DISTRIBUTION_SMOKE_SCHEMA;
  mode: SmokeMode;
  result: "passed" | "failed";
  release: {
    repositoryUrl: string;
    nMinusOneTag: string;
    nTag: string;
    cliReleaseTag: string;
    signerIdentity: string;
  };
  application: ApplicationEvidence;
  isolation: {
    claudeConfigFingerprint: string;
    codexHomeFingerprint: string;
    atlasConfigFingerprint: string;
    cliCacheFingerprint: string;
    globalRootsUntouched: true;
  };
  checks: DistributionSmokeCheck[];
  cursor: {
    status: "operator_asserted";
    evidenceSha256: string;
  };
  failure?: {
    code: string;
    checkId: DistributionCheckId;
  };
}

export class DistributionSmokeError extends Error {
  constructor(
    readonly code: string,
    readonly checkId: DistributionCheckId,
  ) {
    super(`[${code}] ${checkId}`);
    this.name = "DistributionSmokeError";
  }
}

function fail(code: string, checkId: DistributionCheckId): never {
  throw new DistributionSmokeError(code, checkId);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeRepositoryUrl(value: string): {
  url: string;
  slug: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("repository URL is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("repository URL must be credential-free GitHub HTTPS");
  }
  const parts = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (
    parts.length !== 2
    || !GITHUB_OWNER.test(parts[0]!)
    || !GITHUB_REPOSITORY.test(parts[1]!)
    || parts[1] === "."
    || parts[1] === ".."
  ) {
    throw new Error("repository URL must contain one owner and repository");
  }
  const slug = `${parts[0]}/${parts[1]}`;
  return { url: `https://github.com/${slug}`, slug };
}

function normalizeApiOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("API origin is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("API origin must be one credential-free HTTPS origin");
  }
  return parsed.origin;
}

function pluginVersion(tag: string): string {
  const match = /^atlas--v(.+)$/.exec(tag);
  if (!match?.[1] || !STRICT_VERSION.test(match[1])) {
    throw new Error("plugin tags must use atlas--vX.Y.Z");
  }
  return match[1];
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => BigInt(part));
  const rightParts = right.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! > rightParts[index]!) return 1;
    if (leftParts[index]! < rightParts[index]!) return -1;
  }
  return 0;
}

export function normalizeSmokeConfig(
  config: DistributionSmokeConfig,
): DistributionSmokeConfig {
  const repository = normalizeRepositoryUrl(config.repositoryUrl);
  const oldVersion = pluginVersion(config.nMinusOneTag);
  const newVersion = pluginVersion(config.nTag);
  if (compareVersion(newVersion, oldVersion) <= 0) {
    throw new Error("N plugin version must be greater than N-1");
  }
  const cliVersion = /^atlas-cli-v(.+)$/.exec(config.cliReleaseTag)?.[1];
  if (!cliVersion || !STRICT_VERSION.test(cliVersion)) {
    throw new Error("CLI release tag must use atlas-cli-vX.Y.Z");
  }
  const signer = new RegExp(
    "^https://github\\.com/"
      + "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/"
      + "[A-Za-z0-9._-]{1,100}/\\.github/workflows/"
      + `release-cli\\.yml@refs/tags/cli-v${cliVersion.replaceAll(".", "\\.")}$`,
  );
  if (!signer.test(config.signerIdentity)) {
    throw new Error("signer identity does not match the CLI release tag");
  }
  if (!GIT_SHA.test(config.expectedApplicationSha)) {
    throw new Error("expected application SHA must be lowercase 40-character Git SHA");
  }
  if (!SHA256.test(config.cursorEvidenceSha256)) {
    throw new Error("Cursor evidence digest must be lowercase SHA-256");
  }
  if (!config.evidenceOut.trim()) throw new Error("evidence output is required");
  return {
    ...config,
    repositoryUrl: repository.url,
    apiOrigin: normalizeApiOrigin(config.apiOrigin),
    evidenceOut: resolve(config.evidenceOut),
  };
}

export function parseDistributionSmokeEvidence(
  raw: string,
): DistributionSmokeEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("distribution smoke evidence is not valid JSON");
  }
  const top = record(parsed, "evidence");
  const topKeys = [
    "schemaVersion",
    "mode",
    "result",
    "release",
    "application",
    "isolation",
    "checks",
    "cursor",
    ...(top.result === "failed" ? ["failure"] : []),
  ];
  exactKeys(top, topKeys, "evidence");
  if (top.schemaVersion !== DISTRIBUTION_SMOKE_SCHEMA) {
    throw new Error("unexpected smoke schema version");
  }
  if (top.mode !== "fixture" && top.mode !== "live") {
    throw new Error("invalid smoke mode");
  }
  if (top.result !== "passed" && top.result !== "failed") {
    throw new Error("invalid smoke result");
  }

  const release = record(top.release, "release");
  exactKeys(
    release,
    [
      "repositoryUrl",
      "nMinusOneTag",
      "nTag",
      "cliReleaseTag",
      "signerIdentity",
    ],
    "release",
  );
  for (const key of Object.keys(release)) {
    if (typeof release[key] !== "string") {
      throw new Error(`release.${key} must be a string`);
    }
  }
  const normalizedConfig = normalizeSmokeConfig({
    mode: top.mode,
    repositoryUrl: release.repositoryUrl as string,
    nMinusOneTag: release.nMinusOneTag as string,
    nTag: release.nTag as string,
    cliReleaseTag: release.cliReleaseTag as string,
    signerIdentity: release.signerIdentity as string,
    apiOrigin: (record(top.application, "application").apiOrigin as string),
    expectedApplicationSha: (
      record(top.application, "application").expectedSha as string
    ),
    cursorEvidenceSha256: (
      record(top.cursor, "cursor").evidenceSha256 as string
    ),
    evidenceOut: "/evidence.json",
    overwriteEvidence: false,
  });

  const application = record(top.application, "application");
  exactKeys(
    application,
    [
      "apiOrigin",
      "expectedSha",
      "healthSourceSha",
      "healthGitSha",
      "deploymentId",
    ],
    "application",
  );
  for (const key of ["expectedSha", "healthSourceSha", "healthGitSha"]) {
    if (typeof application[key] !== "string" || !GIT_SHA.test(application[key] as string)) {
      throw new Error(`application.${key} must be lowercase Git SHA`);
    }
  }
  if (
    application.expectedSha !== application.healthSourceSha
    || application.expectedSha !== application.healthGitSha
  ) {
    throw new Error("application health SHAs must equal expectedSha");
  }
  if (
    typeof application.deploymentId !== "string"
    || !/^[A-Za-z0-9_.:-]{1,200}$/.test(application.deploymentId)
  ) {
    throw new Error("application deploymentId is invalid");
  }

  const isolation = record(top.isolation, "isolation");
  exactKeys(
    isolation,
    [
      "claudeConfigFingerprint",
      "codexHomeFingerprint",
      "atlasConfigFingerprint",
      "cliCacheFingerprint",
      "globalRootsUntouched",
    ],
    "isolation",
  );
  for (
    const key of [
      "claudeConfigFingerprint",
      "codexHomeFingerprint",
      "atlasConfigFingerprint",
      "cliCacheFingerprint",
    ]
  ) {
    if (typeof isolation[key] !== "string" || !SHA256.test(isolation[key] as string)) {
      throw new Error(`isolation.${key} must be lowercase SHA-256`);
    }
  }
  if (isolation.globalRootsUntouched !== true) {
    throw new Error("globalRootsUntouched must be true");
  }

  if (!Array.isArray(top.checks) || top.checks.length === 0) {
    throw new Error("checks must be a nonempty array");
  }
  const seen = new Set<string>();
  const checks = top.checks.map((value, index) => {
    const check = record(value, `checks[${index}]`);
    const keys = [
      "id",
      "host",
      "status",
      ...(check.observedVersion === undefined ? [] : ["observedVersion"]),
    ];
    exactKeys(check, keys, `checks[${index}]`);
    if (
      typeof check.id !== "string"
      || !CHECK_IDS.includes(check.id as DistributionCheckId)
      || seen.has(check.id)
    ) {
      throw new Error("check ids must be known and unique");
    }
    const id = check.id as DistributionCheckId;
    seen.add(id);
    if (id !== CHECK_IDS[index]) {
      throw new Error("checks must be an ordered execution prefix");
    }
    if (check.host !== CHECK_HOST[id]) {
      throw new Error(`check host does not match ${id}`);
    }
    if (check.status !== "passed" && check.status !== "failed") {
      throw new Error("check status must be passed or failed");
    }
    if (
      check.observedVersion !== undefined
      && (
        typeof check.observedVersion !== "string"
        || !STRICT_VERSION.test(check.observedVersion)
      )
    ) {
      throw new Error("observedVersion must be strict semver");
    }
    if (
      check.status === "passed"
      && VERSION_CHECKS.has(id) !== (check.observedVersion !== undefined)
    ) {
      throw new Error("observedVersion must appear exactly on passed version checks");
    }
    if (check.status === "failed" && check.observedVersion !== undefined) {
      throw new Error("failed checks cannot claim an observed version");
    }
    return check as unknown as DistributionSmokeCheck;
  });
  if (top.result === "passed") {
    if (
      checks.length !== CHECK_IDS.length
      || CHECK_IDS.some((id) => !seen.has(id))
      || checks.some((check) => check.status !== "passed")
    ) {
      throw new Error("passing evidence requires every check exactly once");
    }
  }

  const cursor = record(top.cursor, "cursor");
  exactKeys(cursor, ["status", "evidenceSha256"], "cursor");
  if (
    cursor.status !== "operator_asserted"
    || typeof cursor.evidenceSha256 !== "string"
    || !SHA256.test(cursor.evidenceSha256)
  ) {
    throw new Error("Cursor evidence must be one explicit operator assertion");
  }

  let failure: DistributionSmokeEvidence["failure"];
  if (top.result === "failed") {
    const failureRecord = record(top.failure, "failure");
    exactKeys(failureRecord, ["code", "checkId"], "failure");
    if (
      typeof failureRecord.code !== "string"
      || !/^[a-z][a-z0-9_]{2,63}$/.test(failureRecord.code)
      || typeof failureRecord.checkId !== "string"
      || !CHECK_IDS.includes(failureRecord.checkId as DistributionCheckId)
    ) {
      throw new Error("failure fields are invalid");
    }
    const failedCheck = checks.find(
      (check) => check.id === failureRecord.checkId,
    );
    if (!failedCheck || failedCheck.status !== "failed") {
      throw new Error("failure must identify the failed check");
    }
    if (
      checks.at(-1)?.id !== failureRecord.checkId
      || checks.filter((check) => check.status === "failed").length !== 1
      || checks.slice(0, -1).some((check) => check.status !== "passed")
    ) {
      throw new Error("failed evidence must end at exactly one failed check");
    }
    failure = {
      code: failureRecord.code,
      checkId: failureRecord.checkId as DistributionCheckId,
    };
  }

  return {
    schemaVersion: DISTRIBUTION_SMOKE_SCHEMA,
    mode: top.mode,
    result: top.result,
    release: {
      repositoryUrl: normalizedConfig.repositoryUrl,
      nMinusOneTag: normalizedConfig.nMinusOneTag,
      nTag: normalizedConfig.nTag,
      cliReleaseTag: normalizedConfig.cliReleaseTag,
      signerIdentity: normalizedConfig.signerIdentity,
    },
    application: {
      apiOrigin: normalizedConfig.apiOrigin,
      expectedSha: application.expectedSha as string,
      healthSourceSha: application.healthSourceSha as string,
      healthGitSha: application.healthGitSha as string,
      deploymentId: application.deploymentId as string,
    },
    isolation: isolation as unknown as DistributionSmokeEvidence["isolation"],
    checks,
    cursor: {
      status: "operator_asserted",
      evidenceSha256: cursor.evidenceSha256,
    },
    ...(failure ? { failure } : {}),
  };
}

export function serializeDistributionSmokeEvidence(
  evidence: DistributionSmokeEvidence,
): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

export interface SmokeOperations {
  isolationEvidence(): DistributionSmokeEvidence["isolation"];
  publicReleasePreflight(): Promise<void>;
  applicationHealth(): Promise<ApplicationEvidence>;
  loadApiKey(): string;
  cleanInstall(host: "claude" | "codex", tag: string): Promise<string>;
  authenticate(host: "claude" | "codex", apiKey: string): Promise<void>;
  discoverTools(host: "claude" | "codex", apiKey: string): Promise<void>;
  switchVersion(host: "claude" | "codex", tag: string): Promise<string>;
  checksumRefusal(): Promise<void>;
  cosignAttestation(): Promise<void>;
  cleanup(): void;
}

function baseEvidence(
  config: DistributionSmokeConfig,
  operations: SmokeOperations,
): Omit<DistributionSmokeEvidence, "result" | "application" | "checks"> {
  return {
    schemaVersion: DISTRIBUTION_SMOKE_SCHEMA,
    mode: config.mode,
    release: {
      repositoryUrl: config.repositoryUrl,
      nMinusOneTag: config.nMinusOneTag,
      nTag: config.nTag,
      cliReleaseTag: config.cliReleaseTag,
      signerIdentity: config.signerIdentity,
    },
    isolation: operations.isolationEvidence(),
    cursor: {
      status: "operator_asserted",
      evidenceSha256: config.cursorEvidenceSha256,
    },
  };
}

export async function runDistributionSmoke(
  configArg: DistributionSmokeConfig,
  operations: SmokeOperations,
): Promise<DistributionSmokeEvidence> {
  const config = normalizeSmokeConfig(configArg);
  const checks: DistributionSmokeCheck[] = [];
  let current: DistributionCheckId = "public_release_preflight";
  let application: ApplicationEvidence = {
    apiOrigin: config.apiOrigin,
    expectedSha: config.expectedApplicationSha,
    healthSourceSha: config.expectedApplicationSha,
    healthGitSha: config.expectedApplicationSha,
    deploymentId: "unverified",
  };
  const pass = (id: DistributionCheckId, observedVersion?: string): void => {
    checks.push({
      id,
      host: CHECK_HOST[id],
      status: "passed",
      ...(observedVersion ? { observedVersion } : {}),
    });
  };

  try {
    current = "public_release_preflight";
    await operations.publicReleasePreflight();
    pass(current);

    current = "application_health";
    const observedApplication = await operations.applicationHealth();
    if (
      observedApplication.apiOrigin !== config.apiOrigin
      || observedApplication.expectedSha !== config.expectedApplicationSha
      || observedApplication.healthSourceSha !== config.expectedApplicationSha
      || observedApplication.healthGitSha !== config.expectedApplicationSha
    ) {
      fail("application_sha_mismatch", current);
    }
    application = observedApplication;
    pass(current);

    current = "claude_clean_install";
    pass(current, await operations.cleanInstall("claude", config.nMinusOneTag));
    current = "claude_auth";
    // Deliberately read the key only after both public and deployment
    // preflights pass. It never enters evidence or a host-plugin command.
    const apiKey = operations.loadApiKey();
    if (!apiKey) fail("credential_unavailable", current);
    await operations.authenticate("claude", apiKey);
    pass(current);
    current = "claude_tool_discovery";
    await operations.discoverTools("claude", apiKey);
    pass(current);
    current = "claude_upgrade";
    pass(current, await operations.switchVersion("claude", config.nTag));
    current = "claude_rollback";
    pass(
      current,
      await operations.switchVersion("claude", config.nMinusOneTag),
    );

    current = "codex_clean_install";
    pass(current, await operations.cleanInstall("codex", config.nMinusOneTag));
    current = "codex_auth";
    await operations.authenticate("codex", apiKey);
    pass(current);
    current = "codex_tool_discovery";
    await operations.discoverTools("codex", apiKey);
    pass(current);
    current = "codex_upgrade";
    pass(current, await operations.switchVersion("codex", config.nTag));
    current = "codex_rollback";
    pass(current, await operations.switchVersion("codex", config.nMinusOneTag));

    current = "checksum_refusal";
    await operations.checksumRefusal();
    pass(current);
    current = "cosign_attestation";
    await operations.cosignAttestation();
    pass(current);

    const evidence: DistributionSmokeEvidence = {
      ...baseEvidence(config, operations),
      result: "passed",
      application,
      checks,
    };
    parseDistributionSmokeEvidence(serializeDistributionSmokeEvidence(evidence));
    return evidence;
  } catch (error) {
    const smokeError = error instanceof DistributionSmokeError
      ? error
      : new DistributionSmokeError("unexpected_failure", current);
    const existing = checks.find((check) => check.id === smokeError.checkId);
    if (existing) {
      existing.status = "failed";
      delete existing.observedVersion;
    } else {
      checks.push({
        id: smokeError.checkId,
        host: CHECK_HOST[smokeError.checkId],
        status: "failed",
      });
    }
    const evidence: DistributionSmokeEvidence = {
      ...baseEvidence(config, operations),
      result: "failed",
      application,
      checks,
      failure: {
        code: smokeError.code,
        checkId: smokeError.checkId,
      },
    };
    parseDistributionSmokeEvidence(serializeDistributionSmokeEvidence(evidence));
    return evidence;
  } finally {
    operations.cleanup();
  }
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class LiveSmokeOperations implements SmokeOperations {
  private readonly root: string;
  private readonly home: string;
  private readonly claudeConfig: string;
  private readonly codexHome: string;
  private readonly atlasConfig: string;
  private readonly cliCache: string;
  private readonly repository: { url: string; slug: string };
  private readonly target: string;
  private readonly versionRoots = new Map<"claude" | "codex", string>();

  constructor(private readonly config: DistributionSmokeConfig) {
    this.repository = normalizeRepositoryUrl(config.repositoryUrl);
    this.root = mkdtempSync(join(tmpdir(), "atlas-distribution-smoke-"));
    chmodSync(this.root, 0o700);
    this.home = join(this.root, "home");
    this.claudeConfig = join(this.root, "claude");
    this.codexHome = join(this.root, "codex");
    this.atlasConfig = join(this.root, "atlas");
    this.cliCache = join(this.root, "cache");
    for (const path of [
      this.home,
      this.claudeConfig,
      this.codexHome,
      this.atlasConfig,
      this.cliCache,
      join(this.root, "tmp"),
    ]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    const os = process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
      ? "linux"
      : fail("unsupported_platform", "public_release_preflight");
    const arch = process.arch === "arm64"
      ? "arm64"
      : process.arch === "x64"
      ? "x64"
      : fail("unsupported_architecture", "public_release_preflight");
    this.target = `${os}-${arch}`;
  }

  isolationEvidence(): DistributionSmokeEvidence["isolation"] {
    return {
      claudeConfigFingerprint: sha256(this.claudeConfig),
      codexHomeFingerprint: sha256(this.codexHome),
      atlasConfigFingerprint: sha256(this.atlasConfig),
      cliCacheFingerprint: sha256(this.cliCache),
      globalRootsUntouched: true,
    };
  }

  private environment(apiKey?: string): Record<string, string> {
    const path = process.env.PATH;
    if (!path) fail("path_unavailable", "public_release_preflight");
    return {
      PATH: path,
      HOME: this.home,
      TMPDIR: join(this.root, "tmp"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CI: "1",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
      CLAUDE_CONFIG_DIR: this.claudeConfig,
      CODEX_HOME: this.codexHome,
      XDG_CONFIG_HOME: join(this.root, "xdg-config"),
      XDG_DATA_HOME: join(this.root, "xdg-data"),
      XDG_CACHE_HOME: this.cliCache,
      ATLAS_CONFIG_HOME: this.atlasConfig,
      ATLAS_FORWARDER_CONFIG_HOME: this.atlasConfig,
      ATLAS_FORWARDER_INSTALL_PATH: join(this.home, ".local/bin/atlas"),
      ATLAS_API_URL: this.config.apiOrigin,
      ...(apiKey ? { ATLAS_API_KEY: apiKey } : {}),
    };
  }

  private command(
    checkId: DistributionCheckId,
    command: string,
    args: string[],
    options: {
      cwd?: string;
      apiKey?: string;
      expectedFailure?: boolean;
    } = {},
  ): CommandResult {
    const result = Bun.spawnSync([command, ...args], {
      cwd: options.cwd ?? this.root,
      env: this.environment(options.apiKey),
      stdout: "pipe",
      stderr: "pipe",
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    if (
      stdout.length > MAX_COMMAND_OUTPUT
      || stderr.length > MAX_COMMAND_OUTPUT
    ) {
      fail("command_output_too_large", checkId);
    }
    if (options.expectedFailure ? result.exitCode === 0 : result.exitCode !== 0) {
      fail(options.expectedFailure ? "unsafe_success" : "command_failed", checkId);
    }
    return { exitCode: result.exitCode, stdout, stderr };
  }

  private json(
    checkId: DistributionCheckId,
    command: string,
    args: string[],
    options: { cwd?: string; apiKey?: string } = {},
  ): unknown {
    const result = this.command(checkId, command, args, options);
    try {
      return JSON.parse(result.stdout);
    } catch {
      fail("invalid_command_json", checkId);
    }
  }

  async publicReleasePreflight(): Promise<void> {
    const check = "public_release_preflight";
    for (const command of ["claude", "codex", "curl", "git", "cosign"]) {
      this.command(check, "which", [command]);
    }
    this.command(check, "git", [
      "ls-remote",
      "--exit-code",
      "--tags",
      this.repository.url,
      `refs/tags/${this.config.nMinusOneTag}`,
      `refs/tags/${this.config.nTag}`,
    ]);
    for (const tag of [this.config.nMinusOneTag, this.config.nTag]) {
      this.command(check, "curl", [
        "-fsSL",
        "--max-time",
        "30",
        "-o",
        "/dev/null",
        `${this.repository.url}/releases/tag/${encodeURIComponent(tag)}`,
      ]);
    }
    for (
      const asset of [
        "checksums.txt",
        `atlas-${this.target}`,
        `atlas-${this.target}.sigstore.json`,
      ]
    ) {
      this.command(check, "curl", [
        "-fsSL",
        "--max-time",
        "30",
        "-o",
        "/dev/null",
        `${this.repository.url}/releases/download/${this.config.cliReleaseTag}/${asset}`,
      ]);
    }
  }

  async applicationHealth(): Promise<ApplicationEvidence> {
    const check = "application_health";
    let response: Response;
    try {
      response = await fetch(`${this.config.apiOrigin}/api/health`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      fail("health_unavailable", check);
    }
    if (!response.ok) fail("health_unavailable", check);
    const raw = await response.text();
    if (raw.length > 65_536) fail("health_response_too_large", check);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail("invalid_health_response", check);
    }
    const top = record(parsed, "health");
    const deployment = record(top.deployment, "deployment");
    if (
      top.status !== "ok"
      || deployment.target_env !== "production"
      || deployment.provider_stubs_enabled !== false
      || typeof deployment.git_commit_sha !== "string"
      || typeof deployment.source_commit_sha !== "string"
      || typeof deployment.deployment_id !== "string"
      || !GIT_SHA.test(deployment.git_commit_sha)
      || !GIT_SHA.test(deployment.source_commit_sha)
      || !/^[A-Za-z0-9_.:-]{1,200}$/.test(deployment.deployment_id)
    ) {
      fail("invalid_health_response", check);
    }
    return {
      apiOrigin: this.config.apiOrigin,
      expectedSha: this.config.expectedApplicationSha,
      healthSourceSha: deployment.source_commit_sha,
      healthGitSha: deployment.git_commit_sha,
      deploymentId: deployment.deployment_id,
    };
  }

  loadApiKey(): string {
    const value = process.env.ATLAS_DISTRIBUTION_SMOKE_API_KEY?.trim() ?? "";
    if (!/^atlas_sk_[A-Za-z0-9_-]{16,}$/.test(value)) {
      fail("credential_unavailable", "claude_auth");
    }
    return value;
  }

  private claudeState(check: DistributionCheckId): {
    version: string;
    root: string;
  } {
    const parsed = this.json(check, "claude", ["plugin", "list", "--json"]);
    if (!Array.isArray(parsed)) fail("invalid_plugin_state", check);
    const matches = parsed.filter((value) => {
      const item = record(value, "Claude plugin");
      return (
        typeof item.id === "string"
        && item.id.startsWith("atlas@")
        && item.enabled === true
      );
    });
    if (matches.length !== 1) fail("invalid_plugin_state", check);
    const plugin = record(matches[0], "Claude plugin");
    if (
      typeof plugin.version !== "string"
      || !STRICT_VERSION.test(plugin.version)
      || typeof plugin.installPath !== "string"
    ) {
      fail("invalid_plugin_state", check);
    }
    return {
      version: plugin.version,
      root: this.safePluginRoot(plugin.installPath, this.claudeConfig, check),
    };
  }

  private codexState(check: DistributionCheckId): {
    version: string;
    root: string;
  } {
    const parsed = record(
      this.json(check, "codex", ["plugin", "list", "--json"]),
      "Codex plugin list",
    );
    if (!Array.isArray(parsed.installed)) fail("invalid_plugin_state", check);
    const matches = parsed.installed.filter((value) => {
      const item = record(value, "Codex plugin");
      return (
        typeof item.pluginId === "string"
        && item.pluginId.startsWith("atlas@")
        && item.installed === true
        && item.enabled === true
      );
    });
    if (matches.length !== 1) fail("invalid_plugin_state", check);
    const plugin = record(matches[0], "Codex plugin");
    if (
      typeof plugin.version !== "string"
      || !STRICT_VERSION.test(plugin.version)
      || typeof plugin.marketplaceName !== "string"
      || !/^[A-Za-z0-9._-]+$/.test(plugin.marketplaceName)
    ) {
      fail("invalid_plugin_state", check);
    }
    const root = join(
      this.codexHome,
      "plugins/cache",
      plugin.marketplaceName,
      "atlas",
      plugin.version,
    );
    return {
      version: plugin.version,
      root: this.safePluginRoot(root, this.codexHome, check),
    };
  }

  private safePluginRoot(
    path: string,
    isolationRoot: string,
    check: DistributionCheckId,
  ): string {
    if (!existsSync(path)) fail("plugin_root_missing", check);
    const root = realpathSync(path);
    const relativePath = relative(realpathSync(isolationRoot), root);
    if (
      relativePath === ""
      || relativePath === ".."
      || relativePath.startsWith(`..${sep}`)
      || !lstatSync(join(root, "bin/atlas")).isFile()
    ) {
      fail("plugin_root_outside_isolation", check);
    }
    return root;
  }

  async cleanInstall(
    host: "claude" | "codex",
    tag: string,
  ): Promise<string> {
    const check = host === "claude"
      ? "claude_clean_install"
      : "codex_clean_install";
    if (host === "claude") {
      this.command(check, "claude", [
        "plugin",
        "marketplace",
        "add",
        `${this.repository.slug}@${tag}`,
      ]);
      this.command(check, "claude", [
        "plugin",
        "install",
        "atlas@atlas-plugins",
        "--scope",
        "user",
      ]);
      const state = this.claudeState(check);
      this.assertTagVersion(tag, state.version, check);
      this.versionRoots.set(host, state.root);
      return state.version;
    }
    this.command(check, "codex", [
      "plugin",
      "marketplace",
      "add",
      this.repository.slug,
      "--ref",
      tag,
    ]);
    this.command(check, "codex", ["plugin", "add", "atlas@atlas-plugins"]);
    const state = this.codexState(check);
    this.assertTagVersion(tag, state.version, check);
    this.versionRoots.set(host, state.root);
    return state.version;
  }

  private assertTagVersion(
    tag: string,
    actual: string,
    check: DistributionCheckId,
  ): void {
    if (actual !== pluginVersion(tag)) fail("plugin_version_mismatch", check);
  }

  private atlas(
    host: "claude" | "codex",
    check: DistributionCheckId,
    args: string[],
    apiKey?: string,
  ): CommandResult {
    const root = this.versionRoots.get(host);
    if (!root) fail("plugin_root_missing", check);
    return this.command(check, join(root, "bin/atlas"), args, { apiKey });
  }

  async authenticate(
    host: "claude" | "codex",
    apiKey: string,
  ): Promise<void> {
    const check = host === "claude" ? "claude_auth" : "codex_auth";
    const result = this.atlas(host, check, ["whoami", "--json"], apiKey);
    try {
      const parsed = record(JSON.parse(result.stdout), "whoami");
      if (parsed.error !== undefined) fail("authentication_failed", check);
    } catch (error) {
      if (error instanceof DistributionSmokeError) throw error;
      fail("invalid_command_json", check);
    }
  }

  async discoverTools(
    host: "claude" | "codex",
    apiKey: string,
  ): Promise<void> {
    const check = host === "claude"
      ? "claude_tool_discovery"
      : "codex_tool_discovery";
    const mcp = this.command(check, host, ["mcp", "list"]);
    if (!/\batlas\b/i.test(mcp.stdout + mcp.stderr)) {
      fail("mcp_not_discovered", check);
    }
    const listed = this.atlas(host, check, ["tools", "list", "--json"], apiKey);
    let tools: unknown;
    try {
      tools = JSON.parse(listed.stdout);
    } catch {
      fail("invalid_command_json", check);
    }
    if (
      !Array.isArray(tools)
      || !tools.some(
        (value) =>
          typeof value === "object"
          && value !== null
          && (value as Record<string, unknown>).name === "atlas_capabilities",
      )
    ) {
      fail("capability_tool_missing", check);
    }
    const called = this.atlas(
      host,
      check,
      [
        "tools",
        "call",
        "atlas_capabilities",
        "--json-args",
        "{}",
        "--json",
      ],
      apiKey,
    );
    try {
      const response = record(JSON.parse(called.stdout), "capabilities");
      if (response.error !== undefined) fail("capability_call_failed", check);
    } catch (error) {
      if (error instanceof DistributionSmokeError) throw error;
      fail("invalid_command_json", check);
    }
  }

  async switchVersion(
    host: "claude" | "codex",
    tag: string,
  ): Promise<string> {
    const check = host === "claude"
      ? tag === this.config.nTag
        ? "claude_upgrade"
        : "claude_rollback"
      : tag === this.config.nTag
      ? "codex_upgrade"
      : "codex_rollback";
    if (host === "claude") {
      this.command(check, "claude", [
        "plugin",
        "marketplace",
        "add",
        `${this.repository.slug}@${tag}`,
      ]);
      this.command(check, "claude", [
        "plugin",
        "update",
        "atlas@atlas-plugins",
        "--scope",
        "user",
      ]);
      const state = this.claudeState(check);
      this.assertTagVersion(tag, state.version, check);
      this.versionRoots.set(host, state.root);
      return state.version;
    }
    this.command(check, "codex", [
      "plugin",
      "marketplace",
      "remove",
      "atlas-plugins",
    ]);
    this.command(check, "codex", [
      "plugin",
      "marketplace",
      "add",
      this.repository.slug,
      "--ref",
      tag,
    ]);
    this.command(check, "codex", ["plugin", "add", "atlas@atlas-plugins"]);
    const state = this.codexState(check);
    this.assertTagVersion(tag, state.version, check);
    this.versionRoots.set(host, state.root);
    return state.version;
  }

  async checksumRefusal(): Promise<void> {
    const check = "checksum_refusal";
    const root = this.versionRoots.get("claude");
    if (!root) fail("plugin_root_missing", check);
    const disposable = join(this.root, "bad-pin-plugin");
    cpSync(root, disposable, { recursive: true, errorOnExist: true });
    const checksumsPath = join(disposable, "bin/cli-checksums");
    const original = readFileSync(checksumsPath, "utf8");
    const targetPattern = new RegExp(
      `^[0-9a-f]{64}([ \\t]+atlas-${this.target})$`,
      "m",
    );
    if (!targetPattern.test(original)) fail("release_pin_missing", check);
    writeFileSync(
      checksumsPath,
      original.replace(targetPattern, `${"0".repeat(64)}$1`),
    );
    const badCache = join(this.root, "bad-pin-cache");
    mkdirSync(badCache, { mode: 0o700 });
    const result = Bun.spawnSync(
      [join(disposable, "bin/atlas"), "--version"],
      {
        cwd: disposable,
        env: {
          ...this.environment(),
          XDG_CACHE_HOME: badCache,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: COMMAND_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    if (
      stdout.length > MAX_COMMAND_OUTPUT
      || stderr.length > MAX_COMMAND_OUTPUT
      || result.exitCode === 0
      || !stderr.includes("pinned digest verification failed")
    ) {
      fail("checksum_refusal_not_observed", check);
    }
    const version = readFileSync(join(disposable, "bin/cli-version"), "utf8")
      .trim();
    const cached = join(badCache, "atlas-cli", version, `atlas-${this.target}`);
    if (existsSync(cached)) fail("untrusted_binary_cached", check);
  }

  async cosignAttestation(): Promise<void> {
    const check = "cosign_attestation";
    const release = join(this.root, "attestation");
    mkdirSync(release, { mode: 0o700 });
    const binary = join(release, `atlas-${this.target}`);
    const bundle = `${binary}.sigstore.json`;
    for (
      const [asset, destination] of [
        [`atlas-${this.target}`, binary],
        [`atlas-${this.target}.sigstore.json`, bundle],
      ] as const
    ) {
      this.command(check, "curl", [
        "-fsSL",
        "--max-time",
        "60",
        "-o",
        destination,
        `${this.repository.url}/releases/download/${this.config.cliReleaseTag}/${asset}`,
      ]);
    }
    this.command(check, "cosign", [
      "verify-blob",
      binary,
      "--bundle",
      bundle,
      "--certificate-identity",
      this.config.signerIdentity,
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
    ]);
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

class FixtureSmokeOperations implements SmokeOperations {
  readonly calls: string[] = [];

  constructor(private readonly config: DistributionSmokeConfig) {}

  isolationEvidence(): DistributionSmokeEvidence["isolation"] {
    return {
      claudeConfigFingerprint: "1".repeat(64),
      codexHomeFingerprint: "2".repeat(64),
      atlasConfigFingerprint: "3".repeat(64),
      cliCacheFingerprint: "4".repeat(64),
      globalRootsUntouched: true,
    };
  }

  async publicReleasePreflight(): Promise<void> {
    this.calls.push("public_release_preflight");
  }

  async applicationHealth(): Promise<ApplicationEvidence> {
    this.calls.push("application_health");
    return {
      apiOrigin: this.config.apiOrigin,
      expectedSha: this.config.expectedApplicationSha,
      healthSourceSha: this.config.expectedApplicationSha,
      healthGitSha: this.config.expectedApplicationSha,
      deploymentId: "fixture-deployment",
    };
  }

  loadApiKey(): string {
    this.calls.push("load_api_key");
    return "fixture-key-never-persisted";
  }

  async cleanInstall(host: "claude" | "codex", tag: string): Promise<string> {
    this.calls.push(`${host}:install:${tag}`);
    return pluginVersion(tag);
  }

  async authenticate(host: "claude" | "codex"): Promise<void> {
    this.calls.push(`${host}:auth`);
  }

  async discoverTools(host: "claude" | "codex"): Promise<void> {
    this.calls.push(`${host}:discover`);
  }

  async switchVersion(host: "claude" | "codex", tag: string): Promise<string> {
    this.calls.push(`${host}:switch:${tag}`);
    return pluginVersion(tag);
  }

  async checksumRefusal(): Promise<void> {
    this.calls.push("checksum_refusal");
  }

  async cosignAttestation(): Promise<void> {
    this.calls.push("cosign_attestation");
  }

  cleanup(): void {
    this.calls.push("cleanup");
  }
}

function writeEvidence(
  path: string,
  evidence: DistributionSmokeEvidence,
  overwrite: boolean,
): void {
  if (existsSync(path) && !overwrite) {
    throw new Error("evidence output already exists");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(temporary, serializeDistributionSmokeEvidence(evidence), {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function fixtureConfig(evidenceOut: string): DistributionSmokeConfig {
  return {
    mode: "fixture",
    repositoryUrl: "https://github.com/example/atlas-agent-plugins",
    nMinusOneTag: "atlas--v1.0.0",
    nTag: "atlas--v1.0.1",
    cliReleaseTag: "atlas-cli-v1.0.0",
    signerIdentity:
      "https://github.com/example/source/.github/workflows/release-cli.yml@refs/tags/cli-v1.0.0",
    apiOrigin: "https://atlas.example.invalid",
    expectedApplicationSha: "a".repeat(40),
    cursorEvidenceSha256: "b".repeat(64),
    evidenceOut,
    overwriteEvidence: false,
  };
}

function parseCli(argv: string[]): DistributionSmokeConfig {
  let mode: SmokeMode | undefined;
  let overwriteEvidence = false;
  let confirmLive = false;
  const values = new Map<string, string>();
  const valueFlags = new Set([
    "--mode",
    "--repository-url",
    "--n-minus-one-tag",
    "--n-tag",
    "--cli-release-tag",
    "--signer-identity",
    "--api-origin",
    "--expected-application-sha",
    "--cursor-evidence-sha256",
    "--evidence-out",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === "--overwrite-evidence") {
      if (overwriteEvidence) throw new Error("duplicate --overwrite-evidence");
      overwriteEvidence = true;
      continue;
    }
    if (flag === "--confirm-live") {
      if (confirmLive) throw new Error("duplicate --confirm-live");
      confirmLive = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`unknown option ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires one value`);
    }
    if (values.has(flag)) throw new Error(`duplicate option ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const modeValue = values.get("--mode");
  if (modeValue !== "fixture" && modeValue !== "live") {
    throw new Error("--mode must be fixture or live");
  }
  mode = modeValue;
  const evidenceOut = values.get("--evidence-out");
  if (!evidenceOut) throw new Error("--evidence-out is required");
  if (mode === "fixture") {
    if (confirmLive) throw new Error("--confirm-live is invalid in fixture mode");
    const fixture = fixtureConfig(evidenceOut);
    return { ...fixture, overwriteEvidence };
  }
  if (!confirmLive) throw new Error("live mode requires --confirm-live");
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`${flag} is required in live mode`);
    return value;
  };
  return normalizeSmokeConfig({
    mode,
    repositoryUrl: required("--repository-url"),
    nMinusOneTag: required("--n-minus-one-tag"),
    nTag: required("--n-tag"),
    cliReleaseTag: required("--cli-release-tag"),
    signerIdentity: required("--signer-identity"),
    apiOrigin: required("--api-origin"),
    expectedApplicationSha: required("--expected-application-sha"),
    cursorEvidenceSha256: required("--cursor-evidence-sha256"),
    evidenceOut,
    overwriteEvidence,
  });
}

async function main(): Promise<void> {
  let config: DistributionSmokeConfig;
  try {
    config = parseCli(process.argv.slice(2));
  } catch {
    console.error("distribution-smoke: failed (invalid_arguments)");
    process.exit(2);
  }
  if (existsSync(config.evidenceOut) && !config.overwriteEvidence) {
    console.error("distribution-smoke: failed (evidence_exists)");
    process.exit(1);
  }
  const operations = config.mode === "fixture"
    ? new FixtureSmokeOperations(config)
    : new LiveSmokeOperations(config);
  const evidence = await runDistributionSmoke(config, operations);
  try {
    writeEvidence(config.evidenceOut, evidence, config.overwriteEvidence);
  } catch {
    console.error("distribution-smoke: failed (evidence_write_failed)");
    process.exit(1);
  }
  if (evidence.result !== "passed") {
    console.error(
      `distribution-smoke: failed (${evidence.failure?.code ?? "unexpected_failure"})`,
    );
    process.exit(1);
  }
  console.log(
    `distribution-smoke: passed (${evidence.checks.length} checks; credential-redacted evidence written)`,
  );
}

if (import.meta.main) {
  await main();
}
