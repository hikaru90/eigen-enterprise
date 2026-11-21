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
