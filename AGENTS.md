# eigenEnterprise — Agent Working Agreement

**The website is the company.** eigenEnterprise is an AI-native company OS: SvelteKit + Postgres (pgvector + Apache AGE), single-tenant per company, Apache-2.0. Customer zero: Kindred Digital Labs. See [`plan/phase-0-kernel.md`](plan/phase-0-kernel.md) for the approved architecture.

## Orchestrator model (how agents work here)

- The **main agent is the orchestrator**. It owns the plan in `plan/`, decomposes work, and **delegates to subagents** (Task tool) for research, exploration, and scoped implementation.
- **Parallel work happens in git worktrees**, one workstream per branch (`git worktree add ../ee-<stream> -b <stream>`). Workstreams touch disjoint file sets by design. The orchestrator reviews, merges into `main`, and prunes the worktree.
- The orchestrator never does what a subagent could do in parallel; it integrates, decides, and keeps `main` green.
- **Every agent edits only within its workstream scope.** Cross-cutting changes go back to the orchestrator.

## Progress documentation (non-negotiable)

- `plan/` is the source of truth: approved phase plans (`plan/phase-*.md`) and **`plan/progress.md`**.
- After every completed milestone (and before ending a session), update `plan/progress.md`: what shipped, commit refs, what broke, decisions taken, what's next.
- Decisions with architecture impact get a line in `plan/progress.md` (decision log section) — no silent choices.

## Engineering guardrails (carried from eigen — still binding)

- **Drizzle migrations:** every schema change needs BOTH `drizzle/NNNN_name.sql` AND a journal entry in `drizzle/meta/_journal.json` (idx sequential, tag = filename without `.sql`), plus schema update in `src/lib/server/db/`. `scripts/migrate.mjs` fails fast on mismatch.
- **TDD:** tests first for features/fixes (vitest unit; Playwright headed for e2e). No weakening assertions to green a build — fix root causes, never work around them.
- **No fallbacks / no silent degradation:** no `|| 'localhost'` default envs, no bypass paths, no temporary shims. Fail loud with explicit errors.
- **No string heuristics for meaning:** never regex/keyword/substring logic to decide semantic anything (classification, routing, entity typing). Always LLM + ontology + JSON schema. Post-LLM code may only parse/validate/persist.
- **Svelte:** no `$effect` for control flow — explicit events, handlers, `onMount`. `$derived` for pure view state is fine.
- **LLM middleware:** all model calls go through the gateway (`src/lib/server/llm/`) — never direct provider calls. Cost tracking stays attached.
- **Secrets:** never commit; never log raw credentials (redact `*key`, `*token`, `*secret`, `password`).

## Commands

| Task | Command |
|---|---|
| Unit tests | `npm test` |
| Coverage | `npm run test:coverage` |
| Typecheck | `npm run check` |
| Lint | `npm run lint` |
| Dev DB | `npm run db:up` |
| Dev server | `npm run dev` |
| Migrations | `npm run db:migrate` |

## Repo map

- `plan/` — plans + progress (this governs everything)
- `src/lib/kernel/` — action registry, principals, events, modules, vcs, approvals, admin tools
- `src/cli/` — `ee` CLI: thin dispatcher over kernel registry tools (agents' native hands, no MCP hop)
- `src/lib/server/` — existing eigen services being promoted into modules (memory, owlery client, llm, job-queue, mcp)
- `modules/` — module manifests + implementations (baseline: website, orchestrator/agent, chat-gateway, memory, email)
- `drizzle/` — SQL migrations + journal (see guardrails)
