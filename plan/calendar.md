# Calendar plugin (approved direction; K1 + K2 built, K3–K7 open)

Source: Contribute `df14e05a` (calendar with appointments, phone reminders before a call,
company-visible vs private / "out of office") and `d8ec9006` (read agreed call appointments
out of emails, propose them, on accept add to the calendar and send the invitation).

**Owner decisions (2026-11-12):**
1. Own Calendar plugin **plus two-way sync** with Google Calendar and Microsoft 365 / Outlook.
2. Appointments found in emails are **always a proposal**: accept (or edit) → event + invitation. Nothing is added or sent on its own.
3. Calendar is a plugin like every sidebar entry (see `progress.md`, the plugin decision): `modules/calendar`, official, can be deactivated.
4. Recurring events from the start (RRULE in K1; synced calendars need it anyway).
5. New events default to **busy** (colleagues see "Busy" + time).
6. The owner registers the Google and Microsoft OAuth apps; steps in `plan/calendar-oauth-setup.md`.

## Shape

### 1. Data (one migration, number assigned when the slice starts)
- `calendar_events`: owner (member), title, notes, start/end (UTC) + the time zone it was made in, all-day, location, optional call (Calls meeting id), visibility, status (confirmed / tentative / cancelled), source (`local` / `google` / `microsoft` / `email_proposal`) + external id + etag.
- `calendar_attendees`: member or external email, role, RSVP state.
- `calendar_reminders`: minutes before, channel (push, in-app).
- `calendar_connections`: per member, provider, encrypted tokens, sync cursor (Google `syncToken`, Graph delta link), push-channel id + expiry.
- `calendar_proposals` (from email): message id, extracted fields, state (open / accepted / dismissed).
- Recurrence: RRULE on the event (+ exceptions), expanded on read. In K1.

### 2. Visibility (enforced in the store, tested like the inbox access rules)
Per event: **company** (colleagues see title + time), **busy** (colleagues see "Busy" + time), **private** (colleagues see "Out of office" + time). New events default to **busy**; a member can change their default in calendar settings. The owner and admins get no extra view of others' private details. The agent sees what the person it acts for sees.

### 3. UI (`/m/calendar`)
Day / week / month, phone-first (375 px). Create/edit dialog. Colleagues' availability side by side (free/busy only). "Join call" on events with a call; "Add a call" creates a Calls meeting. Presence shows "In a meeting" during a company-visible event.

### 4. Reminders
Web push to the installed app (`src/lib/server/push/*` exists) + an in-app toast; for a call event the reminder opens the call. Push needs the app installed on iPhone (Install app dialog exists).

### 5. Invitations
External attendees get an iCalendar invitation (iMIP: `text/calendar` METHOD:REQUEST) through company mail (Email plugin, SES). Replies (ACCEPT/DECLINE) are read from the inbox once it receives mail (`plan/email-inbox.md`). Members are invited inside the app.

### 6. Sync (per person, opt-in)
Google Calendar API and Microsoft Graph, OAuth per member with calendar scopes; incremental sync + provider push (Google watch channels, Graph subscriptions) with renewal; our event ↔ their event by external id + etag; a conflict keeps the newer change and logs both. Disconnect stops sync and keeps local copies.
**Owner steps:** register an OAuth app in Google Cloud and in Microsoft Entra (client id/secret as ee secrets, redirect URL on the console host). Google's calendar scope needs Google's app verification before it works for people outside a test list.

### 7. Appointments from emails (after the inbox ingest ships)
On each received mail in a personal inbox: the gateway (JSON schema, company provider) answers "is an appointment agreed here?" with time, time zone, participants, place/call — or nothing. A hit becomes a proposal shown on the mail and in Calendar: Accept / Edit / Dismiss. Accept creates the event and sends the invitation (§5). Only the mailbox holder sees it (inbox privacy). Never pattern-matched in code (no string heuristics).

### 8. Agent tools
`calendar.list` (as the person), `calendar.free_busy`, `calendar.propose_event` (approval-gated). The agent never accepts proposals or sends invitations itself.

## Slices (TDD, worktrees under `.claude/worktrees/`)
- **K1** data + store + visibility rules + plugin manifest.
- **K2** UI (views, dialog, availability) — after K1.
- **K3** reminders (push) + Calls link + presence "In a meeting" — after K1.
- **K4** invitations over company mail — after K1.
- **K5** Google sync, **K6** Microsoft sync — after K1, need the owner's OAuth apps.
- **K7** email → proposal — after K1 + the inbox ingest.

## Status (2026-11-13)

**K1 built** (branch `contrib/calendar`, migration `0136_calendar`):
- Tables `calendar_events` (owner, title, notes, start/end UTC + time zone, all-day, location,
  `call_id`, visibility, status, source + external id + etag, RRULE + `exdates` +
  `recurrence_ends_at`, changed instances as rows with `recurrence_id` + `original_start`),
  `calendar_attendees` (member or external email, role required/optional, RSVP) and
  `calendar_preferences` (a member's default visibility — §2's "change their default").
- Service `modules/calendar/service.ts` decides every read and write (no RLS, like Contacts):
  owner + member guests see an event in full, only the owner changes it; everyone else only
  through `freeBusy` (company → title, busy → "Busy", private → "Out of office"; cancelled and
  declined take no time); owner/admins/the agent on its own get exactly the colleague view.
- Recurrence `modules/calendar/recurrence.ts`: FREQ daily/weekly/monthly/yearly, INTERVAL,
  COUNT/UNTIL, weekly BYDAY, monthly nth weekday or BYMONTHDAY; expanded on read in the
  event's zone (DST-correct); anything else refused loud. Change/delete one instance or the
  series; a new time or rule for all events starts the series over (changed/removed instances
  are dropped — the dialog says so).
- Plugin `modules/calendar` (official, seeded on once, switchable; route `/m/calendar`, no API
  prefix) and read tools `calendar.list` (as the person) + `calendar.free_busy`.
- **For K4/K7:** `createEvent(deps, actor, input, { source: 'email_proposal', externalId })`
  takes external guests (`{ email, name? }`) — the invitation and the proposal flow build on it.

**K2 built:** `/m/calendar` day (hour grid) / week (list of days) / month (six weeks),
phone-first; event dialog (title, all-day, start/end, time zone, location, repeat, visibility
with what colleagues see, member guests, notes; this event / all events for a series; delete
asks first; guests see the event read only); colleagues' availability (`?with=`); "New events by
default" setting. Calendar sits after Calls in the sidebar.

**Still open:**
- **K3** reminders (web push + in-app toast; a `calendar_reminders` table), "Add a call" / "Join
  call" (the `call_id` column exists, nothing sets it yet), presence "In a meeting".
- **K4** invitations over company mail (iMIP REQUEST to external guests; replies from the inbox),
  in-app RSVP for member guests (the `rsvp` column exists; no UI or service call yet).
- **K5/K6** Google / Microsoft sync — need the owner's OAuth apps (`plan/calendar-oauth-setup.md`);
  the sync must extend the RRULE subset (or keep unsupported rules read-only) and fill
  `source`/`external_id`/`etag`; a `calendar_connections` table.
- **K7** email → proposal (after the inbox ingest); `calendar_proposals` table;
  `calendar.propose_event` (approval-gated) agent tool.
- "This and following events" for a series (not built: this event / all events only).
- External guests can't be added in the dialog yet (kept when editing; the service takes them).

## Open (owner)
1. Group/shared calendars (a team, a room) — needed?
