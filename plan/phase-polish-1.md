# Phase: Polish 1 — one assistant everywhere, Slack-grade Messages, profiles, full width, Owlery inside

**Status:** SHIPPED to main 2026-11-04 (see progress.md; not done: campaigns, webhooks, visual block builder/xyflow canvas). APPROVED by owner direction (2026-11-04, voice feedback after using release `3ee4199` on the box). Owner: "make a plan, integrate with subagents, don't ask questions, just build."
**Orchestrator:** main session. Streams run in `.claude/worktrees/<stream>` (never `../`), merged `--no-ff` into `main`.

## 0. Owner feedback (condensed)

1. **Messages** look bare-bones. Should look and be organized like Slack and use the whole screen.
2. **Profiles:** on login a person must create a profile — profile picture, first name, last name — and Messages uses it.
3. **Assistant vs Agent vs Chat is confusing.** They are one thing. The assistant should sit on a top layer in every layout (a bar at the top you click into, or ⌘K to focus), the sidebar for it should be resizable.
4. **Overview** — unclear why it's a nav item. It is the dashboard: clicking the company name at the top of the sidebar (currently no route) opens it.
5. **Full width:** Website is the only full-width page, which feels odd. All pages (Email sub-pages, Drive, …) use the full width.
6. **Email:** "Sender not set up" with nothing to click; "For developers / keys / how to send" is unintuitive even for a developer. Owlery is a full email automation platform (sender domains, identities, logs, flows, layouts, templates) — the full platform should live inside eigenEnterprise, not a bare-bones send.
7. **Agent:** Runs ("Run 1", no way to start one, "AI provider isn't set up" on click) is unclear. Runs/Activity are fine as ideas, but they belong to the one assistant. **Roadmap belongs in Memory as a project.**
8. **Drive:** full width, style it better.
9. Fine for now: Modules, Brand, Website sub-pages (site, settings, domain), Memory, Settings.

## 1. Decisions (orchestrator, owner may veto — logged in progress.md)

- **P-1 One assistant.** "Assistant" and "Agent" nav entries are removed. The company agent's chat lives in a **global assistant panel** available on every signed-in page: a top bar with an "Ask the assistant… ⌘K" field; ⌘K (Ctrl+K) focuses it from anywhere; sending opens a **right-side panel, resizable by drag** (width remembered per browser), collapsible. The panel holds the conversation, a "New conversation" action and a conversation list (what used to be Runs), and the Activity log as its second tab. The run view (`/agent/runs/[id]`) stays a linkable page (rule 5: things you link to are pages) at `/assistant/[id]`; the list at `/assistant`. **Removed (announced):** nav entries Assistant + Agent, `/agent`, `/agent/runs`, `/agent/activity` (moved to `/assistant`, `/assistant/activity`), `/agent/roadmap` (moved to Memory, P-4).
- **P-2 Dashboard at `/`.** The company name/badge at the top of the sidebar links to `/`, which is the dashboard (today's Overview content, styled up). The "Overview" nav item and `/overview` are removed (announced). The full-screen first-run flows (welcome boot sequence, provider gate) stay on `/` exactly as today; the onboarding hand-off greeting now arrives in the assistant panel (opened automatically).
- **P-3 Full width is the rule.** `PageFrame` default becomes full width (`px-4 sm:px-8`, no `max-w-5xl`); forms and reading text keep their own `max-w-2xl` measure. `docs/design-system.md` › Page frame updated. Messages and Drive are app-style full-bleed layouts (no page padding, own panes).
- **P-4 Roadmap = a Memory project.** The roadmap becomes a system project "Roadmap" in Memory; items are that project's tasks (status planned / in progress / shipped mapped onto task states, kind kept). The roadmap kernel tools keep their names and contracts but read/write through Memory. Existing `extension_roadmap_items` rows are migrated; the table is dropped only after the migration copies them. Factory F3 ("tickets come from the roadmap") now reads the Memory project.
- **P-5 Profiles are required.** After any sign-in (claim, signup, invite join) a person without a complete profile (first name, last name, picture) lands on `/welcome/profile` before anything else; owner onboarding asks for it in its name step. Pictures are cropped square client-side, resized to 256 px WebP, stored content-addressed with the Drive blob store, served by an authenticated route. Name = "First Last" also written to `user.name`. Settings › Account edits the same profile. Avatars appear in Messages, the sidebar footer, the member list.
- **P-6 Owlery inside.** The email module grows into the Owlery feature set, ported (not proxied) into ee's single-tenant model: sender domains with DNS (DKIM/SPF/DMARC/MAIL FROM) verification, identities, templates, layouts, flows (automations), contacts/lists, logs/events, suppression, and an API with clear keys. UI = Email area with tabs (Overview · Domains · Identities · Templates · Layouts · Flows · Contacts · Logs · API), every setup state actionable (never a dead "not set up"). The developer section is rewritten as a plain "Send from your code" page with a working curl example and one button to create a sending key. Delivered in stages (E-P1 domains/identities/logs/API, E-P2 templates/layouts, E-P3 flows/contacts) — each stage shippable.

## 2. Workstreams (disjoint files)

| Stream | Owns | Migrations |
|---|---|---|
| **A shell** — P-1, P-2, P-3 | `src/lib/components/app-shell.svelte`, `src/lib/shell/**`, new `src/lib/components/assistant/**`, `src/routes/(nucleus)/+page.*`, `+layout.*`, `overview/`, `agent/` (delete/move), new `assistant/`, `src/lib/components/page/**`, `docs/design-system.md`, website layout's width prop, shell e2e | none |
| **B people** — P-5 + Messages | `src/routes/(nucleus)/messages/**`, `src/lib/messages/**`, `modules/messages/**` (view data only), profile routes/API, `src/routes/(nucleus)/settings/+page*` (account), invite/claim/signup post-sign-in redirect, new `src/lib/components/user-avatar.svelte`, profile schema | `0113_user_profile` |
| **C email** — P-6 | `modules/email/**`, email page(s) under `src/routes/(nucleus)/m/email/**` (moved out of `[moduleId]`), `src/routes/api/mail/**`, `src/routes/docs/send-mail.md`, email schema files | `0114`–`0119` reserved |
| **D memory+drive** — P-4 + Drive | `modules/orchestrator/roadmap/**`, `modules/memory/**`, `src/routes/(nucleus)/m/memory/**`, `src/routes/(nucleus)/drive/**`, `src/lib/drive/**` / drive components, roadmap schema | `0120_roadmap_into_memory` |

Integration (orchestrator): sidebar avatar from B in A's shell; Agent-area link replacements; full gates; release to the box.

## 3. Done means

Each stream: unit + component tests for new behavior (TDD), its e2e green, `npm run check` 0 errors, lint clean on touched files, committed on its branch with a short report (what shipped, what's not verified, any removal). Orchestrator: merged main green (check, unit, the touched e2e), released to the box, progress.md entry.
