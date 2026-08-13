import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type CliPinState = "bootstrap" | "pinned";

export interface CliPinPolicy {
  schemaVersion: 1;
  state: CliPinState;
}

export class CliPinPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliPinPolicyError";
  }
}

export function parseCliPinPolicy(raw: string): CliPinPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliPinPolicyError("cli-pin-policy.json is not valid JSON");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) {
    throw new CliPinPolicyError("cli-pin-policy.json must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2
    || keys[0] !== "schemaVersion"
    || keys[1] !== "state"
  ) {
    throw new CliPinPolicyError(
      "cli-pin-policy.json must contain exactly schemaVersion and state",
    );
  }
  if (record.schemaVersion !== 1) {
    throw new CliPinPolicyError(
      "cli-pin-policy.json schemaVersion must equal 1",
    );
  }
  if (record.state !== "bootstrap" && record.state !== "pinned") {
    throw new CliPinPolicyError(
      "cli-pin-policy.json state must be bootstrap or pinned",
    );
  }
  return {
    schemaVersion: 1,
    state: record.state,
  };
}

export function readCliPinPolicy(root: string): CliPinPolicy {
  return parseCliPinPolicy(
    readFileSync(join(root, "atlas/bin/cli-pin-policy.json"), "utf8"),
  );
}

export function transitionCliPinPolicy(
  root: string,
  target: CliPinState,
): CliPinPolicy {
  const absoluteRoot = resolve(root);
  const path = join(absoluteRoot, "atlas/bin/cli-pin-policy.json");
  const current = readCliPinPolicy(absoluteRoot);
  if (target === "bootstrap") {
    throw new CliPinPolicyError(
      "cli pin policy cannot transition back to bootstrap",
    );
  }
  if (current.state === target) return current;

  const next: CliPinPolicy = { schemaVersion: 1, state: target };
  const temporary = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return next;
}

function main(): void {
  const [target, rootArg, extra] = process.argv.slice(2);
  if (
    extra !== undefined
    || target !== "pinned"
  ) {
    console.error(
      "usage: bun scripts/cli-pin-policy.ts pinned [distribution-root]",
    );
    process.exit(2);
  }
  const root = rootArg
    ? resolve(rootArg)
    : resolve(import.meta.dir, "..");
  const policy = transitionCliPinPolicy(root, target);
  console.log(
    `cli-pin-policy: ${policy.state} (${join(root, "atlas/bin/cli-pin-policy.json")})`,
  );
}

if (import.meta.main) main();
