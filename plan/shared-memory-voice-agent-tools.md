# Shared projects, voice input everywhere, the brain on every tool (2026-11-21)

Owner, 2026-11-21: "I want you to make the following memories and projects … be shared … across the company. The default should be sharing them. If somebody creates a project … there could be a toggle saying this should be absolutely private, nobody has access to it. … In general I should be able to see projects of my other team members." · "All input fields should have a voice speech to text function like in contribute, and especially ask the company brain input field." · "Make sure that the ask the company brain field, so the agent field, is connected to all tools and has access to all tools using eigen CLI." · "I'm gonna go away, you're on your own, plan for it, use subagents, and then execute."

## 1. Shared Memory (WS `memory-share`)

**Decision (owner, overrides `plan/phase-company-brain.md` §4 "authored work starts private" for these kinds):**
- **Projects** start **shared with everyone in the company**. Every member sees every shared project, its tasks and its progress, read-only unless they own it (or it's the Roadmap system project, as today).
- **Notes** (Memory › Notes, text files) start **shared with everyone** too ("memories").
- A **Private** toggle on each project and note: private = readable by its owner only, with **no admin or owner override** (§4 "Private means readable by its owner only").
- Tasks inside a project follow the project. Tasks not in any project stay private to their person.
- **Raw thoughts / Capture stay private** (§4: thoughts are never readable on demand by others). What gets shared is what the person put into a project or a note. Logged as the agent's interpretation of "memories", and the owner may widen it.
- Existing items: a migration switches existing projects and notes to shared, *except* items that carry an explicit private marker, if any exist. Because this changes who can read existing data, it is announced in `plan/progress.md`.
- Enforcement is RLS at company scope (owner + visibility on the row); retrieval filters by access before ranking. Encryption keys must let every member read shared items: no per-person-key content in a shared row.
- The assistant/brain sees shared projects and notes of colleagues in its answers, same rule.

### Design (WS `memory-share`, 2026-11-21)

**Today.** A project is a `canonical_entity` row with `project_status` set (label plain text); its tasks are `thought` rows (`category = 'task'`) linked through `thought_entity` (+ `project_task_sequence` ranks, `project_milestone`, `temporal_event` dates). A note is a `text_file` row (title plain, body only in `body_text_encrypted`). Thoughts carry `*_encrypted` copies of their text and metadata. Every Memory table has one RLS policy `user_id = app.current_user_id` (enable_rls.sql, re-applied after every migrate by ee preStart). Content is encrypted with the row owner's DEK (`tenant_data_key`, itself RLS-scoped to its user), so another member's session can neither see nor decrypt it. The Roadmap system project is read by switching the DB session to the company owner (roadmap store `withUserDb(ownerId)`). Services take the Memory owner's id and filter `user_id = owner` explicitly; RLS is the guarantee underneath.

**Visibility.** One column `visibility text not null default 'company' check in ('private','company')` on `canonical_entity` and `text_file` (the §4 dial; "shared with some" is not built). The migration's default makes every existing project and note shared; no explicit private marker exists on either today (checked: neither table has one), so nothing is kept private. Non-project entities carry the column but it means nothing: only rows with a live `project_status` (not `dismissed`) are ever shared.

**RLS (company scope).** The owner policy stays `FOR ALL` (all writes owner-only). A second, permissive `FOR SELECT` policy per table adds what a signed-in colleague (`app.current_user_id <> ''`) may read:
- `canonical_entity`: `visibility = 'company'` and a live project.
- `thought`: `category = 'task'` and linked (same owner) to such a project. Every other thought — Capture, notes-like thoughts, tasks outside projects, tasks of a private project — stays owner-only.
- `thought_entity`, `project_task_sequence`, `project_milestone`: rows of a shared project. `temporal_event`: rows whose thought the reader can see.
- `text_file`: `visibility = 'company'`. `thought_text_file` (note↔thought links) stays private.
- Write guard: `thought_entity`, `project_task_sequence`, `project_milestone` inserts/updates must point at the writer's own project, so a colleague can't hang a task on someone else's shared project.
Toggling `visibility` is a plain row update, so a project/note turning private disappears for everyone else on their next query. No admin or owner override exists in any policy.

**Keys.** A shared row must never need a per-person key. New `company_data_key` (one row, DEK wrapped by the master key like `tenant_data_key`, readable by any signed-in session). An envelope encrypted with it carries `"k":"company"`; `decryptTenantValue` picks the key from the envelope (explicit key id, no guessing), so every existing read path decrypts shared rows for every member unchanged, and refuses loud when asked to decrypt another person's personal-key envelope. Re-keying is one idempotent reconcile (`src/lib/server/memory/shared-memory-keys.ts`): a thought is company-keyed iff it is a task in a shared project; a note iff it is shared. It runs on every visibility toggle (both ways), on every write that links a thought to a project or rewrites a thought's ciphertext, on note writes, and once per user at server start (backfill for the migration, which cannot encrypt in SQL).

**Reads.** Colleague views call the existing owner-parameterised services with the *owner's* id inside the *reader's* session: RLS trims the result to what is shared, decryption uses the company key. Memory › Projects gets a Mine / Team switch (Team: colleagues' shared projects with owner name, tasks, progress); a colleague's project page is read-only (no edit, dismiss, review, task actions). Memory › Notes gets Mine / Team / All; a colleague's note opens read-only with its author. Own projects and notes get a Private switch (create + edit); Roadmap can't be made private.

**Registry (no UI-only actions).** `memory.set_project_visibility`, `memory.set_text_file_visibility` (owner only; the assistant acting for a person may only make things private, never widen — same leash rule as approvals); `memory.create_text_file` takes `private`; `memory.list_projects` / `memory.list_text_files` / `memory.search_text_files` / `memory.get_text_file` / `memory.get_project_timeline` include colleagues' shared items, each marked with owner and `editable`. Search filters by access in SQL before ranking. `memory.retrieve_thoughts` stays the person's own thoughts.

## 2. Voice input on every input field (WS `voice-everywhere`)

- One dictation affordance (the existing dictation stack, model `qwen/qwen3-asr-1.7b`, the way Contribute does it) on every free-text field: the shared Textarea and text-like Input primitives, plus the app's own composers. **"Ask the company brain" first.**
- Not on password, email, number, URL, code, OTP, date and search-as-filter fields.
- Dictated text goes in at the cursor; the person can edit before sending. Nothing auto-sends.
- One component, opt-out per field; fails loud and visibly when STT isn't configured (no silent hiding).

## 3. The brain reaches every tool (WS `brain-all-tools`)

- The "Ask the company brain" agent reaches **every kernel registry tool the asking person may run**, through the `ee` CLI (src/cli, the agents' native hands, no MCP hop), instead of a curated subset.
- Permission is unchanged: the agent runs *as the person* (CB3), so role checks, RLS, approvals and destructive-tool gating stay exactly as they are. "All tools" means all tools within the person's reach, never escalation.
- A test pins it: every registered tool the person's role allows is reachable from the brain; a member still can't reach admin-only tools.

## Workstreams

Three worktrees under `.claude/worktrees/`, tests first, unit + component only (the orchestrator runs e2e). `memory-share` owns the Memory data layer, the project/note pages, and the only migration. `voice-everywhere` owns the shared input primitives and composers, and touches the Memory pages only through those primitives. `brain-all-tools` owns `src/lib/server/agent`, `src/cli` and the brain's tool exposure.
