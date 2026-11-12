# Contribute board, round 4 (triage, not started)

Source: os.cerberusblue.com over its MCP, `contribute.list status:all`, read 2026-11-12.
36 proposals: **12 new** since the round-2 read (11–12 Nov), all `requested`, plus 13 status
changes made by the round-3 / v0.5.5 work. Production runs v0.5.5. No board status changed here.

One new one is already done: `2bda4814` (403 shown; hide what I can't use) was round 3 W2 and is
`shipped` on the board.

## A. Bugs

| # | Proposal | What we know | Work |
|---|---|---|---|
| A1 | `cccc91c0` `/settings/passkeys` → 500 "Internal Error" | The load calls `auth.api.listPasskeys` + `auth.api.listSessions` (`src/routes/(nucleus)/settings/passkeys/+page.server.ts`); the passkey plugin is wired (`@better-auth/passkey` 1.7.12). **Nothing in the production journal**: `handleError` (`src/hooks.server.ts:236`) only sends to PostHog and never logs, so every unexpected 500 is invisible on the server. | (1) `handleError` also writes the error + route to the server log (fail loud; redact credentials). (2) Reproduce signed in on production (or the box), failing test, fix. |
| A2 | `7e2ac4c8` A call **hangs up when you open another page** (went to Email during a call) | By design today: `/calls/[id]` hangs up in `onDestroy` / `pagehide` (`src/lib/calls/call-view.svelte`). | The call lives in the nucleus layout, not the page: navigating keeps it; a docked mini call (names, mute, hang up, back to call) on every page; hang-up only by the button or closing the tab. Two-browser e2e: navigate during a call, both stay connected. |
| A3 | `7f1f8a6a` + `bf41c35d` Replacing the company logo: macOS wants Chrome to have Desktop access; after saying no, "Replace logo" does nothing | `settings/company/+page.svelte`: "Replace logo" is the form's **submit** button next to a native file input (`required`), so clicking it without a chosen file only triggers the browser's validation, and no picker opens. The Desktop prompt is macOS (Chrome → Desktop folder), not us. | "Replace logo" opens the picker and uploads on pick; drag-and-drop and paste (⌘V) as alternatives that need no folder access; one line on how to allow Chrome later (System Settings → Privacy & Security → Files and Folders). Component test. |

## B. Small (one workstream each)

| # | Proposal | Work |
|---|---|---|
| B1 | `feba04ff` Memory's "Active" dot should be green | The shared `StatusPill` (`src/lib/components/page/status-pill.svelte`) colours "on" with `bg-primary` (the brand colour), on every module header (Memory, Contacts, Website, generic module page). Use a success (green) token, AA in light + dark. Its label is `text-[11px]`, under round 3's 13px minimum: fix together. |
| B2 | `f02fb253` Choose audio devices in calls (dropdown) | No device picking today. Microphone + speaker (and camera) dropdowns in the call controls; LiveKit `switchActiveDevice`, list from `enumerateDevices`, refresh on `devicechange`; speaker output only where the browser supports it (say so where it doesn't). |
| B3 | `7e2ac4c8` (second half) Call layout "side by side, flat"; should adapt and use the space | Adaptive grid: speaker / active-talker view, tiles sized to the room and the window, screen share large. Goes with A2 (same files): one workstream. |
| B4 | `2ac70cc5` Restore backups, not only make them | Restore exists on the CLI only (`ee restore`, `ee restore --verify`, `ee/src/backup/README.md`). Settings → Backups gets "Check a backup" (verify, writes nothing) and "Restore" (owner only, typed confirmation; the box restores to that snapshot and restarts). Restore wipes the current state: needs the owner's go on the UX and on whether a partial restore (one file / one module) is wanted. |

## C. Need an owner decision first

| # | Proposal | Question |
|---|---|---|
| C1 | `94641271` + `678ff079` Contacts by voice: say freely who someone is, how you met, channel, email/phone, next steps; the AI fills in the contact. The form always stays (accessibility) | Fits the existing pieces: dictation (`voice-dictation.svelte`) → LLM extraction through the gateway with a JSON schema of the contact fields → the prefilled form to check and save (never saved unseen). Small decision: also for "Log a contact" / follow-ups? Recommended: yes, same flow. |
| C2 | `d8ec9006` Read call appointments out of emails → a proposal → accept → calendar entry + invitation sent | Needs the Email inbox (`plan/email-inbox.md`, S1–S2 in progress) and a Calendar (`df14e05a`, not planned yet). Decide the Calendar first (own module, or sync with Google/Outlook?), then this is a slice of it. |
| C3 | `c05c3a40` "Stable core + officially endorsed plugins": Messages, Calls, Website, Email … are plugins; people extend by building their own; an overview of which plugins are active and a way to switch them out | Close to `plan/phase-extensions.md` (approved 2026-11-03: core never forked, company features are own-process extensions). New in this ask: (a) today's built-in modules become swappable official plugins; (b) a **Modules** page in Settings: the kernel already has `kernel.module_list` / `module_activate` / `module_deactivate`, but no page uses them. Recommendation: build (b) now; (a) is the extensions plan's X-phases and changes the architecture, so it needs a plan update and the owner's go. |

## Suggested order

1. A1 (`handleError` logging first: it makes every later 500 diagnosable), A3 + B1 (one small workstream: company page + status pill), A2 + B3 (calls: one workstream), B2 (calls controls, after A2 or in the same stream).
2. Owner answers on B4, C1–C3. Then C1 and the Modules page (C3b).
3. After release: set board statuses over `contribute.update` with the owner's go-ahead.
