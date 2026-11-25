# Make-a-wish round — 2026-11-25

Source: every eigenEnterprise board. one.eigenenterprise.app (`eigen` MCP, `contribute.list`), os.cerberusblue.com's own board (`cerberusblue` MCP, `contribute.list`) and the central hub of all installs (`contribute_hub.list`), read 2026-11-25. Owner: "get the latest contributions and integrate them … spawn subagents" · "i want all contributions. all eigenenterprise contributions."

## Board state at read

- The six v0.5.42 wishes (brand bare host, sortable tables, Call now, outside invites, video quality, noise cancellation) stay `in_progress` until v0.5.42 is installed on one.eigenenterprise.app.
- Hub 41ad3156 (light mode, install 5a952997…): already built (`f9bb6573`, Light · Dark · System). The hub shows the remote install's own status, so it can't be closed from here.
- cerberusblue ffa2aa98 (brand website capture): code shipped in v0.5.37, the box runs an older version. Stays `in_progress` until it's installed there.
- cerberusblue c05c3a40 (stable core + endorsed plugins): continues through the upgrades and module-hub phases (U2). Nothing new this round.

## Workstreams (one subagent each, own worktree in `.claude/worktrees/`)

| Id | Board | Item | Workstream | Migration |
|---|---|---|---|---|
| 2a0ed534 | ee-one | Column sorting: the last table, Assistant activity | `activity-sort` (sorting flattens the grouping over the loaded rows; third click restores it) | — |
| 30a8d920 | ee-one | Part 2: see what the company brain has taken in | `brain-intake` (read tool + page) | (0185 only if unavoidable) |
| 057cd4d5 | ee-one | Questions for staff, tags, answered in the brain | `staff-questions` | 0183 |
| b92e6ba5 | ee-one | Handover page the brain keeps up to date | `handover` (v1 + `plan/handover.md`) | 0184 |
| 3b18c845 | ee-one | Capture traces from every box | `traces-concept`, plan only (`plan/traces-phone-home.md`): it sends company data off the box, so concept and owner choices come first | — |
| fc3c5174 | ee-one (via hub) | Co-worker changes don't save on Save | `coworker-save` (bug) | — |
| 288dc1d2 | cerberusblue | Brand material: export/download, logo, AI texts | `brand-material` | — |
| df14e05a | cerberusblue | Calendar: phone reminders, call from the event (Google/Outlook sync assessed, not built) | `calendar-remind` | (0186 only if unavoidable) |
| b73604ff | cerberusblue | Accessibility: the ~60 remaining spots | `a11y-rest` | — |

## Not this round

- 11f05e24 decision-model sorting of the one input (part 2): waits on the decision-model wiring.
- 7478dbe4 decks: later, unchanged.

## Decisions

- Migration numbers are assigned up front (0183 questions, 0184 handover, 0185/0186 reserved) so parallel branches merge without journal collisions.
- Traces leave the box only after a concept the owner approves; no code this round.
