#!/usr/bin/env bun
/**
 * Deterministic Atlas distribution package builder and verifier.
 *
 * The provenance document is a sidecar, not an archive member. That avoids a
 * self-referential digest while still letting a reviewed distribution commit
 * bind every other path, mode, byte, and the exact reproducible USTAR artifact.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const PACKAGE_PROVENANCE_SCHEMA = "atlas-package-provenance/v1";
export const PACKAGE_PROVENANCE_FILENAME = "PACKAGE_PROVENANCE.json";
export const PACKAGE_ARTIFACT_FILENAME = "atlas-agent-plugins.tar";
const PRIVATE_METADATA_FILENAME = "STAGING.md";
const TAR_BLOCK_BYTES = 512;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_GITHUB_PART = /^[A-Za-z0-9_.-]+$/;

export interface PackageSource {
  repository: string;
  ref: string;
  sha: string;
  subdirectory: string;
  treeSha: string;
}

export interface PackageFileRecord {
  path: string;
  mode: "0644" | "0755";
  size: number;
  sha256: string;
}

export interface PackageProvenance {
  schemaVersion: typeof PACKAGE_PROVENANCE_SCHEMA;
  source: PackageSource;
  package: {
    format: "ustar";
    fileCount: number;
    contentBytes: number;
    artifactBytes: number;
    contentSha256: string;
    treeSha256: string;
    artifactSha256: string;
  };
  files: PackageFileRecord[];
}

export interface PackagePayloadEntry extends PackageFileRecord {
  contents: Buffer;
}

export interface BuiltPackage {
  provenance: PackageProvenance;
  provenanceBytes: Buffer;
  artifactBytes: Buffer;
  entries: PackagePayloadEntry[];
}

export class PackageProvenanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "PackageProvenanceError";
  }
}

function fail(code: string, message: string): never {
  throw new PackageProvenanceError(code, message);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(
      "invalid_provenance_schema",
      `${label} must contain exactly ${sortedExpected.join(", ")}`,
    );
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid_provenance_schema", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function normalizePackageSource(source: PackageSource): PackageSource {
  let repository: URL;
  try {
    repository = new URL(source.repository);
  } catch {
    fail("invalid_source_repository", "source repository must be a URL");
  }
  if (
    repository.protocol !== "https:"
    || repository.hostname !== "github.com"
    || repository.username
    || repository.password
    || repository.search
    || repository.hash
  ) {
    fail(
      "invalid_source_repository",
      "source repository must be a credential-free https://github.com URL",
    );
  }
  const parts = repository.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (
    parts.length !== 2
    || parts.some((part) => !SAFE_GITHUB_PART.test(part))
  ) {
    fail(
      "invalid_source_repository",
      "source repository must identify one GitHub owner and repository",
    );
  }
  const normalizedRepository = `https://github.com/${parts[0]}/${parts[1]}`;

  if (
    !/^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(source.ref)
    || source.ref.includes("..")
    || source.ref.includes("//")
    || source.ref.includes("@{")
    || source.ref.endsWith("/")
    || source.ref.endsWith(".")
  ) {
    fail(
      "invalid_source_ref",
      "source ref must be one safe full refs/heads/* or refs/tags/* name",
    );
  }
  if (!GIT_SHA.test(source.sha)) {
    fail(
      "invalid_source_sha",
      "source sha must be one lowercase 40-character Git commit id",
    );
  }
  if (!GIT_SHA.test(source.treeSha)) {
    fail(
      "invalid_source_tree_sha",
      "source tree sha must be one lowercase 40-character Git tree id",
    );
  }
  const subdirectory = source.subdirectory === ""
    ? "."
    : source.subdirectory.split(sep).join("/");
  if (
    subdirectory !== "."
    && (
      subdirectory.startsWith("/")
      || subdirectory.endsWith("/")
      || subdirectory.includes("\\")
      || subdirectory.split("/").some(
        (part) => part === "" || part === "." || part === "..",
      )
    )
  ) {
    fail(
      "invalid_source_subdirectory",
      "source subdirectory must be . or one safe repository-relative path",
    );
  }
  return {
    repository: normalizedRepository,
    ref: source.ref,
    sha: source.sha,
    subdirectory,
    treeSha: source.treeSha,
  };
}

function runGit(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    fail("git_preflight_failed", `git ${args[0]} preflight failed`);
  }
  return result.stdout.toString().trim();
}

export function requireCommittedPackageSource(
  sourceRootArg: string,
  sourceArg: PackageSource,
): PackageSource {
  const sourceRoot = realpathSync(resolve(sourceRootArg));
  const source = normalizePackageSource(sourceArg);
  const top = realpathSync(
    runGit(sourceRoot, ["rev-parse", "--show-toplevel"]),
  );
  const actualSubdirectory = relative(top, sourceRoot).split(sep).join("/") || ".";
  if (actualSubdirectory !== source.subdirectory) {
    fail(
      "source_subdirectory_mismatch",
      "source subdirectory does not identify the package root in this checkout",
    );
  }
  const head = runGit(sourceRoot, ["rev-parse", "HEAD"]);
  if (head !== source.sha) {
    fail("source_sha_mismatch", "source sha does not equal the checked-out HEAD");
  }
  const refCommit = runGit(sourceRoot, [
    "rev-parse",
    "--verify",
    `${source.ref}^{commit}`,
  ]);
  if (refCommit !== source.sha) {
    fail("source_ref_mismatch", "source ref does not resolve to the source sha");
  }
  const treeExpression = source.subdirectory === "."
    ? `${source.sha}^{tree}`
    : `${source.sha}:${source.subdirectory}`;
  const treeSha = runGit(sourceRoot, ["rev-parse", "--verify", treeExpression]);
  if (treeSha !== source.treeSha) {
    fail(
      "source_tree_sha_mismatch",
      "source tree sha does not equal the package subtree at the source commit",
    );
  }
  const remote = runGit(sourceRoot, ["remote", "get-url", "origin"])
    .replace(/\.git$/, "");
  if (remote !== source.repository) {
    fail(
      "source_repository_mismatch",
      "source repository does not equal the credential-free origin URL",
    );
  }
  const status = runGit(top, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    actualSubdirectory,
  ]);
  if (status) {
    fail(
      "dirty_source",
      "source package has tracked or untracked changes; commit the approved tree first",
    );
  }
  return source;
}

function ignoredPath(rel: string): boolean {
  if (rel === PACKAGE_PROVENANCE_FILENAME) return true;
  if (rel === PRIVATE_METADATA_FILENAME) return true;
  return rel
    .split("/")
    .some((part) => part === ".git" || part === "node_modules");
}

function assertSafeRelativePath(rel: string): void {
  if (
    !rel
    || rel.startsWith("/")
    || rel.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(rel)
    || rel.split("/").some((part) => part === "" || part === "." || part === "..")
    || Buffer.byteLength(rel, "utf8") > 255
  ) {
    fail("unsafe_package_path", `unsafe package path ${JSON.stringify(rel)}`);
  }
}

export function collectPackagePayload(rootArg: string): PackagePayloadEntry[] {
  const root = resolve(rootArg);
  const entries: PackagePayloadEntry[] = [];

  const walk = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, item.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (ignoredPath(rel)) continue;
      assertSafeRelativePath(rel);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        fail("symbolic_link", `${rel} is a symbolic link`);
      }
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) {
        fail("unsupported_file_type", `${rel} is not a regular file`);
      }
      const contents = readFileSync(absolute);
      const permissions = stat.mode & 0o777;
      if (permissions !== 0o644 && permissions !== 0o755) {
        fail(
          "invalid_package_mode",
          `${rel} mode must be exactly 0644 or 0755`,
        );
      }
      entries.push({
        path: rel,
        mode: permissions === 0o644 ? "0644" : "0755",
        size: contents.byteLength,
        sha256: sha256(contents),
        contents,
      });
    }
  };

  walk(root);
  entries.sort((left, right) => comparePath(left.path, right.path));
  return entries;
}

function framedContentDigest(entries: readonly PackagePayloadEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    const path = Buffer.from(entry.path, "utf8");
    const lengths = Buffer.alloc(12);
    lengths.writeUInt32BE(path.byteLength, 0);
    lengths.writeBigUInt64BE(BigInt(entry.contents.byteLength), 4);
    hash.update(lengths);
    hash.update(path);
    hash.update(entry.contents);
  }
  return hash.digest("hex");
}

function tarNameParts(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, "utf8") <= 100) {
    return { name: path, prefix: "" };
  }
  const slashes = [...path.matchAll(/\//g)].map((match) => match.index as number);
  for (let index = slashes.length - 1; index >= 0; index -= 1) {
    const split = slashes[index] as number;
    const prefix = path.slice(0, split);
    const name = path.slice(split + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= 155
      && Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
  }
  fail("tar_path_too_long", `${path} cannot be represented in USTAR`);
}

function writeTarText(
  header: Buffer,
  offset: number,
  width: number,
  value: string,
  label: string,
): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > width) {
    fail("tar_field_too_long", `${label} exceeds its USTAR field`);
  }
  encoded.copy(header, offset);
}

function tarOctal(value: number, width: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_tar_value", `${label} is outside the deterministic USTAR range`);
  }
  const digits = value.toString(8);
  if (digits.length > width - 1) {
    fail("invalid_tar_value", `${label} is too large for deterministic USTAR`);
  }
  return `${digits.padStart(width - 1, "0")}\0`;
}

export function createDeterministicTar(
  entries: readonly PackagePayloadEntry[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const { name, prefix } = tarNameParts(entry.path);
    const header = Buffer.alloc(TAR_BLOCK_BYTES);
    writeTarText(header, 0, 100, name, "path");
    writeTarText(
      header,
      100,
      8,
      tarOctal(Number.parseInt(entry.mode, 8), 8, "mode"),
      "mode",
    );
    writeTarText(header, 108, 8, tarOctal(0, 8, "uid"), "uid");
    writeTarText(header, 116, 8, tarOctal(0, 8, "gid"), "gid");
    writeTarText(
      header,
      124,
      12,
      tarOctal(entry.contents.byteLength, 12, "size"),
      "size",
    );
    writeTarText(header, 136, 12, tarOctal(0, 12, "mtime"), "mtime");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarText(header, 257, 6, "ustar\0", "magic");
    writeTarText(header, 263, 2, "00", "version");
    writeTarText(header, 345, 155, prefix, "path prefix");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeTarText(
      header,
      148,
      8,
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      "checksum",
    );
    chunks.push(header, entry.contents);
    const remainder = entry.contents.byteLength % TAR_BLOCK_BYTES;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(TAR_BLOCK_BYTES - remainder));
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  return Buffer.concat(chunks);
}

function records(entries: readonly PackagePayloadEntry[]): PackageFileRecord[] {
  return entries.map(({ path, mode, size, sha256: digest }) => ({
    path,
    mode,
    size,
    sha256: digest,
  }));
}

export function serializePackageProvenance(
  provenance: PackageProvenance,
): Buffer {
  return Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8");
}

export function buildPackage(
  root: string,
  sourceArg: PackageSource,
): BuiltPackage {
  const source = normalizePackageSource(sourceArg);
  const entries = collectPackagePayload(root);
  if (entries.length === 0) {
    fail("empty_package", "the distribution package contains no files");
  }
  const files = records(entries);
  const treeSha256 = sha256(`${JSON.stringify(files)}\n`);
  const artifactBytes = createDeterministicTar(entries);
  const provenance: PackageProvenance = {
    schemaVersion: PACKAGE_PROVENANCE_SCHEMA,
    source,
    package: {
      format: "ustar",
      fileCount: files.length,
      contentBytes: entries.reduce((total, entry) => total + entry.size, 0),
      artifactBytes: artifactBytes.byteLength,
      contentSha256: framedContentDigest(entries),
      treeSha256,
      artifactSha256: sha256(artifactBytes),
    },
    files,
  };
  return {
    provenance,
    provenanceBytes: serializePackageProvenance(provenance),
    artifactBytes,
    entries,
  };
}

export function parsePackageProvenance(raw: string): PackageProvenance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("invalid_provenance_json", "package provenance is not valid JSON");
  }
  const top = asRecord(parsed, "provenance");
  assertExactKeys(top, ["schemaVersion", "source", "package", "files"], "provenance");
  if (top.schemaVersion !== PACKAGE_PROVENANCE_SCHEMA) {
    fail(
      "invalid_provenance_schema",
      `schemaVersion must equal ${PACKAGE_PROVENANCE_SCHEMA}`,
    );
  }

  const sourceRecord = asRecord(top.source, "source");
  assertExactKeys(
    sourceRecord,
    ["repository", "ref", "sha", "subdirectory", "treeSha"],
    "source",
  );
  if (
    typeof sourceRecord.repository !== "string"
    || typeof sourceRecord.ref !== "string"
    || typeof sourceRecord.sha !== "string"
    || typeof sourceRecord.subdirectory !== "string"
    || typeof sourceRecord.treeSha !== "string"
  ) {
    fail("invalid_provenance_schema", "source fields must be strings");
  }
  const source = normalizePackageSource(sourceRecord as unknown as PackageSource);

  const packageRecord = asRecord(top.package, "package");
  assertExactKeys(
    packageRecord,
    [
      "format",
      "fileCount",
      "contentBytes",
      "artifactBytes",
      "contentSha256",
      "treeSha256",
      "artifactSha256",
    ],
    "package",
  );
  if (packageRecord.format !== "ustar") {
    fail("invalid_provenance_schema", "package format must equal ustar");
  }
  for (const field of ["fileCount", "contentBytes", "artifactBytes"] as const) {
    if (
      !Number.isSafeInteger(packageRecord[field])
      || (packageRecord[field] as number) < 0
    ) {
      fail("invalid_provenance_schema", `package.${field} must be a nonnegative integer`);
    }
  }
  for (
    const field of ["contentSha256", "treeSha256", "artifactSha256"] as const
  ) {
    if (
      typeof packageRecord[field] !== "string"
      || !SHA256.test(packageRecord[field] as string)
    ) {
      fail("invalid_provenance_schema", `package.${field} must be lowercase SHA-256`);
    }
  }

  if (!Array.isArray(top.files) || top.files.length === 0) {
    fail("invalid_provenance_schema", "files must be a nonempty array");
  }
  const files: PackageFileRecord[] = top.files.map((value, index) => {
    const file = asRecord(value, `files[${index}]`);
    assertExactKeys(file, ["path", "mode", "size", "sha256"], `files[${index}]`);
    if (typeof file.path !== "string") {
      fail("invalid_provenance_schema", `files[${index}].path must be a string`);
    }
    assertSafeRelativePath(file.path);
    if (file.mode !== "0644" && file.mode !== "0755") {
      fail("invalid_provenance_schema", `files[${index}].mode must be 0644 or 0755`);
    }
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) {
      fail("invalid_provenance_schema", `files[${index}].size must be nonnegative`);
    }
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      fail("invalid_provenance_schema", `files[${index}].sha256 must be lowercase SHA-256`);
    }
    return {
      path: file.path,
      mode: file.mode,
      size: file.size as number,
      sha256: file.sha256,
    };
  });
  for (let index = 1; index < files.length; index += 1) {
    if (comparePath(files[index - 1]!.path, files[index]!.path) >= 0) {
      fail(
        "noncanonical_file_manifest",
        "file manifest paths must be unique and bytewise sorted",
      );
    }
  }
  if (packageRecord.fileCount !== files.length) {
    fail(
      "invalid_provenance_schema",
      "package.fileCount must equal the canonical file manifest length",
    );
  }
  if (
    packageRecord.contentBytes
    !== files.reduce((total, file) => total + file.size, 0)
  ) {
    fail(
      "invalid_provenance_schema",
      "package.contentBytes must equal the canonical file manifest total",
    );
  }
  if (
    packageRecord.artifactBytes < TAR_BLOCK_BYTES * 2
    || packageRecord.artifactBytes % TAR_BLOCK_BYTES !== 0
  ) {
    fail(
      "invalid_provenance_schema",
      "package.artifactBytes must be one complete deterministic USTAR size",
    );
  }
  if (packageRecord.treeSha256 !== sha256(`${JSON.stringify(files)}\n`)) {
    fail(
      "invalid_provenance_schema",
      "package.treeSha256 must bind the canonical file manifest",
    );
  }

  return {
    schemaVersion: PACKAGE_PROVENANCE_SCHEMA,
    source,
    package: {
      format: "ustar",
      fileCount: packageRecord.fileCount as number,
      contentBytes: packageRecord.contentBytes as number,
      artifactBytes: packageRecord.artifactBytes as number,
      contentSha256: packageRecord.contentSha256 as string,
      treeSha256: packageRecord.treeSha256 as string,
      artifactSha256: packageRecord.artifactSha256 as string,
    },
    files,
  };
}

export function verifyPackage(
  rootArg: string,
  provenanceRaw: string,
): PackageProvenance {
  const root = resolve(rootArg);
  if (existsSync(join(root, PRIVATE_METADATA_FILENAME))) {
    fail(
      "private_metadata_present",
      `${PRIVATE_METADATA_FILENAME} must not exist in a distribution checkout`,
    );
  }
  const provenance = parsePackageProvenance(provenanceRaw);
  const canonical = serializePackageProvenance(provenance);
  if (!canonical.equals(Buffer.from(provenanceRaw, "utf8"))) {
    fail(
      "noncanonical_provenance",
      "package provenance must use the canonical generated representation",
    );
  }
  const rebuilt = buildPackage(root, provenance.source);
  if (
    JSON.stringify(rebuilt.provenance.files) !== JSON.stringify(provenance.files)
  ) {
    fail(
      "file_manifest_mismatch",
      "distribution checkout paths, modes, sizes, or content digests differ from provenance",
    );
  }
  if (
    JSON.stringify(rebuilt.provenance.package)
    !== JSON.stringify(provenance.package)
  ) {
    fail(
      "package_digest_mismatch",
      "distribution checkout content, tree, or artifact digest differs from provenance",
    );
  }
  return provenance;
}

function parseCli(argv: string[]): {
  command: "build" | "verify";
  values: Map<string, string>;
} {
  const command = argv[0];
  if (command !== "build" && command !== "verify") {
    fail(
      "invalid_arguments",
      "usage: package-provenance.ts build|verify [options]",
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("invalid_arguments", "every package provenance option requires one value");
    }
    if (values.has(flag)) {
      fail("invalid_arguments", `duplicate option ${flag}`);
    }
    values.set(flag, value);
  }
  const allowed = command === "build"
    ? new Set([
      "--root",
      "--out",
      "--source-repository",
      "--source-ref",
      "--source-sha",
      "--source-subdirectory",
      "--source-tree-sha",
    ])
    : new Set(["--root", "--provenance"]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) fail("invalid_arguments", `unknown option ${flag}`);
  }
  return { command, values };
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) fail("invalid_arguments", `missing ${flag}`);
  return value;
}

function writeNewFile(path: string, contents: Buffer): void {
  writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
}

function main(): void {
  const { command, values } = parseCli(process.argv.slice(2));
  const root = resolve(required(values, "--root"));
  if (command === "verify") {
    const provenancePath = resolve(required(values, "--provenance"));
    if (provenancePath !== join(root, PACKAGE_PROVENANCE_FILENAME)) {
      fail(
        "unexpected_provenance_path",
        `verification must use ${PACKAGE_PROVENANCE_FILENAME} from the checkout root`,
      );
    }
    const provenance = verifyPackage(
      root,
      readFileSync(provenancePath, "utf8"),
    );
    console.log(
      `package-provenance: OK (${provenance.package.treeSha256})`,
    );
    return;
  }

  const output = resolve(required(values, "--out"));
  if (output === root || relative(root, output).split(sep)[0] !== "..") {
    fail("unsafe_output_path", "package output must be outside the source root");
  }
  if (existsSync(output)) {
    fail("output_exists", "package output directory already exists");
  }
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output, { mode: 0o700 });
  const source = requireCommittedPackageSource(root, {
    repository: required(values, "--source-repository"),
    ref: required(values, "--source-ref"),
    sha: required(values, "--source-sha"),
    subdirectory: required(values, "--source-subdirectory"),
    treeSha: required(values, "--source-tree-sha"),
  });
  const built = buildPackage(root, source);
  writeNewFile(join(output, PACKAGE_ARTIFACT_FILENAME), built.artifactBytes);
  writeNewFile(
    join(output, PACKAGE_PROVENANCE_FILENAME),
    built.provenanceBytes,
  );
  console.log(
    `package-provenance: built ${built.provenance.package.fileCount} files (${built.provenance.package.treeSha256})`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const code = error instanceof PackageProvenanceError
      ? error.code
      : "unexpected_error";
    console.error(`package-provenance: failed (${code})`);
    process.exit(1);
  }
}
