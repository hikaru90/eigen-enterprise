# Contribute board round — 2026-11-23

Source: ee-one (`eigen` MCP, `contribute.list`), os.cerberusblue.com (`cerberusblue` MCP, `contribute.list` + `contribute_hub.list`), read 2026-11-23. ee-one runs v0.5.37, os.cerberusblue.com v0.5.35.
Owner: "get contributions from all boxes and start integrating them".

## Board housekeeping (done)

- ee-one 54c4b1d2 (check and correct call-summary items before the brain takes them): `shipped` — "Import into the brain" (`cd6d48ec`) is in v0.5.37, which ee-one runs.
- os.cerberusblue.com ffa2aa98 (brand website capture): stays `in_progress` — the Chromium capability is in v0.5.37, the box runs v0.5.35.
- The older cerberusblue items (plugins, accessibility, calendar, brand material) are unchanged.

## New since the 11-21 round

| Id | Install | Item | Call |
|---|---|---|---|
| bcd930e2, 3786cf54 | ee-one | Rename Contribute → "Make a wish" / "Wünsch dir was", magic-wand icon (agreed in the note) | WS `wish` |
| 593f7e08 | ee-one | PDF won't open: "Failed to fetch dynamically imported module" (version skew after a release) | WS `stale-chunk` |
| f45acdef | ee-one | Same-name upload: no "replace?" dialog | WS `drive-replace` |
| 6b91931f | ee-one (owner) | Prettier, rounder assistant chat; show tool calls | WS `assistant` |
| 30a8d920 | ee-one | AI budget transparency: cost per reply, my allowance, red zone | WS `assistant` (part 1; "what the brain absorbed" later) |
| 74cbc486 | ee-one (owner) | Read-aloud voice faster, volume adjustable | WS `tts` |
| bb05b451 | ee-one | Chat inside a call | WS `call-chat` |
| de821eda | ee-one (owner) | Navigating the website closes the chat and stops speech | WS `site-chat` |
| 41ad3156 | 5a952997… | Light mode switch | WS `light-mode` |
| fba4abf3, 11f05e24, 3668d181 | ee-one | Remove Capture; one input that files everything; Notes vs Capture, Tasks vs Projects | **Owner's call** (Memory structure; removing Capture is a removal) |
| b92e6ba5 | ee-one | Handover / status page the brain keeps up to date ("outbox" of the brain) | **Owner's call** (concept first) |
| 7478dbe4 | ee-one | Decks | Unchanged: later |

## Workstreams

One worktree each (`.claude/worktrees/`), disjoint files, tests first, unit + component tests only in the worktree; the orchestrator runs e2e after merging. No migrations this round (AI Co-workers wave 1 is adding them).

## Decisions

- Board items move to `shipped` only once live on the install that shared them.
- Internal ids (`contribute` module, `/contribute`, `contribute.*` tools) stay; only labels become "Make a wish".
