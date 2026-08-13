import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPackage,
  PACKAGE_PROVENANCE_FILENAME,
  PackageProvenanceError,
  parsePackageProvenance,
  requireCommittedPackageSource,
  serializePackageProvenance,
  type PackageSource,
  verifyPackage,
} from "./package-provenance";

const fixtures = new Set<string>();
const SOURCE: PackageSource = {
  repository: "https://github.com/example/source-repository",
  ref: "refs/heads/main",
  sha: "a".repeat(40),
  subdirectory: "package",
  treeSha: "c".repeat(40),
};

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

function sourceFixture(): string {
  const root = temp("atlas-package-provenance-");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "README.md"), "Atlas\n");
  writeFileSync(join(root, "bin/atlas"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "bin/atlas"), 0o755);
  writeFileSync(join(root, "docs/z-last.md"), "last\n");
  writeFileSync(join(root, "docs/a-first.md"), "first\n");
  writeFileSync(join(root, "STAGING.md"), "private\n");
  return root;
}

function materializeDistribution(
  sourceRoot: string,
  destination: string,
  source: PackageSource = SOURCE,
): ReturnType<typeof buildPackage> {
  const built = buildPackage(sourceRoot, source);
  mkdirSync(destination, { recursive: true });
  for (const entry of built.entries) {
    const path = join(destination, ...entry.path.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, entry.contents, {
      mode: Number.parseInt(entry.mode, 8),
    });
    chmodSync(path, Number.parseInt(entry.mode, 8));
  }
  writeFileSync(
    join(destination, PACKAGE_PROVENANCE_FILENAME),
    built.provenanceBytes,
  );
  return built;
}

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof PackageProvenanceError) return error.code;
    throw error;
  }
  throw new Error("expected PackageProvenanceError");
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

describe("deterministic package provenance", () => {
  test("builds byte-identical provenance and USTAR artifacts twice", () => {
    const root = sourceFixture();
    const first = buildPackage(root, SOURCE);
    const second = buildPackage(root, SOURCE);

    expect(second.provenanceBytes.equals(first.provenanceBytes)).toBe(true);
    expect(second.artifactBytes.equals(first.artifactBytes)).toBe(true);
    expect(second.provenance.package.artifactSha256).toBe(
      first.provenance.package.artifactSha256,
    );
    expect(first.provenance.files.map((file) => file.path)).toEqual([
      "README.md",
      "bin/atlas",
      "docs/a-first.md",
      "docs/z-last.md",
    ]);
    expect(first.provenance.files[1]?.mode).toBe("0755");
    expect(first.provenance.source.subdirectory).toBe("package");
    expect(first.provenance.package.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.provenance.package.treeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("verifies one exact distribution checkout and rejects every drift class", () => {
    const sourceRoot = sourceFixture();
    const distribution = temp("atlas-distribution-");
    const built = materializeDistribution(sourceRoot, distribution);
    const raw = readFileSync(
      join(distribution, PACKAGE_PROVENANCE_FILENAME),
      "utf8",
    );
    expect(verifyPackage(distribution, raw)).toEqual(built.provenance);

    writeFileSync(join(distribution, "README.md"), "tampered\n");
    expect(code(() => verifyPackage(distribution, raw))).toBe(
      "file_manifest_mismatch",
    );
    writeFileSync(join(distribution, "README.md"), "Atlas\n");

    writeFileSync(join(distribution, "extra.txt"), "extra\n");
    expect(code(() => verifyPackage(distribution, raw))).toBe(
      "file_manifest_mismatch",
    );
    rmSync(join(distribution, "extra.txt"));

    chmodSync(join(distribution, "bin/atlas"), 0o644);
    expect(code(() => verifyPackage(distribution, raw))).toBe(
      "file_manifest_mismatch",
    );
  });

  test("rejects private staging metadata and noncanonical or extensible provenance", () => {
    const sourceRoot = sourceFixture();
    const distribution = temp("atlas-distribution-");
    const built = materializeDistribution(sourceRoot, distribution);
    const canonical = built.provenanceBytes.toString("utf8");

    writeFileSync(join(distribution, "STAGING.md"), "must not ship\n");
    expect(code(() => verifyPackage(distribution, canonical))).toBe(
      "private_metadata_present",
    );
    rmSync(join(distribution, "STAGING.md"));

    const extended = {
      ...JSON.parse(canonical),
      allowMismatch: true,
    };
    expect(code(() => parsePackageProvenance(JSON.stringify(extended)))).toBe(
      "invalid_provenance_schema",
    );
    expect(
      code(() =>
        verifyPackage(
          distribution,
          JSON.stringify(built.provenance),
        )
      ),
    ).toBe("noncanonical_provenance");

    for (const mutate of [
      (value: Record<string, any>) => {
        value.package.fileCount += 1;
      },
      (value: Record<string, any>) => {
        value.package.contentBytes += 1;
      },
      (value: Record<string, any>) => {
        value.package.artifactBytes += 1;
      },
      (value: Record<string, any>) => {
        value.package.treeSha256 = "f".repeat(64);
      },
    ]) {
      const invalid = JSON.parse(canonical) as Record<string, any>;
      mutate(invalid);
      expect(code(() => parsePackageProvenance(JSON.stringify(invalid)))).toBe(
        "invalid_provenance_schema",
      );
    }
  });

  test("rejects credential-bearing repository URLs and unsafe refs or subdirectories", () => {
    for (const source of [
      { ...SOURCE, repository: "https://token@github.com/example/repo" },
      { ...SOURCE, repository: "https://github.com/example/repo?token=x" },
      { ...SOURCE, ref: "main" },
      { ...SOURCE, ref: "refs/heads/../main" },
      { ...SOURCE, subdirectory: "../package" },
    ]) {
      expect(() => buildPackage(sourceFixture(), source)).toThrow(
        PackageProvenanceError,
      );
    }
    const built = buildPackage(sourceFixture(), SOURCE);
    const unsafe = JSON.parse(
      built.provenanceBytes.toString("utf8"),
    ) as Record<string, any>;
    unsafe.files[0].path = "unsafe\npath";
    expect(code(() => parsePackageProvenance(JSON.stringify(unsafe)))).toBe(
      "unsafe_package_path",
    );
  });

  test("binds preparation metadata to a clean Git ref, SHA, origin, and subtree", () => {
    const repository = temp("atlas-provenance-git-");
    git(repository, "init", "-b", "main");
    git(
      repository,
      "remote",
      "add",
      "origin",
      "https://github.com/example/source-repository.git",
    );
    const packageRoot = join(repository, "package");
    mkdirSync(packageRoot);
    writeFileSync(join(packageRoot, "README.md"), "approved\n");
    git(repository, "add", "package/README.md");
    git(
      repository,
      "-c",
      "user.name=Atlas Test",
      "-c",
      "user.email=atlas@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "seed",
    );
    const sha = git(repository, "rev-parse", "HEAD");
    const treeSha = git(repository, "rev-parse", "HEAD:package");
    const source = { ...SOURCE, sha, treeSha };
    expect(requireCommittedPackageSource(packageRoot, source)).toEqual(source);

    writeFileSync(join(packageRoot, "README.md"), "dirty\n");
    expect(code(() => requireCommittedPackageSource(packageRoot, source))).toBe(
      "dirty_source",
    );
  });

  test("round-trips the canonical strict document", () => {
    const built = buildPackage(sourceFixture(), SOURCE);
    const parsed = parsePackageProvenance(
      built.provenanceBytes.toString("utf8"),
    );
    expect(serializePackageProvenance(parsed).equals(built.provenanceBytes)).toBe(
      true,
    );
  });
});
