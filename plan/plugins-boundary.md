# Plugin boundary: every sidebar entry a real plugin (draft, plan next)

**Owner decisions (2026-11-12):** every sidebar entry is a plugin (Messages, Assistant/Chat,
Calls, Website, Email, Brand, Memory, Drive, Contacts, Calendar …) — the specs intend it and it
stays that way. Official plugins are never removed or altered, only deactivated. A company's own
plugin is always added alongside; it may implement the same contract as an official one, which the
owner then deactivates. A plugin a person switched off is never switched back on by the assistant.
The owner asked for this plan before any move ("Yes, plan it next").

## Where the code stands (W6 report, round 4)
- **Assistant/Chat:** no module. Shell top bar + panel (`src/lib/components/assistant/`, `src/routes/(nucleus)/assistant/`); its agent tools sit in the internal `modules/orchestrator`, so today it is core and can't be switched off.
- **Memory:** `modules/memory/` holds only the manifest and tools; ~70 implementation files in `src/lib/server/memory/`, pages in `src/routes/(nucleus)/m/memory/`.
- **Partly in core:** Messages UI (`src/lib/messages/`), Calls UI (`src/lib/calls/`), Drive UI (`src/lib/components/drive/`), Brand server code (`src/lib/server/brand/`), Website server code (`src/lib/server/website/`). Every plugin's pages live under `src/routes/(nucleus)/…` (SvelteKit's file routing).
- Settings → Plugins (round 4 W6) switches plugins through the kernel; W7 makes "off" really off (pages, APIs, jobs, agent).

## To decide in this plan (draft questions)
1. **Folder rule:** a plugin's server code, UI components, tools, migrations and specs live under `modules/<id>/`; `src/routes/…` keeps only thin route files that import from the plugin. Boundary spec: core never imports a plugin; plugins talk through kernel ports/tools/events only (`modules/boundaries.spec.ts` exists — extend it to UI + server code).
2. **Assistant as a plugin:** the top bar, panel and conversation pages move into `modules/assistant`; the shell gets an empty slot when it's off. What stays core: the kernel registry, approvals, the durable agent engine (other plugins' agents use it)?
3. **Memory:** move `src/lib/server/memory/**` into `modules/memory/`; who else imports it today (grounding, onboarding, recap) must go through ports.
4. **Contract per plugin** (for "own plugin with the same contract"): tools + their schemas, events, data folders, UI slots, as in `plan/phase-extensions.md` §2. Versioned.
5. **Order:** one plugin per slice, smallest first, each green on its own (unit + e2e of that plugin).

## Round 5 (contrib/plugins, Contribute c05c3a40): inventory, Assistant switchable, open questions

### Built: the Assistant is an official, switchable plugin (no open choice needed)
- `modules/assistant/manifest.ts` (id `assistant`, no tools of its own), in `moduleManifests` and
  `SYSTEM_MODULE_IDS`: seeded on once — an existing company has no record yet, so it comes up **on**;
  Settings → Plugins shows its row (official, switch); a person's switch-off sticks (boot does not
  re-seed it) and the agent cannot switch it back on (`module_switched_off`, the generic kernel rule).
- The plugin gate claims `/assistant`, `/assistant/[id]`, `/m/assistant` (pages) and `/api/chat`,
  `/api/assistant/**` (APIs). Not a sidebar entry: `IN_SHELL = ['assistant']` in `$lib/shell/nav`.
- `ShellData.assistant` (layout load): off → the shell builds no `AssistantController`, shows no top
  bar field (⌘K included) and no panel, loads nothing; the welcome hand-off is not marked; the
  dashboard drops the ask box, the approval "Review" button (with a line saying approvals are decided
  in the Assistant's conversation + a Settings → Plugins link for managers) and the conversations
  link; the Assistant area offers only its Activity tab. On → unchanged (specs pin both).
- Background work: the Assistant has **none server-side** (the job queue drains only Memory
  consolidation, webhook deliveries to agents, onboarding grounding pushes; ticks are Memory, Email,
  Repos). Its only "background" work is client-side in the panel (pending welcome greeting) — gone
  with the panel.
- **Stays core (decision for the owner's review):** the durable agent engine and its runs
  (`/api/agent/**`, `/api/agents/**`), the orchestrator agent and its internal tools, the kernel
  registry, approvals (`/api/approvals`), the company activity log `/assistant/activity` (every
  plugin's and agent's actions and the AI spend — a core exception inside the Assistant's prefix, like
  dictation inside Memory's), speech (`/api/tts`, `/api/voice`, dictation). Telegram (chat-gateway),
  recap, onboarding and other plugins' agents use them; switching the Assistant off removes the
  members' conversation surface, not the agent.

### Inventory — Assistant (read-only, 2026-11-13)
- Plugin UI: `src/lib/components/assistant/**` (16 files), pages `src/routes/(nucleus)/assistant/{+page,[id]}`,
  APIs `src/routes/api/chat`, `src/routes/api/assistant/{conversation,activity}`, server
  `src/lib/server/assistant/conversation.ts`.
- Core → Assistant imports (must become a shell slot to move the code): `app-shell.svelte` (bar, panel,
  controller, context), `(nucleus)/dashboard.svelte` (context), `(nucleus)/+page.svelte` (handoff),
  `assistant/+layout.svelte` (ASSISTANT_TABS from `$lib/shell/area-nav`).
- Assistant → core: `$lib/chat/*` (approvals client, ndjson stream, normalize), approval card + mode
  select, voice input, chat-markdown, agent-run feed, `$lib/server/chat/*`, `$lib/server/agent-runs/*`,
  `$lib/server/approvals/owner-decision`, `$lib/server/activity/*`, `modules/orchestrator/brain`
  (`ORCHESTRATOR_AGENT_ID`, from `/api/chat`).
- Reverse coupling to resolve: `src/lib/server/assistant/conversation.ts` (server) imports UI modules
  `components/assistant/nucleus-chat` + `types`; the durable engine (`src/lib/server/agent/durable-engine.ts`,
  core) writes the Assistant's conversation store (`$lib/server/chat/mirror-durable-turn`, `chat_message`)
  — the conversation store is shared by engine and Assistant and needs an owner (Q7).

### Inventory — Memory (read-only, 2026-11-13)
- Already done (W6/W7): switchable in Settings → Plugins, its pages (`/m/memory/**`) and 11 API prefixes
  gated, its two background jobs skip (`pluginOn('memory', …)`: overnight consolidation, event
  reminders + daily summaries), its kernel tools fail closed (the MCP lists only active modules' tools).
- `src/lib/server/memory/`: 148 files (70 non-spec). 82 non-spec files outside it import it: api routes
  (timeline 12, temporal-events 3, entities 3, thoughts, memories, admin), `src/lib/server/{capture 10,
  retrieval 7, grounding 5, consolidation 3, settings 2, qa 2, ontology 2, llm 2, graph 2, text-files,
  mcp, job-queue, embeddings}`, `src/routes/timeline/*` (7 UI files), `src/lib/graph/*` (2),
  `src/hooks.server.ts`, `src/routes/+layout.server.ts`, and 6 other plugins.
- **What "full plugin" still lacks:**
  1. **Generic helpers living in Memory that others need** — `llm-json-content` (Contacts, Contribute,
     Drive, Repos, grounding, `llm/batch-json`, `llm/stt-judge`, ontology), `user-timezone` (Calendar,
     Contacts, job-queue admin, notification settings), `lexical-text` (orchestrator roadmap, text-files),
     `authorship` (root layout, embeddings, MCP, text-files). They are not Memory; they must move to core
     libs before Memory can move (else every plugin imports a plugin).
  2. **Core code that writes or reads Memory without asking whether it is on** — `/api/grounding/**`
     (core) records check-in answers into Memory (`grounding/relevance-answer` → `memory/lifecycle`);
     Settings → Notifications (`settings/notification-settings`, `notification-status`) resyncs event
     reminders; `/api/admin/dispatch-reminders` runs the dispatch tick (it does self-skip via `pluginOn`).
     With Memory off these still run (the grounding check-in is the real leak).
  3. **The memory-adjacent services** (`capture`, `retrieval`, `consolidation`, `graph`, `text-files`,
     `embeddings`, `ontology`, `qa`, `src/routes/timeline`, `src/lib/graph`) sit in core folders; which of
     them are Memory and which are shared core (ontology? embeddings?) is part of Q1/Q6.
  4. Its code lives in core folders, so the boundary spec cannot hold it (Q1).

### Proposed slices (each green on its own; owner approves the list)
1. **S1 Shared helpers out of Memory** (no behaviour change): `llm-json-content`, `user-timezone`,
   `lexical-text`, `authorship` → core (`src/lib/server/llm/`, `src/lib/server/datetime/`, …). Mechanical.
2. **S2 Memory off is off in core code paths:** grounding check-ins and notification settings ask
   `pluginOn('memory', …)` / answer the switched-off state. Small, behaviour change only while off.
3. **S3 Boundary spec for core → plugin** (after Q1): extend `modules/boundaries.spec.ts` to `src/**`,
   with today's crossings as a visible, shrinking allowlist (like REMAINING in the a11y guard).
4. **S4 Assistant code into `modules/assistant/`** (after Q1/Q2): UI, server conversation, routes as
   thin files; the shell renders a slot the plugin fills.
5. **S5 Memory code into `modules/memory/`** (after Q1, S1–S3): the ~70 files + the adjacent services
   Q6 assigns to Memory, through ports for grounding/onboarding/recap.
6. **S6 Contract + company plugins** (after Q4/Q5): the versioned contract, then the install mechanism.

### Owner questions (with my recommendation)
- **Q1 Folder rule** — all of a plugin (server, UI, tools, migrations, specs) under `modules/<id>/`,
  `src/routes/**` only thin route files? *Recommend yes*, enforced by S3 with an allowlist that only
  shrinks; official plugins move one per slice (Calendar/Contacts already follow it: `modules/*/ui`).
- **Q2 Shell slots** — the shell knows the Assistant today (it imports the bar and panel). Should the shell
  get named slots (top-bar centre, side panel, dashboard ask box) that a plugin fills, so a company's own
  assistant can replace the official one? *Recommend yes, but only a fixed, small slot list* (no generic
  UI hooks — the phase-extensions "no patching core" rule).
- **Q3 Approvals with the Assistant off** — today they are decided in the Assistant's conversation (or
  over MCP/CLI). With it off the dashboard lists them without a way to decide in the app.
  *Recommend:* an Approve/Deny list in core (Dashboard → Needs you), so approvals never depend on a plugin.
- **Q4 Versioned contract** — the extension contract (phase-extensions §2) as `Extension API 1.x` for
  official plugins too? *Recommend:* one contract for both, version it now at 1.0 with what official
  plugins already use (manifest, tools, events, routes map, background `pluginOn`, shell slots of Q2);
  "same contract" = the same tool names + schemas, so a company plugin can replace an official one.
- **Q5 Company plugins alongside official ones** — installed from the company's extensions repo by ee as
  their own process (phase-extensions X1), or in-process first? *Recommend:* out of process as approved
  (X1); no in-process company code. Two plugins implementing the same contract may not both be on
  (the kernel refuses the second — needs a `provides: <contract>` field on the manifest).
- **Q6 What is Memory** — are `ontology`, `embeddings`, `retrieval`, `graph` Memory's or shared core
  (Drive, Contacts and the agent's grounding use them)? *Recommend:* retrieval/embeddings/ontology core
  (search infrastructure), capture/consolidation/timeline/text-files Memory.
- **Q7 Conversation store** — `chat_message` is written by the core engine and read by the Assistant.
  *Recommend:* core owns the store (engine), the Assistant reads it through an engine port.

Decision for the owner's review (round 5): the Assistant is a plugin; the durable agent engine, the
kernel registry, approvals, the activity log and speech stay core (see "Stays core" above).
