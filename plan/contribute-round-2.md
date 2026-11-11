# Contribute board, round 2 (triage, not started)

Source: os.cerberusblue.com over its MCP, `contribute.list status:all`, read 2026-11-11.
The board now has 24 proposals: 12 from round 1 (see `progress.md`, "Production Contribute
board, round 1") and **12 new**, all posted 16:54–18:49 by one member, all `requested`.
No board status on production has been changed.

Production runs **v0.5.1**. v0.5.2 is held (see `progress.md`, the HOLD entry), so some of
these reports are about bugs that main has already fixed.

## A. Bugs

| # | Proposal (id prefix) | What we know | Work |
|---|---|---|---|
| A1 | `ca3bb7b9` "Members and invites currently throws 502" | `/settings/members` load calls `memberDeps()`, `listMembers`, `listGroups`. Can't tell the cause from code. On production `members.list` / `members.group_list` over MCP work; no code returns 502 (that's the proxy when the app doesn't answer). | Read the production server log for the 502 first, then write a failing test and fix. |
| A2 | `ffa2aa98` Brand extraction from the site URL fails: `/api/brand/extract/start failed (500)` | **Cause found:** capture launches Playwright Chromium; releases ship no browser (`npm ci --ignore-scripts`, no `playwright install`). | Owner decision: ship headless Chromium to servers (how), or capture without a browser. Either way the failure must say what's missing, not "Internal Error". |
| A3 | `3c1e9fb0` Voice message: "couldn't transcribe the recording" | **Fixed on main, released in v0.5.2** (`542bd65`: STT model had no OpenRouter endpoints). Production is still on v0.5.1. | No code. Fixed by the upgrade once the hold is lifted. Then check with a real microphone. |
| A4 | `a7e819fe` "TTS is still broken. Maybe missing creds or keys?" | Known: the voice model `qwen/qwen3-tts-flash-2026-02-10` has 0 OpenRouter endpoints. A fix was proposed separately and has not landed. | **Fixed on main** (not committed): `qwen/qwen-audio-3.0-tts-flash`, voice `longanhuan_v3.6` (owner: Qwen, female voice). Not tried live. |

## B. Small ideas (one workstream each)

| # | Proposal | Work |
|---|---|---|
| B1 | `6a3b17ba` Admin: edit the company name and logo in the top-left corner | Doesn't exist. The name comes from `foundingCompanyName()` (`src/lib/server/overview/sources.ts`), and nothing can edit it. There is no company logo. Add both to Settings for owner/admin. Question: should the logo come from Brand (active style) or be uploaded? |
| B2 | `7fa15491` Memory: "Does it stay with me? What can leak? Can I delete things?" | Add a note like Drive's "Who can see your Drive" (`81e69bf`): who can read memory, what the agent sees, what leaves the server (LLM provider). Also check that deleting a memory entry works and is easy to find. |
| B3 | `119f59a4` Messages: online / reachable status (like Teams or Slack) | There is no presence today. Show online / away from open sessions or SSE connections, plus a status the person sets. Question: who sees it (everyone in the company)? |
| B4 | `1ab7cd3f` Drive: an archive for old files you don't want to delete, with the assistant's help deciding what goes there | Archive state per file/folder (hidden from the default view, still searchable), plus an agent tool that suggests candidates. The person approves each move. The assistant's suggestions must be LLM-judged (no string heuristics). |
| B5 | `b73604ff` Accessibility: contrast (dark grey on light grey), font sizes, spacing | Contrast check of the design tokens against WCAG AA, then fix the tokens. Add an automated a11y check (axe) to the component/e2e suites. |

## C. Large ideas (need an owner decision before planning)

| # | Proposal | Question for the owner |
|---|---|---|
| C1 | `eb674853` + round-1 `b8a87a25` Email should open on the **inbox** | Inbound mail isn't stored at all today (no inbox). Needs receiving (IMAP poll or inbound webhook from the mail provider), storage, and threading. Its own plan, like `video-calls.md`. |
| C2 | `2212c421` Contacts as a people tracker: name, where we met / channel (LinkedIn, phone, mail), why they matter (partner, customer, funder, VC, production). Newsletter shouldn't dominate. "Goes beyond email", "my most important tool right now" | Own **Contacts** module (people + tags + channels, used by Email, Messages, Calls), or inside Email? Recommendation: own module, with Email's newsletter list moved under Marketing. Tags are typed in an ontology, not free text. |
| C3 | `df14e05a` Calendar with appointments: phone notifications before a call, company-visible vs private events ("out of office"), works at night | New **Calendar** module. Questions: own calendar only, or sync with Google/Outlook (CalDAV/ICS)? Push notifications to the phone need the installed PWA (`Install app`) and Web Push. Links to Calls (a meeting starts a call). |

## D. Carried from round 1, still open

- **Video calls** (`messages`, still `requested` on the board): built (Calls S1–S4 on main). Waiting for the box proof and lifting the v0.5.2 hold / v0.5.3. Mark it shipped after the production upgrade.
- **Brand guide upload** (`brand`): blocked on the owner's choice: (a) file/image input in the gateway, or (b) a PDF text extractor.
- **Brand material** (`in_progress`): banners, trade-fair posters, merch still "Coming".
- **Email "who to write next"** (`in_progress`): needs a rule set by the owner. C2 (contacts with tags) would give it the data.
- **Dashboard "top priorities" summary**: gap noted in round 1, no proposal open.

## Suggested order

1. A1, A2 (production logs needed: who can read them on os.cerberusblue.com?), A4. Then the box proof, so A3 and the video calls ship with the next upgrade.
2. B1–B5 as parallel worktree workstreams (disjoint files).
3. Owner decisions on C1–C3, then one plan file each.
4. After each release reaches production: set the board statuses and notes over `contribute.update` (only with the owner's go-ahead).
