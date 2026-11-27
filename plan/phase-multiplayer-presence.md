# Multiplayer presence — see where everyone is working (owner, 2026-11-27)

Source (owner): "I want eigenEnterprise to be inherently multiplayer … display where every person
is so when you work together you don't feel so alone … a little icon or avatar highlighting where
the person is currently working: which item in the sidebar, inside the current view or the
dashboard, what the person is looking at."

## Where we start

- Presence already exists (plan/contribute-round-3.md W5, Contribute e4ef6be1): an in-memory
  `PresenceTracker` per os process (`src/lib/server/presence/tracker.ts`), fed by a heartbeat
  every 25 s from every nucleus tab (`PresenceHeartbeat`, `POST /api/messages/presence`), plus
  Calls' live state. Status = in_call / dnd / online / away / offline. AI co-workers from facts.
- Delivery is SSE, not WebSocket: `event: presence` on `/api/messages/stream`, which only the
  Messages page opens. The shell shows only *my* status (from the beat's answer).
- LiveKit is the media server for calls. It is **not** used for presence: a LiveKit room per
  page would mean a media-server connection for every open tab, for state that is a few bytes.

## Shape

```
tab ──beat {clientId, state, where}──▶ POST /api/messages/presence ──▶ PresenceTracker (memory)
     (every 25 s + right after every navigation / focus change)               │ subscribe
tab ◀──SSE event: presence {people:[{…status, where}]}── GET /api/messages/presence/stream
                                    └─ per viewer: where filtered by what THEY may open
```

- **Where** a tab is = `{ area, path, item }`: the sidebar entry (`currentNavId`, `dashboard`
  for `/`), the page pathname (no query), and the one thing open on it (`conversation`,
  `drive_file`, `drive_folder`) — declared by the page, never guessed from text.
- A person's where = their most recently active tab's (else most recent tab's).
- **Per-viewer filtering (fail closed):** the area is shown to every member. The item (with
  its title) only when the viewer may open it themselves (Drive access, `canUse` for
  conversations — a DM only to its participants). When the item is hidden, the path is hidden
  too (it carries the id); the viewer sees just the area.
- **Share where I am** — a per-person switch next to Do not disturb, **on by default**, stored in
  `user_preference.share_where` (migration 0188). Off: others see the status, never the place.
- Co-workers have no where (yet — phase 2).
- Everything is reachable outside the UI: `messages.presence` (read: everyone's status + where as
  the caller may see it) and `messages.set_share_where` (write).

## UI (restrained: neutral rings, small avatars, no colour tiles)

1. **Sidebar:** each nav entry (and the company badge for the dashboard) shows a stack of up to
   3 small avatars (+n) of the people in that area right now; hover/focus lists names and what
   each has open. Collapsed sidebar and phone drawer: the same, smaller.
2. **"Here with you" in the top bar:** the people on the same page/item as me.
3. **In the view (phase 1b):** avatars on the Messages channel/DM rows and on Drive rows that
   someone has open.
4. **Status card:** "Share where I am" switch under Do not disturb.

## Workstreams

- **A — server** (`src/lib/server/presence/**`, `modules/messages/presence.ts`, new
  `src/routes/api/messages/presence/{stream,where}/**`, `modules/messages/tools.ts` +
  `manifest.ts`, `src/lib/kernel/ui-parity.ts`, migration 0188 + schema, specs).
- **B — client** (`src/lib/messages/presence.ts` heartbeat, new
  `src/lib/presence/company-presence.svelte.ts`, shell: `app-shell.svelte`,
  `presence-nav.svelte`, `presence-self.svelte`, nucleus `+layout.svelte`, page focus calls in
  Messages + Drive file/folder pages, component specs).
- **C — in-view markers** (after A + B merge).
- Contract both build against: `src/lib/presence/where.ts`.

## Decisions (logged in progress.md)

1. SSE over the existing tracker, no WebSocket, no LiveKit for presence.
2. Location is in memory like status (a restart forgets it until the next beat, ≤ 25 s);
   only the share switch is stored.
3. Share on by default; items fail closed per viewer; DMs only to their participants.
4. A navigation sends a beat at once, so the sidebar follows within about a second.
