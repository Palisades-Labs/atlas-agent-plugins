# Distribution release smoke

The release smoke proves the public package, its pinned CLI, and the compatible
Atlas deployment as one credential-redacting acceptance run. It uses temporary
Claude, Codex, Atlas, and CLI-cache roots and removes them after the run. It
never writes raw command output, credentials, durations, or machine-local paths
to evidence.

Run the offline state-machine and evidence-contract fixture first:

```sh
bun scripts/distribution-smoke.ts \
  --mode fixture \
  --evidence-out /tmp/atlas-distribution-smoke-fixture.json
```

For a live release, load `ATLAS_DISTRIBUTION_SMOKE_API_KEY` into the invoking
shell from the approved secret store. Do not put the key in an argument,
transcript, file, or chat. Then run:

```sh
bun scripts/distribution-smoke.ts \
  --mode live \
  --confirm-live \
  --repository-url https://github.com/OWNER/REPOSITORY \
  --n-minus-one-tag atlas--vN_MINUS_ONE \
  --n-tag atlas--vN \
  --cli-release-tag atlas-cli-vCLI_VERSION \
  --signer-identity https://github.com/SOURCE_OWNER/SOURCE_REPOSITORY/.github/workflows/release-cli.yml@refs/tags/cli-vCLI_VERSION \
  --api-origin https://app.example.com \
  --expected-application-sha 40_CHARACTER_LOWERCASE_GIT_SHA \
  --cursor-evidence-sha256 64_CHARACTER_LOWERCASE_SHA256 \
  --evidence-out /secure/release-evidence/atlas-distribution-smoke.json
```

The command fails closed before reading the Atlas key unless both public plugin
tags/releases, the pinned CLI assets, and the exact production application SHA
are available. It then proves clean install, authentication, MCP discovery and
an `atlas_capabilities` call, N-1 → N upgrade, N → N-1 rollback, wrong-checksum
refusal, and explicit Cosign verification for Claude Code and Codex.

Cursor has no equivalent release-test CLI. Test its clean install, auth, MCP
discovery, and capability call manually in an isolated Cursor profile, store a
credential-free transcript, and pass that transcript's SHA-256 as
`--cursor-evidence-sha256`. The resulting JSON records the explicit operator
assertion without embedding the transcript.

Evidence is created atomically with mode `0600` and is never overwritten unless
`--overwrite-evidence` is explicit. Validate consumers against
[`distribution-smoke-evidence.schema.json`](distribution-smoke-evidence.schema.json)
and the stricter ordered-check parser in `scripts/distribution-smoke.ts`.
