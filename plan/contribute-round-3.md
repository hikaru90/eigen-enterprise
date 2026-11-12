# Contribute board, round 3 — features, not only bugs

Source: os.cerberusblue.com, `contributions` table read 2026-11-12 (read-only SQL over SSH; the
MCP is not configured in this session). 25 proposals, 1 new since round 2 (`2bda4814`).
Owner: "look at all features … really think about what would improve the project … don't just
debug fix, please also ship features."

## State of every open proposal

| id | Ask | State |
|---|---|---|
| `ca3bb7b9` | Members & invites 502 | **Fixed** (spawnGit EPIPE crash), shipping as v0.5.4 in its own session |
| `3c1e9fb0` | Voice message "couldn't transcribe" | Fixed in v0.5.2 (`542bd65`); verify on prod after upgrade |
| `a7e819fe` | TTS broken | Fixed in v0.5.3 (`d5bd18f`); verify on prod |
| `32d24301` | Video calls for DMs and groups | **Shipped in v0.5.3** (Calls module) — board still says requested |
| `ffa2aa98` | Brand URL extraction 500 | Cause known (no Chromium on servers). Round 3: honest error + upload alternative (W7). Shipping a browser = owner decision |
| `2bda4814` | 403 "Something went wrong / Forbidden" shown; hide what I can't use | **W2** |
| `6a3b17ba` | Admin edits company name + logo (top left) | **W2** |
| `2212c421` | Contacts = people tracker (name, channel, where met, why relevant, tags partner/customer/funder/VC/production) — "my most important tool" | **W1** |
| `b8a87a25` | Email part 2: "who should I write to next" | **W1** (follow-ups on contacts) |
| `7fa15491` | Memory: does it stay with me, what can leak, can I delete? | **W3** |
| `1ab7cd3f` | Drive archive for old files, with help deciding | **W4** |
| `119f59a4` | Messages presence (online / reachable) | **W5** |
| `b73604ff` | Accessibility (contrast, type sizes, spacing) | **W6** |
| `17b56d93` | Upload an existing brand guide | **W7** |
| `288dc1d2` | Brand material part 2 (banners, posters, merch) | Next round |
| `eb674853` | Email opens on the inbox | Needs inbound mail storage (receiving infra) — owner decision, next round |
| `df14e05a` | Calendar with appointments, phone notifications, private/out-of-office | Next round: own plan (large; builds on Calls + push + presence from W5) |

## Workstreams (one worktree each, disjoint files; migrations pre-assigned)

- **W1 Contacts** — new `modules/contacts` + `/m/contacts`. Migration **0124**.
- **W2 Shell: company identity + role-aware UI** — Settings → Company (name, logo), top-left shows them; nav/actions hidden by role; a human 403 page. Migration **0125**.
- **W3 Memory trust** — who can read memory, what leaves the server, delete that works and is easy to find. No migration expected.
- **W4 Drive archive** — archive/unarchive, Archived view, agent-assisted "what could be archived" (LLM + JSON schema). Migration **0126**.
- **W5 Messages presence** — online / away / offline / in a call, shown in Messages. Ephemeral, no migration.
- **W6 Accessibility** — global tokens: WCAG AA contrast, base type size, spacing; a contrast test. Global CSS only.
- **W7 Brand guide upload + honest URL-capture failure** — upload PDF/images → LLM (gateway, JSON schema) → a brand style. Migration **0127** only if needed.

## Decisions (owner may veto)

1. Contacts is its own module (people you know), not Email's audience lists. Email's "Contacts" tab is renamed **"Lists"** (same route, same function) so the two aren't confused — announced here, not a removal.
2. Contacts are private to their creator by default; a contact can be shared with the company.
3. Company logo is uploaded in Settings → Company (owner/admin). Brand style stays separate.
4. Presence is in memory in the os process (single tenant, one process); it resets on restart, which is fine for "online now".
