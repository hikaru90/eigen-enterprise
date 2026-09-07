# Phase-0 Plan — eigenEnterprise Kernel Skeleton

Status: APPROVED (grilled & consolidated, 2026-09-07)
Next phase: execution

## Goal

`eigenEnterprise` repo, booted like eigen (compose: app + Postgres/pgvector/AGE), with the kernel proven end-to-end: one action registry driving MCP + OpenAPI, principals incl. agents, append-only events, three activated modules, and the orchestrator answering via Telegram — every action permitted, approved, audited, git-committed.

## Thesis (context)

The website is the company. One self-hostable, single-tenant web app (SvelteKit + Postgres 16 with pgvector + Apache AGE + VPS volume) that *is* a company — public face, internal console, agent-native core in one artifact. Customer zero: Kindred Digital Labs. OSS (Apache-2.0), paid cloud later. eigen/eigenmesh continues as the personal memory product.

## Seed

- New git repo at `/Users/alexanderbuckner/+Code/eigenEnterprise` from eigen's tree (no history), Apache-2.0, new README
- **Strip:** `billing/` (PayPal/wallet; keep `llm/gateway-cost`), eigenmesh branding + `eigenmesh-thoughts.csv` + deploy specifics, PWA/service-worker
- **Keep:** db, auth, api-keys, llm, agent-loop, job-queue, scheduled-tasks, mcp, memory/graph/retrieval, ontology, activity, owlery client, observability, paraglide, tests/lint tooling

## Kernel (`src/lib/kernel/`)

1. `registry.ts` — generalizes `server/mcp/registry.ts`; `ToolDescriptor { name, module, summary, inputSchema, permission, auditClass: read|mutate|external, handler }`; `execute()` is the only run path: **permission → approval gate → audit event → git commit**; renders the MCP server + OpenAPI spec. Code outside the registry = legacy on day one.
2. `principals.ts` — `kind: human|agent|service` + roles (owner/admin/member in v0); Better Auth users ↔ principals 1:1; API keys attach to principals; the **orchestrator** = first agent principal (company's general assistant, owner-delegated tool scope in Phase 0).
3. `events.ts` — append-only `kernel_events` + `emit()`; existing activity dual-writes through it. Everything flows through EE — an action outside the stream didn't happen.
4. `modules.ts` — manifest `{ id, name, version, tools[], permissions, settings, migrations }` + `module_activations` table gating tools/routes. Installation in Phase 0 = dev-time: module folder in `modules/`, registered in index, activated via DB row. No runtime hot-loading, ever. No CLI for now (registry still generates OpenAPI; `ee` CLI deferred — nothing needs it yet).
5. `gateway/` + `modules/chat-gateway/` — Telegram via long-polling (bot token from env; no webhook/TLS burden on VPS). Ported hermes gateway concepts (TypeScript, not Python): platform registry, chat↔session mapping, **allowlist** of Telegram user IDs → owner principals (hermes' full pairing dance is overkill for v0), delivery message chunking. Inbound → event → **orchestrator** loop → reply. Zero side doors — all actions via registry tools, so Telegram inherits permissions, approvals, audit for free.
6. `vcs.ts` — auto-commit after `auditClass: mutate` executions; structured commit messages, .gitignore-aware, env-off for dev. The instance is a git repo on the VPS: audit trail, rollback, and history are the same mechanism. Optional off-site remote mirror.
7. Agent service — `llm/agent-loop.ts` + `job-queue` promoted: personas table (orchestrator row seeded), `approvals` table + registry hook; triggers: chat, cron, events. Chat UI stays an interactive loop client (already exists in eigen). LLM middleware: EUrouter-compatible gateway (chat completions + embeddings), per-principal routing + spend tracking (`gateway-cost`). Personas-with-roles come later; Phase 0 = one orchestrator.

## Pilot modules (manifested + activation-proven)

| Module | Source | Phase-0 proof |
|---|---|---|
| `memory` | existing (capture/graph/retrieval) | manifest + activation gating on existing tools |
| `email` | `server/owlery/` client | tools (send mail, add contact) through registry → approval gate → event stream |
| `chat-gateway` | new, hermes-concept port | Telegram bot → message → event → orchestrator → reply |

## Verification

New tests: registry↔MCP↔OpenAPI parity, permission + approval gates, event append-only, activation gating, Telegram allowlist.
Existing `npm test` / `npm run check` / lint stay green.

## Later phases

1. Website module — content objects (pages/docs/posts/processes, one model, kind + visibility private/team/company/public), brand kernel (formalized, deterministic, versioned brand context store; owlery design-system AI as bootstrap), public rendering, contact capture
2. owlery engine internalization — EmailProvider port (built-in SES | external SMTP | API); owlery-the-product lives on standalone
3. Sales — contacts/accounts, deals, capture→lead wiring, memory linkage
4. Agent expansion — personas with roles/scopes/playbooks, constitutional editor, multi-party approvals
5. Accounting — quotes/invoices, E-Rechnung receive (mandatory since 2025) + issue prep, GoBD storage (append-only, hash-chained, checksummed, 10y retention), DATEV export, USt basics; ERPNext (migration `0069_erpnext_invoice_sync`) as schema seed; German tax law verified against current sources at build time
6. kindred.digital dogfood demo — fresh instance → modules → brand bootstrap from current site → content import → contact capture → lead → orchestrator drafts follow-up → approval → sent → team-visible; same action via chat UI and via hermes/MCP

## Accepted tradeoffs (on record)

- Apache-2.0: maximum adoption, zero copyleft protection for the cloud business
- No runtime plugin loading; the manifest is the future plugin contract
- No bookkeeping ledger in EE — compliance-grade documents + DATEV export
- No native desktop/mobile — the browser is the runtime
- No CLI in Phase 0
- Data safety: one Postgres per company; nightly encrypted pg_dump → S3 + volume snapshots + tested restore (WAL/PITR in cloud tier later); Postgres never exposed
