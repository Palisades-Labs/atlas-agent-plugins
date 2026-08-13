import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISTRIBUTION_SMOKE_SCHEMA,
  normalizeSmokeConfig,
  parseDistributionSmokeEvidence,
  runDistributionSmoke,
  serializeDistributionSmokeEvidence,
  type ApplicationEvidence,
  type DistributionSmokeCheck,
  type DistributionSmokeConfig,
  type DistributionSmokeEvidence,
  type SmokeOperations,
} from "./distribution-smoke";

const SCRIPT = join(import.meta.dir, "distribution-smoke.ts");
const N_MINUS_ONE_VERSION = "1.2.3";
const N_VERSION = "1.3.0";
const SENSITIVE_SENTINEL = "SENSITIVE_SENTINEL_DO_NOT_PERSIST_7e5c";
const fixtures = new Set<string>();

const EXPECTED_CHECKS = [
  {
    id: "public_release_preflight",
    host: "shared",
    status: "passed",
  },
  {
    id: "application_health",
    host: "shared",
    status: "passed",
  },
  {
    id: "claude_clean_install",
    host: "claude",
    status: "passed",
    observedVersion: N_MINUS_ONE_VERSION,
  },
  {
    id: "claude_auth",
    host: "claude",
    status: "passed",
  },
  {
    id: "claude_tool_discovery",
    host: "claude",
    status: "passed",
  },
  {
    id: "claude_upgrade",
    host: "claude",
    status: "passed",
    observedVersion: N_VERSION,
  },
  {
    id: "claude_rollback",
    host: "claude",
    status: "passed",
    observedVersion: N_MINUS_ONE_VERSION,
  },
  {
    id: "codex_clean_install",
    host: "codex",
    status: "passed",
    observedVersion: N_MINUS_ONE_VERSION,
  },
  {
    id: "codex_auth",
    host: "codex",
    status: "passed",
  },
  {
    id: "codex_tool_discovery",
    host: "codex",
    status: "passed",
  },
  {
    id: "codex_upgrade",
    host: "codex",
    status: "passed",
    observedVersion: N_VERSION,
  },
  {
    id: "codex_rollback",
    host: "codex",
    status: "passed",
    observedVersion: N_MINUS_ONE_VERSION,
  },
  {
    id: "checksum_refusal",
    host: "shared",
    status: "passed",
  },
  {
    id: "cosign_attestation",
    host: "shared",
    status: "passed",
  },
] satisfies DistributionSmokeCheck[];

type FailureStage =
  | "public_release_preflight"
  | "application_health"
  | "claude_auth";

interface OperationsHarness {
  operations: SmokeOperations;
  calls: string[];
  credentialLoads(): number;
}

afterEach(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
  fixtures.clear();
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtures.add(root);
  return root;
}

function config(
  overrides: Partial<DistributionSmokeConfig> = {},
): DistributionSmokeConfig {
  return {
    mode: "fixture",
    repositoryUrl: "https://github.com/example/atlas-agent-plugins",
    nMinusOneTag: `atlas--v${N_MINUS_ONE_VERSION}`,
    nTag: `atlas--v${N_VERSION}`,
    cliReleaseTag: "atlas-cli-v4.5.6",
    signerIdentity:
      "https://github.com/example/source/.github/workflows/release-cli.yml@refs/tags/cli-v4.5.6",
    apiOrigin: "https://api.example.invalid",
    expectedApplicationSha: "a".repeat(40),
    cursorEvidenceSha256: "b".repeat(64),
    evidenceOut: join(tmpdir(), "unused-distribution-smoke-evidence.json"),
    overwriteEvidence: false,
    ...overrides,
  };
}

function application(configValue: DistributionSmokeConfig): ApplicationEvidence {
  return {
    apiOrigin: configValue.apiOrigin,
    expectedSha: configValue.expectedApplicationSha,
    healthSourceSha: configValue.expectedApplicationSha,
    healthGitSha: configValue.expectedApplicationSha,
    deploymentId: "fixture-deployment",
  };
}

function operationHarness(
  configValue: DistributionSmokeConfig,
  failAt?: FailureStage,
): OperationsHarness {
  const calls: string[] = [];
  let loadCount = 0;
  const throwIfRequested = (stage: FailureStage): void => {
    if (failAt === stage) {
      throw new Error(`${stage}:${SENSITIVE_SENTINEL}`);
    }
  };
  const version = (tag: string): string => tag.replace(/^atlas--v/, "");

  return {
    calls,
    credentialLoads: () => loadCount,
    operations: {
      isolationEvidence: () => ({
        claudeConfigFingerprint: "1".repeat(64),
        codexHomeFingerprint: "2".repeat(64),
        atlasConfigFingerprint: "3".repeat(64),
        cliCacheFingerprint: "4".repeat(64),
        globalRootsUntouched: true,
      }),
      publicReleasePreflight: async () => {
        calls.push("public_release_preflight");
        throwIfRequested("public_release_preflight");
      },
      applicationHealth: async () => {
        calls.push("application_health");
        throwIfRequested("application_health");
        return application(configValue);
      },
      loadApiKey: () => {
        calls.push("load_api_key");
        loadCount += 1;
        return SENSITIVE_SENTINEL;
      },
      cleanInstall: async (host, tag) => {
        calls.push(`${host}:clean_install:${tag}`);
        return version(tag);
      },
      authenticate: async (host, apiKey) => {
        calls.push(`${host}:authenticate`);
        if (host === "claude" && failAt === "claude_auth") {
          throw new Error(`authentication:${apiKey}`);
        }
      },
      discoverTools: async (host) => {
        calls.push(`${host}:tool_discovery`);
      },
      switchVersion: async (host, tag) => {
        calls.push(`${host}:switch:${tag}`);
        return version(tag);
      },
      checksumRefusal: async () => {
        calls.push("checksum_refusal");
      },
      cosignAttestation: async () => {
        calls.push("cosign_attestation");
      },
      cleanup: () => {
        calls.push("cleanup");
      },
    },
  };
}

function passingEvidence(): DistributionSmokeEvidence {
  const configValue = config();
  return {
    schemaVersion: DISTRIBUTION_SMOKE_SCHEMA,
    mode: "fixture",
    result: "passed",
    release: {
      repositoryUrl: configValue.repositoryUrl,
      nMinusOneTag: configValue.nMinusOneTag,
      nTag: configValue.nTag,
      cliReleaseTag: configValue.cliReleaseTag,
      signerIdentity: configValue.signerIdentity,
    },
    application: application(configValue),
    isolation: {
      claudeConfigFingerprint: "1".repeat(64),
      codexHomeFingerprint: "2".repeat(64),
      atlasConfigFingerprint: "3".repeat(64),
      cliCacheFingerprint: "4".repeat(64),
      globalRootsUntouched: true,
    },
    checks: EXPECTED_CHECKS.map((check) => ({ ...check })),
    cursor: {
      status: "operator_asserted",
      evidenceSha256: configValue.cursorEvidenceSha256,
    },
  };
}

function encoded(evidence: unknown): string {
  return `${JSON.stringify(evidence)}\n`;
}

describe("fixture smoke", () => {
  test("passes all 14 checks in contract order with exact observed versions", async () => {
    const configValue = config();
    const harness = operationHarness(configValue);

    const evidence = await runDistributionSmoke(
      configValue,
      harness.operations,
    );

    expect(evidence.result).toBe("passed");
    expect(evidence.release).toEqual({
      repositoryUrl: configValue.repositoryUrl,
      nMinusOneTag: `atlas--v${N_MINUS_ONE_VERSION}`,
      nTag: `atlas--v${N_VERSION}`,
      cliReleaseTag: "atlas-cli-v4.5.6",
      signerIdentity: configValue.signerIdentity,
    });
    expect(evidence.checks).toEqual(EXPECTED_CHECKS);
    expect(evidence.checks).toHaveLength(14);
    expect(harness.credentialLoads()).toBe(1);
    expect(harness.calls.at(-1)).toBe("cleanup");
    expect(serializeDistributionSmokeEvidence(evidence)).not.toContain(
      SENSITIVE_SENTINEL,
    );
  });
});

describe("strict evidence parser", () => {
  test("rejects extra top-level and per-check fields", () => {
    expect(() =>
      parseDistributionSmokeEvidence(encoded({
        ...passingEvidence(),
        rawOutput: "forbidden",
      }))
    ).toThrow("evidence has unexpected fields");

    const withDuration = passingEvidence();
    Object.assign(withDuration.checks[0]!, { durationMs: 1 });
    expect(() =>
      parseDistributionSmokeEvidence(encoded(withDuration))
    ).toThrow("checks[0] has unexpected fields");
  });

  test("rejects duplicate or incomplete passing check sets", () => {
    const duplicate = passingEvidence();
    duplicate.checks[13] = { ...duplicate.checks[0]! };
    expect(() =>
      parseDistributionSmokeEvidence(encoded(duplicate))
    ).toThrow("check ids must be known and unique");

    const incomplete = passingEvidence();
    incomplete.checks = incomplete.checks.slice(0, -1);
    expect(() =>
      parseDistributionSmokeEvidence(encoded(incomplete))
    ).toThrow("passing evidence requires every check exactly once");
  });

  test("rejects failure metadata that identifies a passing check", () => {
    const inconsistent: DistributionSmokeEvidence = {
      ...passingEvidence(),
      result: "failed",
      failure: {
        code: "health_check_failed",
        checkId: "application_health",
      },
    };
    expect(() =>
      parseDistributionSmokeEvidence(encoded(inconsistent))
    ).toThrow("failure must identify the failed check");
  });
});

describe("configuration validation", () => {
  const invalidCases: Array<{
    name: string;
    override: Partial<DistributionSmokeConfig>;
    message: string;
  }> = [
    {
      name: "credential-bearing repository URL",
      override: {
        repositoryUrl:
          "https://actor:opaque-value@github.com/example/atlas-agent-plugins",
      },
      message: "credential-free GitHub HTTPS",
    },
    {
      name: "malformed N-1 tag",
      override: { nMinusOneTag: "atlas--v01.2.3" },
      message: "plugin tags must use atlas--vX.Y.Z",
    },
    {
      name: "non-increasing N tag",
      override: { nTag: `atlas--v${N_MINUS_ONE_VERSION}` },
      message: "N plugin version must be greater",
    },
    {
      name: "malformed CLI release tag",
      override: { cliReleaseTag: "atlas-cli-v4.5" },
      message: "CLI release tag must use atlas-cli-vX.Y.Z",
    },
    {
      name: "signer identity for another release",
      override: {
        signerIdentity:
          "https://github.com/example/source/.github/workflows/release-cli.yml@refs/tags/cli-v4.5.7",
      },
      message: "signer identity does not match",
    },
    {
      name: "API URL with a path",
      override: { apiOrigin: "https://api.example.invalid/v1" },
      message: "API origin must be one credential-free HTTPS origin",
    },
    {
      name: "uppercase application SHA",
      override: { expectedApplicationSha: "A".repeat(40) },
      message: "expected application SHA must be lowercase",
    },
    {
      name: "uppercase Cursor digest",
      override: { cursorEvidenceSha256: "B".repeat(64) },
      message: "Cursor evidence digest must be lowercase",
    },
  ];

  for (const invalidCase of invalidCases) {
    test(`rejects ${invalidCase.name}`, () => {
      expect(() =>
        normalizeSmokeConfig(config(invalidCase.override))
      ).toThrow(invalidCase.message);
    });
  }
});

describe("failure safety and credential ordering", () => {
  for (
    const stage of [
      "public_release_preflight",
      "application_health",
    ] as const
  ) {
    test(`${stage} fails before credentials are loaded`, async () => {
      const configValue = config();
      const harness = operationHarness(configValue, stage);

      const evidence = await runDistributionSmoke(
        configValue,
        harness.operations,
      );

      expect(evidence.result).toBe("failed");
      expect(evidence.failure).toEqual({
        code: "unexpected_failure",
        checkId: stage,
      });
      expect(evidence.checks.at(-1)).toEqual({
        id: stage,
        host: "shared",
        status: "failed",
      });
      expect(harness.credentialLoads()).toBe(0);
      expect(harness.calls).not.toContain("load_api_key");
      expect(serializeDistributionSmokeEvidence(evidence)).not.toContain(
        SENSITIVE_SENTINEL,
      );
    });
  }

  test("failure evidence never persists a loaded credential or thrown message", async () => {
    const configValue = config();
    const harness = operationHarness(configValue, "claude_auth");

    const evidence = await runDistributionSmoke(
      configValue,
      harness.operations,
    );
    const serialized = serializeDistributionSmokeEvidence(evidence);

    expect(harness.credentialLoads()).toBe(1);
    expect(evidence.result).toBe("failed");
    expect(evidence.failure).toEqual({
      code: "unexpected_failure",
      checkId: "claude_auth",
    });
    expect(serialized).not.toContain(SENSITIVE_SENTINEL);
    expect(serialized).not.toContain("authentication:");
    expect(() => parseDistributionSmokeEvidence(serialized)).not.toThrow();
  });
});

describe("command-line evidence boundary", () => {
  test("writes fixture evidence with mode 0600 and refuses overwrite", () => {
    const root = temp("atlas-distribution-smoke-cli-");
    const evidenceOut = join(root, "evidence.json");
    const command = [
      "bun",
      SCRIPT,
      "--mode",
      "fixture",
      "--evidence-out",
      evidenceOut,
    ];

    const first = Bun.spawnSync(command, {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(first.exitCode).toBe(0);
    expect(first.stderr.toString()).toBe("");
    expect(statSync(evidenceOut).mode & 0o777).toBe(0o600);
    const original = readFileSync(evidenceOut, "utf8");
    expect(parseDistributionSmokeEvidence(original).mode).toBe("fixture");

    const second = Bun.spawnSync(command, {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(second.exitCode).toBe(1);
    expect(second.stderr.toString()).toContain(
      "distribution-smoke: failed (evidence_exists)",
    );
    expect(readFileSync(evidenceOut, "utf8")).toBe(original);
  });
});
