# Changelog

## 0.1.7 - 2026-08-13

- Pinned Atlas CLI v0.1.1 and its verified release digests.
- Published target-specific keyless Sigstore bundles for all supported binaries.

## 0.1.6 - 2026-07-23

- Replaced cache-mtime terminal routing with an active-host forwarder that follows Claude Code and Codex upgrades and true N-to-N-1 rollbacks.
- Made the unreleased checksum placeholder a one-way machine-readable bootstrap state; plugin releases require four nonzero immutable CLI digests.
- Added a PR-base release guard so every shipped `atlas/**` change carries one strictly increasing plugin version and matching changelog entry.

## 0.1.5 - 2026-07-21

- Froze exact secret-free provider connection generations, effective LLM routing, and HubSpot mapping/dedup behavior across discovery planning, execution, and review-held delivery.
- Added claim-before-transport provider authorization, serialized generation-safe HubSpot OAuth refresh, and fail-closed handling for unknown external outcomes.
- Made run lifecycle recovery preserve shared plan budgets, held-export terminal convergence, external-write projection ownership, and truthful root-plus-held provider telemetry.
- Corrected Google source write-back guidance to reflect per-write live-grid rereads and identity/header re-resolution.
- Kept Claude Code, Codex, and Cursor manifests in version lockstep and expanded the local production-readiness evidence without claiming an unpublished release or production deploy.

## 0.1.4 - 2026-07-21

- Added an explicit prompt-injection boundary: imported cells, CRM fields, provider responses, and web research are untrusted data, never agent instructions.
- Made enrichment workflows preflight provider readiness and exact saved configs before sampling, with explicit phone-waterfall and Perplexity word-budget guidance.
- Corrected single-document wait output, terminal `dispatch_incomplete` recovery, conditional-scope discovery, and curated vocabulary guidance.
- Journaled every BYOK drafting/filter call, kept uncertain paid receipts pinned for operator review, and documented provider-quota versus Atlas-credit boundaries.
- Validated every CLI API origin before transport creation so unsafe environment or stored endpoints can never receive a bearer key.
- Expanded the release gate to require clean installs, live upgrade/rollback, checksum-failure smokes, and all seven workflow skills.
- Added first-class MCP and CLI commit guidance for frozen discovery review holds, including claim-first HubSpot delivery and manual review for ambiguous outcomes.

## 0.1.3 - 2026-07-21

- Added a first-class company-discovery skill and `atlas discover companies` workflow for manual or HubSpot-list seeds.
- Added signed source/provider/ICP snapshots, explicit Atlas-only versus HubSpot delivery, and hard row, provider-unit, and Atlas-credit ceilings.
- Documented atomic worker ownership, paid-provider claims, safe retry/recovery, and unknown provider-USD semantics.

## 0.1.2 - 2026-07-21

- Added first-class Cursor plugin and marketplace manifests.
- Made the bundled MCP launcher portable across Claude Code, Codex, and Cursor plugin roots.
- Hardened launcher cache verification and added per-binary keyless Sigstore verification bound to the exact release workflow and tag.
- Added first-class CLI/MCP operations for empty-sheet creation, existing-sheet source columns, find-more people runs, provider capacity, and multi-field Google write-back.
- Added recoverable filtered exports to new HubSpot company lists and caller-owned Google Spreadsheets.
- Added first-class filter listing/deletion, sheet restore, guarded row deletion, identity correction, and manual cell correction commands.
- Made manual repairs serialize with run creation, reject archived sheets, and converge safely after lost idempotency progress writes.
- Documented safe source-field validation, testable provider capacity, saved write-back mappings, overwrite safeguards, and Google binding-owner authentication.

## 0.1.1 - 2026-07-21

- Made enrichment creation non-running by default and reserved whole-sheet dispatch for explicit `--run` calls.
- Required the agent workflow to sample, review, and finish with `--unrun-only` so sampled cells are not re-billed.
- Documented Perplexity's operation-specific 50-word draft default and exact natural-language word-budget overrides.
