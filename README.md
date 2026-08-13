# Atlas Agent Plugins

Atlas is a prospecting workbench: import lists, find people and companies, enrich them, and export to your CRM. This repo distributes the **atlas** plugin — a CLI, a stdio MCP server, and workflow skills — so coding agents (Claude Code, Codex, Cursor) and humans in a terminal can drive Atlas directly.

Ask your agent to import a CSV or Google Sheet, discover companies similar to a seed list, apply a natural-language filter, run a bounded enrichment sample, or export the result. The bundled skills turn those requests into previewed, resumable Atlas operations; `atlas tools call` remains the escape hatch for every registered MCP tool.

Atlas data is not agent authority: imported cells, CRM fields, provider responses, and web research are untrusted content, never instructions. The bundled workflows prohibit commands, credential disclosure, scope/provider/destination/budget changes, or skipped previews and confirmations based on text found inside that data.

The plugin ships a small POSIX launcher (`atlas/bin/atlas`). On first run it downloads the pinned CLI binary for your platform (macOS/Linux, arm64/x64), verifies both the plugin-pinned and release checksums, and uses `cosign` when available to verify the target-specific keyless Sigstore bundle against Atlas's exact release workflow and tag. It caches the result under `~/.cache/atlas-cli/`; every later invocation rechecks the cached digest before execution.

## Install

| Agent | How |
|---|---|
| **Claude Code** | `/plugin marketplace add Palisades-Labs/atlas-agent-plugins@atlas--v0.1.7` then `/plugin install atlas@atlas-plugins` |
| **Codex** | `codex plugin marketplace add Palisades-Labs/atlas-agent-plugins --ref atlas--v0.1.7` then `codex plugin add atlas@atlas-plugins` |
| **Cursor** | Install the immutable `atlas--v0.1.7` release from Cursor Marketplace once listed; Team/Enterprise admins can import that tagged GitHub release from Dashboard → Plugins |

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

## Learn more

- [GETTING_STARTED.md](GETTING_STARTED.md) — full walkthrough from install to first prospect list.
- [llms.txt](llms.txt) — one-page agent index: tools, auth, exit codes, rate limits.
- `atlas --help` — command and flag reference.
