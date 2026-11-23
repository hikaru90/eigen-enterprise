# Parity debt: UI-only actions that must become registry actions

<!-- Generated from src/lib/kernel/ui-parity.ts by src/lib/kernel/ui-parity.spec.ts. Do not edit by hand:
     change the map, then run `npx vitest run src/lib/kernel/ui-parity.spec.ts -u`. -->

Registry-first (plan/phase-company-brain.md §1, CB4): everything clickable is a kernel registry
action first, so the `ee` CLI, MCP and the agent get it too. Every mutating entry point of the app
(form actions, POST/PUT/PATCH/DELETE handlers) is mapped in `src/lib/kernel/ui-parity.ts`; the gate
fails on an unmapped one, and the debt below can only shrink (`DEBT_CEILING`). Each stage-3
milestone (CB8–CB13) clears its module’s section.

Mutating entry points: **340** — tool 202, human-only 46, transport 48, no effect 16, **debt 28**.

| Module | Debt |
|---|---|
| kernel | 9 |
| calendar | 7 |
| calls | 6 |
| members | 4 |
| assistant | 1 |
| website | 1 |

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
