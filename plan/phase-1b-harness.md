# Phase 1b Plan — The Harness (AgentRuntime)

Status: APPROVED (grilled 2026-09-07 — user: (d)/yes/yes/yes/yes/internal-website/one-cap/no-criterion-question)
Next phase: execution

## Thesis

eigenEnterprise IS the harness — but "harness" is internal vocabulary. Externally:
the website is the company. The harness powers and builds the website; nobody
has to know it exists.

## Kernel primitive

`AgentRuntime` (src/lib/kernel/agent-runtime.ts) + `LoopEngine` interface:
- **Harness provides** (never reimplemented per agent): sessions, tool surface
  (registry ∩ module activation ∩ agent scope), approvals, scoped memory access,
  event stream, spend cap enforcement, verification hooks, activity feed
- **Harness never touches**: model choice, prompts, reasoning strategy, stop conditions
- `AgentConfig`: { id (= principal id), personaName, description, loopEngine,
  toolScope, memoryScope, verificationPolicy, spendCapUsd, enabled }
- `LoopEngine` implementations: `builtin-json` (orchestrator's protocol, extracted),
  `pi` (from dev-agent's runner); engines are hosted code; hermes/opencode stay
  external MCP clients
- Spend cap: single cap on the harness agent itself (no granular per-agent limits
  for now); enforced in the runtime against gateway-cost accumulation, fail loud
- Sessions: in-memory v0 (documented debt); events: agent.dispatched/replied/
  stopped/budget_exceeded

## Demotions / migrations (the point of the whole exercise)

1. Orchestrator brain → `BuiltinJsonLoop` engine; orchestrator = seeded AgentConfig,
   zero code privilege
2. dev-agent's pi spawn → `PiEngine`; dev-agent keeps sandbox/merge governance
   (its domain) but stops owning spawning
3. New agent = config object; inherits permissions/approvals/memory/events/
   verification — no new code

## Module contract extension (additive, optional)

ModuleManifest gains `agents?: AgentTypeSpec[]` and `verification?: Policy[]`.
memory/email untouched; third parties can ship agents, not just tools.

## Acceptance (informal, not ceremonial)

Adding a company agent = config + zero new code, full harness inherited.
Deleting/replacing the orchestrator requires no kernel changes.

## Workstreams

- `wt/harness`: AgentRuntime + LoopEngine + BuiltinJsonLoop extraction +
  orchestrator-as-config + manifest fields + tests
- `wt/pi-engine`: PiEngine extraction; dev-agent consumes runtime budget/events
  (NO modules/index.ts edits — orchestrator wires at integration)
