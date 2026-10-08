# Phase: Software Factory (lights-out build loop)

**Status:** Draft — awaiting owner confirmation of scope + first slice.
**Source:** Owner-provided lights-out factory blueprint (2026-10-08) + this repo's existing primitives.
**Relationship to other phases:** Runs in the **main app** (kernel + dev-agent live here). `company-os/` stays untouched — the factory is tooling that accelerates ALL workstreams, including company-os milestones. Supersedes nothing; parks nothing.

## 0. What the owner asked for

A software factory: tickets → code → tests → evals → improvement → deployment, as a closed
multi-agent loop with automated quality gates, self-healing, evidence-based improvement, and a
human **on** the loop (rules + approvals), not **in** it (every click).

## 1. Mapping: blueprint → what this repo already has

| Blueprint piece | Already here | Gap |
|---|---|---|
| Specialized agent chain | `src/lib/kernel/agent-runtime.ts` (agents = configs on loop engines); `modules/dev-agent` hosts headless **pi** in a git worktree (prompt contract: `.pi/skills/dev-agent-protocol/SKILL.md`) | Chain wiring + per-role prompt configs |
| Quality gates | `npm test`, `npm run check`, `npm run lint`, Playwright suites — all defined in package.json | Gate runner that executes them in the worktree and parses results |
| Approval before risky actions | Kernel approval gate (`auditClass !== 'read'` → owner decision; `StaticApprovalPolicy`) | Merge-to-main as an approval-gated factory tool |
| Audit trail | Kernel events (append-only) + agent session logs | Friction-signal extraction on top |
| Fallback/redundancy | pi-subagents (retry, fresh-context reviewers, lane model) | Factory-level retry policy + failure classification |
| Friction signals | Kernel events, session-log DB, eigen capture/thoughts | Signals → issue pipeline |
| Evals | `evals/` (graph-scale…), vitest | Per-change eval selection |
| Deploy | `docker-compose.yaml`, deploy/ scripts | Post-merge smoke + auto-bug on failure |

**Deliberately NOT imported:** LangChain/LangSmith, Ona, Factory.com, Sentry-specific responder —
external products from the pasted blueprint. The kernel + harness + pi are our orchestration layer;
external integrations arrive only when a milestone needs them.

## 2. Milestones (thin slice first — the wedge lesson applies)

Each milestone: tests first, green gates, one commit, demo on a REAL ticket.

- **M0 — One closed loop (the proof):** kernel module `factory` with tools:
  `factory.build` (ticket spec → dev-agent in a fresh worktree → runs `npm test` + `npm run check`
  + `npm run lint` in that worktree → structured report: diff summary, gate results, files touched)
  and `factory.merge` (approval-gated; only callable when all gates green; merges worktree → main,
  prunes worktree). Prove on ONE real small ticket end-to-end. Owner approves the merge — that's
  the whole human role in M0.
- **M1 — Reviewer + iterative resolution:** second agent (fresh-context reviewer) reads the diff
  against the ticket spec, posts concrete findings; builder revises (max 3 rounds, then escalates
  to owner with the transcript). Gates re-run after each round.
- **M2 — Risk-tiered autonomy:** classification of changes (docs-only / test-only / src) →
  green + low-risk auto-merges WITH audit trail; src changes keep the owner approval gate.
  Failure classification for gates (assertion vs infra vs flake) — flake = re-run once, loudly.
- **M3 — Shepherd + friction signals:** stale-loop detection (builder stuck, gates failing N times
  → escalate with full evidence); kernel events → weekly friction digest (most-retried steps,
  most-failed gates) filed as capture thoughts → owner turns them into tickets.
- **M4 — Evals + browser layer:** per-change eval selection (changed-module → its eval suite);
  Playwright journeys for UI-touching changes; post-merge smoke on the deployed instance with
  auto-filed bugs on failure.

## 3. Non-negotiables (inherited guardrails)

- TDD; no weakened assertions to get green.
- Fail loud — a gate that can't run is a failed gate, never a pass.
- Every factory action is a kernel tool call: permission-checked, audited; merges are
  approval-gated until M2 says otherwise per risk class.
- The factory edits only its worktree; `main` moves only through `factory.merge`.
- No string heuristics for meaning (risk classification = deterministic file-path/extension rules;
  anything semantic = LLM + structured output).

## 4. Risks

- **Dev-agent quality ceiling:** the loop is only as good as the builder. M0's demo ticket must be
  honest (a real bug we'd file anyway), not a toy. If the builder can't close it, that IS the
  finding — the factory's first improvement target.
- **Gate runtime:** full unit suite ~25s, svelte-check ~60s, Playwright minutes. M0 runs unit +
  check + lint in-worktree; Playwright arrives in M4 behind a change-detector.
- **Scope gravity:** factory work must not eat company-os M4+ — milestones are owner-gated.

## 5. Open questions (owner decides before M0)

1. **Ticket source:** GitHub Issues on this repo, eigen capture thoughts, or plain prompt text for M0?
2. **First proof ticket:** which real small bug/feature should M0 close? (Proposal from me:
   one of the pre-existing lint errors in `src/lib/kernel` listed in progress.md — small, real,
   fully verifiable by existing gates.)
3. **Merge policy:** owner approval per merge from day one (M0 default), or auto-merge
   docs-only changes immediately?
