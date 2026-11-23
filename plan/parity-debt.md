# Parity debt: UI-only actions that must become registry actions

<!-- Generated from src/lib/kernel/ui-parity.ts by src/lib/kernel/ui-parity.spec.ts. Do not edit by hand:
     change the map, then run `npx vitest run src/lib/kernel/ui-parity.spec.ts -u`. -->

Registry-first (plan/phase-company-brain.md §1, CB4): everything clickable is a kernel registry
action first, so the `ee` CLI, MCP and the agent get it too. Every mutating entry point of the app
(form actions, POST/PUT/PATCH/DELETE handlers) is mapped in `src/lib/kernel/ui-parity.ts`; the gate
fails on an unmapped one, and the debt below can only shrink (`DEBT_CEILING`). Each stage-3
milestone (CB8–CB13) clears its module’s section.

Mutating entry points: **340** — tool 171, human-only 46, transport 48, no effect 16, **debt 59**.

| Module | Debt |
|---|---|
| memory | 31 |
| kernel | 9 |
| calendar | 7 |
| calls | 6 |
| members | 4 |
| assistant | 1 |
| website | 1 |

## memory (31)

- `/(nucleus)/m/memory/settings ?/deleteArchived` — Delete archived thoughts for good.
- `/(nucleus)/m/memory/tasks ?/seen` — Mark an assigned task seen.
- `/api/agents/[id]/assign POST` — Hand a thought to a connected external agent.
- `/api/agents/[id]/projects POST` — Bind a connected agent to a project.
- `/api/agents/[id]/projects/[projectId] DELETE` — Unbind a connected agent from a project.
- `/api/capture/edit POST` — Edit a stored thought.
- `/api/capture/enrich-retry POST` — Retry the enrichment of a thought.
- `/api/capture/relink POST` — Re-link a thought in the graph.
- `/api/entities/[entityId] DELETE` — Delete an entity.
- `/api/entities/[entityId] PATCH` — Edit an entity.
- `/api/entities/[entityId]/sync POST` — Re-sync an entity and its relations to the graph.
- `/api/graph/rearrange POST` — Clean up my graph (prune, repair relations).
- `/api/grounding/question POST` — Answer a check-in question (keep or archive a thought).
- `/api/scheduled-tasks/[taskId] DELETE` — Delete a scheduled task.
- `/api/scheduled-tasks/[taskId] PATCH` — Pause or resume a scheduled task.
- `/api/scheduled-tasks/[taskId] POST` — Run a scheduled task now.
- `/api/scheduled-tasks/[taskId]/retry POST` — Retry a failed scheduled task.
- `/api/temporal-events/[id]/action POST` — Reschedule, snooze or complete a timeline item.
- `/api/text-files/[fileId] DELETE` — Delete a note.
- `/api/thoughts/[thoughtId] DELETE` — Delete a thought.
- `/api/thoughts/[thoughtId] PATCH` — Open, complete or archive a thought.
- `/api/thoughts/[thoughtId]/text-files POST` — Link a note to a thought.
- `/api/thoughts/[thoughtId]/text-files/[fileId] DELETE` — Unlink a note from a thought.
- `/api/timeline/projects POST` — Create a project.
- `/api/timeline/projects/[entityId]/deadline POST` — Set a project deadline.
- `/api/timeline/projects/[entityId]/dismiss POST` — Dismiss a project.
- `/api/timeline/projects/[entityId]/milestones POST` — Set a project milestone.
- `/api/timeline/projects/[entityId]/order POST` — Reorder a project’s tasks.
- `/api/timeline/projects/[entityId]/review/apply POST` — Apply a project review (task statuses, new tasks).
- `/api/timeline/projects/[entityId]/update PUT` — Rename a project.
- `/api/timeline/projects/assign POST` — Assign a thought to a project.

## kernel (9)

- `/(nucleus)/m/memory/settings ?/settings` — My notification settings.
- `/(nucleus)/settings/backups ?/run` — Run a backup now.
- `/(nucleus)/settings/company ?/recropLogo` — Re-crop the company logo.
- `/(nucleus)/settings/company ?/removeLogo` — Remove the company logo.
- `/(nucleus)/settings/company ?/uploadLogo` — Upload the company logo (image bytes + crop).
- `/(nucleus)/settings/llm ?/saveModelConfig` — Chat and embedding model or rule; settings.update covers only the chat model and rule.
- `/(nucleus)/settings/llm/byok/[provider] ?/saveModelConfig` — Chat and embedding model or rule (same actions as Settings › AI).
- `/(nucleus)/settings/updates ?/update` — Install a new eigenEnterprise release.
- `/api/settings/notifications PUT` — My notification settings.

## calendar (7)

- `/(nucleus)/m/calendar ?/acceptProposal` — Accept an appointment found in mail (event + invitation).
- `/(nucleus)/m/calendar ?/delete` — Delete an event, a series or one occurrence.
- `/(nucleus)/m/calendar ?/dismissProposal` — Dismiss an appointment found in mail.
- `/(nucleus)/m/calendar ?/preferences` — Default visibility of my new events.
- `/(nucleus)/m/calendar ?/save` — Create or edit an event, a series or one occurrence (or accept a proposal with edits).
- `/(nucleus)/m/email/inbox ?/acceptProposal` — Accept the appointment found in this mail.
- `/(nucleus)/m/email/inbox ?/dismissProposal` — Dismiss the appointment found in this mail.

## calls (6)

- `/api/calls/[id]/brain POST` — Switch the Company Brain on or off in a call.
- `/api/calls/[id]/brain/answers/[answerId]/share POST` — Share a Brain answer with the call.
- `/api/calls/[id]/brain/recap POST` — A recap of the call by the Company Brain.
- `/api/calls/[id]/guests POST` — Invite guests by email to a call.
- `/api/calls/[id]/guests/[guestId] DELETE` — Remove a guest from a call.
- `/api/calls/meetings POST` — Book a meeting (now or later) with guests by email and a duration.

## members (4)

- `/(nucleus)/settings/members ?/remove` — Remove a member.
- `/api/onboarding/name POST` — Set what I am called.
- `/api/profile PUT` — Set my first and last name.
- `/api/profile/avatar POST` — Set my profile picture (image bytes, cropped).

## assistant (1)

- `/api/agent/runs/[id] PATCH` — Rename a conversation.

## website (1)

- `/api/onboarding/founding POST` — The founding interview (tone, name, positioning) as one act; its artifacts already run through website.* tools.
