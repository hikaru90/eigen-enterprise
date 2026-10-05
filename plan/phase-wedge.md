# Phase Wedge — the thin slice

**Status:** Active. Owner-directed pivot (2026-09-21).
**Governing docs:** `plan/the-wedge.md` (strategy), `plan/first-conversation.md` (the product moment), `plan/company-os-architecture.md` (target architecture), `plan/claim.md` (why).
**Supersedes:** phase-2b/2c/2d/3 roadmap ordering for all new work. Those phases are **parked**, not deleted.

## 0. Why this phase exists

Owner verdict on the existing build: *"very opinionated, bloated and not what i wanted."* The kernel-machinery direction (approvals UI, brand extraction pipeline, visual editor, tree navigation, 81 migrations, 4k tests) built elaborate infrastructure while the actual product — **describe your company → running on your own VPS in 10 minutes** — doesn't exist.

The wedge doc's build list is the mandate:

1. Agent harness (minimal tool registry)
2. One module: website (generated from conversation, stored as git, rendered by SvelteKit)
3. One-command deploy to a VPS
4. Eigen Mesh wired in from day one (so the website remembers)
5. Owlery wired in from day one (so the contact form works)

That's it. No shop. No brand module. No design system. No org charts. **The agent's output quality is the thing that decides this** — every milestone serves the first conversation.

## 1. Where the code lives

`company-os/` — a fresh, self-contained TypeScript package inside this repo, with its own `package.json`, tsconfig, vitest setup. **Zero imports from `src/lib/kernel`, `modules/brand`, or any existing eigenEnterprise app code.** The existing build stays untouched (parked, never deleted). When the slice warrants its own repo, the directory extracts cleanly.

## 2. Decisions of record

These implement the docs; owner can veto any of them.

- **W1 — Fresh minimal build.** New code at `company-os/`, no reuse of the existing kernel/brand/auth machinery. If a proven primitive is genuinely needed, port it thin instead of importing the module around it.
- **W2 — Postgres only.** No Redis, no BullMQ in the slice. Module ops (git clone, render, commit) run inline in one process with streamed progress lines — that's what P2 actually shows the founder. A queue arrives when there's a true async need (second long-running module), not before. Keeps the deploy lean: 3 containers (app, postgres, caddy).
- **W3 — Minimal LLM client.** OpenAI-compatible `/chat/completions` with streaming via `fetch`. Env: `COMPANY_OS_LLM_BASE_URL`, `COMPANY_OS_LLM_API_KEY`, `COMPANY_OS_LLM_MODEL` — required, fail loud at call time, no defaults (no-fallbacks rule). No provider matrix, no BYOK UI, no cost-tracking DB.
- **W4 — Website module = git repo of content + theme.** The generated site is content (structured copy) + theme tokens (+ optional Svelte overrides later) committed to a git repo from the first render ("even version 0.1 is committed"). The app renders it; every conversation edit is a tool call → file write → commit. Full-code-site generation (agent writes real components) is revisited at M3 only if the template straitjacket visibly hurts quality — the honest risk lives there.
- **W5 — Never-invent is structural, not prompt advice.** The renderer consumes only the structured answer map. Copy is LLM-drafted *from* those answers and stored in the module repo with its source answers. Hard filter on prices/legal claims/certifications: an LLM check pass (no string heuristics for meaning), sentences failing it are rejected before commit.
- **W6 — Chat streaming over SSE.** No websockets in the slice. One POST stream per turn.
- **W7 — Owner access = single token.** `COMPANY_OS_OWNER_TOKEN` env, fail loud if unset. No user accounts, no auth framework. A public VPS running a root agent with an open chat endpoint is not shippable.
- **W8 — Memory (Eigen Mesh v0) is a company memory table.** Every answer persisted immediately (`memory` rows: kind, key, value, source). Resume-after-disconnect reads it back. Semantic retrieval/embeddings come when the amount of memory makes reading it all impractical — not before. No fake readiness in P0: the arrival check verifies what the slice actually needs (Postgres, module runtime), says exactly what's broken otherwise.

## 3. Milestones

Build order follows `first-conversation.md` §6. Each milestone: tests first, green gates (`vitest` in `company-os/`), one commit.

- **M0 — Harness core** *(headless)*: streaming LLM client (W3), tool registry (JSON-schema tools, loud parse errors), reasoning loop (reason → tool → observe, loud max-steps failure). DI seams so tests run without env/network.
- **M1 — Session + memory**: conversation persistence after every message (W8), resume on re-entry ("You were setting up <company> — where were we?"), Postgres store + migrations (SQL file + applied via the slice's own migrate path), in-memory store only as an injected test double.
- **M2 — First conversation P0/P1**: arrival health check (real substrate probe, honest failures), the 7-question interrogation policy (≤7, one per turn, choices-over-blanks, skip rules), answers → memory. Code enforces the invariants; the LLM runs the conversation within them.
- **M3 — Website module + first render (P2/P3)**: dead-simple `module.json` (identity, tools, content contract — the weekend-shippable bar), template repo (typographic, "handmade" register, monogram fallback for missing assets), generation from answers only (W5), git commit per render, preview surface + silent reveal.
- **M4 — Iteration + handoff (P4/P5)**: conversation-driven edits as tools, ~3-iteration cap then "park it" offer, ownership handoff script, second-module mention left to the founder.
- **M5 — Deploy (the wedge itself)**: `docker compose` (app + postgres + caddy), one-command install script, TLS + `preview.<domain>` routing, domain config conversationally. Target: install → live personalized site ≤ 10 min.
- **M6 — Chat surface**: minimal SvelteKit chat UI with SSE streaming + named progress lines (no bare spinners). (Built after the flow works headless — the loop is the product, the chrome is not.)
- **M7 — Contact form + Owlery slot**: compose profile + `email.send` path, only wired when the founder asks for the form (per first-conversation §6.5).
- **M8 — Eval**: 20 fake companies through the flow, human-judged against the success criteria below. This is the gate that decides whether the wedge is real.

## 4. Success criteria (from first-conversation.md §4 — binding)

| Metric | Target |
|---|---|
| Install → live personalized site | ≤ 10 min |
| Questions asked | ≤ 7 |
| Questions per turn | 1 |
| Site copy traceable to answers | 100 % |
| Invented facts | 0 |
| Founder reaction at reveal | voluntary positive signal |
| Second-module mention by founder (not agent) within session | target yes |

The only metric that really matters: **would the founder ship this?**

## 5. Non-goals for this phase

Shop, brand module, design system, org charts, module marketplace/economics, user-facing agent classes, Redis/BullMQ, pgvector, multi-tenant anything, the existing app's UI. Open strategy threads (template system, module dev economics) stay open in `the-wedge.md` until the slice proves out.
