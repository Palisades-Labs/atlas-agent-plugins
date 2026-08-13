#!/usr/bin/env bun
/**
 * validate-manifests.ts — plugin-manifest consistency gate (CI: launcher job).
 *
 * Validates the staged plugin repo's machine-read files so a bad edit fails a
 * PR instead of a client install:
 *   - atlas/.claude-plugin/plugin.json     parses; name/version/description
 *   - atlas/.codex-plugin/plugin.json      parses; required author/interface
 *                                          metadata is complete; skills path
 *                                          exists; inline MCP config pins the
 *                                          reviewed launcher + timeouts
 *   - atlas/.cursor-plugin/plugin.json     parses; required metadata and
 *                                          referenced skills/MCP paths exist
 *   - .claude-plugin/marketplace.json      parses; supported Claude marketplace
 *                                          metadata (name/description/owner) and
 *                                          plugins[] name/source/description/category;
 *                                          unsupported interface/policy fields
 *                                          stay absent; source dirs exist
 *   - .cursor-plugin/marketplace.json      parses; owner/metadata/plugins[];
 *                                          source dirs exist
 *   - atlas/.mcp.json + atlas/mcp.json     match and launch portably from the
 *                                          plugin root in Claude, Codex, Cursor
 *   - atlas/bin/cli-version                non-empty semver
 *   - atlas/bin/cli-pin-policy.json        exact machine-readable bootstrap or
 *                                          pinned state. Bootstrap permits only
 *                                          the initial zero-entry placeholder;
 *                                          pinned requires 4 nonzero digests.
 *   - atlas/bin/cli-checksums              matches the policy state, CLI version,
 *                                          and exact 4-target launcher contract.
 *   - atlas/bin/atlas                      verifies target-specific keyless
 *                                          Sigstore bundles against the exact
 *                                          release workflow/tag identity and
 *                                          GitHub Actions OIDC issuer; legacy
 *                                          private-repo attestation calls fail.
 *   - plugin-version lockstep: all three plugin manifests carry the same
 *     version and the latest changelog heading matches it. The plugin and CLI
 *     versions are intentionally independent.
 *
 * Public-repo usage: `bun scripts/validate-manifests.ts`.
 * Monorepo CI passes the staging root explicitly when validating a clean copy.
 * No dependencies — plain node:fs, exits 1 with every finding listed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  CliPinPolicyError,
  readCliPinPolicy,
  type CliPinState,
} from "./cli-pin-policy";

const ROOT = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, "..");
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TARGETS = ["atlas-darwin-arm64", "atlas-darwin-x64", "atlas-linux-arm64", "atlas-linux-x64"];
const CANONICAL_PLUGIN_REPO_SLUG = "Palisades-Labs/atlas-agent-plugins";
const CANONICAL_PLUGIN_REPOSITORY = `https://github.com/${CANONICAL_PLUGIN_REPO_SLUG}`;
const PORTABLE_MCP_COMMAND =
  'if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then exec "$CLAUDE_PLUGIN_ROOT/bin/atlas" mcp; fi; exec ./bin/atlas mcp';
const CODEX_STARTUP_TIMEOUT_SECONDS = 300;
const CODEX_TOOL_TIMEOUT_SECONDS = 90;
const ENRICHMENT_SAFE_FLOW = [
  ["draft without running", "atlas enrich add <table_id> --goal"],
  ["real sampled run", "atlas enrich run <column_id> --test 5 --wait"],
  ["real-sample explanation", "`--test n` runs a real capped run"],
  ["read sampled cells", "atlas sheets read <table_id>"],
  ["review sampled cells", "inspect the sampled cells"],
  ["unrun-only completion", "atlas enrich run <column_id> --unrun-only --wait"],
] as const;

const problems: string[] = [];
const problem = (msg: string): void => {
  problems.push(msg);
};

function readJson(relPath: string): Record<string, unknown> | null {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    problem(`${relPath}: file missing`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(abs, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      problem(`${relPath}: top level is not a JSON object`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    problem(`${relPath}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function requireString(relPath: string, obj: Record<string, unknown>, field: string): string | null {
  const value = obj[field];
  if (typeof value !== "string" || value.trim() === "") {
    problem(`${relPath}: required field "${field}" is missing or empty`);
    return null;
  }
  return value;
}

function requireObject(
  relPath: string,
  obj: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null {
  const value = obj[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problem(`${relPath}: required field "${field}" is missing or is not an object`);
    return null;
  }
  return value as Record<string, unknown>;
}

function requireStringArray(
  relPath: string,
  obj: Record<string, unknown>,
  field: string,
): string[] | null {
  const value = obj[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    problem(`${relPath}: required field "${field}" must be a non-empty string array`);
    return null;
  }
  return value as string[];
}

function validateAuthor(relPath: string, obj: Record<string, unknown>, requireUrl: boolean): void {
  const author = requireObject(relPath, obj, "author");
  if (!author) return;
  for (const field of requireUrl ? ["name", "email", "url"] : ["name", "email"]) {
    requireString(`${relPath} author`, author, field);
  }
}

function validateCanonicalRepository(relPath: string, obj: Record<string, unknown>): void {
  const repository = requireString(relPath, obj, "repository");
  if (repository !== null && repository !== CANONICAL_PLUGIN_REPOSITORY) {
    problem(
      `${relPath}: repository must equal canonical distribution URL ${JSON.stringify(CANONICAL_PLUGIN_REPOSITORY)}`,
    );
  }
}

function validatePluginReference(
  relPath: string,
  manifest: Record<string, unknown>,
  field: string,
  expectedKind: "file" | "directory",
): void {
  const ref = requireString(relPath, manifest, field);
  if (ref === null) return;
  const pluginRoot = resolve(ROOT, "atlas");
  const target = resolve(pluginRoot, ref);
  if (target !== pluginRoot && !target.startsWith(`${pluginRoot}${sep}`)) {
    problem(`${relPath}: "${field}" escapes the plugin root: "${ref}"`);
    return;
  }
  if (!existsSync(target)) {
    problem(`${relPath}: "${field}" points at "${ref}" which does not exist under atlas/`);
    return;
  }
  const stat = statSync(target);
  if (expectedKind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    problem(`${relPath}: "${field}" must point at a ${expectedKind}, got "${ref}"`);
  }
}

// ── plugin manifests ────────────────────────────────────────────────────────
const manifestVersions: { relPath: string; version: string }[] = [];

const claudePlugin = readJson("atlas/.claude-plugin/plugin.json");
if (claudePlugin) {
  const name = requireString("atlas/.claude-plugin/plugin.json", claudePlugin, "name");
  if (name !== null && name !== "atlas") problem(`atlas/.claude-plugin/plugin.json: name must be "atlas"`);
  requireString("atlas/.claude-plugin/plugin.json", claudePlugin, "description");
  const v = requireString("atlas/.claude-plugin/plugin.json", claudePlugin, "version");
  if (v && !SEMVER.test(v)) problem(`atlas/.claude-plugin/plugin.json: version "${v}" is not semver`);
  if (v) manifestVersions.push({ relPath: "atlas/.claude-plugin/plugin.json", version: v });
  validateAuthor("atlas/.claude-plugin/plugin.json", claudePlugin, false);
  for (const field of ["homepage", "license"]) {
    requireString("atlas/.claude-plugin/plugin.json", claudePlugin, field);
  }
  validateCanonicalRepository("atlas/.claude-plugin/plugin.json", claudePlugin);
  requireStringArray("atlas/.claude-plugin/plugin.json", claudePlugin, "keywords");
}

const codexPlugin = readJson("atlas/.codex-plugin/plugin.json");
if (codexPlugin) {
  const name = requireString("atlas/.codex-plugin/plugin.json", codexPlugin, "name");
  if (name !== null && name !== "atlas") problem(`atlas/.codex-plugin/plugin.json: name must be "atlas"`);
  requireString("atlas/.codex-plugin/plugin.json", codexPlugin, "description");
  const v = requireString("atlas/.codex-plugin/plugin.json", codexPlugin, "version");
  if (v && !SEMVER.test(v)) problem(`atlas/.codex-plugin/plugin.json: version "${v}" is not semver`);
  if (v) manifestVersions.push({ relPath: "atlas/.codex-plugin/plugin.json", version: v });
  validateAuthor("atlas/.codex-plugin/plugin.json", codexPlugin, true);
  for (const field of ["homepage", "license"]) {
    requireString("atlas/.codex-plugin/plugin.json", codexPlugin, field);
  }
  validateCanonicalRepository("atlas/.codex-plugin/plugin.json", codexPlugin);
  requireStringArray("atlas/.codex-plugin/plugin.json", codexPlugin, "keywords");
  const pluginInterface = requireObject("atlas/.codex-plugin/plugin.json", codexPlugin, "interface");
  if (pluginInterface) {
    for (const field of [
      "displayName",
      "shortDescription",
      "longDescription",
      "developerName",
      "category",
      "websiteURL",
      "privacyPolicyURL",
      "termsOfServiceURL",
    ]) {
      requireString("atlas/.codex-plugin/plugin.json interface", pluginInterface, field);
    }
    requireStringArray("atlas/.codex-plugin/plugin.json interface", pluginInterface, "capabilities");
    const defaultPrompts = requireStringArray(
      "atlas/.codex-plugin/plugin.json interface",
      pluginInterface,
      "defaultPrompt",
    );
    if (defaultPrompts !== null) {
      if (defaultPrompts.length > 3) {
        problem(
          `atlas/.codex-plugin/plugin.json interface: defaultPrompt must contain at most 3 entries; found ${defaultPrompts.length}`,
        );
      }
      defaultPrompts.forEach((prompt, index) => {
        const characterCount = Array.from(prompt).length;
        if (characterCount > 128) {
          problem(
            `atlas/.codex-plugin/plugin.json interface: defaultPrompt[${index}] exceeds 128 characters (${characterCount})`,
          );
        }
      });
    }
  }
  // Skills stay path-based. Codex MCP configuration is deliberately inline so
  // its longer cold-download/tool timeouts cannot be silently lost while the
  // Claude/Cursor companion files remain portable and byte-identical.
  validatePluginReference("atlas/.codex-plugin/plugin.json", codexPlugin, "skills", "directory");
  const servers = requireObject("atlas/.codex-plugin/plugin.json", codexPlugin, "mcpServers");
  const atlasServer = servers
    ? requireObject("atlas/.codex-plugin/plugin.json mcpServers", servers, "atlas")
    : null;
  if (atlasServer) {
    const command = requireString(
      "atlas/.codex-plugin/plugin.json mcpServers.atlas",
      atlasServer,
      "command",
    );
    if (command !== null && command !== "sh") {
      problem('atlas/.codex-plugin/plugin.json: Atlas server command must be "sh"');
    }
    const cwd = requireString(
      "atlas/.codex-plugin/plugin.json mcpServers.atlas",
      atlasServer,
      "cwd",
    );
    if (cwd !== null && cwd !== ".") {
      problem('atlas/.codex-plugin/plugin.json: Atlas server cwd must be "."');
    }
    const args = atlasServer["args"];
    if (!Array.isArray(args) || args.length !== 2 || args[0] !== "-c" || args[1] !== PORTABLE_MCP_COMMAND) {
      problem(
        'atlas/.codex-plugin/plugin.json: Atlas server args must exactly match the reviewed portable launcher command',
      );
    }
    if (atlasServer["startup_timeout_sec"] !== CODEX_STARTUP_TIMEOUT_SECONDS) {
      problem(
        `atlas/.codex-plugin/plugin.json: startup_timeout_sec must be ${CODEX_STARTUP_TIMEOUT_SECONDS}`,
      );
    }
    if (atlasServer["tool_timeout_sec"] !== CODEX_TOOL_TIMEOUT_SECONDS) {
      problem(
        `atlas/.codex-plugin/plugin.json: tool_timeout_sec must be ${CODEX_TOOL_TIMEOUT_SECONDS}`,
      );
    }
  }
}

const cursorPlugin = readJson("atlas/.cursor-plugin/plugin.json");
if (cursorPlugin) {
  const name = requireString("atlas/.cursor-plugin/plugin.json", cursorPlugin, "name");
  if (name !== null && name !== "atlas") problem(`atlas/.cursor-plugin/plugin.json: name must be "atlas"`);
  requireString("atlas/.cursor-plugin/plugin.json", cursorPlugin, "displayName");
  requireString("atlas/.cursor-plugin/plugin.json", cursorPlugin, "description");
  const v = requireString("atlas/.cursor-plugin/plugin.json", cursorPlugin, "version");
  if (v && !SEMVER.test(v)) problem(`atlas/.cursor-plugin/plugin.json: version "${v}" is not semver`);
  if (v) manifestVersions.push({ relPath: "atlas/.cursor-plugin/plugin.json", version: v });
  validateAuthor("atlas/.cursor-plugin/plugin.json", cursorPlugin, false);
  requireString("atlas/.cursor-plugin/plugin.json", cursorPlugin, "license");
  validateCanonicalRepository("atlas/.cursor-plugin/plugin.json", cursorPlugin);
  requireStringArray("atlas/.cursor-plugin/plugin.json", cursorPlugin, "keywords");
  validatePluginReference("atlas/.cursor-plugin/plugin.json", cursorPlugin, "logo", "file");
  validatePluginReference("atlas/.cursor-plugin/plugin.json", cursorPlugin, "skills", "directory");
  validatePluginReference("atlas/.cursor-plugin/plugin.json", cursorPlugin, "mcpServers", "file");
}

// ── marketplace ─────────────────────────────────────────────────────────────
const marketplace = readJson(".claude-plugin/marketplace.json");
if (marketplace) {
  requireString(".claude-plugin/marketplace.json", marketplace, "name");
  requireString(".claude-plugin/marketplace.json", marketplace, "description");
  if (Object.hasOwn(marketplace, "interface")) {
    problem(
      `.claude-plugin/marketplace.json: top-level "interface" is unsupported by the native Claude marketplace schema`,
    );
  }
  const owner = marketplace["owner"];
  if (typeof owner !== "object" || owner === null || typeof (owner as Record<string, unknown>)["name"] !== "string") {
    problem(`.claude-plugin/marketplace.json: "owner.name" is missing`);
  }
  const plugins = marketplace["plugins"];
  if (!Array.isArray(plugins) || plugins.length === 0) {
    problem(`.claude-plugin/marketplace.json: "plugins" must be a non-empty array`);
  } else {
    plugins.forEach((entry: unknown, i: number) => {
      if (typeof entry !== "object" || entry === null) {
        problem(`.claude-plugin/marketplace.json: plugins[${i}] is not an object`);
        return;
      }
      const e = entry as Record<string, unknown>;
      for (const field of ["name", "source", "description"]) {
        if (typeof e[field] !== "string" || (e[field] as string).trim() === "") {
          problem(`.claude-plugin/marketplace.json: plugins[${i}].${field} is missing or empty`);
        }
      }
      if (typeof e["category"] !== "string" || (e["category"] as string).trim() === "") {
        problem(`.claude-plugin/marketplace.json: plugins[${i}].category is missing or empty`);
      }
      if (Object.hasOwn(e, "policy")) {
        problem(
          `.claude-plugin/marketplace.json: plugins[${i}].policy is unsupported by the native Claude marketplace schema`,
        );
      }
      const source = e["source"];
      if (typeof source === "string") {
        const dir = resolve(ROOT, source);
        if (dir !== ROOT && !dir.startsWith(`${ROOT}${sep}`)) {
          problem(`.claude-plugin/marketplace.json: plugins[${i}].source escapes the repository root`);
          return;
        }
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          problem(`.claude-plugin/marketplace.json: plugins[${i}].source "${source}" is not a directory`);
        }
      }
    });
  }
}

const cursorMarketplace = readJson(".cursor-plugin/marketplace.json");
if (cursorMarketplace) {
  requireString(".cursor-plugin/marketplace.json", cursorMarketplace, "name");
  const owner = requireObject(".cursor-plugin/marketplace.json", cursorMarketplace, "owner");
  if (owner) {
    requireString(".cursor-plugin/marketplace.json owner", owner, "name");
    requireString(".cursor-plugin/marketplace.json owner", owner, "email");
  }
  const metadata = requireObject(".cursor-plugin/marketplace.json", cursorMarketplace, "metadata");
  if (metadata) requireString(".cursor-plugin/marketplace.json metadata", metadata, "description");
  const plugins = cursorMarketplace["plugins"];
  if (!Array.isArray(plugins) || plugins.length === 0) {
    problem(`.cursor-plugin/marketplace.json: "plugins" must be a non-empty array`);
  } else {
    plugins.forEach((entry: unknown, i: number) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        problem(`.cursor-plugin/marketplace.json: plugins[${i}] is not an object`);
        return;
      }
      const plugin = entry as Record<string, unknown>;
      for (const field of ["name", "source", "description"]) {
        requireString(`.cursor-plugin/marketplace.json plugins[${i}]`, plugin, field);
      }
      const source = plugin["source"];
      if (typeof source === "string") {
        const dir = resolve(ROOT, source);
        if (dir !== ROOT && !dir.startsWith(`${ROOT}${sep}`)) {
          problem(`.cursor-plugin/marketplace.json: plugins[${i}].source escapes the repository root`);
          return;
        }
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          problem(`.cursor-plugin/marketplace.json: plugins[${i}].source "${source}" is not a directory`);
        }
      }
    });
  }
}

// ── portable MCP definitions ───────────────────────────────────────────────
const claudeMcp = readJson("atlas/.mcp.json");
const cursorMcp = readJson("atlas/mcp.json");
if (claudeMcp && cursorMcp) {
  if (JSON.stringify(claudeMcp) !== JSON.stringify(cursorMcp)) {
    problem("atlas/.mcp.json and atlas/mcp.json must remain identical");
  }
  const servers = requireObject("atlas/.mcp.json", claudeMcp, "mcpServers");
  const atlasServer = servers ? requireObject("atlas/.mcp.json mcpServers", servers, "atlas") : null;
  if (atlasServer) {
    const command = requireString("atlas/.mcp.json mcpServers.atlas", atlasServer, "command");
    if (command !== null && command !== "sh") {
      problem('atlas/.mcp.json: Atlas server command must be "sh" so clients do not receive a literal ${CLAUDE_PLUGIN_ROOT} executable');
    }
    const cwd = requireString("atlas/.mcp.json mcpServers.atlas", atlasServer, "cwd");
    if (cwd !== null && cwd !== ".") {
      problem('atlas/.mcp.json: Atlas server cwd must be "." so Claude and Cursor resolve it against the plugin root');
    }
    const args = atlasServer["args"];
    if (!Array.isArray(args) || args.length !== 2 || args[0] !== "-c" || typeof args[1] !== "string") {
      problem('atlas/.mcp.json: Atlas server args must be ["-c", <portable launcher command>]');
    } else {
      const shellCommand = args[1] as string;
      if (shellCommand !== PORTABLE_MCP_COMMAND) {
        problem("atlas/.mcp.json: launcher command must exactly match the reviewed portable launcher command");
      }
    }
  }
}

// Cursor's published template validator requires name + description
// frontmatter on every discoverable skill. Enforce the same rule locally.
const skillsRoot = join(ROOT, "atlas/skills");
if (existsSync(skillsRoot) && statSync(skillsRoot).isDirectory()) {
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relPath = `atlas/skills/${entry.name}/SKILL.md`;
    const skillPath = join(skillsRoot, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) {
      problem(`${relPath}: file missing`);
      continue;
    }
    const skill = readFileSync(skillPath, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
    if (!frontmatter) {
      problem(`${relPath}: missing YAML frontmatter`);
      continue;
    }
    for (const field of ["name", "description"]) {
      if (!new RegExp(`^${field}:\\s*\\S`, "m").test(frontmatter)) {
        problem(`${relPath}: frontmatter field "${field}" is missing or empty`);
      }
    }
  }

  const enrichmentSkillPath = join(skillsRoot, "enrichment/SKILL.md");
  if (existsSync(enrichmentSkillPath)) {
    const enrichmentSkill = readFileSync(enrichmentSkillPath, "utf8").toLowerCase();
    let previousIndex = -1;
    for (const [label, marker] of ENRICHMENT_SAFE_FLOW) {
      const markerIndex = enrichmentSkill.indexOf(marker, previousIndex + 1);
      if (markerIndex === -1) {
        problem(
          `atlas/skills/enrichment/SKILL.md: missing or out-of-order required ${label} marker ${JSON.stringify(marker)}`,
        );
        continue;
      }
      previousIndex = markerIndex;
    }
  }
}

// ── launcher trust contract + pins ──────────────────────────────────────────
const launcherPath = join(ROOT, "atlas/bin/atlas");
if (!existsSync(launcherPath)) {
  problem("atlas/bin/atlas: file missing");
} else {
  const launcher = readFileSync(launcherPath, "utf8");
  const canonicalRepoMarker = `ATLAS_PLUGIN_REPO="\${ATLAS_PLUGIN_REPO:-${CANONICAL_PLUGIN_REPO_SLUG}}"`;
  if (!launcher.includes(canonicalRepoMarker)) {
    problem(
      `atlas/bin/atlas: default release repository must match canonical slug ${CANONICAL_PLUGIN_REPO_SLUG}`,
    );
  }
  const sigstoreMarkers = [
    "cosign verify-blob",
    '--bundle "$SIGSTORE_BUNDLE"',
    '--certificate-identity "$ATLAS_SIGNER_IDENTITY"',
    '--certificate-oidc-issuer "$ATLAS_OIDC_ISSUER"',
    "https://github.com/blast-double/auto-prospector/.github/workflows/release-cli.yml",
    "https://token.actions.githubusercontent.com",
    "${ATLAS_SIGNER_WORKFLOW}@refs/tags/cli-v${VERSION}",
    "atlas-$TARGET.sigstore.json",
  ];
  for (const marker of sigstoreMarkers) {
    if (!launcher.includes(marker)) {
      problem(`atlas/bin/atlas: missing reviewed Sigstore trust marker ${JSON.stringify(marker)}`);
    }
  }
  for (const legacyMarker of ["gh attestation verify", "ATLAS_ATTEST_REPO", "ATLAS_ATTEST_WORKFLOW"]) {
    if (launcher.includes(legacyMarker)) {
      problem(`atlas/bin/atlas: legacy private-repo attestation dependency remains: ${legacyMarker}`);
    }
  }
}

let cliVersion: string | null = null;
const versionPath = join(ROOT, "atlas/bin/cli-version");
if (!existsSync(versionPath)) {
  problem("atlas/bin/cli-version: file missing");
} else {
  cliVersion = readFileSync(versionPath, "utf8").trim();
  if (!SEMVER.test(cliVersion)) {
    problem(`atlas/bin/cli-version: "${cliVersion}" is not semver`);
    cliVersion = null;
  }
}

const checksumsPath = join(ROOT, "atlas/bin/cli-checksums");
let cliPinState: CliPinState | null = null;
try {
  cliPinState = readCliPinPolicy(ROOT).state;
} catch (error) {
  problem(
    `atlas/bin/cli-pin-policy.json: ${
      error instanceof CliPinPolicyError
        ? error.message
        : "file missing or unreadable"
    }`,
  );
}
if (!existsSync(checksumsPath)) {
  problem("atlas/bin/cli-checksums: file missing — the launcher fails closed without it");
} else {
  const raw = readFileSync(checksumsPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
  if (cliPinState === "bootstrap") {
    if (lines.length !== 0) {
      problem(
        "atlas/bin/cli-checksums: bootstrap policy requires the zero-entry placeholder; release pins must atomically transition policy to pinned",
      );
    }
    if (!raw.includes("TODO(release)")) {
      problem(
        "atlas/bin/cli-checksums: bootstrap placeholder is missing its TODO(release) marker",
      );
    }
    if (cliVersion && !raw.includes(`atlas-cli-v${cliVersion}`)) {
      problem(`atlas/bin/cli-checksums: TODO(release) must name current CLI release atlas-cli-v${cliVersion}`);
    }
  } else if (cliPinState === "pinned") {
    if (lines.length === 0) {
      problem(
        "atlas/bin/cli-checksums: pinned policy requires four nonzero release digests",
      );
    }
    const seen = new Map<string, number>();
    for (const line of lines) {
      const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
      if (!match) {
        problem(`atlas/bin/cli-checksums: malformed digest line: ${JSON.stringify(line)}`);
        continue;
      }
      if (/^0{64}$/.test(match[1] as string)) {
        problem(
          `atlas/bin/cli-checksums: ${match[2]} uses the all-zero bootstrap sentinel; pinned digests must be nonzero`,
        );
      }
      const name = match[2] as string;
      if (!TARGETS.includes(name)) {
        problem(`atlas/bin/cli-checksums: entry for unknown target "${name}" (expected one of: ${TARGETS.join(", ")})`);
        continue;
      }
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    for (const target of TARGETS) {
      const count = seen.get(target) ?? 0;
      if (count === 0) problem(`atlas/bin/cli-checksums: missing pinned digest for ${target} — a partial pin set bricks that platform`);
      if (count > 1) problem(`atlas/bin/cli-checksums: ${count} entries for ${target} — must be exactly one`);
    }
    if (raw.includes("TODO(release)")) {
      problem("atlas/bin/cli-checksums: carries digest entries AND the TODO(release) placeholder marker — remove the stale marker");
    }
    const generatedVersion = /Generated .* for version (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\./.exec(raw)?.[1];
    if (!generatedVersion) {
      problem("atlas/bin/cli-checksums: pinned file is missing its generated version header");
    } else if (cliVersion && generatedVersion !== cliVersion) {
      problem(`atlas/bin/cli-checksums: generated for CLI ${generatedVersion}, but cli-version is ${cliVersion}`);
    }
  }
}

// ── plugin version + changelog consistency ─────────────────────────────────
if (manifestVersions.length > 0) {
  const pluginVersion = manifestVersions[0]!.version;
  for (const { relPath, version } of manifestVersions.slice(1)) {
    if (version !== pluginVersion) {
      problem(`${relPath}: version ${version} != plugin version ${pluginVersion} — all plugin manifests ship together`);
    }
  }
  const changelogPath = join(ROOT, "atlas/CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    problem("atlas/CHANGELOG.md: file missing");
  } else {
    const latestVersion = /^##\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/m.exec(
      readFileSync(changelogPath, "utf8"),
    )?.[1];
    if (!latestVersion) {
      problem("atlas/CHANGELOG.md: no semver release heading found");
    } else if (latestVersion !== pluginVersion) {
      problem(`atlas/CHANGELOG.md: latest release ${latestVersion} != plugin manifest version ${pluginVersion}`);
    }
  }

  const installContracts = [
    {
      relPath: "README.md",
      markers: [
        `/plugin marketplace add Palisades-Labs/atlas-agent-plugins@atlas--v${pluginVersion}`,
        `codex plugin marketplace add Palisades-Labs/atlas-agent-plugins --ref atlas--v${pluginVersion}`,
        `atlas--v${pluginVersion}`,
      ],
    },
    {
      relPath: "GETTING_STARTED.md",
      markers: [
        `/plugin marketplace add Palisades-Labs/atlas-agent-plugins@atlas--v${pluginVersion}`,
        `codex plugin marketplace add Palisades-Labs/atlas-agent-plugins --ref atlas--v${pluginVersion}`,
        `git clone --branch atlas--v${pluginVersion} --depth 1 https://github.com/Palisades-Labs/atlas-agent-plugins.git`,
      ],
    },
  ];
  for (const { relPath, markers } of installContracts) {
    const path = join(ROOT, relPath);
    if (!existsSync(path)) {
      problem(`${relPath}: file missing`);
      continue;
    }
    const contents = readFileSync(path, "utf8");
    for (const marker of markers) {
      if (!contents.includes(marker)) {
        problem(
          `${relPath}: production install instructions must pin immutable plugin tag atlas--v${pluginVersion}; missing ${JSON.stringify(marker)}`,
        );
      }
    }
    for (const mutableCommand of [
      /^\/plugin marketplace add Palisades-Labs\/atlas-agent-plugins\s*$/m,
      /^codex plugin marketplace add Palisades-Labs\/atlas-agent-plugins\s*$/m,
      /^git clone https:\/\/github\.com\/Palisades-Labs\/atlas-agent-plugins\.git\s*$/m,
    ]) {
      if (mutableCommand.test(contents)) {
        problem(`${relPath}: mutable default-branch production install instruction is forbidden`);
      }
    }
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error(`validate-manifests: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("validate-manifests: OK (Claude/Codex/Cursor manifests, MCP wiring, marketplaces, changelog, launcher Sigstore policy + pins)");
