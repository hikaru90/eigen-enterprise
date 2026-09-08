# Kernel Open-API Standards — Inter-Module Contract

Status: APPROVED (user, 2026-09-07)
Scope: kernel contract hardening. No schema changes, no new modules.

## Goal

Make the kernel registry the *only* inter-module API, expressed entirely in open standards: JSON Schema contracts, CloudEvents stream, OpenAPI 3.1 at the edge. One source of truth (Zod), multiple standard renderings.

## The standard stack (decided)

| Concern | Standard | Owner file |
|---|---|---|
| Tool input/output contracts | JSON Schema 2020-12 (zod v4 `toJSONSchema`) | `src/lib/kernel/openapi.ts` |
| Inter-module calls | Registry `execute()` only — no transport, no imports | `src/lib/kernel/registry.ts` |
| Event stream envelope | CloudEvents 1.0 (CNCF) adapter | `src/lib/kernel/cloudevents.ts` (new) |
| HTTP surface | OpenAPI 3.1 + RFC 9457 problem+json (errors: later) | `src/lib/kernel/openapi.ts` |
| Agent↔tools | MCP (already rendered from registry) | `src/lib/server/mcp/server.ts` |
| Manifest plugin contract | JSON Schema for `ModuleManifest` (later) | `src/lib/kernel/modules.ts` |
| Agent↔agent federation | A2A — watch only, not adopted | — |

Rejected: gRPC/protobuf (heavy, poor dynamic discovery), direct module imports (side doors), bespoke wire protocol (JSON-RPC 2.0 via MCP already covers the edge).

## Normative rules

1. **Zero side doors.** Module code never imports another module's handlers. Cross-module work goes through `kernelRegistry.execute(name, input, ctx)` so permissions, approvals, audit, and vcs-commit apply universally. (Follow-up: lint/test enforcing no cross-module imports outside the registry.)
2. **Output contracts are advertised and enforced.** `ToolDescriptor.outputSchema?: ZodType`; when set, `execute()` validates the handler result (fail loud: `invalid_output`) and MCP `tools/list` + OpenAPI 200 response advertise the compiled JSON Schema (`io: 'output'`).
3. **Events are CloudEvents-shaped at every boundary.** `toCloudEvent(event, { source })` maps a `KernelEvent` to a spec-compliant CloudEvents 1.0 envelope (`specversion`, `id`, `source`, `type`, `time`, `data`, `principalid` extension). Source is explicit at call sites — no implicit defaults. Event types use reverse-DNS: `com.eigenenterprise.<module>.<event>`.
4. **No DB migration in this round.** The envelope is derived at read/emit boundaries; `kernel_events` columns stay canonical. Old rows map losslessly (id→id, ts→time, type→type, payload→data).
5. Wiring explicit `source` into every `emitKernelEvent` call site (registry audit → tool's module, kernel internals → `com.eigenenterprise:kernel`) is a follow-up on main after both streams merge.

## Workstreams (disjoint file sets)

| Stream | Branch | Files | Proof | Status |
|---|---|---|---|---|
| `output-schema` | `wt/output-schema` | `kernel/types.ts`, `kernel/registry.ts`, `kernel/openapi.ts`, `mcp/server.ts` + their specs | Output validation round-trip; parity test covers outputSchema; advertised in MCP + OpenAPI | ✅ merged `49ae71c` (2026-09-08) |
| `cloud-events` | `wt/cloud-events` | `kernel/events.ts` (types/naming helper only if needed), `kernel/cloudevents.ts` (new) + specs | Envelope conformance tests (required attributes, extension, lossless legacy mapping) | ✅ merged `1585d9b` (2026-09-08) |

Neither stream touches: `db-stores.ts`, `modules/**`, migrations, other modules' emit sites.

## Verification

- TDD; tests first in both streams.
- Scoped vitest green; `npm run check` = 5 documented baseline errors (no new); `npm run lint` = baseline.
- Post-merge on main: kernel suites + parity re-run; progress.md entry.

## Later (tracked, not in this round)

1. problem+json error shape in `kernel/errors.ts` + OpenAPI error responses.
2. Published `module-manifest.schema.json`, validated at `modules/index.ts` registration.
3. `source` wiring at all emit sites (rule 3/5).
4. Cross-module import guard (rule 1).
5. A2A agent cards — only when an agent federation use case exists.
