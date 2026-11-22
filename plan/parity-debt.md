# Parity debt: UI-only actions that must become registry actions

<!-- Generated from src/lib/kernel/ui-parity.ts by src/lib/kernel/ui-parity.spec.ts. Do not edit by hand:
     change the map, then run `npx vitest run src/lib/kernel/ui-parity.spec.ts -u`. -->

Registry-first (plan/phase-company-brain.md §1, CB4): everything clickable is a kernel registry
action first, so the `ee` CLI, MCP and the agent get it too. Every mutating entry point of the app
(form actions, POST/PUT/PATCH/DELETE handlers) is mapped in `src/lib/kernel/ui-parity.ts`; the gate
fails on an unmapped one, and the debt below can only shrink (`DEBT_CEILING`). Each stage-3
milestone (CB8–CB13) clears its module’s section.

Mutating entry points: **340** — tool 101, human-only 46, transport 48, no effect 16, **debt 129**.

| Module | Debt |
|---|---|
| email | 41 |
| memory | 31 |
| drive | 9 |
| kernel | 9 |
| messages | 9 |
| calendar | 7 |
| calls | 6 |
| contacts | 6 |
| members | 4 |
| brand | 2 |
| contribute | 2 |
| assistant | 1 |
| repos | 1 |
| website | 1 |

## email (41)

- `/(nucleus)/m/email/domains/[id] ?/delete` — Remove a sender domain.
- `/(nucleus)/m/email/domains/[id] ?/receiving` — Switch receiving (MX) on or off for a domain.
- `/(nucleus)/m/email/domains/[id] ?/tracking` — Open/click tracking for a domain.
- `/(nucleus)/m/email/inbox ?/createLabel` — Create a mailbox label.
- `/(nucleus)/m/email/inbox ?/createMine` — Create my own mailbox.
- `/(nucleus)/m/email/inbox ?/deleteLabel` — Delete a mailbox label.
- `/(nucleus)/m/email/inbox ?/label` — Put a label on a mail or take it off.
- `/(nucleus)/m/email/inbox ?/move` — Move a mail (archive, trash, a folder).
- `/(nucleus)/m/email/inbox ?/read` — Mark a mail read.
- `/(nucleus)/m/email/inbox ?/send` — Write or reply from a mailbox, with attachments (email.send_mail is the transactional sender, not a mailbox).
- `/(nucleus)/m/email/inbox ?/star` — Star a mail.
- `/(nucleus)/m/email/inbox ?/unread` — Mark a mail unread.
- `/(nucleus)/m/email/inbox ?/unstar` — Unstar a mail.
- `/(nucleus)/m/email/layouts ?/create` — Create a mail layout.
- `/(nucleus)/m/email/layouts/[id] ?/delete` — Delete a mail layout.
- `/(nucleus)/m/email/layouts/[id] ?/save` — Edit a mail layout.
- `/(nucleus)/m/email/logs/[id] ?/cancel` — Cancel a queued mail.
- `/(nucleus)/m/email/mailboxes ?/alias` — Add an alias address to a mailbox.
- `/(nucleus)/m/email/mailboxes ?/assign` — Give a member a personal mailbox.
- `/(nucleus)/m/email/mailboxes ?/disable` — Disable a mailbox.
- `/(nucleus)/m/email/mailboxes ?/enable` — Enable a mailbox.
- `/(nucleus)/m/email/mailboxes ?/removeAlias` — Remove an alias address.
- `/(nucleus)/m/email/mailboxes ?/shared` — Create a shared mailbox.
- `/(nucleus)/m/email/marketing/flows ?/create` — Create an email flow (email.flow_list only reads).
- `/(nucleus)/m/email/marketing/flows/[id] ?/delete` — Delete an email flow.
- `/(nucleus)/m/email/marketing/flows/[id] ?/save` — Edit an email flow.
- `/(nucleus)/m/email/marketing/flows/[id] ?/status` — Start, pause or stop an email flow.
- `/(nucleus)/m/email/marketing/lists ?/create` — Create a contact list.
- `/(nucleus)/m/email/marketing/lists/[id] ?/delete` — Delete a contact list.
- `/(nucleus)/m/email/marketing/lists/[id] ?/import` — Import people into a list (CSV).
- `/(nucleus)/m/email/marketing/lists/[id] ?/remove` — Remove a person from a list.
- `/(nucleus)/m/email/marketing/lists/[id] ?/settings` — List settings (double opt-in, public sign-up).
- `/(nucleus)/m/email/senders ?/makeDefault` — Make a sender the default.
- `/(nucleus)/m/email/senders ?/remove` — Remove a sender.
- `/(nucleus)/m/email/setup ?/events` — Wire SES delivery events (SNS topic, configuration sets) at Amazon.
- `/(nucleus)/m/email/setup ?/receiving` — Set up receiving at Amazon (bucket, topic, rule set).
- `/(nucleus)/m/email/templates ?/create` — Create a mail template.
- `/(nucleus)/m/email/templates/[id] ?/delete` — Delete a mail template.
- `/(nucleus)/m/email/templates/[id] ?/save` — Edit a mail template.
- `/(nucleus)/m/email/templates/[id] ?/test` — Save the draft template and send myself a test.
- `/api/onboarding/sender POST` — Make an address on a company domain the default sender (managed box).

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

## drive (9)

- `/api/drive/documents POST` — New empty Document (.md) or Table (.csv); drive.create_document makes .md with text only.
- `/api/drive/files/[id]/content PUT` — Save an office file’s bytes (PDF, Word, PowerPoint) as a new revision.
- `/api/drive/files/[id]/revisions POST` — Restore a file revision.
- `/api/drive/folders POST` — Create a folder.
- `/api/drive/items/[type]/[id] DELETE` — Move a file or folder to the trash, or delete it forever.
- `/api/drive/items/[type]/[id] PATCH` — Rename or move a file or folder.
- `/api/drive/items/[type]/[id]/grants PUT` — Share: set who may open or edit.
- `/api/drive/items/[type]/[id]/restore POST` — Restore from the trash.
- `/api/drive/upload POST` — Upload files.

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

## messages (9)

- `/api/messages/channels POST` — Create a channel.
- `/api/messages/conversations/[id]/attachments POST` — Upload files (or voice clips) for a message.
- `/api/messages/conversations/[id]/messages POST` — Post a message or a thread reply.
- `/api/messages/conversations/[id]/read POST` — Mark a conversation read.
- `/api/messages/dms POST` — Open a direct message.
- `/api/messages/messages/[id] DELETE` — Delete a message (own, or moderation).
- `/api/messages/messages/[id] PATCH` — Edit my message.
- `/api/messages/messages/[id]/reactions POST` — React to a message.
- `/api/messages/presence PUT` — Do not disturb on or off.

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

## contacts (6)

- `/(nucleus)/m/email/people/[id] ?/delete` — Delete a contact.
- `/(nucleus)/m/email/people/[id] ?/share` — Change who sees a contact.
- `/(nucleus)/m/email/people/import ?/import` — Import contacts.
- `/(nucleus)/m/email/people/settings ?/company` — Company default visibility of new contacts.
- `/(nucleus)/m/email/people/settings ?/mine` — My default visibility of new contacts.
- `/api/contacts/sharing POST` — Share many contacts at once, or make them private.

## members (4)

- `/(nucleus)/settings/members ?/remove` — Remove a member.
- `/api/onboarding/name POST` — Set what I am called.
- `/api/profile PUT` — Set my first and last name.
- `/api/profile/avatar POST` — Set my profile picture (image bytes, cropped).

## brand (2)

- `/api/brand/social/posts POST` — An uploaded social post (multipart files); the JSON graphic post is brand.social_post_create.
- `/api/brand/social/posts/[id] DELETE` — Delete a social post and its files.

## contribute (2)

- `/api/contribute POST` — Propose an improvement.
- `/api/contribute/[id]/vote POST` — Vote on a proposal.

## assistant (1)

- `/api/agent/runs/[id] PATCH` — Rename a conversation.

## repos (1)

- `/(nucleus)/drive/github ?/setRepo` — Choose a repo to sync into Drive, or stop syncing it.

## website (1)

- `/api/onboarding/founding POST` — The founding interview (tone, name, positioning) as one act; its artifacts already run through website.* tools.
