# Contribute board round — 2026-11-19

Source: production board (os.cerberusblue.com → Contribute), status `requested`, read 2026-11-19 via the cerberusblue MCP endpoint.

## Triage

| Board id | Item | Call |
|---|---|---|
| 65cff7b3 | Company switcher top-left | **Decline** — owner note: feature creep, companies live on different domains |
| f8fce7ef | Rename Brand → Marketing | **Leave** — evaluated already, owner's decision pending |
| e3846ef8 | Messages drop the line breaks I typed (bug) | Round 1 · WS `msg-text` |
| 468d46cb | Chat draft vanishes when I click away (bug) | Round 1 · WS `msg-text` |
| e5e54be0 | Voice messages: play the recording, not only the transcript | Round 1 · WS `msg-voice` |
| a192fe00 | "Ask the assistant" → "Ask the company brain" | Round 1 · WS `brain` |
| 6d5eb456 | Show how many decisions the Brain knows | Round 1 · WS `brain` |
| 5e206f7f | Call duration clock during a call | Round 1 · WS `calls` |
| 4e40a672 | Auto transcript in meetings | Round 1 · WS `calls` |
| 7f5f5423 | Company Brain can optionally join a call | Round 2 · after `calls` merges (builds on transcripts) |
| — | MCP `tools/list` invalid: `settings.update` inputSchema is a top-level `oneOf`, no `type: "object"` → Claude Code loads none of production's tools | Round 1 · WS `mcp-schema` (found while reading the board) |

In-progress items (plugins, accessibility, calendar, brand extraction, brand material) are untouched this round.

## Workstreams (round 1, parallel worktrees under `.claude/worktrees/`)

- **msg-text** — `src/lib/messages/message-composer.svelte`, message body rendering, a draft store per conversation. Line breaks survive send → store → render; a typed draft survives navigating away and back (per conversation, per browser, cleared on send).
- **msg-voice** — voice attachments: the recording is kept and a play button sits above the transcript. Own playback component; `message-row.svelte` touched only to mount it.
- **brain** — product copy "Ask the company brain" wherever the assistant entry says "Ask the assistant"; a "Your Brain knows N decisions" counter, counted from typed memory (ontology), never text matching. If memory has no typed decisions, the agent counts what *is* typed and logs that as a decision for the owner.
- **calls** — elapsed-time clock in the call view; per-person transcripts (direction agreed 2026-11-19: each browser records its own mic in ~30 s chunks → batch STT on `qwen/qwen3-asr-1.7b` → merged by timestamp; no bot, consent per person, visible indicator).
- **mcp-schema** — every tool's `inputSchema` advertised over MCP has `type: "object"`; a test pins it for all registered tools.

## Round 2 — Company Brain in the call (7f5f5423)

Design from the user's feedback ("trying too hard"): **off by default, the host switches it on per call, visible to everyone**. It only listens (reads the transcript), never speaks or posts unasked. It answers only when someone addresses it (button / mention), in the call's side panel, briefly, from memory and the transcript. After the call it offers a recap, it doesn't post one. No proactive ideas, no questions back during the call.

## Decisions

- Draft persistence is per browser (localStorage-backed, per conversation), not synced to the server — an unsent draft is a per-viewer convenience.
- Orchestrator alone edits `plan/progress.md` and the board; agents commit only to their branch.
- Shipping = merged to `main`, gate green, released, on production; the board item is marked `shipped` only once live on os.cerberusblue.com.

## Round 3 — what other installs shared (central board, "All installs")

Read via `contribute_hub.list` (all from install `46faacaa…` = ee-one). Their status is owned by the install that shared them, so they are marked done on ee-one's own board, not here.

| Remote id | Item | Call |
|---|---|---|
| 6ea81bc5 | Attach documents in the AI assistant | WS `assistant-input` |
| 5ef181df | Assistant voice input: mic left of send, explain the speaker control | WS `assistant-input` |
| e5f38b2c | Drive: drag files into folders created in the current view | WS `drive` |
| 604b1375 | Drive: upload whole folders | WS `drive` |
| cf5b7f1d | Assign a task to a member → their "Needs you", feedback to the assigner | WS `member-tasks` |
| 47141f10 | Internal documents never become website pages (Drive / Memory instead) | WS `website-guard` |
| cdb96072 | Voice input on every field | Later — touches every form; after round 3 |
| 7478dbe4 | Create decks (pitch decks) | Later — feature of its own |
| 3668d181 | Memory: Notes vs Capture, Tasks vs Projects | Owner's call (product structure) |
| 6950f7a7 | "Test." | Skip |

- **Decision:** `contribute.list` returns `allInstalls` (what every install shared) next to this company's proposals on the central board install, for those who manage the board — same rule as the "All installs" tab (commit `0a98c201`).
