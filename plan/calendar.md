# Calendar plugin (approved direction; slices not started)

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

## Open (owner)
1. Group/shared calendars (a team, a room) — needed?
