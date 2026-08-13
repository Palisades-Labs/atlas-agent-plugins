#!/usr/bin/env bun
/**
 * Validate the exact tree that can be copied to the public plugin repository.
 * STAGING.md is intentionally monorepo-only; every other file is copied to a
 * temporary directory and tested there so no validation can accidentally rely
 * on sibling monorepo files.
 */
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

const SOURCE = resolve(import.meta.dir, "..");
const REQUIRED_FILES = [
  ".github/workflows/release-plugin.yml",
  ".github/workflows/validate.yml",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "README.md",
  "GETTING_STARTED.md",
  "llms.txt",
  "LICENSE",
  "docs/cli.md",
  "docs/mcp.md",
  "atlas/.claude-plugin/plugin.json",
  "atlas/.codex-plugin/plugin.json",
  "atlas/.cursor-plugin/plugin.json",
  "atlas/.mcp.json",
  "atlas/assets/logo.svg",
  "atlas/mcp.json",
  "atlas/bin/atlas",
  "atlas/bin/cli-checksums",
  "atlas/bin/cli-pin-policy.json",
  "atlas/bin/cli-version",
  "atlas/bin/atlas-forwarder",
  "atlas/bin/forwarder-test.sh",
  "atlas/bin/launcher-test.sh",
  "atlas/skills/build-list/SKILL.md",
  "atlas/skills/company-discovery/SKILL.md",
  "atlas/skills/enrichment/SKILL.md",
  "atlas/skills/runs/SKILL.md",
  "atlas/skills/setup/SKILL.md",
  "atlas/skills/sheets/SKILL.md",
  "atlas/skills/troubleshooting/SKILL.md",
  "scripts/cli-pin-policy.test.ts",
  "scripts/cli-pin-policy.ts",
  "scripts/validate-manifests.ts",
  "scripts/validate-release-diff.test.ts",
  "scripts/validate-release-diff.ts",
  "scripts/verify-plugin-release.test.ts",
  "scripts/verify-plugin-release.ts",
];
const EXPECTED_SKILLS = [
  "build-list",
  "company-discovery",
  "enrichment",
  "runs",
  "setup",
  "sheets",
  "troubleshooting",
];
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const FORBIDDEN_FILENAMES = [
  /^\.env(?:\..+)?$/,
  /^\.DS_Store$/,
  /^credentials(?:\.json)?$/i,
  /^id_(?:rsa|ed25519)$/,
  /\.(?:key|pem|p12|pfx)$/i,
];
const FORBIDDEN_CONTENT: ReadonlyArray<[RegExp, string]> = [
  [/PENDING:/, "unresolved PENDING marker"],
  [/\bSTAGING\.md\b/, "reference to the monorepo-only STAGING.md"],
  [/apps\/agent-plugins\//, "monorepo-only apps/agent-plugins path"],
  [/apps\/cli\//, "monorepo-only apps/cli path"],
  [/\.claude\/worktrees\//, "local worktree path"],
  [/\/Users\/[A-Za-z0-9._-]+\//, "absolute macOS user path"],
  [/\batlas_sk_[A-Za-z0-9_-]{16,}\b/, "Atlas API key-like value"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/, "GitHub token-like value"],
];

/**
 * Sources exempt from the FORBIDDEN_CONTENT scan because naming a marker IS
 * their job. Keep this list minimal — every entry is a file whose contents no
 * longer get leak-scanned, so it may only hold tooling that enforces the same
 * markers it mentions. Filename and symlink checks still apply to all of them.
 */
const CONTENT_SCAN_EXEMPT: ReadonlySet<string> = new Set([
  "scripts/validate-package.ts",
  "scripts/package-provenance.ts",
  "scripts/package-provenance.test.ts",
]);

const problems: string[] = [];
const problem = (message: string): void => {
  problems.push(message);
};

function walk(root: string, visit: (absolute: string, rel: string) => void): void {
  for (const entry of readdirSync(root)) {
    // These may be directories in a normal clone or files in a Git worktree.
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const absolute = join(root, entry);
    const rel = relative(SOURCE, absolute);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      problem(`${rel}: symbolic links are not allowed in the public package`);
      continue;
    }
    if (stat.isDirectory()) {
      // Repository metadata and local dependency installs are never part of a
      // Git-distributed package, but are present when this runs in its public
      // repository. Exclude them from both the scan and clean-copy fixture.
      walk(absolute, visit);
    } else if (stat.isFile()) {
      visit(absolute, rel);
    }
  }
}

walk(SOURCE, (absolute, rel) => {
  const name = basename(absolute);
  if (rel === "STAGING.md") return;
  if (FORBIDDEN_FILENAMES.some((pattern) => pattern.test(name))) {
    problem(`${rel}: secret-bearing or generated filename must not ship`);
  }
  // These necessarily name the forbidden markers they enforce: this validator
  // scans for them, and package-provenance asserts STAGING.md never ships.
  if (CONTENT_SCAN_EXEMPT.has(rel)) return;
  // The staged repository is text-only. Treat an unreadable/binary addition as
  // a review requirement instead of silently omitting it from the leak scan.
  const contents = readFileSync(absolute, "utf8");
  if (contents.includes("\u0000")) {
    problem(`${rel}: binary content is not expected in the plugin repository`);
    return;
  }
  for (const [pattern, reason] of FORBIDDEN_CONTENT) {
    if (pattern.test(contents)) problem(`${rel}: contains ${reason}`);
  }
});

for (const rel of REQUIRED_FILES) {
  try {
    if (!statSync(join(SOURCE, rel)).isFile()) problem(`${rel}: required public file is not a regular file`);
  } catch {
    problem(`${rel}: required public file is missing`);
  }
}

try {
  const actualSkills = readdirSync(join(SOURCE, "atlas/skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && statSync(join(SOURCE, "atlas/skills", entry.name, "SKILL.md")).isFile())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(actualSkills) !== JSON.stringify(EXPECTED_SKILLS)) {
    problem(
      `atlas/skills: expected exactly ${EXPECTED_SKILLS.join(", ")}; found ${actualSkills.join(", ") || "none"}`,
    );
  }
  for (const skill of EXPECTED_SKILLS) {
    const contents = readFileSync(join(SOURCE, "atlas/skills", skill, "SKILL.md"), "utf8").toLowerCase();
    if (!contents.includes("untrusted") || !contents.includes("instructions")) {
      problem(
        `atlas/skills/${skill}/SKILL.md: must tell agents that external data is untrusted and not instructions`,
      );
    }
  }
} catch {
  problem("atlas/skills: could not enumerate the required workflow skills");
}

for (const rel of [
  "atlas/bin/atlas",
  "atlas/bin/atlas-forwarder",
  "atlas/bin/forwarder-test.sh",
  "atlas/bin/launcher-test.sh",
]) {
  try {
    if ((statSync(join(SOURCE, rel)).mode & 0o111) === 0) {
      problem(`${rel}: must retain an executable bit`);
    }
  } catch {
    // The required-file finding above is clearer when the file is absent.
  }
}

if (problems.length > 0) {
  console.error(`validate-package: ${problems.length} source problem(s):`);
  for (const entry of problems) console.error(`  - ${entry}`);
  process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), "atlas-agent-plugin-package-"));
const packagedRoot = join(temp, "atlas-agent-plugins");

function run(label: string, command: string[]): void {
  const result = Bun.spawnSync(command, {
    cwd: packagedRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();
    console.error(`validate-package: ${label} failed in the clean package`);
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
    process.exitCode = 1;
    return;
  }
  console.log(`${label}: OK`);
}

function runExpectFailure(label: string, command: string[], expectedMessage: string): void {
  const result = Bun.spawnSync(command, {
    cwd: packagedRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  if (result.exitCode === 0) {
    console.error(`validate-package: ${label} unexpectedly passed in the clean package`);
    process.exitCode = 1;
    return;
  }
  if (!output.includes(expectedMessage)) {
    console.error(`validate-package: ${label} failed without the expected diagnostic`);
    console.error(output.trim());
    process.exitCode = 1;
    return;
  }
  console.log(`${label}: OK`);
}

try {
  cpSync(SOURCE, packagedRoot, {
    recursive: true,
    filter: (source) => {
      const rel = relative(SOURCE, source);
      if (rel === "STAGING.md") return false;
      return !rel.split(sep).some((part) => IGNORED_DIRECTORIES.has(part));
    },
  });

  try {
    statSync(join(packagedRoot, "STAGING.md"));
    console.error("validate-package: STAGING.md leaked into the public package");
    process.exitCode = 1;
  } catch {
    // Expected: staging operations stay in the private monorepo.
  }

  run("clean-package manifest validation", [
    "bun",
    join(packagedRoot, "scripts/validate-manifests.ts"),
    packagedRoot,
  ]);
  run("clean-package plugin release contract tests", [
    "bun",
    "test",
    join(packagedRoot, "scripts/verify-plugin-release.test.ts"),
  ]);
  run("clean-package CLI pin policy tests", [
    "bun",
    "test",
    join(packagedRoot, "scripts/cli-pin-policy.test.ts"),
  ]);
  run("clean-package release base-diff guard tests", [
    "bun",
    "test",
    join(packagedRoot, "scripts/validate-release-diff.test.ts"),
  ]);

  const codexManifestPath = join(packagedRoot, "atlas/.codex-plugin/plugin.json");
  const originalCodexManifest = readFileSync(codexManifestPath, "utf8");
  try {
    const tooManyPrompts = JSON.parse(originalCodexManifest) as {
      interface: { defaultPrompt: string[] };
    };
    tooManyPrompts.interface.defaultPrompt = ["one", "two", "three", "four"];
    writeFileSync(codexManifestPath, `${JSON.stringify(tooManyPrompts, null, 2)}\n`);
    runExpectFailure(
      "clean-package Codex prompt-limit regression",
      ["bun", join(packagedRoot, "scripts/validate-manifests.ts"), packagedRoot],
      "defaultPrompt must contain at most 3 entries; found 4",
    );

    const tooLongPrompt = JSON.parse(originalCodexManifest) as {
      interface: { defaultPrompt: string[] };
    };
    tooLongPrompt.interface.defaultPrompt = ["x".repeat(129)];
    writeFileSync(codexManifestPath, `${JSON.stringify(tooLongPrompt, null, 2)}\n`);
    runExpectFailure(
      "clean-package Codex prompt-length regression",
      ["bun", join(packagedRoot, "scripts/validate-manifests.ts"), packagedRoot],
      "defaultPrompt[0] exceeds 128 characters (129)",
    );

    const driftedRepository = JSON.parse(originalCodexManifest) as { repository: string };
    driftedRepository.repository = "https://github.com/example/atlas-agent-plugins";
    writeFileSync(codexManifestPath, `${JSON.stringify(driftedRepository, null, 2)}\n`);
    runExpectFailure(
      "clean-package repository-slug regression",
      ["bun", join(packagedRoot, "scripts/validate-manifests.ts"), packagedRoot],
      "repository must equal canonical distribution URL",
    );
  } finally {
    writeFileSync(codexManifestPath, originalCodexManifest);
  }

  const enrichmentSkillPath = join(packagedRoot, "atlas/skills/enrichment/SKILL.md");
  const originalEnrichmentSkill = readFileSync(enrichmentSkillPath, "utf8");
  try {
    writeFileSync(
      enrichmentSkillPath,
      originalEnrichmentSkill.replace(
        "atlas enrich run <column_id> --unrun-only --wait",
        "atlas enrich run <column_id> --wait",
      ),
    );
    runExpectFailure(
      "clean-package enrichment safe-flow regression",
      ["bun", join(packagedRoot, "scripts/validate-manifests.ts"), packagedRoot],
      "missing or out-of-order required unrun-only completion marker",
    );
  } finally {
    writeFileSync(enrichmentSkillPath, originalEnrichmentSkill);
  }

  const readmePath = join(packagedRoot, "README.md");
  const originalReadme = readFileSync(readmePath, "utf8");
  try {
    writeFileSync(
      readmePath,
      originalReadme.replace(
        /Palisades-Labs\/atlas-agent-plugins@atlas--v[0-9.]+/,
        "Palisades-Labs/atlas-agent-plugins",
      ),
    );
    runExpectFailure(
      "clean-package immutable install-pin regression",
      ["bun", join(packagedRoot, "scripts/validate-manifests.ts"), packagedRoot],
      "production install instructions must pin immutable plugin tag",
    );
  } finally {
    writeFileSync(readmePath, originalReadme);
  }

  const pinPolicyPath = join(packagedRoot, "atlas/bin/cli-pin-policy.json");
  const pinChecksumsPath = join(packagedRoot, "atlas/bin/cli-checksums");
  const originalPinPolicy = readFileSync(pinPolicyPath, "utf8");
  const originalPinChecksums = readFileSync(pinChecksumsPath, "utf8");
  try {
    writeFileSync(
      pinPolicyPath,
      `${JSON.stringify({ schemaVersion: 1, state: "pinned" }, null, 2)}\n`,
    );
    // Seed the placeholder shape explicitly: once a real release pins four
    // digests, the package's own cli-checksums no longer reproduces the
    // comment-only bootstrap file this regression depends on (first observed
    // on the first real pin PR, 2026-08-13).
    writeFileSync(
      pinChecksumsPath,
      "# TODO(release): placeholder seeded by pinned-with-placeholder regression.\n",
    );
    runExpectFailure(
      "clean-package pinned-with-placeholder regression",
      ["bun", join(packagedRoot, "scripts/validate-manifests.ts"), packagedRoot],
      "pinned policy requires four nonzero release digests",
    );

    const cliVersion = readFileSync(
      join(packagedRoot, "atlas/bin/cli-version"),
      "utf8",
    ).trim();
    const pinnedChecksums = [
      `# Generated by the Atlas CLI release workflow for version ${cliVersion}.`,
      `${"1".repeat(64)}  atlas-darwin-arm64`,
      `${"2".repeat(64)}  atlas-darwin-x64`,
      `${"3".repeat(64)}  atlas-linux-arm64`,
      `${"4".repeat(64)}  atlas-linux-x64`,
      "",
    ].join("\n");
    writeFileSync(pinChecksumsPath, pinnedChecksums);
    run("clean-package pinned-policy four-digest regression", [
      "bun",
      join(packagedRoot, "scripts/validate-manifests.ts"),
      packagedRoot,
    ]);

    writeFileSync(
      pinChecksumsPath,
      pinnedChecksums.replace("1".repeat(64), "0".repeat(64)),
    );
    runExpectFailure(
      "clean-package pinned-policy zero-digest regression",
      ["bun", join(packagedRoot, "scripts/validate-manifests.ts"), packagedRoot],
      "uses the all-zero bootstrap sentinel",
    );
  } finally {
    writeFileSync(pinPolicyPath, originalPinPolicy);
    writeFileSync(pinChecksumsPath, originalPinChecksums);
  }

  run("clean-package launcher tests", ["bash", join(packagedRoot, "atlas/bin/launcher-test.sh")]);
  run("clean-package active-plugin forwarder tests", [
    "bash",
    join(packagedRoot, "atlas/bin/forwarder-test.sh"),
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (process.exitCode) process.exit(process.exitCode);
console.log("validate-package: OK (public tree is self-contained, leak-scanned, and executable)");
