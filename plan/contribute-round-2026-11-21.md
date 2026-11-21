# Contribute board round — 2026-11-21

Source: os.cerberusblue.com over the cerberusblue MCP (`contribute.list`, `contribute_hub.list`), read 2026-11-21. Production runs v0.5.30.
Owner: "get newest contributions from all companies over the cerberus mcp and integrate them. ill be away, you are on your own".

## Board housekeeping (done)

The 11-19 round is in v0.5.30, which is live on production, so these are now `shipped` with a note:
e3846ef8 (line breaks), 468d46cb (drafts), e5e54be0 (voice playback), a192fe00 ("Ask the company brain"), 6d5eb456 (decisions counter), 5e206f7f (call clock), 4e40a672 (transcripts), 7f5f5423 (Brain in the call), 19cf0d97 (ingest "Platform EUrouter not configured": fixed by CB1 `33f6c193`; on production all thoughts after 10-21 are `complete`, the 15 `pending` are the owner's from 10-21 and index when the owner opens Memory).

## New since the 11-19 round

### This company (cerberusblue)

| Board id | Item | Call |
|---|---|---|
| 2c414719 | Recurring reminders (weekdays + time), shown on the dashboard / Needs you when online, stay until done or snoozed, pausable, deletable | WS `reminders` |
| a950ef11 | Assistant: after stopping a reply, edit my message and resend it | WS `assistant-edit` |
| 19cf0d97 | Ingest failed: Platform EUrouter not configured | Already fixed (above) |

### Other installs (central board, all from `46faacaa…` = ee-one)

Their status belongs to the install that shared them; nothing is marked here.

| Remote id | Item | Call |
|---|---|---|
| 87f5b9f8 | No notifications after adding the app to the phone's home screen (bug) | WS `pwa-push` |
| e9490497 | Add and delete Memory tasks through the assistant | WS `memory-tasks-agent` |
| d5e61e1f | Memory: the "no project" checkbox looks like a choice but completes the task | WS `memory-ux` |
| 6b5eda9f | Memory: what is the pinned roadmap at the top, and why is it pinned | WS `memory-ux` |
| d6264dd1 | Drive: PDF full view, dismiss the details pane | WS `drive-ux` |
| b94496fe | Sharing: drop the extra "Add" step, "Save" takes the people picked | WS `drive-ux` (replaces a step: announced) |
| 89815b8d | Chat reactions: every emoji, not only 10 | WS `reactions` |
| bcd930e2 | Rename "Contribute" to "wish button", other emoji than the bulb | **Owner's call** (product naming) |
| 11f05e24 | One input bar that sorts everything into the right Memory area; Note vs Capture | **Owner's call** (Memory structure, with 3668d181) |
| cdb96072, 7478dbe4, 3668d181 | Voice everywhere, decks, Notes vs Capture | Unchanged from 11-19: later / owner's call |
| 6950f7a7 | "Test." | Skip |

## Workstreams

One worktree each (`.claude/worktrees/`), disjoint files, tests first, unit + component tests only in the worktree (the e2e harness has fixed ports; the orchestrator runs e2e after merging). Only `reminders` may add a migration.

## Decisions

- Board items are marked `shipped` only once live on os.cerberusblue.com; this round's items stay as they are until the owner releases.
