# Phase: Software Factory (the system evolves itself)

**Status:** APPROVED direction (owner, 2026-10-30) — decisions F1–F4 below. Milestones start after the owner's "go" on this plan. §8 has one open question (push credential) that blocks only milestone S4.
**Source:** Owner-provided lights-out factory blueprint (2026-10-08), revised 2026-10-30 against what actually exists.
**Supersedes:** the 2026-10-08 draft of this file (it built M0 on `dev-agent`, which phase-3 froze for deletion). **Absorbs:** the open follow-ups of `plan/phase-durable.md` (D8 visibility, D9 mirror, durable background tasks) and the unfinished phase-3 M3 cleanup.
**Must stay congruent with:** `phase-durable.md`, `phase-3-one-agent.md`, `phase-substrate.md` (D11, D15, D16), `company-os-architecture.md`.

## 0. What the owner asked for

A software factory: tickets → code → tests → evals → improvement → deployment, as a closed loop with automated quality gates, self-healing and evidence-based improvement. The human is **on** the loop (rules + approvals), not **in** it (every click). 2026-10-30: "focus on pi durable implementation and setting up the software factory so that the system can self evolve."

## 0b. Amendment (owner, 2026-11-03) — never fork the core

The factory **does not edit eigenEnterprise's own source for one company.** A per-company fork would turn every upstream release into a painful merge. Instead (`plan/phase-extensions.md`):
- **Company features** are built as **extensions** in the company's extensions repo (Extension API, own process, declarative UI, data in the company data repo). The loop below applies unchanged, with the extensions repo as the working repository; S2's "source checkout on the box" becomes a checkout of the extensions repo.
- **Core improvements** (bugs, better editors, new capabilities every company needs) become **pull requests to the upstream eigenEnterprise repo** — never merged into a company's running core; they arrive with the next release.
- **Before every core update** the factory runs the extension compatibility check (extensions plan §3) and repairs extensions, never the core.
- Deploy remains an owner click (D11); `system.yaml` in the data repo records what runs.

## 1. Owner decisions (2026-10-30)

- **F1 — The factory lives on the box.** The deployed system changes itself: ee keeps a git checkout of eigenEnterprise's own source next to the running release, the factory builds and gates there, and a shipped change becomes a new EE release through ee's blue-green, health-gated path. The Mac checkout is not the factory's home.
- **F2 — The builder is the durable agent with the `repo.*` hands.** Each ticket runs as a **background pi-durable conversation** (no browser request attached) using the existing `repo.*` registry tools. A restart mid-build resumes from the checkpoint. `dev-agent`, `pi-engine` and the `pi` loop engine are deleted (phase-3 M3, announced in §6).
- **F3 — Tickets come from the Extension Roadmap** (`modules/orchestrator/roadmap`, table `extension_roadmap_items`; statuses `planned | in_progress | shipped`, kinds `feature | fix | chore`). Humans and the agent already read and write it, and `catalog_gap` already lands there, so the loop closes inside the product.
- **F4 — Autonomy at start: green docs-only and test-only changes auto-merge.** Source changes need the owner's approval to merge. **Every deploy needs the owner's click** (D11: only humans change the server; unchanged).

## 2. What exists vs. the gap (verified 2026-10-30)

| Piece | Exists | Gap |
|---|---|---|
| Durable loop | pi-durable 1.3.0 is the orchestrator's only engine; crash-resume proven (SIGKILL spec); state at `/var/lib/ee-state/os/agent/agent.sqlite` on the box | Runs only inside a chat request. A tool call resumed after a restart returns `not_run` (no live request to bind a principal to) — correct for chat, fatal for background work |
| Visibility | `watchEvents` wrapper in `durable-harness.ts` (`events(conversationId)`) | D8 not built: no SSE endpoint, no run view, no multi-viewer |
| Chat mirror | `chat_message` rows written around dispatch | D9: a turn finished after a restart never reaches the chat bubbles |
| Repo hands | `repo.worktree_create/run/read_file/write_file/merge` (allowlisted, approval-gated merge, server-side verify) | Repo root = git root of `process.cwd()`. On the box that is a read-only release tarball, **not a git checkout** → the hands have nothing to work on |
| Tickets | Roadmap items (status `planned/in_progress/shipped`, kind `feature/fix/chore`, rank), `roadmap.*` tools | No "build this" transition, no link item ↔ run, no `blocked` status (needs a migration) |
| Gates | `npm test`, `npm run check`, `npm run lint` | `repo.merge` verifies only kernel-scoped vitest + check |
| Deploy | ee: system-tier workload `os`, blue-green, health gate, `release` (tarball) and `git` source kinds | No path from a merged commit to a new `os` release on the box |
| Dead code | — | `dev-agent`, `pi-engine`, `pi` engine still wired; `kernel_agent_session_events` + `AgentSessionLog` have no writer since builtin-json died |

## 3. Design

### 3.1 Durable background runs (F2)
- `startBackgroundRun({ key, agentId, principalId, instructions, prompt })` on the durable harness box: an ownerless conversation recorded in `durable_conversations` with a **run principal** column (new migration). Nobody awaits it; the harness drives it to settle.
- Resumed tool calls look up the conversation's recorded principal and run as it. Chat conversations keep today's rule (no live request ⇒ `not_run`); only rows with a recorded run principal resume tool execution. Fail loud if the principal no longer exists.
- The factory principal is a seeded **agent** principal (`agent:factory`), never the owner. Its tool scope is `repo.*`, `roadmap.*`, `factory.*` — nothing that touches the server.
- Boot warm-up (exists) resumes background runs like any other pending turn.

### 3.2 Source on the box (F1)
- ee maintains `${EE_STATE_DIR}/source`: a git clone of eigenEnterprise at the deployed rev (the `os` workload's source). This is a separate tree from the read-only release and the company repo (desired state). Worktrees live under `${EE_STATE_DIR}/source-worktrees/`.
- `repo.*` resolves its root from `EE_SOURCE_DIR` (injected by ee). Unset ⇒ fail loud — no `process.cwd()` fallback.
- Gates run in a capped transient systemd unit (one build at a time, phase-substrate §9.10). `node_modules` comes from `npm ci` against the lockfile, with the npm cache in the state dir.

### 3.3 The loop (one ticket)
`roadmap item (planned)` → owner or agent calls `factory.build(itemId)` → item `in_progress`, background run starts with the factory persona + discipline + item text → `repo.worktree_create` → edits → **full gates** (`npm test` + `npm run check` + `npm run lint` in the worktree) → `factory.report` writes a structured result onto the item (diff summary, files, gate results, risk class) →
- **risk class docs-only / test-only + green** ⇒ auto-merge (F4), item `shipped`;
- **src + green** ⇒ approval card (existing approval gate) → owner yes → merge;
- **red** ⇒ the run revises (bounded rounds); still red ⇒ item `blocked` (new status) with the evidence, owner notified.

### 3.4 Risk classes (deterministic file-path rules, not meaning)
- **docs-only:** every changed path under `docs/**`, `plan/**` or `*.md` — except governance files.
- **test-only:** every changed path is `*.spec.ts`, `*.e2e.ts` or under `tests/**`, **and** no test file is deleted, **and** the test count does not drop (vitest counts before vs. after). A drop ⇒ treated as src (guardrail: no weakening tests).
- **governance files are always src-class:** `AGENTS.md`, `.pi/skills/**`, `modules/orchestrator/discipline.ts`, `src/lib/kernel/approvals*`, the factory's own risk rules. The system never rewrites its own rules unattended.
- Everything else: src.

### 3.5 Ship (F1 + F4)
- After merge, main is pushed to GitHub (credential: §8).
- `factory.release` proposes a deploy of rev X: approval card → **owner click** → ee switches the `os` workload source to `git@rev X`, builds in the sandboxed build unit, deploys blue-green with health gate + keep-3; D15 expand/contract migrations apply.
- After deploy: smoke checks (health + one kernel tool round-trip). Failure ⇒ ee keeps the old slot serving (S4 behaviour) and the factory files a `fix` roadmap item with the evidence.

### 3.6 Self-evolution closure
Friction signals (kernel events + durable run events: most-retried steps, most-failed gates, `catalog_gap`, blocked items) → a periodic digest → the agent **proposes** roadmap items. Proposals stay `planned` until the owner (or a later autonomy rule) triages them. That closes the loop: the system notices its own friction, files it, builds it, ships it.

## 4. Milestones

Each one: tests first, gates green, one commit per workstream, a `plan/progress.md` entry, and proof on the box where it says so.

- **S0 — Durable foundations.** Background runs with a recorded run principal (§3.1) + migration; D8 SSE `/api/agent/runs/[id]/events` (snapshot on connect) + a run list/detail page, two browsers on one run; D9 mirror of settled turns into `chat_message`. *Proof:* on the box, a background run is killed mid-tool-call (`systemctl restart`) and finishes after boot, running its tools as its recorded principal; two browsers watch it live.
- **S1 — Cleanup (announced, §6).** Delete `dev-agent`, `pi-engine`, the `pi` loop engine and `kernel_agent_session_events`/`AgentSessionLog` (drop migration). *Proof:* gates green; no reference left (grep pinned in a spec).
- **S2 — Source on the box.** ee source checkout + `EE_SOURCE_DIR`; `repo.*` root from env; gates in a sandboxed unit with `npm ci`. *Proof:* on the box, `repo.worktree_create` + `repo.run npm test` run green in a worktree; the release tree stays read-only.
- **S3 — Factory M0: one ticket, end to end.** `factory.build/report/status`, roadmap link, full gates, risk classes with auto-merge for docs/tests. *Proof:* a real small ticket (a docs fix auto-merges; a real small src bug goes through the owner approval) closes on the box without anyone typing in a terminal.
- **S4 — Ship.** Push + `factory.release` + ee `os` from git rev + post-deploy smoke + auto-filed bug on failure. *Proof:* a merged change is live on the box after one owner click; a deliberately broken change leaves the old release serving and files a `fix` item.
- **S5 — Reviewer.** Fresh-context reviewer run reads diff vs. ticket, ≤3 revise rounds, then escalate with transcript.
- **S6 — Friction → roadmap (§3.6).** The self-evolution closure.
- **Later:** per-change eval selection + Playwright for UI changes; more autonomy per risk class only by explicit owner rule.

## 5. Non-negotiables (carried over)

- TDD; no weakened assertions to get green; a gate that can't run is a failed gate.
- Every factory action is a kernel tool call: permission-checked, audited, visible in the run view.
- The factory edits only worktrees; main moves only through merge (auto for docs/test classes, approved otherwise).
- D11: no factory action changes the server; deploy is always an owner click.
- No string heuristics for meaning: risk classes are file-path rules; anything semantic goes through the LLM with structured output.
- All model calls through the gateway (pi-durable's provider already is).

## 6. Removals (announced before they ship — AGENTS.md "no silent removals")

- `modules/orchestrator/dev-agent` (tools `dev-agent.dispatch/status/logs/merge/abort`) and `.pi/skills/dev-agent-protocol` — replaced by `factory.*` on the durable agent.
- `src/lib/kernel/pi-engine.ts` and the `pi` loop engine registration in `boot.ts`.
- `kernel_agent_session_events` table, `AgentSessionLog`, `WiredKernel.sessionLog` — no writer since 2026-10-20.

## 7. Risks

- **Builds on a small VPS compete with production.** One build at a time, capped unit; heavy gates (Playwright) wait for "Later".
- **The agent changing its own runtime.** Bounded by: governance files always owner-approved, deploy always owner-clicked, blue-green + health gate + keep-3 rollback.
- **Builder quality ceiling.** The first S3 ticket must be a real bug. If the builder can't close it, that is the first finding.
- **pi-durable is pinned at 1.3.0** (D1). Background runs use only APIs present in 1.3.0 (`createConversation` ownerless, `resume`, `watchEvents`); no durable sleeps.

## 8. Open question (blocks S4 only)

**How the box pushes merged commits to GitHub.** Today's deploy keys are read-only by design. Options:
1. A GitHub App installation token with `contents: write`, scoped to the eigenEnterprise repo only, minted per push (same pattern as today's fetch tokens). *Recommendation.*
2. A write-enabled deploy key held by ee for that one repo.
3. The box's source checkout stays authoritative and the Mac pulls from it (no write credential on the box, but GitHub drifts).
