# Phase 3 Plan — One Agent (dsh concepts, implemented in-repo)

Status: APPROVED (decided with owner 2026-09-09; amended same day — NO dsh install,
concepts only). Supersedes phase-1b harness direction; sales phase moves later.

## Thesis

One agent instance does everything — talks to the owner, works the repo, runs the
company tools. Implemented **in this repo**, borrowing DeepSeek Harness (dsh)
concepts. No external harness dependency, no pi dependency for the agent itself.
The hand-built multi-agent machinery (AgentRuntime engines, orchestrator brain,
dev-agent module) is absorbed into the one loop.

Owner's words, on record: "We need one agent that does all. One instance which
handles the system, modules, approvals." — "The kernel is fine, but exposed to
the agent." — "We don't install dsh. We take the concepts of dsh and implement
them in our repo."

## Concept → implementation map (dsh concept → in-repo piece)

| dsh concept | In eigenEnterprise | Status |
|---|---|---|
| Everything is a plugin | module manifests + activation | exists |
| Guarded tool pipeline, one door | kernel registry `execute()` (permission → approval → zod → handler → event → git) | exists |
| LLM adapter seam | llm gateway + api-shapes (EUrouter/OpenRouter/Anthropic/Codex) | exists |
| Durable session log ("model-visible means logged") | append-only Postgres session log; the loop derives model history from it | **build (M1)** |
| Loop: turns/steps, inbox, streaming | one loop (evolved builtin-json protocol), the ONLY engine | **build (M1)** |
| Sandbox/subprocess seam | `repo.*` registry tools: worktree_create / run (scoped) / merge (approval-gated, server-side verify) | **build (M2)** |
| Approval policy at pre-execute | kernel approvals, surfaced in-band in the conversation | exists |
| System prompt as assembled sections | persona + discipline sections (ported from `.pi/skills`) on the one agent config | **build (M2)** |

## The one agent

- **Identity**: the seeded agent principal (orchestrator config row survives as
  THE config: persona, model routing, spend cap, tool scope = all). One agent,
  zero code privilege debates.
- **Brain**: one loop. Turn = steps of model request + tool calls. Tools via the
  registry door, in-process. Approval-pending surfaces as part of the
  conversation: the agent asks the owner in chat, owner says yes, agent retries —
  audited in kernel_events + git.
- **Memory of the conversation**: durable session log (Postgres, append-only).
  Restart resumes; history is derived from the log, never from RAM. The
  in-memory Maps debt dies here.
- **Hands**: registry tools — company tools (memory, email, brand, …) AND repo
  tools (worktree → run scoped commands → verify → merge). Repo work follows the
  dev-agent discipline without the dev-agent module: mutations only in
  `wt/agent-<session>` worktrees; `npm test` + `npm run check` green before
  merge; merge is approval-gated (owner yes in chat); structured commits;
  `plan/progress.md` updated by the agent itself.
- **Discipline**: `.pi/skills` essence (plan-first, understand-first,
  no-fallbacks, TDD, worktree-verify-merge) ported into the agent's system
  prompt sections — maintained by the agent like everything else.
- **Surface**: the nucleus chatbox (`/`) — THE conversation with the company.
  `/api/chat` speaks to the one loop (NDJSON streaming plumbing reused from the
  legacy loop). Telegram dormant until wanted.
- **Rights**: v0 single operator = owner session; conversational checks for
  later arrivals (owner executes, others ask), git rollback as backstop.

## Milestones

- **M1 — the loop + the log**: durable append-only session log (tables +
  migration); one loop replacing builtin-json internals (durable history,
  streaming steps, in-band approvals); `/api/chat` → the loop; chatbox resumes
  sessions across restarts. Legacy agent-loop path retired from `/api/chat`.
- **M2 — hands + discipline**: `repo.*` tools (worktree/run/merge with
  server-side verification gate, merge approval-gated); `.pi/skills` port into
  system-prompt sections. Proof: in one conversation — "improve X" → plan →
  worktree → tests green → owner yes → merged → progress.md updated.
- **M3 — dogfood + cleanup**: the agent improves its own prompt/skill through
  the M2 path. Then deliberate deletion of frozen code: pi-engine, dev-agent
  module, orchestrator brain/loop, builtin-json remnants, AgentRuntime engine
  indirection (fold the one loop in directly).

## Frozen (kept where wired, deleted in M3, deliberately)

AgentRuntime engine indirection, `pi-engine.ts`, `engines/builtin-json.ts`
(protocol evolves into the one loop), `modules/orchestrator` brain/loop,
`modules/dev-agent`, legacy `/api/chat` agent-loop path, Telegram gateway.

NOT frozen: kernel proper (registry/principals/approvals/events/vcs/modules +
DB stores), website/auth/memory/brand app, phase-2c branding M3–M5,
`ee` CLI (the human/external door onto the same registry).

## Risks on record

- The loop is hand-maintained in-repo again — accepted: it is one protocol file
  plus a log, smaller than any external-harness integration, with zero churn
  risk and full ownership.
- Owner principal in the agent's hands: conversational governance + git
  rollback + provider-level spend caps; no fail-closed gate on the agent's own
  repo-hands beyond the approval-gated merge. Accepted for customer zero.
- Approval decisions happen on the owner's chat yes: audit trail = transcript +
  kernel_events + git.

## Non-goals

No external harness dependency (dsh/pi) for the agent. No multi-agent
proliferation: one loop, one config. No multi-tenant anything. No Telegram until
asked for.
