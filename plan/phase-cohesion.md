# Phase: Cohesion — one app, one shell, one place for settings

**Status:** APPROVED direction (owner, 2026-11-02). C1 waits for the screenshot inventory (C0) and the owner's per-area decisions.
**Owner feedback (2026-11-02):** "What is missing completely is the cohesiveness of the whole system. Settings pages don't make sense, we have different UIs, we have old broken UI of eigenmesh in there, sometimes we use the new side panel layout, sometimes separate pages."
**Why it happened:** every round added pages for its own feature; nobody owned the whole. `plan/phase-platform.md` step 2 (app shell + per-module pages) was planned on 2026-10-20 and never built. This phase is that step, done properly, and it takes priority over new pages.

## 1. Rules (binding for every page from now on)

1. **One shell.** Every signed-in page renders inside one layout: a left navigation with **Chat, Overview, Website, Email, Brand, Agent, Settings** (phone: bottom bar or drawer). Only signed-out pages (login, claim, invite, password reset) and the public company site live outside it.
2. **Every module has one page, and its settings live on that page.** `/m/<module>` (or its named route) shows status, what it produced, and its settings. No module settings under `/settings`.
3. **`/settings` holds only what belongs to the whole company:** members, AI provider, passkeys and sessions, API keys, approval mode. Nothing module-specific.
4. **Onboarding reuses the real pages and forms.** The welcome flow embeds the same components the module pages use (AI provider, email setup), never its own copies.
5. **Pages vs side panels:** lists and details are pages with their own URL; quick edits and context next to the current page are side panels. A side panel never holds something you'd want to link to.
6. **No legacy chrome.** No page renders the old eigen/eigenmesh navigation. Old features either move into a module page or are removed (announced, owner-approved).
7. **Enforced by a test:** a spec lists every `+page.svelte` and fails if a signed-in page sits outside the shell layout group (with a short, explicit allowlist for signed-out/public pages).

## 2. Milestones

- **C0 — Inventory** (running): a screenshot of every page, grouped by layout family, published for the owner, plus a list of inconsistencies and broken pages.
- **C1 — Owner decisions per area**: for every old area (activity, capture, graph, notes, timeline, memory, admin, eval, feedback, demo, docs, …) and every settings page: keep → which module/page it moves into, or remove. Written into §3 of this plan.
- **C2 — The shell**: the one layout + navigation, built from the existing design system (`docs/design-system.md`, shadcn components); all kept pages moved into it; the guard spec (rule 7).
- **C3 — Module pages + settings**: Website, Email, Brand, Agent (runs + roadmap), Memory (if kept) each get their page with their settings; `/settings` reduced to rule 3; onboarding reuses the same components (rule 4).
- **C4 — Removals**: everything C1 marks for removal goes, in one announced change with a progress entry (routes, components, API routes only they used, tests).
- **C5 — Rules in the repo**: §1 goes into AGENTS.md and `docs/design-system.md`, so every future agent and plan follows it.
- **Proof**: a Playwright walk through every navigation entry on the test server, screenshots inspected, plus a new inventory to compare with C0.

## 3. Owner decisions per area (2026-11-02, after the C0 inventory)

Inventory: 61 pages — 20 in the new shell, 15 in the old eigen chrome, 8 settings, 18 standalone (published for the owner as "App Page Inventory").

- **Memory → one Memory module page in the shell.** Notes, tasks, projects and capture move into it. The graph view (`/memory`) and the old `/chat` are removed; the agent keeps its memory tools. `/m/memory` must stop saying "Not active" when Memory works.
- **Internals → Agent page.** The Agent page gets **Activity** (a readable log replacing the raw `/activity` table) and **Roadmap** (replacing `/settings/extensions`; where factory tickets live), next to **Runs**. `/eval`, `/admin/queue` and `/feedback` leave the owner UI (removed).
- **Leftovers → removed.** `/demo/*`, the stubs `/settings/agents` and `/settings/scheduled-tasks`, the "Change password" form, legacy URLs (`/register`, `/forgot-password`, `/reset-password`, `/graph`, `/notes`, `/timeline`, `/memory/timeline`, `/settings/hosting`, `/m/website/apps` alias), the duplicate `/m/website/hosting` (keep `/m/website/settings`) and the second brand entry `/m/brand` (Brand = `/brand`). Old URLs 404.
- **`/settings` = Members & invites, AI provider, Passkeys & sessions, API keys (moved from `/api-keys`), Approval mode.** Nothing module-specific.
- Also fixed in C2: the root error page lives in the shell for signed-in users and never says "Back to capture"; titles follow one pattern ("<Page> · <Section> · eigenEnterprise"); signed-out `/claim` and `/invite` dead ends get a way to sign in.

## 4. Interaction with running work

Brand picker (B3/B4), email (E1+), website (W1+) and agent (S1+) continue; their pages already sit in the new shell group and are fitted into the navigation in C2. New pages in any plan follow §1 from today.
