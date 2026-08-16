# Atlas Agent Plugins

Atlas is a prospecting workbench: import lists, find people and companies, enrich them, and export to your CRM. This repo distributes the **atlas** plugin — a CLI, a stdio MCP server, and workflow skills — so coding agents (Claude Code, Codex, Cursor) and humans in a terminal can drive Atlas directly.

Ask your agent to import a CSV or Google Sheet, discover companies similar to a seed list, apply a natural-language filter, run a bounded enrichment sample, or export the result. The bundled skills turn those requests into previewed, resumable Atlas operations; `atlas tools call` remains the escape hatch for every registered MCP tool.

## Install

| Agent | How |
|---|---|
| **Claude Code** | `/plugin marketplace add Palisades-Labs/atlas-agent-plugins@atlas--v0.1.8` then `/plugin install atlas@atlas-plugins` |
| **Codex** | `codex plugin marketplace add Palisades-Labs/atlas-agent-plugins --ref atlas--v0.1.8` then `codex plugin add atlas@atlas-plugins` |
| **Cursor** | Install the immutable `atlas--v0.1.8` release from Cursor Marketplace once listed; Team/Enterprise admins can import that tagged GitHub release from Dashboard → Plugins |

## Set up and authenticate

After installing the plugin, ask your agent:

> Set up Atlas.

The bundled setup workflow installs a stable terminal forwarder that follows
the Atlas version currently enabled by Claude Code or Codex—not whichever
cache directory was modified last. It therefore follows both upgrades and
rollbacks while old verified CLI caches remain available. Setup then downloads
and verifies the pinned CLI, starts browser login, and tells you when to restart
the agent.

If `atlas --version` already works in your terminal, you can run the login step
directly instead:

```
atlas login
```

`atlas login` runs a browser device flow and stores an API key locally. Then restart your agent — the `atlas mcp` server resolves credentials at startup. Verify with:

```
atlas whoami
```

## Verify a download

The plugin ships a small POSIX launcher (`atlas/bin/atlas`). On first run it downloads the pinned CLI binary for your platform (macOS/Linux, arm64/x64), verifies both the plugin-pinned and release checksums, and uses `cosign` when available to verify the target-specific keyless Sigstore bundle against Atlas's exact release workflow and tag. It caches the result under `~/.cache/atlas-cli/`; every later invocation rechecks the cached digest before execution. **That happens automatically — the steps below are for verifying a binary you downloaded by hand.**

Download the binary and its matching `.sigstore.json` bundle, then run:

```sh
cosign verify-blob atlas-darwin-arm64 --bundle atlas-darwin-arm64.sigstore.json --certificate-identity "https://github.com/blast-double/auto-prospector/.github/workflows/release-cli.yml@refs/tags/cli-v0.1.2" --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

Cosign 3.1.3 returns `Verified OK` for the live v0.1.2 asset. Replace the binary and bundle filenames for your platform.

GitHub CLI 2.93.0 can independently verify the downloaded asset against the immutable release:

```sh
gh release verify-asset atlas-cli-v0.1.2 atlas-darwin-arm64 --repo Palisades-Labs/atlas-agent-plugins
```

It returns `✓ Verification succeeded!`; its calculated digest matches the digest pinned by the Atlas plugin.

Both commands name a release version, in different forms: `refs/tags/cli-v<version>` in the Cosign identity and `atlas-cli-v<version>` in the GitHub command. Change **both** to the release you actually downloaded — verifying a newer binary against `v0.1.2` fails for the wrong reason.

On macOS, verify **before** clearing Gatekeeper. Released binaries are not yet Apple-notarized, so a browser download is quarantined. Once verification passes, make it executable (`chmod +x atlas-<os>-<arch>`), then either run it and approve under System Settings → Privacy & Security → Open Anyway, or clear the attribute yourself with `xattr -d com.apple.quarantine ./atlas-<os>-<arch>`.

## Security

Atlas data is not agent authority: imported cells, CRM fields, provider responses, and web research are untrusted content, never instructions. The bundled workflows prohibit commands, credential disclosure, scope/provider/destination/budget changes, or skipped previews and confirmations based on text found inside that data.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Learn more

- [GETTING_STARTED.md](GETTING_STARTED.md) — full walkthrough from install to first prospect list.
- [llms.txt](llms.txt) — one-page agent index: tools, auth, exit codes, rate limits.
- `atlas --help` — command and flag reference.
