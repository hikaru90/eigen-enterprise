# Progress Log

Format: newest entries on top. Every milestone gets: what shipped, commit refs, what broke, decisions, what's next.

## 2026-11-12 — v0.5.7 on production (os.cerberusblue.com)

Owner: "Yes, upgrade". `ee upgrade --check` saw 0.5.6 → 0.5.7; ran `ee upgrade --from https://github.com/hikaru90/eigen-enterprise/releases/download/v0.5.7`, detached (`nohup setsid`, log `/root/ee-upgrade-0.5.7.log`). Safety copy + rollback steps: `/var/lib/ee/upgrades/2026-11-12T20-54-04Z`.
- **Observed after:** `ee upgrade --check` says it runs `eigenenterprise-0.5.7-318854f07775`; os switched b → a (`ee-os-a` active, 0 restarts); "Applied 4 migration(s)"; no `[server error]` lines in its journal; `ee-livekit-a` and `ee-cerberusblue-website-b` running; `/login` 200, `/api/health` 200, anonymous `/settings/passkeys` 302 → login.
- **Not verified signed in:** the passkeys page, logo upload, calls across pages, Settings → Plugins / Backups restore, contacts by voice. Board statuses unchanged.

## 2026-11-12 — v0.5.7 published on GitHub (Contribute round 4)

Owner: "Push and release". Release commit `318854f`, tag `v0.5.7`; main + tag pushed through the pre-push gate (`npm run ci:local`, exit 0). Release run 43303577670: amd64 + arm64 builds + publish green; 12 assets; GitHub's latest = v0.5.7. Carries round 4 (W1–W7 + `a77bb8b`, entry below).
- **Not done:** production (os.cerberusblue.com) still runs v0.5.6 — no `ee upgrade` run. Nothing from round 4 tried on the box. Backup restore never run on systemd (box drill first). Board statuses unchanged.

## 2026-11-12 — Email inbox S6 merged: Email opens on your inbox; Company mail tab (main `f9b204c`, not pushed, not on the box)

Owner: "Start S6". Contribute `eb674853` ("Das Email-Postfach sollte sofort den Posteingang zeigen") is now true in code.
- **Shipped (`58201e6`):** `/m/email` redirects (303) to `/m/email/inbox`, keeping the query. Tabs: **Inbox**, **Company mail**, Lists, Setup. The "Connect SES" hints on Domains, Senders and API point at Setup › Account instead of the old landing.
- **Announced move + access change:** the old Email landing (company-wide Pending + last 10 sent: system, agent, API, template and flow mail; never a member's webmail) moved to `/m/email/company` as **Company mail**, for the **owner and admins only** (owner decision 2026-11-12). The page answers members with the admin refusal and the tab is hidden for them. **Members could see this view before and no longer can.** Nothing was removed.
- **Side change:** `eslint --fix` on the Email routes re-sorted imports in 11 Email pages (import order and comment position only, no behaviour).
- **Gates:** svelte-check 0 errors; email route + module units green; e2e `page-frame`, `email-inbox`, `email-inbox-compose` 4/4 passed; full unit run 807 files / 6514 passed, 1 failed (the known flaky Messages concurrent-appends test).
- **Next:** S7, the real proof on the box. It needs the owner's AWS/DNS steps on production first: verify `cerberusblue.com` as an SES domain, request SES production access, then turn on receiving for the domain (MX → SES). The Contribute item stays open on production until S7 has shipped.

## 2026-11-12 — Email inbox S5 merged: compose, reply, reply all, forward + Sent (main `74ab9da`, not pushed, not on the box)

Owner: "Start S5". Built in worktree `email-inbox-s5` (`16c0ce9`), merged on top of round 4.
- **Shipped:** "New mail" (From picker when you can send from several mailboxes), Reply / Reply all / Forward in the reader (Re:/Fwd:, quoted text, In-Reply-To + References, reply-all minus your own addresses and aliases), Cc/Bcc, uploads (25 MB total, 20 files, 50 recipients, 40 MB finished mail), forward re-attaches the original's attachments (virus-blocked never). Raw MIME via nodemailer's MailComposer (now a direct dependency) through a new `owlery.sendRaw` (SESv2 `Content.Raw`); every other `send()` caller unchanged. The sender's copy goes to Sent in the right thread and updates live. You can only send from a mailbox you can read; never from a disabled one. Migration `0132` (`inbox_messages.bcc`; fake transport keeps raw + recipients).
- **Privacy (owner decision: only the member reads):** webmail sends write **no** `mail_messages` row, no timeline or audit event — they don't appear under Company mail or Logs (e2e-checked with an admin). Each carries one SES tag `ee_webmail=1` (no ids, no content); delivery events with that tag only feed suppressions (permanent bounces + complaints, source `webmail`), everything else is dropped. Suppressed addresses stay visible to admins under Suppression, as before.
- **Plain errors:** SES sandbox (detected via GetAccount, not Amazon's wording), suppressed recipient, domain not verified, too large, bad address, disabled mailbox.
- **Decisions:** References also end with our own Message-ID, because SES reportedly replaces it (unproven until S7); attachments of sent mail are not kept (metadata only, download answers 410; keeping them would need a new `s3:PutObject` permission); drafts and HTML compose out of scope (S5 notes).
- **Gates on main:** svelte-check 0 errors; unit 806 files / 6510 passed, 1 failed (the known flaky Messages concurrent-appends test); S5's own: component 15/15, e2e `email-inbox-compose.e2e.ts` passed (run 3 of 3 allowed: run 1 wrong test id, run 2 a Vite reload from eslint --fix mid-run). Round 4's plugin gate already covers `/m/email/*` and `/api/mail/*`.
- **Not verified:** nothing against real SES; replies go to From (the original's Reply-To isn't stored); without JavaScript a failed send loses the typed fields; the e2e leaves fake SES settings in the test DB.
- **Next:** S6 (Inbox-first landing, Company mail tab), then S7 (real proof on the box: verified domain + SES production access needed on production).

## 2026-11-12 — Contribute board round 4: all items built and merged into main (not pushed, not released)

Owner: "all items bro. you can ask if we need more context for the big items". Seven worktree workstreams, reviewed and merged into main by the orchestrator. Plan: `plan/contribute-round-4.md`. Board statuses on production NOT changed.
- **W1 Passkeys 500 + server error log** (`cccc91c0`) — `2b217ba`, `2f158b6`. Cause: better-auth's `auth.api.listSessions` refuses a session older than `freshAge` (default 1 day, "Session is not fresh") and our sessions last a year, so every machine signed in before yesterday got a 500 (production: 5 of 7 active sessions). The page now reads sessions through `internalAdapter.listSessions(user.id, { onlyActiveSessions: true })`; the spec runs a real better-auth in memory. `handleError` now logs one line (method, path without query, route, status) + stack + causes to the server log; never headers, cookies or bodies. **Owner call (open):** the same 1-day default applies to better-auth's `unlinkAccount` / password-less `deleteUser`; set `session.freshAge` explicitly?
- **W2 Logo upload + green status** (`7f1f8a6a`, `bf41c35d`, `feba04ff`) — `3549d74`, `f7b4ad8`. "Replace logo" opens the picker and uploads on pick; drop and paste (⌘V) work without folder access; a plain line on the macOS Files-and-Folders permission. Status pill "on" uses a new `--success` token (AA checked light + dark, ≥ 4.5:1), label 13px. Not adjusted by brand styles yet.
- **W3 Calls** (`7e2ac4c8`, `f02fb253`) — `0fa7763`. The live call lives in the nucleus layout: moving around the app keeps it, a docked mini call on every other page (mute, camera, devices, hang up, back to call). Adaptive layout (screen share large; two people = stage + self view; grid by head count, one column at 375 px). Microphone / speaker / camera pickers, remembered per browser; "can't choose a speaker here" said where unsupported. `calls.e2e.ts` 5/5 incl. "navigate during a call". **Behaviour changes (announced):** leaving `/calls/[id]` no longer hangs up; one call at a time (Accept disabled with a reason, Call/Join and New meeting refuse while in a call); leaving the nucleus area still ends the call.
- **W4 Restore backups** (`2ac70cc5`) — `4dc7a2e`. Settings → Backups lists snapshots, "Check" (verify, writes nothing), "Restore…" (owner; typed company name + recovery code, whole-company only, verified into staging first; ee hands over to a transient `ee-restore.service` running `ee restore-apply`; progress in `/var/lib/ee/restore.json` survives the restart; page reconnects). New ee control calls `GET /v1/backups/snapshots`, `GET|POST /v1/backups/restore`, `POST /v1/backups/check`; one job at a time (409). Fixed: restoring a backup with no Drive files failed. **Not proven:** never run on systemd / the box — a box drill is listed in the W4 report (extend `ee/e2e/restore-drill.sh`).
- **W5 Contacts by voice** (`94641271`, `678ff079`) — `e5663af`. "Tell me about them" (new + edit) and "Tell me how it went" (log): dictation or typed text → `POST /api/contacts/extract` → company provider through the gateway, JSON schema + zod (3 tries, then 502) → prefills the form; nothing saved before Save; existing values never overwritten silently (old → new list). Typing works as before.
- **W6 Settings → Plugins** (`c05c3a40`) — `d87593d`. Every plugin, Official, on/off, "Needs / Needed by", switch through `kernel.module_activate/deactivate` (audited); the core (kernel, members, contribute, agent tools) as one line. Manifests can declare `requires` (calls → messages, recap → chat-gateway); switching off what an active plugin needs is refused. **Behaviour change:** `ensureSystemModulesActive` no longer switches plugins back on at boot (only the first time); Brand is now switchable. Route is `/settings/modules`, tab says "Plugins".
- **W7 Off means off** — `7d47c77`, `5fe28b0`, + `a77bb8b` (orchestrator). One `handle` step in `hooks.server.ts` with the route map `src/lib/plugins/routes.ts` (spec fails on unclaimed routes): pages of an off plugin show "<Plugin> is switched off" (owner/admin: link to Settings → Plugins), APIs 409 `plugin_inactive`, form actions never run; webhooks decided per route (LiveKit, SES events, unsubscribe keep working; SES inbound accepted + dropped; GitHub webhook and website contact form refused); Memory and Email background jobs skip with a log line; activation set cached in-process, invalidated by kernel switches and Postgres NOTIFY `ee_module_activations`. The assistant: `module_inactive` says switched-off vs never set up; auto-activate only for never set up; agent/service calls of `kernel.module_activate` on a switched-off plugin refused (`module_switched_off`). `a77bb8b`: the shell opens the call feed / presence beat only while Calls / Messages are on.
- **Decision log (owner, 2026-11-12):** every sidebar entry is a plugin; official plugins are never removed or altered, only deactivated; a company's own plugin is added alongside and may implement the same contract; the assistant never re-enables a plugin a person switched off. Calendar: own plugin + Google/Microsoft two-way sync, recurring from the start, new events "busy" by default, proposals from email always need acceptance (`plan/calendar.md`, OAuth steps `plan/calendar-oauth-setup.md`). Assistant/Memory etc. behind the plugin boundary: plan next (`plan/plugins-boundary.md`).
- **Gates (main `a77bb8b`, after all merges):** `npm run check` 0 errors; lint 0 errors (220 warnings); unit 6372 passed / 93 skipped, 1 failure (`gitstore/engine.spec.ts` EPIPE test) that passes 3/3 alone; components 310/311 (the pre-existing `app-detail-settings.svelte.spec.ts`); ee 224 passed; `calls.e2e.ts` 4/5 in the full run — "DM call nobody answers" showed the generic "this call is over" instead of "Nobody answered." on the caller once, passes alone (1.1 min): a timing race between ring-out and the room close, not fixed. Unit timeouts in the run before were load from parallel workstreams (all pass alone).
- **Open / not done:** the switched-off page renders without the sidebar; `/s/*` (public site) and `/mail/*` are outside the gate — **owner call:** should switching Website off take the public site down?; Telegram poll keeps polling after Chat Gateway is switched off at runtime; already-queued overnight jobs still run; a background run executing as a recorded human could still re-enable a plugin; nothing in this round tried on the box or production; Calendar not started (K1 next); board statuses not set.

## 2026-11-12 — GitHub repos in Drive: plan approved, S0 contract on main (main, not pushed, not on the box)

Owner: "Approve, start S0". Contract only, no behaviour:
- `modules/repos/drive-port.ts`: `DriveSourcePort` (consumer-owned, like Calls' `CallContextPort`; Drive implements it in S2, `modules/index.ts` adapts it). Items addressed by the source's own keys (`repo:<id>/…`); `remove` deletes for good (derived data).
- `src/lib/server/github/token-client.ts`: `GitHubTokenClient` (GET only, conditional with ETags, `Link` paging, typed `GitHubTokenError` kinds `unauthorized | no_access | rate_limited | unavailable | write_refused`). S1 implements it.
- `modules/repos/manifest.ts`: `repos` manifest stub (`repos.list`, `repos.sync_now`, requires `drive`), **not registered** in `modules/index.ts` until S3.
- Migration numbers: 0132 (drive sources, S2) and 0133 (repos, S3) taken by convention; not written yet.
- Gates: `npm run check` 0 errors; eslint clean on the new files; boundaries/manifests/index specs green.
- **Next:** S1, S2, S3 in parallel worktrees.

## 2026-11-12 — GitHub repos in Drive planned: read-only, fine-grained token (plan only, no code)

Owner: GitHub repos in the Drive, read-only, so eigenEnterprise knows what's happening on branches and PRs, using a personal access token. Plan: [`plan/github-drive.md`](github-drive.md) (approved 2026-11-12).
- **Owner decisions:** a read-only fine-grained token the owner pastes in; repo folders visible to the whole company, view only; contents are generated pages (Overview, Branches, Pull requests, Activity) plus README and the Markdown docs of the default branch; an AI "What's going on" summary per repo, only after a sync that found changes.
- **Decision log (architecture, proposed in the plan):** (1) a new plugin `modules/repos` (id `repos`; `github.*` stays the Website module's); (2) Drive gets generic **read-only source folders** (`source` column + `drive_source_items` upsert map + a `DriveSourcePort` system writer), with the read-only rule ahead of the agent bypass in `allows()`; (3) the token is sealed in the app DB (envelope.ts, key derived from `TENANT_MASTER_KEY`) via an admin-only page route, never through a tool, the chat or an approval (approvals store raw input); classic tokens are refused; the token client is GET-only; (4) polling every 15 min on the job-queue tick with ETags, no webhooks (a read-only token can't create one); (5) the GitHub REST client moves from `modules/website/github/` to `src/lib/server/github/` (boundary rule), behaviour unchanged; (6) source items stay out of the git-native data repo and backups (derived, rebuilt by a sync).
- **Found:** Drive isn't indexed and the orchestrator prompt never mentions it, so folders alone wouldn't make the assistant aware. The plan adds a "Connected GitHub repos" prompt block + `repos.list`.
- **Nothing removed:** the Website module's GitHub connection (public / App / deploy key) is unchanged.
- **Next:** owner approval, then S0 contract on main → S1 (shared client), S2 (Drive source folders), S3 (repos plugin core) in parallel worktrees → S4 (the assistant knows) → S5 proof on the box with a real token.

## 2026-11-12 — v0.5.6 on production (os.cerberusblue.com): the member assistant fix

- **What:** v0.5.6 = v0.5.5 + the fix below (every principal's assistant turn runs on the company's — the owner's — AI provider). Bump `aae0819`, tag `v0.5.6`.
- **Release run 43237920042 succeeded** (arm64 + amd64 + publish).
- **Upgrade:** `ee upgrade --from https://github.com/hikaru90/eigen-enterprise/releases/download/v0.5.6`, detached (log `/root/ee-upgrade-0.5.6.log`). Safety copy `/var/lib/ee/upgrades/2026-11-12T14-34-49Z`. `ee upgrade --check`: runs 0.5.6-aae081926f61. `ee-os-b` active, no errors in its journal since, `/login` 200.
- **Not verified:** no member has chatted since the upgrade (the last member turn, pi task 50 at 13:52 CET, is the old `Platform EUrouter not configured` failure). A member needs to send one message to confirm.

## 2026-11-12 — Email inbox S4 merged: webmail read UI, safe HTML mail, attachments, live updates (main `c23076b`, not pushed, not on the box)

Owner: "Start S4". Built in worktree `email-inbox-s4` (`6904830`), merged into main (`c23076b`) on top of the round-4 merges.
- **Shipped:** an **Inbox** tab, first in the Email area (`/m/email/inbox`; `/m/email` still opens on the old view until S6): mailbox switcher, folders with unread counts, a search (literal, case-insensitive), a thread reader, read/unread, star, archive, trash, spam / not spam. Every call goes through the S1 access rule (not readable = not found). HTML mail is sanitized server-side (DOMPurify) and shown in a sandboxed iframe with its own CSP; remote images are stripped from the srcdoc until "Show images". Attachments are re-read from the raw S3 mail (checked by part index + md5); virus-blocked ones answer 403; inline only for cid: images, with a sandbox CSP. Live updates over `/api/mail/inbox/stream` (access re-checked per event, mailbox id only). Dev-only harness `/api/e2e/harness/inbox` seeds mail for e2e.
- **Bugs the e2e found and fixed on the way:** screen readers heard "2unread" (the sr-only space was dropped); a live-update reload cancelled a click that was opening a mail; Chromium still requested a remote image the CSP should have blocked (now stripped from the HTML too).
- **Decisions:** actions apply to the open mail, not the whole thread; received mail can't be moved into Sent; ids in URLs/forms must be uuids; search capped at 200 characters (S4 notes in `plan/email-inbox.md`).
- **Gates on main after the merge:** svelte-check 0 errors; unit 793 files / 6328 passed, 5 failed — the known flaky `modules/messages/db-store.pg.spec.ts` concurrent-appends test, and 4 in `settings/backups/page.server.spec.ts` (round 4's new restore page, `4dc7a2e`), which pass 11/11 on their own: they fail only in the full parallel run. S4 touches nothing there; left to the round-4 session. S4's own: component 9/9, e2e `email-inbox.e2e.ts` passed (run 4, on alternate ports because another harness held the defaults).
- **Not verified:** attachment download only in unit tests (fake raw source), nothing against real S3; cid: images whose part the parser can't match may show broken inside the sandbox (nothing leaks); no unread counts on other mailboxes in the switcher; full component + e2e suites not run.
- **Next:** S5 (compose / reply / forward + Sent), S6 (Inbox-first landing, Company mail tab), S7 (real proof on the box).

## 2026-11-12 — Contribute board round 4 triaged: 12 new proposals (plan only, no code)

Owner: "get the newest batch of contribute items and integrate them". Read over production's MCP (`contribute.list status:all`): 36 proposals, 12 new; `2bda4814` (hide what I can't use) is already shipped by round 3. Triage in `plan/contribute-round-4.md`.
- **Bugs:** `/settings/passkeys` 500 (cause unknown); a call hangs up when you open another page (by design today: the call lives in the page); "Replace logo" opens no picker (it's the form's submit button; the Desktop prompt is macOS).
- **Found:** `handleError` (`src/hooks.server.ts`) never writes to the server log, only to PostHog, so production's unexpected 500s leave nothing in the journal. The passkeys 500 left no trace. Fix first.
- **Small:** green Active dot (shared `StatusPill`, also 11px text), audio device picker in calls, adaptive call layout, restore backups from Settings (CLI `ee restore` exists).
- **Need owner decisions:** contacts by voice (dictation → LLM → prefilled form), appointments from emails into a calendar (needs Email inbox + Calendar), "everything is a plugin" + a Modules page (kernel module tools exist, no UI; architecture part overlaps `phase-extensions.md`).
- Board statuses on production NOT changed.
- **Owner: "all items".** Six worktree workstreams started (W1 error logging + passkeys 500, W2 logo picker + green status pill, W3 calls: survive navigation + adaptive layout + device pickers, W4 restore backups from Settings, W5 contacts by voice, W6 Settings → Plugins overview). Calendar planned: `plan/calendar.md` (awaiting approval).
- **Decision log (owner, 2026-11-12):** (1) **Every sidebar entry is a plugin** (Messages, Assistant/Chat, Calls, Website, Email, Brand, Memory, Drive, Contacts, Calendar …), as the specs already intend; it stays that way. (2) **Official plugins are never removed or altered, only deactivated.** A company's own plugin is always added alongside; it may implement the same contract as an official one, which the owner then deactivates. (3) Calendar: own plugin + two-way Google / Microsoft sync. (4) Appointments from emails are always a proposal; accept → event + invitation.

## 2026-11-12 — Email inbox S2 + S3 merged: receiving setup and the inbound ingest (main, not pushed, not on the box)

Owner: "Merge, then S2+S3". S1 merged (`a4e96c0`); shared contract on main first (`675c482`: deps `@aws-sdk/client-ses` + `@aws-sdk/client-s3` + `mailparser`, migration `0130_mail_receiving`, `OwleryStore.writeReceiving`, `modules/email/inbox/receiving-contract.ts`); S2 and S3 built in parallel worktrees and merged (`efd1bfa` S3, `6eb8c75` S2); e2e reset fix `e147715`.
- **S2 (receiving setup):** SES v1 receipt rules + inbound S3 bucket seams with fakes (`modules/email/owlery/{ses-receiving,inbound-bucket,fake-receiving,receiving}.ts`). Setup order: active rule set read first (a foreign one stops everything before AWS is touched) → topic (account id from its ARN) → bucket `ee-inbound-<account>-<region>` (public access blocked, SSE-S3, SES-only bucket policy) → subscription to `/api/mail/ses-inbound` → `ee-inbound` created + activated → rules `ee-inbound-1..n` (≤100 recipients, spam/virus scan, S3 action + topic). Rules re-sync after every mailbox change and domain switch; a failed sync keeps the change and shows Amazon's reason. Domain page: "Receive mail on this domain" (verified domains only) lists the current MX records with a "moves all mail" warning first; `inbound_mx` DNS record with live seen/not-seen. Setup › Account: Receiving status + retry + copyable IAM policy for the bucket. Removing a domain that still has mailboxes now stops before Amazon with a plain message.
- **S3 (ingest):** `/api/mail/ses-inbound` verifies the SNS signature, accepts only the stored topic (403 otherwise) and bucket, confirms the subscription and flips receiving to `ready`. Mail is read from S3 (≤40 MB), parsed with mailparser, routed on the envelope recipients (Bcc arrives; alias + primary = one row; unknown/disabled skipped), Spam on spam/virus FAIL or DMARC FAIL with quarantine/reject, threaded by In-Reply-To/References within the mailbox, attachments as metadata (`0131_inbox_attachments`, bytes stay in S3, blocked on virus FAIL), idempotent on SNS retries, `pg_notify('inbox_messages')` for the live view. Logs carry ids/counts/sizes only. CSRF-exempt like `ses-events`.
- **Changed wording (announced):** the SNS "callback is not https" error now reads "Amazon only delivers to an https address, and this callback is …" — delivery events show it too (shared SNS seam).
- **Gates:** unit 776 files / 6162 passed, 1 failed = `modules/messages/db-store.pg.spec.ts` concurrent-appends test, flaky on main before this work (fails ~1 in 3 alone; not touched here); `npm run check` 0 errors; eslint 0 errors on the email files (import-order warnings only).
- **Not verified:** nothing has run against real AWS (SDK command shapes, mapped error codes, SES accepting the bucket policy), no component/e2e test for the new UI; the live S3 read has no fake under MAIL_TRANSPORT=fake (a notification there errors loudly). Production still needs a verified domain + SES production access (S0).
- **Next:** S4 (webmail read UI + SSE), then S5 (compose/reply), S6 (Inbox-first tabs), S7 (real proof on the box).

## 2026-11-12 — Email inbox S1: mailboxes, access rules, Setup › Mailboxes (branch `email-inbox-s1` @ `316b514`, not merged, not on the box)

- **Shipped on the branch:** migration `0129_mailboxes` (`mailboxes`, `mailbox_addresses`, `inbox_messages`) + `src/lib/server/db/inbox.schema.ts`; `modules/email/inbox/` (types, store seam, memory + Postgres stores, service, live wiring); Setup › **Mailboxes** (`/m/email/mailboxes`): assign a member's personal mailbox (address prefilled `firstname.lastname`, umlauts spelled out), shared mailboxes per group, aliases, stop/turn on receiving.
- **Access rules (tested):** a personal mailbox is read only by its member — the owner, admins and other members get "not found"; a shared mailbox follows its group's members; someone no longer in the company reads nothing; the admin view shows addresses, holder, counts and size, never subjects or senders. No agent path. Every change is a kernel event with addresses only.
- **Decisions:** addresses are unique company-wide in one table (primary + aliases), so an alias can never collide with another mailbox; one personal mailbox per member (DB partial unique index); "Stop receiving" keeps the mail readable; `mailbox_addresses.domain_id` is `ON DELETE RESTRICT`, so removing a domain that still has mailboxes fails loudly (the Domains page error message for that is S2 work); attachments get their table in S3, where they are first written.
- **Tests:** inbox unit + Postgres specs (39), Mailboxes page server spec (4), tabs spec; `npm run check` 0 errors; eslint clean on the new files.
- **Next:** S2 (receiving setup: MX record, S3 bucket, receipt rule set, SNS) and S3 (ingest webhook) — disjoint files, can run in parallel.

## 2026-11-12 — Email inbox planned: personal + shared mailboxes on SES receiving (plan only, no code)

Contribute `eb674853` ("Email should open on the inbox"), widened by the owner: every owner and member gets their own address and inbox. Plan: [`plan/email-inbox.md`](email-inbox.md).
- **Decisions (owner):** receiving through Amazon SES (MX → SES → S3 + SNS → console), no mail server on the box; a personal inbox is readable only by its member (not the owner, not agents), shared addresses are group mailboxes; the owner assigns each address by hand (`firstname.lastname` only as a prefill); `/m/email` opens on your inbox.
- **Announced move (no removal):** today's Email landing (Pending + last 10 sent, company-wide) moves to a new **Company mail** tab for admins.
- **Open before the real proof:** no IMAP for phone/desktop clients with SES receiving; retention; what happens to a leaver's mailbox; 40 MB SES size cap.
- **S0 done (docs + production read-only):** eu-central-1 supports receiving. Production has **no verified domain** (only the address hello@cerberusblue.com) and is **in the SES sandbox**, so replies to outside addresses fail until the owner requests production access. Both are owner steps in AWS/DNS.
- **Design changes from S0:** one S3 action that notifies a topic, instead of an SNS action (the SNS action bounces mail over 150 KB); setup refuses to replace a foreign active receipt rule set; rules are chunked at 100 recipients; routing uses envelope recipients; new deps `@aws-sdk/client-ses` (v1 receipt APIs) + `@aws-sdk/client-s3`; new IAM: S3 on the inbound bucket only.

## 2026-11-12 — Fix: the assistant failed for everyone but the owner (production)

Owner: "the assisstant does not work on the prod machine" / "fix it please".
- **What broke:** on os.cerberusblue.com every assistant turn by a non-owner ended with "Something went wrong on my side…". The journal only said `durable agent run ended without an answer: model_error`; the durable store (`/var/lib/private/ee-state/os/agent/agent.sqlite`, `pi_tasks`) held the real error: `Platform EUrouter not configured: set LLM_BASE_URL`. The provider is stored per user; only the owner has one (byok). The admin and the member had none, so their turns fell to the platform path, which a self-hosted server never has. The Contribute judge, voice and Drive already ran on the company provider (`onCompanyProvider`, `8dc8f4e`); the assistant's durable completion never did.
- **Fix:** `db-scoped-complete.ts`: every durable model call runs inside `onCompanyProvider` (the owner's provider config); usage stays attributed to the caller. `provider-ready.ts`: new `isCompanyProviderReady()` used by `/` and the assistant conversation load, so members no longer see the false "No AI provider is set up yet" banner (no owner → not ready).
- **E2E:** the shared test DB has a stale real owner (with a real OpenRouter key), so with the fix every e2e user's chat went to that key. New `src/routes/e2e/company-owner.ts` (`becomeCompanyOwner` → `restore`): the specs that connect a provider and chat now do it as the company owner (`agent-runs-live`, `assistant-area`, `onboarding-provider`, `pricing`, `onboarding-welcome`) — the product's real shape. The stale owner is put back after each test. As the owner, the welcome boot also asks for company email (`needsMail`), so the two `onboarding-welcome` journeys that reach the mind gate now walk that step on the fake transport (SES form → harness verifies the sender → test mail → Continue), with the mail settings wiped before and after each test (`DELETE /api/e2e/harness/mail`).
- **Gates:** unit 749 files / 5966 passed (80 skipped); svelte-check 0 errors; lint 0 errors on touched files.
- **Decision log (architecture impact; owner may veto):** the company's AI provider is the owner's for every principal, in chat as everywhere else. A provider an admin or member saves on their own account is not used. Settings → AI provider still saves to the caller's account — it should be owner-only (follow-up).
- **Known gap (follow-up):** a non-invited member, or an admin before any provider exists, still gets the welcome mind gate and can save a provider that is then never used. Production has only the owner and invited people, so nobody hits it there.
- **Pre-existing, exposed (not fixed):** after `email-platform.e2e.ts` runs (it fails on main too), `/api/onboarding/mail` no longer recognises `SenderNotVerifiedError` (`instanceof` false → generic 400): the process-wide Owlery singleton (`globalThis.__eeOwleryService`) seems to hold a second copy of `company-mail.ts`'s classes in Vite dev. The two owner welcome journeys pass alone and fail right after `email-platform` in one run.
- **Released:** v0.5.6 (`aae0819`), on production — see the entry above.

## 2026-11-12 — v0.5.5 on production (os.cerberusblue.com)

Owner: "Yes, upgrade".
- **Release run 43221566721 succeeded** (arm64 + amd64 builds + publish); GitHub lists v0.5.5 as Latest.
- **Upgrade:** the server's `ee upgrade --check` still saw 0.5.4 right after publishing (cached `latest/download`), so it ran pinned: `ee upgrade --from https://github.com/hikaru90/eigen-enterprise/releases/download/v0.5.5`, detached with `nohup setsid` (log `/root/ee-upgrade-0.5.5.log`). Safety copy `/var/lib/ee/upgrades/2026-11-12T12-54-58Z`. No `--node-ip` prompt (saved by the 0.5.3 upgrade).
- **Observed after:** `ee upgrade --check` says it runs `eigenenterprise-0.5.5-5da00442db2d`; os switched b → a (`ee-os-a`, 0 restarts, no warnings in its journal); "Applied 5 migration(s)" (126 rows in `drizzle.__drizzle_migrations`; `contacts`, `company_profile`, `brand_extraction_guides` exist); livekit and the cerberusblue website still running; `/login` 200, anonymous `/settings/members` 302 → login.
- **Not verified:** Settings → Members signed in (the 502 fix), and none of the round-3 features have been clicked through on production yet. The v0.5.4 release session stood down (it had been waiting to upgrade to 0.5.4).

## 2026-11-12 — v0.5.5 tagged: Contribute board round 3 merged into main

Owner: "Merge and release".
- **What:** `contribute-round-3` merged into main with `3ab736b` (tree identical to the gated branch), bump `5da0044`, tag `v0.5.5`. It carries the seven round-3 features below plus v0.5.4's Members 502 fix. Migrations 0124–0128 run on the first start.
- **Release:** main (`0157e19..5da0044`, carrying the v0.5.4 docs commit `f37a68a` too) and the tag pushed through the pre-push gate (`npm run ci:local`: lint, svelte naming, check, unit; exit 0). Release run 43221566721 started 12:50 UTC (arm64 + amd64 builds + publish); it succeeded (see the entry above). Branch `contribute-round-3` and its worktree `.claude/worktrees/round3` can be pruned.
- **Not done (at tagging):** production was upgraded afterwards (entry above). Not on the local box, no e2e run. Board statuses on production unchanged. Test DBs `ee_w1…ee_w7` still on :5433.

## 2026-11-12 — Contribute board round 3: seven features merged on `contribute-round-3` (merged into main and tagged v0.5.5 in the entry above)

Owner: "get the latest contributions … look at all features … really think about what would improve the project … don't just debug fix, please also ship features." Board read from production's `contributions` table (read-only SQL over SSH; no MCP configured in that session): 25 proposals, 1 new (`2bda4814`). Plan: `plan/contribute-round-3.md`. Seven worktree workstreams, merged into branch `contribute-round-3` (worktree `.claude/worktrees/round3`). Board statuses on production NOT changed.
- **W1 Contacts** (`2212c421`, `b8a87a25` part 2) — `69d9866`, `9f23f9c`, merge `ba76cd8`. New system module `modules/contacts` + `/m/contacts`: people with organisation, role, channels, where met, relationship tags (partner, customer, funder, investor, production + custom), why relevant, last contacted, next follow-up + step; "Follow up next" (overdue + 14 days, person's timezone); "Log a contact". Privacy like Drive (creator + owner/admins, or shared with the company), enforced in the service. Agent tools create/update/log_contact approval-gated; the agent never shares or deletes. Migration 0124.
- **W2 Company identity + role-aware UI** (`6a3b17ba`, `2bda4814`) — `7774b42`, merge `a42b49a`, follow-up `2416bf5`. Settings → Company (owner/admin): name + logo (png/jpeg/webp/svg; SVG with scripts refused, rest sanitised; served at `/api/company/logo/<sha>` to members with nosniff + sandbox CSP; bytes under `<drive dir>/company`, row in `company_profile`, migration 0125). `foundingCompanyName()` now returns the edited name. One capability set (`src/lib/server/auth/capabilities.ts` → `src/lib/access/capabilities.ts`) from the routes' own guards drives nav, settings tabs, dashboard cards, Brand tabs; `role-aware.spec.ts` runs guarded loads against it. Human 403 page.
- **W3 Memory trust** (`7fa15491`) — `b66da23`, `6837582`, merge `4a062dd`. "Who can see your Memory" note, each fact pinned by `memory-access.integration.spec.ts` (RLS hides it from everyone else incl. admins, except the owner-held Roadmap project; the company assistant can't read it; MCP keys act as you; text goes to the AI provider, voice to OpenRouter, prompts to PostHog only when `POSTHOG_API_KEY` is set; server access + backups). **Bug found: Delete only archived** (`DELETE /api/thoughts/:id` archived although the UI said "permanently"); now deletes the thought and everything derived (capture raw text, AI summaries). Migration 0128 re-links capture sessions to thoughts (backfilled). Delete on Overview tasks; Settings → Your data: export, purge archived, delete everything (typed confirm).
- **W4 Drive archive** (`1ab7cd3f`) — `1b41d96`, merge `4197eb1`. Archive is a state (`archived_at/by`, migration 0126), Archived view, badges in search, banner; "Suggest what to archive" (facts pick candidates: editable, unchanged ≥ N days, ≤ 60; the model judges name/folder/type/size/dates via the gateway + JSON schema; the person confirms). Agent tools archive/unarchive (approval-gated), list_archived, suggest_archive.
- **W5 Messages presence** (`119f59a4`) — `d013310`, merge `fbb0074`, follow-up `89fc68a` (heartbeat moved into the nucleus layout so leaving Messages doesn't show you offline). Online / away / in a call / do not disturb / offline ("active 2 h ago") over the existing Messages SSE stream; in memory, no migration; offline after 90 s without heartbeat.
- **W6 Accessibility** (`b73604ff`) — `26acbc2`, `545bd4a`, merge `343a57a`. WCAG AA contrast spec over the token pairs, light + dark; worst pair 2.40 → 4.83; brand styles corrected to AA when they theme the app; min text 13px; solid focus rings; reduced motion.
- **W7 Brand guide upload + honest capture failure** (`17b56d93`, `ffa2aa98`) — `bce5631`, `7f03e70`, `06ed24f`, merge `ed15f1b`. URL capture without a browser answers 503 with "upload your brand guide instead" (typed `BrowserUnavailableError`, checked before launch). Upload PDF ≤ 10 MB / images ≤ 5 MB (type from bytes), stored base64 in `brand_extraction_guides` (migration 0127), same propose → judge → accept loop. Gateway: optional `attachments` on user messages (image_url / file parts; logs and analytics get type/name/size only).
- **Behaviour changes the owner must know (no silent removals):** Email's "Contacts" tab is now "Lists" (same route/function, links to Contacts). Members no longer see Website in nav/quick links, nor Brand → Extract (both answered 403). Module cards go to the nav page instead of `/m/<id>` (Brand's card pointed at a missing page). The 403 page no longer shows the server's message. `DELETE /api/thoughts/:id` now really deletes; deleting a Roadmap task answers 409; delete-all also removes notes and check-in answers.
- **Decisions (owner may veto):** see `plan/contribute-round-3.md` (Contacts own module, private by default; logo uploaded in Settings; presence in memory). Plus: logo bytes on disk next to profile pictures; guide bytes in Postgres; DND changes status only, does not mute push (owner call).
- **Gates on `contribute-round-3`:** `npm run check` 0 errors (32 warnings); lint 0 errors; unit 749 files / 5963 tests passed (80 skipped, Postgres specs need DATABASE_URL); components 248/249 — the one failure, `app-detail-settings.svelte.spec.ts`, fails the same on main (`f37a68a`), not from this round. Workstreams ran their own Postgres specs on private DBs `ee_w1…ee_w7` (still on :5433). No e2e run, not on the box.
- **Left:** Contacts history/import/per-person sharing; logo + tone of voice from guides (seed schema has neither); `BRAND_EXTRACT_MODEL` must read images + PDFs; Memory's Tasks-tab trash icon still archives, AI usage previews/PostHog/server logs keep memory text, "Delete project" only dismisses; a11y page-level offenders (≈176 tiny text sizes, ≈157 faded text uses, 4 `outline-none` without replacement — list in the W6 report); Calendar (`df14e05a`), Email inbox (`eb674853`), Brand material part 2 (`288dc1d2`) next round; board statuses on production.

## 2026-11-12 — Members & invites 502 (Contribute A1): cause found and fixed; v0.5.4 published (not on production yet)

Owner: "why do i get … HTTP ERROR 502 when i try to access settings/members?", then "Yes, fix it".
- **Cause (from the production journal, os.cerberusblue.com):** the whole os process crashed on every Members visit. The page reads groups from the company data repo, which runs short git commands through `spawnGit` (`src/lib/server/gitstore/engine.ts`). It always ended git's stdin with `child.stdin.end('')`. When git (e.g. `rev-parse`) exits without reading stdin, the write hits a closed pipe and there was no `error` listener on `child.stdin` → unhandled `EPIPE` → node exits 1 → Caddy `EOF` / `connection refused` = 502 until systemd restarts it. 4 crashes since 2026-11-11 (13:30, 13:52, 19:33, 2026-11-12 11:12 CET), one per Members visit in Caddy's error log. Reproduced on the server with the app's node, as its uid, in its mount namespace (an exit-0 `git rev-parse` raised EPIPE). Locally the race rarely loses, which is why it was "not reproduced" over MCP (`members.list` never touches git).
- **Fix:** no input → git gets no stdin pipe (`'ignore'`, i.e. /dev/null); with input, a stdin `error` listener: EPIPE is not the outcome (git's exit code + stderr are, and callers check them), any other stdin error rejects. Tests first in `engine.spec.ts` (`spawnGit`: 8 MB input to `rev-parse` failed red with the uncaught EPIPE; no-input `hash-object --stdin` gives the empty blob). No other child-stdin writes in the repo.
- **Gates:** unit 5491 passed / 58 skipped; svelte-check 0 errors (the conditional stdio tuple first left `child.stdout`/`stderr` typed nullable, now asserted — they are always piped); lint 0 errors. E2E on the two Members specs: `ws-fixes` passed; `team-invite-passkey` (invite → group → remove) failed once with `page.goto: net::ERR_ABORTED` on `/settings/members` 3 s into a cold harness (the server stayed up), then passed alone (22 s) → cold-harness flake. Full e2e suite not run (~15 min, known unrelated failures on main). An orphaned `npm test` e2e run from this session (16 min on :4173) was stopped first.
- **Release:** fix `b1ac517`, bump `0157e19`, tag `v0.5.4` (main pushed through the pre-push gate: lint 0 errors, check 0 errors, unit 5491 passed). Run 43202686040 succeeded (arm64 + amd64 builds + publish). GitHub lists v0.5.4 as Latest; `latest/download/LATEST` serves `eigenenterprise-0.5.4-0157e19fbf18`. Carries only this fix over v0.5.3.
- **Production state (observed 2026-11-12):** os.cerberusblue.com runs os **0.5.3** (release dir `08da7506921fad4e`, livekit workload up), so the "still on v0.5.1" lines in older entries are stale; the one-time `--node-ip` step of the calls upgrade is behind it.
- **Not done:** production keeps crashing on Members until `ee upgrade` installs v0.5.4 there. Waiting for the owner's go.

## 2026-11-12 — v0.5.3 published on GitHub (Calls, proven on the box); the v0.5.2 hold is lifted

Owner: "Yes, release v0.5.3", then "Yes, retag and push" (waiting for another agent's commit first).
- **What:** tag `v0.5.3` on `ec04458` (version bump `bb6e03d`). It carries everything in v0.5.2 plus the S4 fixes (`603820c` DM hang-up ends for both, `e045e0e` LIVEKIT_API_URL), the two box fixes (`3b49fab` ProcSubset=all for host-port workloads, `46c5979` the fingerprint covers the rendered unit), and the TTS fix (`d5bd18f`). The local CI gate passed in the pre-push hook.
- **Release:** run 43127716364 succeeded (both arch builds + publish). GitHub lists v0.5.3 as Latest and v0.5.2 stays a pre-release. `latest/download/LATEST` serves `eigenenterprise-0.5.3-ec044582dca4`. The assets include `livekit-server-1.13.11-linux-{x64,arm64}.tar.gz` + .sha256.
- **Hold lifted:** servers may upgrade, to v0.5.3 (never v0.5.2). The first upgrade asks once for `ee upgrade --node-ip <public IP>`. It redeploys every workload once (`46c5979`), blue-green for os/apps.
- **Not done:** os.cerberusblue.com is still on v0.5.1; no server has been upgraded. A real call over the internet (public IP, TURN on 443 later) is unproven. Calls has only run on the local box.

## 2026-11-11 — Calls box proof passed: a real two-person call through the ee box (released in v0.5.3)

Owner: "Yes, recreate the box". Release `scripts/release.sh arm64` (eigenEnterprise 0.5.2 + livekit-server 1.13.11, pinned checksum verified), `ee/e2e/box.sh up` + `install os.ee.localhost` (`--node-ip 127.0.0.1`).

- **Proven on the box (Linux, systemd, Caddy):** livekit-server runs under the unit hardening (`ee-livekit-*` active); binds 7881/tcp + 7882/udp; Caddy holds 127.0.0.1:4000 → os and 127.0.0.1:4001 → livekit; `https://rtc.os.ee.localhost` reaches livekit (GET / 200; a WebSocket with a bad token gets LiveKit's 401); os has `LIVEKIT_URL=wss://rtc.os.ee.localhost`, `LIVEKIT_API_URL=http://127.0.0.1:4001`, key + secret.
- **Real call** (scratch Playwright script, two Chromium contexts with fake camera/mic): claim → owner and member complete profiles → member joins by the invite link shown on Members (no email) → owner starts a meeting on /calls → member is rung on /drive and accepts → both see the other's live video (frames still arriving) → webhooks via 127.0.0.1:4000 record both joins → both hang up → call `ended`. livekit's log: `sent webhook` for each event, `room closed`, `room_finished`. Screenshots: `box-01-incoming.png`, `box-02-call-owner.png` (scratchpad).
- **Bugs the box found (fixed, tests first):**
  - `3b49fab` — under `ProcSubset=pid` LiveKit logged an ERROR every 2 s (`open /proc/loadavg`): its node-load stats need system-wide `/proc` counters. Host-port workloads (livekit only) now get `ProcSubset=all`; `ProtectProc=invisible` still hides other processes, `ProtectKernelTunables` keeps `/proc/sys` read-only. Pinned by `units.spec.ts`.
  - `46c5979` — the deploy fingerprint did not cover the rendered unit, so an ee upgrade that changed the unit template never reached a workload with an unchanged release + config (the box kept livekit's old unit after upgrading). The fingerprint now includes the unit rendered at a fixed slot/port; `reconcile.spec.ts` proves a template change redeploys livekit and os. One-time effect: the first upgrade to an ee with this fix redeploys every workload once (blue-green for os/apps; livekit restarts, dropping calls in progress).
- **Decision log (architecture impact; owner may veto):** (1) host-port workloads get `ProcSubset=all` (above). (2) Any change to the rendered unit is a deploy (above). Both join `AF_NETLINK` as the only hardening differences for host-port workloads.
- **Harmless, noted:** two `udp_mux … closed pipe` ERRORs at the moment of hang-up (the last packet written to a just-closed connection). The claim link works once and the owner has no passkey on the box, so a rerun of the proof needs the saved session or a fresh box.
- **Box state now:** claimed by `owner@ee.localhost` (test), member `member@ee.localhost`; the box's earlier install was wiped (owner approved).
- **Release hold:** v0.5.2 on GitHub lacks both fixes (livekit would log the `/proc/loadavg` ERROR every 2 s). Keep it a pre-release; publish the calls work as **v0.5.3** from main instead (needs owner OK: push main + tag).

## 2026-11-11 — Contribute round 2 bugs: TTS fixed; brand capture and Members 502 diagnosed (main, pushed, not released)

Owner: "Fix the bugs" (plan/contribute-round-2.md §A).
- **TTS (A4), fixed:** `tts-client.ts` default model `qwen/qwen-audio-3.0-tts-flash`, voice `longanhuan_v3.6`. **Owner decisions (2026-11-11): TTS stays on Qwen; the voice is a woman's** (a first pass to `google/gemini-3.8-flash-tts` was reverted before commit). The old pair could never work: `qwen/qwen3-tts-flash-2026-02-10` has no OpenRouter endpoints, and `alloy` is in no OpenRouter speech model's `supported_voices`. The successor has one live endpoint (Alibaba, $0.000015/char) and lists only two voices, `loongjohn` and `longanhuan_v3.6` (Chinese voice names; how they sound in German is unknown). Note: ../eigen has no TTS; it pins Qwen only for STT. `LLM_MODEL_TTS` / `LLM_TTS_VOICE` overrides kept. Test first (`tts-client.spec.ts`). **Not verified live:** the local `.env` has no OpenRouter key.
- **Brand URL extraction 500 (A2), cause found, not fixed:** `brand.extract_start` → `captureSite()` runs `chromium.launch()` (Playwright). Releases install node_modules with `npm ci --ignore-scripts` and never download a browser. The local ee box (same install shape) has no Chromium anywhere. The launch throws, `executeBrandExtractTool` rethrows a plain Error, and SvelteKit answers "Internal Error". Fixing it means shipping a headless Chromium (plus its system libraries) to servers. That is a substrate decision for the owner. Over MCP the tool is refused for agents (G8), so production wasn't probed directly.
- **Members & invites 502 (A1), not reproduced:** on production `members.list` and `members.group_list` (MCP) answer fine, and the app is up. No code path returns 502; the proxy answers 502 when the app doesn't respond (crash/restart). Needs the page opened signed in on production, or the server log.
- **"Couldn't transcribe" (A3):** no code; fixed in v0.5.2, waits for the upgrade hold.

## 2026-11-11 — Contribute board round 2 triaged: 12 new proposals (plan only, no code)

Owner: "get the latest entries from the contribute MCP for eigenenterprise and integrate the tasks". Read os.cerberusblue.com over its MCP (`contribute.list status:all`): 24 proposals, 12 new since round 1 (all `requested`). Triage in `plan/contribute-round-2.md`.
- **Bugs:** Members & invites 502 and Brand URL extraction 500: cause unknown, needs the production log. "Couldn't transcribe the recording": already fixed in v0.5.2, but production is on v0.5.1 (hold). TTS broken: known (voice model has no OpenRouter endpoints), fix not landed.
- **Small ideas:** edit company name + logo (doesn't exist), Memory privacy note + delete, Messages presence, Drive archive, accessibility (contrast/type/spacing).
- **Need owner decisions:** Email inbox (no inbound mail storage), Contacts as a people tracker (own module?), Calendar module.
- Board statuses on production NOT changed.
- **Next:** production logs for the two 5xx bugs; TTS model fix; owner answers on C1–C3.

## 2026-11-11 — Calls S4 (e2e against a real livekit-server) green; DM hang-up ends for both (main, not pushed, not on the box)

Owner: "Start S4", then "Yes, end for both". livekit-server 1.13.11 installed on this Mac via Homebrew (`homebrew/core`, same version ee pins).

- **Harness** — `8353eb6`: `playwright.config.ts` runs a throwaway `livekit-server` as a third webServer. It first checks `livekit-server --version` against `LIVEKIT_VERSION` in `scripts/release.sh`; a missing or different binary throws with install steps (no skip). Config goes in via `LIVEKIT_CONFIG`: fixed throwaway keys, signalling 127.0.0.1:7880, media on loopback 7891/tcp + 7892/udp (never the box's 7881/7882), webhook → `http://localhost:4173/api/calls/livekit` (checked: reaches Vite on `[::1]`). Fake camera/mic flags only in the calls spec. `scripts/vite-config.spec.ts` pins the three servers.
- **E2E** — `b600003`, merge `68b78bd`; `src/routes/e2e/calls.e2e.ts`. All 4 pass on main `603820c` (1.5 min): DM call (toast on `/drive`, both see the other's live video with frames still arriving, hang-up ends it on both pages, "Call" line in both DMs), decline, missed (the real 45 s ring), three-person channel call. Screenshots (desktop + 375 px) in `test-results/calls/`.
- **What the real server showed:** the LiveKit browser adapter needed no fixes; webhooks arrive signed and drive joins.
- **Owner decision (2026-11-11):** a DM call ends for both at the first hang-up. A network drop (webhook `left`) is not a hang-up: the call waits for the reconnect. Channel and meeting calls still end when the last person leaves. — `603820c` (tests first; `call-log.spec.ts`'s first case now expects the line at the first hang-up). Same commit: the room is closed whenever a call ends, not only when someone is recorded in it. This fixes a race found in review: a decline that arrives before the caller's join webhook left the caller in an open room.
- **Gates (main `603820c`):** unit 5489 passed / 58 skipped; ee 208 / 3 skipped; typecheck 0 errors (31 warnings); lint 0 errors (221 warnings); calls e2e 4/4.
- **Noted:** in e2e, `[calls] hang up failed … Failed to fetch` appears at teardown: Playwright destroys browser contexts, which kills even `keepalive` requests. The calls were already over. Tab close uses `keepalive` on `pagehide` (`src/lib/calls/call-view.svelte`) but hasn't been seen working in a real browser. The Calls nav item uses the generic module icon.
- **Next:** box proof (owner approval needed: `box.sh up` recreates the box and wipes its install): livekit under the unit hardening, ports 7881/tcp + 7882/udp, `wss://rtc.os.ee.localhost`, a webhook through 127.0.0.1:4000, a real call through Caddy. Then lift the v0.5.2 hold or cut v0.5.3 (see the HOLD entry below).

## 2026-11-11 — HOLD: no server upgrades to v0.5.2 until Calls S4 passes

- **Why:** `v0.5.2` (`c7bb276`, tagged by another session) carries Calls S1–S3. It has never run against a real livekit-server, and the livekit unit's hardening is unproven on Linux. Also, its first `ee upgrade` on a server stops once and asks for `--node-ip <public IP>`.
- **Owner decision (2026-11-11):** hold upgrades. Nobody runs `ee upgrade` or `install.sh` against v0.5.2 on production (os.cerberusblue.com) or any other server until S4 (real-LiveKit e2e + box proof) passes and this hold is lifted here.
- **How upgrades work:** they are manual only (no timer); `ee upgrade` and fresh installs fetch `releases/latest/download` (`ee/src/upgrade.ts:17`). While v0.5.2 is GitHub's "latest", anyone running `ee upgrade` gets it.
- **Enforced (owner: "Yes, mark pre-release"):** the v0.5.2 release run 43069381496 succeeded (assets include `livekit-server-1.13.11-linux-{x64,arm64}.tar.gz` + .sha256, so `c5e51d9` works). Then `gh release edit v0.5.2 --prerelease --latest=false` and `gh release edit v0.5.1 --latest`. Verified: the API reports latest = v0.5.1, and `latest/download/LATEST` redirects to v0.5.1 (GitHub's cache took about a minute). v0.5.2 assets stay downloadable at `releases/download/v0.5.2/`.
- **Lifted 2026-11-12:** v0.5.3 published as latest (see the entry above); v0.5.2 stays a pre-release.
- **Lifting the hold:** once S4 passes, `gh release edit v0.5.2 --prerelease=false --latest` (or cut v0.5.3 with the S4 fixes, which the workflow publishes as latest).

## 2026-11-11 — v0.5.2 published on GitHub (Calls, dictation fix, speech readiness)

Owner: "Yes, release". Published: https://github.com/hikaru90/eigen-enterprise/releases/tag/v0.5.2 (run 43069381496: amd64 + arm64 + publish green); `latest/download/LATEST` → `eigenenterprise-0.5.2-c7bb2763d010`. Release commit `c7bb276`. Carries everything since v0.5.1: Calls S1–S3 (`d4b6ae7` … `05db26c`: ee runs livekit-server, Calls module core, call UI + call lines in Messages), `542bd65` STT on `qwen/qwen3-asr-0.6b` (fixes "Couldn't transcribe the recording"), `a7d4c20` speech needs OpenRouter said up front + endpoint check. Local `vite build` ran green before tagging (the gate gap noted under v0.5.1).

**Not done:** os.cerberusblue.com stays on v0.5.1 — see the HOLD entry above (no `ee upgrade` to v0.5.2 until Calls S4 passes). After the upgrade the server log and Settings → AI provider will flag the assistant's voice (TTS) model `qwen/qwen3-tts-flash-2026-02-10` as having no OpenRouter endpoints — known, fix proposed separately. Not tried on a real server or microphone yet.

## 2026-11-11 — Calls S3 (UI + call lines in Messages) merged (main, not pushed, not on the box)

Owner: "Start S3" (plan/video-calls.md §2–3). One worktree subagent, merged by the orchestrator.

- **What** — `f5f2017`, `143dd6f`, merge `5af00eb`:
  - **Call page** `/calls/[id]`: accept if needed → token → join; grid with names, muted indicator, screen-share tiles; mute / camera / screen share / hang up. Leaving the page or closing the tab hangs up once. "Calls are not set up on this server" is shown plainly; a blocked camera/mic says how to allow it.
  - **`/calls` page**: live calls to (re)join, recent calls (who, when, duration, missed/declined), **New meeting** (any member). Disabled with the reason when LiveKit isn't configured.
  - **Ring on every nucleus page**: `incoming-call-toast.svelte` in `(nucleus)/+layout.svelte`, one `EventSource` on `/api/calls/stream` opened in `onMount`, Web Audio ringtone (silent, no error, when autoplay is blocked).
  - **Call / Join button** in DM and channel headers.
  - `livekit-client` 2.23.0 behind a `CallRoom` interface (`src/lib/calls/room.ts`), loaded only in the browser.
- **Messages change** (new, nothing removed): **call lines**. Migration `0123_message_call_lines` adds `messages.call` jsonb (`{callId, outcome, durationSeconds}`, shape-checked, top-level only, unique per call id). `postCallLine` (`modules/messages/service.ts`) is a no-op on a repeat post; editing a call line is refused. Rows render "Call, 4 min" / "Missed call" / "Declined call" from the data, never from text. Calls tells `CallLogPort.callEnded` once per DM/channel call (meetings post nothing); `modules/index.ts` adapts it to Messages. A failing port fails the request loudly, with the call state already stored.
- **Visible change (announced):** new nav entry **Calls**, after Messages. Since S2 it had shown up as a generic `/m/calls` entry; it now goes to `/calls`.
- **Orchestrator** — `05db26c`: test for "accepted but nobody connected, caller hangs up" → missed line, hang-up succeeds. (In review I suspected a stuck call there; the state machine already handles it: "answered" means someone else connected media, not just clicked Accept.)
- **Gates (merged main `05db26c`):** unit 5469 passed / 58 skipped; components 193 / 194, the one failure `app-detail-settings.svelte.spec.ts` is the same one already on main; typecheck 0 errors (31 warnings); lint 0 errors (218 warnings); test-DB migrate clean (0123 applied).
- **Not verified:** no livekit-server has run, so the LiveKit adapter (remote audio, the autoplay unlock click, disconnect reasons) is only type-checked and tested against a fake room. The UI hasn't been looked at in a browser, phone width included. Flaky: `modules/messages/db-store.pg.spec.ts` "many concurrent appends" failed 2 of 4 runs during S3 (event log, unrelated to call lines). No push notification for a call while the tab is closed (later slice).
- **Next:** S4: `livekit-server --dev` in the e2e harness (needs the binary on this machine), two-browser e2e (DM call, decline, missed, three-person channel call), box proof (`box.sh up` recreates the box and wipes its install).

## 2026-11-11 — Speech needs OpenRouter, said up front; speech models checked for live endpoints (released in v0.5.2)

Owner: "we need endpoints for it, and maybe we should make it mandatory that the user uses open router … at least if they want to use the speech for text" → "Yes, build both".

- **Requirement stated:** speech already runs only on OpenRouter (`llmCreateTranscription`: the billing user's own OpenRouter key under BYOK, else the platform key). `speechToTextReadiness()` (`src/lib/server/llm/speech-readiness.ts`) asks it the way `/api/voice/transcribe` runs it — on the company provider, through the same lookup (now exported: `sttCredentialSource`, `loadOpenRouterSttConfig`) — and answers `ready`, or what is missing: `openrouter_key` (BYOK, owner has none) / `platform_key` (platform credits, server has none). Codes, not error-message parsing. The shell carries it (`ShellData.dictation`); `voice-dictation.svelte` reads it via `$app/state` and disables the mic with the reason as its title, before any recording — every box (Messages composer/edit, Contribute composer/board note) at once. Only "not configured" counts as not ready; other failures surface. OpenRouter stays required for speech only — chat/agent/judge keep the company's provider.
- **Endpoints checked:** `checkSpeechModelEndpoints()` (`speech-models.ts`) asks OpenRouter's public `GET <OPENROUTER_BASE_URL>/models/<id>/endpoints` (no key, nothing about the company sent) for the dictation model (`STT_MODEL`) and the voice model (`ttsModelId()`, now exported); 5 s timeout, 10 min cache (failures not cached); a failed lookup is reported as such, never as fine; no `OPENROUTER_BASE_URL` → says so. **Startup:** `hooks.server.ts` `init` runs `reportSpeechModelsAtStartup()` (not awaited, never blocks boot) → `console.error('[speech] … has no endpoints on OpenRouter — every call will fail')`. **Settings → AI provider** gets a "Speech" section (`src/lib/components/settings/speech-status.svelte`): dictation Ready / what's missing, and each model's providers; a model with none or a failed check is a `role="alert"` row.
- **Tests (written first, each failed first):** `speech-readiness.spec.ts` (6), `speech-models.spec.ts` (7), `layout.server.spec.ts` (+1), settings `page.server.spec.ts` (+1), `voice-dictation.svelte.spec.ts` (+3), `speech-status.svelte.spec.ts` (4, registered). New `$app/state` stub for component tests (`src/lib/vitest-stubs/app-state.svelte.ts`).
- **Gates:** typecheck 0 errors; lint 0 errors; unit 5448 passed; components 181/182 (the one failure is the pre-existing `app-detail-settings.svelte.spec.ts`); `vite build` green.

**Known:** the voice model (`qwen/qwen3-tts-flash-2026-02-10`) still has 0 endpoints — the new check reports it at startup and in settings until the TTS fix lands (separate task card). A disabled button's tooltip doesn't show on touch devices; the settings page carries the same sentence.

## 2026-11-11 — Fix: dictation always failed with "Couldn't transcribe the recording" (released in v0.5.2)

Owner: "update the speech to text from ../eigen to this repo. it was buggy … currently i get Couldn't transcribe the recording".

- **Cause:** the port kept this repo's STT model `qwen/qwen3-asr-flash-2026-02-10`, which has **no endpoints on OpenRouter** (public `/models/<id>/endpoints`: empty), so every `/audio/transcriptions` call failed and `/api/voice/transcribe` answered 502 → the client's "Couldn't transcribe the recording". Eigen's `qwen/qwen3-asr-0.6b` has live endpoints (PrimeIntellect, DeepInfra).
- **Fix (from eigen):** `stt-client.ts` `STT_MODEL = 'qwen/qwen3-asr-0.6b'`, fixed in code, no override — used by dictation and the assistant's capture routes alike. Tests first (`stt-client.spec.ts`: pinned id; an `LLM_MODEL_STT` left in env is ignored) — failed, now pass. Client voice code already matched eigen (only a comment differs); the judge stays the gateway-chat port.
- **Removed (announced):** the `LLM_MODEL_STT` override (env type, `.env.example`, `docs/payments.md`) — eigen has none; a deployment that still sets it is ignored.
- **Gates:** typecheck 0 errors; lint 0 on touched files; unit 5433 passed; `vite build` green. Not tried with a real microphone + provider.

**Found, not fixed:** the assistant's voice (`tts-client.ts` `qwen/qwen3-tts-flash-2026-02-10`) also has 0 OpenRouter endpoints — speech synthesis likely fails the same way.

## 2026-11-11 — Calls S1 (ee runs LiveKit) + S2 (Calls module core) merged (main, not pushed, not on the box)

Owner: "Start S1 and S2" (plan/video-calls.md). Two worktree subagents, merged by the orchestrator.

- **S1 ee** — `d4b6ae7`, merge `9de54e2`. `runtime: 'binary'` (system tier only; apps keep node/static), host `ports` (system only, allow-list 7881/tcp + 7882/udp, collisions rejected; unit gets `SocketBindAllow` lines), livekit-server v1.13.11 seeded as a system workload from a checksum-pinned, reproducible release tarball (`scripts/release.sh`, `ee/install.sh` fetch + verify), config rendered into `LIVEKIT_CONFIG` (loopback signalling on the slot port, explicit `settings.rtcNodeIp`, keys from the secret store `livekit` scope, webhook → `http://127.0.0.1:4000/api/calls/livekit`), calls host `rtc.<console host>` follows the console host. Box publishes 7881/tcp + 7882/udp and installs with `--node-ip 127.0.0.1`.
- **S2 Calls module** — `9bdc6db`, `ff206b3`, merge `f529588`. `modules/calls`: migration `0122_calls` (call, call_participant; one live call per DM/channel via a partial unique index — two people calling each other meet in one call), pure state machine (45 s ring → missed), LiveKit tokens (one room, identity = user id, 10 min, only after accepting), signed webhook as truth for joins/leaves (bad signature → 401, no change; CSRF-exempt), `GET /api/calls/stream` (SSE over `pg_notify('ee_calls')`, snapshot on open, no resume log), `calls.list` / `calls.start` (approval-gated) / `calls.end` (starter only), `/api/calls/**`. Membership through a Calls-side port (`modules/calls/context-port.ts`) adapted in `modules/index.ts` from Messages' existing exports — Messages untouched.
- **Orchestrator fixes** — `c5e51d9`: the release workflow uploads + publishes `livekit-server-*.tar.gz` (+ .sha256), which `install.sh` now fetches (the next tag would otherwise have broken installs/upgrades). `e045e0e`: the console reached LiveKit's server API (close room) via the public `wss://rtc.<host>` — hairpin + the box's local CA; now ee gives os `LIVEKIT_API_URL=http://127.0.0.1:4001`, a Caddy internal listener → livekit (like 4000 → os). Tests first. `livekit-server-sdk` pinned to 2.19.2 (2.19.3 was one day old).
- **Gates (merged main `e045e0e`):** unit 5432 passed / 57 skipped; ee 208 passed / 3 skipped; typecheck 0 errors (31 pre-existing warnings); lint 0 errors (216 warnings); test-DB migrate clean (0122 applied).
- **Decision log (architecture impact):** (1) Units of workloads holding host ports also allow `AF_NETLINK` (Go's UDP mux lists interfaces over netlink; no capabilities, so read-only) — owner may veto. (2) A workload with host ports cannot run two slots side by side: its deploy stops the live slot, then starts the candidate behind the health check (rollback restarts the old slot) — a livekit deploy drops calls in progress; an unchanged pass restarts nothing. (3) `--node-ip` is required on first install and on the first upgrade to a release with calls (never guessed) — that upgrade stops once and asks. (4) Agents only start meetings, never join or get tokens; only the starter can `calls.end`.
- **Not verified:** no livekit-server has run anywhere (the binary has never run under the unit hardening — main box risk: SIGSYS / address-family errors); tokens and webhook proven only with the SDK's own signing. The existing box needs `box.sh up` (recreates the container, wipes its install) to get the new ports. `/v1/status` now lists a `livekit` system workload — the Apps UI may show it.
- **Next:** S3 (UI: /calls, call page with `livekit-client`, ring toast on every nucleus page, call button in DM/channel headers, "Call, n min" system message — needs a Messages-side port), S4 (`livekit-server --dev` in the e2e harness — needs the binary on this machine; two-browser e2e; box proof). Relay-only (TURN) box proof waits on TURN (owner decision 3: later).

## 2026-11-11 — v0.5.1 published on GitHub (Contribute board round 1, dictation, Install app, kernel autocommit opt-in)

Owner: "commit, push, release". Published: https://github.com/hikaru90/eigen-enterprise/releases/tag/v0.5.1 (run 43045254995: amd64 + arm64 + publish green); `latest/download/LATEST` → `eigenenterprise-0.5.1-0a619d03996e`. Carries everything since v0.4.2: `ebc3c0c` Install app, `4b259c3` dictation, the Contribute-board round (`b1b22c0` … `66ed759`), `4f55f82` autocommit opt-in, the Calls plan docs.

- **What broke:** `v0.5.0` (`8fcc403`, tag pushed) failed its release build: `src/routes/api/voice/transcribe/+server.ts` exported `TRANSCRIBE_FAILED_MESSAGE`, which SvelteKit's postbuild analysis rejects (only handlers / `_`-prefixed exports). Nothing was published under v0.5.0; the tag stays on GitHub without a release (not force-moved). Fix `83e94fd` moved the constant to `transcribe/messages.ts`; local `vite build` green; bumped to 0.5.1 (`0a619d0`).
- **Gate gap:** the pre-push gate (`ci:local`: lint, naming, check, unit) does not run `vite build`, so route-export errors only surface in the release workflow.
- **Production board:** via its MCP, the 8 integrated proposals were marked Shipped ("Erledigt – live mit dem nächsten Release" + what changed); Email and Brand material set In progress with what's left; video calls and brand-guide upload stay Requested.

**Not done:** os.cerberusblue.com still runs the older release until `ee upgrade` runs on it (owner's go) — the "Shipped" notes are true only after that. The production API key pasted in chat should be rotated.

## 2026-11-11 — Kernel autocommit can no longer commit the source checkout (main, not pushed, not on the box)

Owner: "Yes, fix it" (the stray `tool brand.picker_choose by …` commits on main, entries below).

- **Root cause:** `wireKernel` defaulted to `new GitCommitter()`, which ran `git commit -am` in the process's working directory. Production was safe only because ee sets `EE_VCS_AUTOCOMMIT=0`; the e2e harness (`vite dev` inside the checkout) committed the developer's uncommitted tracked files on every `mutate` tool call (third time recorded: `tool website.create_page by orchestrator`, then twice today).
- **Fix:** `GitCommitter(repoDir)` requires an absolute repository path and always runs `git -C <repoDir> commit -am`. `wireKernel`'s default is `vcsCommitterFromEnv(process.env)`: **off unless `EE_VCS_REPO_DIR` is set**; a relative path fails loud. `EE_VCS_AUTOCOMMIT=0` still disables a configured committer (ee keeps setting it). Tests: `src/lib/kernel/vcs.spec.ts` (git gets `-C <repo>`; relative path refused; unset env → no committer) — written first, failed, now pass.

**Decision (announced change):** per-tool git autocommit is now opt-in instead of default-on. Nothing in this repo or under ee relied on the default (ee turns it off; the release has no `.git`; kernel_events stays the audit trail). To get the old behaviour back for a repo, set `EE_VCS_REPO_DIR=/abs/path/to/repo`.

## 2026-11-11 — Video calls re-planned as the Calls module on LiveKit (plan only, no code)

- **What:** `plan/video-calls.md` rewritten. Calls is its own system module (`modules/calls`: call + participant tables, LiveKit room tokens, signed LiveKit webhook as the source of truth for who joined, its own SSE stream so it rings on any page, `calls.*` kernel tools — agents never join media). Messages only gets a call button and "Call, n min" system messages, both through ports. livekit-server runs as an ee system workload.
- **Decision log (architecture impact):** (1) owner: video calls are a separate module, not part of Messages; (2) owner: media server is LiveKit — supersedes the `5afae92` draft (P2P + coturn first). (3) Proposed, owner can veto: one media path — 1:1 calls also go through LiveKit, no P2P, no coturn (LiveKit's embedded TURN). (4) Proposed: ee gains a `binary` runtime and a host `ports` field for system workloads only (allow-list 7881/tcp, 7882/udp), and a calls host `rtc.<console host>` routed through Caddy.
- **Owner accepted all 6 recommendations (2026-11-11):** 1:1 on LiveKit too (no P2P, no coturn); ee host ports for system workloads only (7881/tcp, 7882/udp); TURN on 443 later; recording/transcripts later with consent UX; ring on any nucleus page; every member can start a meeting. Plan marked approved.
- **Next:** S1 (ee) and S2 (module core) in parallel worktrees, then S3 (UI + Messages), S4 (two-browser e2e + box relay proof).

## 2026-11-11 — Production Contribute board, round 1: 12 proposals worked (main, not pushed, not on the box)

Owner: "get the contribute tab items" from os.cerberusblue.com (read over its MCP, `contribute.list status:all`: 12 proposals, all Requested), then "plan here and fix every task as a subagent on low". Orchestrated as 7 worktree workstreams, merged on `contribute-board`. Board statuses on production NOT changed.

- **Contribute: draft lost on an outside click (bug)** — `b1b22c0`. The popover unmounts the composer; the draft now lives in `contribute-button.svelte` (bindable `text`). Component test fails without the fix, passes with it. **Dictation (2 proposals)** is covered by `4b259c3` (the voice session); the subagent's own dictation (`4c60d2b`, older streaming button, English-only) was dropped, not merged.
- **Dashboard: "Your company" opened "Connect your AI provider" (bug)** — `58f8021`. Cause: `/` showed full-screen `ProviderOnboarding` whenever the owner's provider was missing, even after the tour. Now it gates only during the welcome tour; afterwards the dashboard shows with a "Connect your AI provider" banner. Recent activity is grouped by day in one card (`activity-groups.ts`, unit-tested). Gap: no "what's happening / top priorities" summary exists.
- **Brand** — `5fbbee7`. New Material tab: digital flyer generated from the active style (banner, poster, merch marked "Coming"). Brand-guide upload **blocked**: the gateway's `ChatMessage.content` is text only — needs (a) file/image input in the gateway or (b) a PDF text extractor.
- **Email** — `ee8f3d0`. Landing is mail first (Pending + last 10 Sent); setup sections moved behind a Setup tab, URLs unchanged; old Overview now `/m/email/setup` ("Account"). Inbound mail isn't stored (no inbox); "who to write next" left out (needs an owner-set rule).
- **Drive** — `81e69bf`. "Who can see your Drive" note on My drive: private by default (creator + owner + admins), share with people/groups/company, the agent reads all of Drive; nothing can be hidden from owner/admins (gap).
- **Memory** — `8e9f339`. Landing is the open tasks with project tags; settings moved to `/m/memory/settings`, linked on the header's right.
- **Messages: video calls** — `5afae92`, plan only: `plan/video-calls.md` (1:1 P2P WebRTC + coturn as an ee workload first, LiveKit for groups; ee must learn to open UDP ports). 6 open owner decisions listed there.

**Gates (on `contribute-board`, base `4b259c3`):** typecheck 0 errors; lint 0 errors (212 pre-existing warnings); unit 5352 passed / 51 skipped; components 174/175 — the one failure, `app-detail-settings.svelte.spec.ts`, fails identically on plain `4b259c3` (pre-existing, untouched here). E2E not run; nothing tried on the box.

**Removed / replaced (announced):** returning owners no longer get the full-screen provider screen at `/` (banner instead); the Brand "Design system" tab is gone (page still at `/brand/system`, linked from Style); Email's Overview moved to Setup → Account; Memory's four "Sections" cards removed (pages still in the header tabs) and its settings form moved to its own page.

**What broke:** at 14:41 two commits titled "tool brand.picker_choose by <random principal>" (`bca8093`, `e07f5e0`) landed on main and swept the voice session's uncommitted tracked files into it, without its new files — main stopped building. Main was later reset past them. Likely cause: a test running `brand.picker_choose` with the kernel VCS pointed at the real checkout (candidates: `modules/brand/selection/picker-tool.spec.ts`, `modules/brand/selection/tools.spec.ts`, `modules/brand/tools.spec.ts`, `src/routes/api/brand/picker/choose/server.spec.ts`). Not fixed yet.

**Next:** fix the committing test; owner decisions — brand-guide upload (a/b), video calls (6), Email "who to write next" rule; release to the box; then mark the board items on production.

## 2026-11-11 — "Install app" in the settings menu: a sure way onto every device's home screen (main, not pushed, not on the box)

- **What:** the cog menu (`home-settings-menu.svelte`) gains **Install app** (hidden inside the installed app). It opens `src/lib/pwa/install-app-dialog.svelte`: the browser's own install dialog where Chromium offers one, otherwise the exact taps for this browser — iPhone/iPad Safari, Chrome, Firefox and Edge (Share → Add to Home Screen), Mac Safari (File → Add to Dock), Android Chrome, Samsung, Firefox and Edge, desktop Chrome and Edge (address-bar icon or menu path). Desktop Firefox and unknown browsers get a plain "cannot install here — open in Chrome, Edge or Safari" with Copy link. A dismissed browser dialog falls back to the menu path, so the screen always shows a way forward; "already installed" and "not https" are said plainly.
- **How:** `beforeinstallprompt` fires once, often before hydration, so an inline script in `src/app.html` captures it (and `appinstalled`) into `window.__eeInstall`; `src/lib/pwa/install.ts` reads it and fails loud if the capture is missing. `src/lib/pwa/install-prompt.ts` is the pure guide.
- **Decision:** browser detection reads the user agent — Safari, iOS and Android browsers expose no feature saying which install menu they have. Platform detection for instructions only, not meaning (the no-string-heuristics rule is about semantics).
- **Tests:** `install-prompt.spec.ts` (11, unit), `install-app-dialog.svelte.spec.ts` (6) + 2 new in `home-settings-menu.svelte.spec.ts` (component, enrolled in `vitest.browser.config.ts`). Typecheck + lint clean.
- **Not done:** not pushed, not on the box, not tried on a real phone. The Messages notifications banner's iPhone "install first" hint could open this dialog — not wired.
- **What broke:** the e2e harness auto-committed the source checkout twice (`tool brand.picker_choose by …`, via `GitCommitter` `git commit -am` in `src/lib/kernel/vcs.ts`), sweeping this work and the uncommitted dictation work into stray commits. Those two local commits were undone (soft, tree kept) and this work committed on its own; the harness fix is a separate task.

## 2026-11-11 — Dictation (speech to text) in every Messages and Contribute text box, ported from Eigen (main, not released)

Owner: "we need the speech to text functionality from ../eigen inside this repo for all text inputs in messages an contribute".

- **Where:** a mic button in the message composer (channel + thread — one component), the in-place message edit box, the Contribute proposal composer (top-bar popover) and the board's owner note editor. Tap → the box's action row becomes Eigen's voice bar (discard, live waveform, timer against the 5-minute cap, Done). Done uploads the whole clip once; the transcript is **appended** to what was typed (never overwrites). Transcribing shows the wait with Cancel; a failure shows a plain message with Retry (same clip, still in memory) / Dismiss.
- **Client (ported unchanged from Eigen):** `src/lib/voice/voice-message.ts` (the session state machine, injected browser APIs), `clip-speech.ts` (Layer 1 of "silence never becomes text": the finished clip is decoded and checked for speech-level sound before any upload; a silent clip is never sent), their specs + `src/lib/test/voice-doubles.ts`. New: `transcribe-voice-clip.ts`, `voice-failure-message.ts`, `voice-dictation.svelte` (the one component every box uses).
- **Server:** new `POST /api/voice/transcribe` — raw audio body (CSRF-exempt), ≤ 8 MB / 5 min; runs on the **company's AI provider** (`onCompanyProvider`, like the Contribute judge) so a member without their own provider can dictate. A non-empty transcript is judged by an LLM (`src/lib/server/llm/stt-judge.ts`, Layer 2: dictation vs. recognition artefact, JSON schema, 3 attempts, no pass-through) with samples of the person's own recent messages as language evidence (`stt-writing-samples.ts`). `""` = no speech. 503 + setup message when there is no company provider; 502 otherwise. `parseSttTranscript` now treats an empty `text` as "no speech" instead of an error.
- **Gates:** typecheck 0 errors; lint 0 errors; unit 5326 passed (incl. new `stt-judge.spec`, `api/voice/transcribe/server.spec`, Eigen's `voice-message` + `clip-speech` specs, `transcribe-voice-clip.spec`, `voice-failure-message.spec`); components: new `voice-dictation.svelte.spec.ts` 10/10 (bar, discard, retry, no speech, 503 message, denied mic, append in message composer / edit / Contribute). **Failing, not from this change:** `app-detail-settings.svelte.spec.ts` (fails with this change stashed too); e2e alone: 44 passed, 22 failed (capture, drive, email, mail, memory, profile, projects, release, tenant-isolation, website-apps, qa-project-assignment) — none in code this change touches; `contribute.e2e` passed. `messages.e2e` failed in the full run but passes alone (25 s) and on clean main → load flake. `profile.e2e` (crop step) also fails on clean main. (The first 64-failure run was the harness breaking while running in parallel with the component suite.) The other 20 failures were not compared against main (a full main run is ~15 min). No e2e for dictation yet.

**Decisions:** (1) Eigen's Layer-2 judge used its Decisions plane, which this repo doesn't have — ported as one gateway chat call with a JSON schema (same pattern as the Contribute judge); writing samples are the person's own messages (Eigen used their thoughts). (2) STT model unchanged (`qwen/qwen3-asr-flash-…`, `LLM_MODEL_STT` override kept); Eigen has since pinned `qwen/qwen3-asr-0.6b` with no override — not adopted without the owner. (3) STT needs OpenRouter credentials on the owner's account (BYOK) or `SERVICE_API_KEY_OPENROUTER`; another provider fails loud with the gateway's message.
**Not changed:** the assistant chat keeps its older streaming voice button on `/api/capture/transcribe` (member's own provider, no silence check).
**Not done:** not pushed, not released, not on the box, not tried with a real microphone + provider.

## 2026-11-11 — v0.4.2 published on GitHub (Contribute judge on the company's AI provider)

Owner: "Yes, release v0.4.2". Commit `c0badfe` (version 0.4.1 → 0.4.2), tag `v0.4.2`; carries fix `8dc8f4e` (entry below). Published: https://github.com/hikaru90/eigen-enterprise/releases/tag/v0.4.2 (run 43023079546: amd64 + arm64 + publish green), marked latest; `latest/download/LATEST` → `eigenenterprise-0.4.2-c0badfe5e683`. Pre-push gate green.

**Not done:** the VPS still runs an older release — `ee upgrade` on 152.53.118.209 (owner's go); then a member proposing on the VPS is the real check (not verified against a real provider yet).

## 2026-11-11 — Fix: Contribute's judge runs on the company's AI provider, not the proposer's (main, not released)

Owner: "when a person contributes, the error message comes up that eurouter is not configured. THIS CANT HAPPEN. we should use the normal set ai provider".

- **Cause:** AI-provider credentials are stored per account (`llm_provider_config` / `llm_active_provider` by user id), and the judge called the gateway as the proposer. A member who never set up a provider has no rows → the gateway falls through to the EUrouter env defaults → "EUrouter is not configured".
- **Fix:** `src/lib/server/llm/company-provider.ts` `onCompanyProvider(fn)` runs gateway calls with `billingUserAsyncLocal` = the owner (the existing override `loadLlmConfig` already honours), so provider config + credentials come from the owner's account; usage/activity stay on the proposer. No owner → `LlmNotConfiguredError` (fail loud, no fallback). `modules/contribute/live.ts` wraps the judge's chat in it.
- **Gates:** `company-provider.spec.ts` (owner's account inside, caller's outside, no owner → error before the call) + contribute unit tests green; `contribute.e2e.ts` passes (mock gateway via env — it doesn't model a member without their own provider; the unit spec covers the routing).

**Decision:** the company's AI provider = the owner's (the owner sets it in the founding journey; Settings → AI provider). Company-level features any member triggers run on it.
**Open (same root cause, not changed):** every other member-triggered AI call (assistant chat, capture/memory extraction, …) still resolves the member's own provider and would hit the same error for a member without one. Making the owner's provider the company default for all of them is a gateway-wide change — owner to decide.
**Not done:** not released (VPS still v0.4.1 without this fix) — needs v0.4.2 + `ee upgrade`.

## 2026-11-11 — v0.4.1 published on GitHub (Contribute release)

Owner: "Yes, release v0.4.1". Commit `deebce7` (version 0.4.0 → 0.4.1), tag `v0.4.1`. Carries Contribute (`c7f1c69`) — the first release since v0.4.0.

- **Published:** https://github.com/hikaru90/eigen-enterprise/releases/tag/v0.4.1 (workflow run 43010324844: amd64 + arm64 builds + publish green), marked latest. `latest/download/LATEST` → `eigenenterprise-0.4.1-deebce73f75d`.
- **Local CI gate** (pre-push) green: 0 lint/type errors, unit 5222 passed.
- **What broke:** the first push died with exit 141 (SIGPIPE) after the gate passed — git opens the SSH connection to GitHub before the ~3-minute pre-push gate, and the idle connection was dropped. Pushing with `GIT_SSH_COMMAND="ssh -o ServerAliveInterval=20"` went through. Lasting fix (not done): a keepalive in the SSH config for github.com, or a gate that doesn't hold the connection open.
- **Annotation:** GitHub warns `actions/checkout`, `setup-node`, `upload-artifact`, `download-artifact` @v4 target the deprecated Node 20 (forced onto Node 24 for now).

**Not done:** the VPS is still on v0.4.0 — next is `ee upgrade` on 152.53.118.209 (owner's go).

## 2026-11-10 — SHIPPED (main `c7f1c69`, pushed, on the box as release `c7f1c6970087`): Contribute — propose improvements from the top bar; an agent picks them up (ported from Eigen)

**On the box:** `ee-os-b` live (internal release `9c3a340b1b0c4c94`, carries the Contribute build), `applied == desired`, no reconcile error, `/api/health` ok; `contributions` + `contribution_votes` exist (0121 applied); signed out, `/contribute` → 302 /login and `/api/contribute` → 401. Not clicked through on the box (the e2e covers the journey).

Owner: "look at the contribute feature from Eigen and include it in Eigen Enterprise … a button at the top right where people can type into and propose improvements to the application, and things will then get picked up by an agent later".

- **Top bar** (`src/lib/components/contribute/contribute-button.svelte`, in `app-shell.svelte`): a "Contribute" button (lightbulb; label from `sm` up) at the right end of the top bar on every signed-in page. It opens Eigen's share composer (`contribute-composer.svelte`): Send runs the board's **LLM judge** first (kind idea|bug|polish, area from the app's surfaces, and whether the same request is already open). No duplicate → shared straight away ("Thanks — it's on the board. Sounds like a bug in Messages."). Duplicate → the chorus card: "Vote for it instead" or "Mine's different". ⌘/Ctrl+Enter sends.
- **Board** `/contribute` (`contribute-board.svelte`): Requested · In progress · Shipped tabs with counts, most wanted first (net score, newest breaks ties; shipped by ship date). Up/down votes (second click takes it back; shipped is closed). Owner/admins set the status (incl. Declined = off the board) and a note people read. No sidebar entry (the module is `internal`); the composer and the page link to each other.
- **Agent's hands** (kernel tools, module `contribute`, a system module — self-seeded active): `contribute.list` (default open = requested + in progress; or one status / all), `contribute.get`, `contribute.update` (status and/or note; shipping stamps `shipped_at`, moving away clears it). Agent + admin roles, no approval (internal, reversible). Reachable from the in-app assistant and `ee contribute.list`.
- **Server:** `modules/contribute/` (catalog, judge, service, DB + in-memory stores, http, live, tools); `/api/contribute` (GET board, POST share), `/check` (judge only, creates nothing), `/[id]` PATCH (owner/admin), `/[id]/vote`. Kernel events `contribute.proposed` and `contribute.status_changed` (activity feed).
- **Migration `0121_contributions`** (journal idx 121): `contributions` (check constraints for kind/area/status/lengths, `shipped_at` set iff shipped) and `contribution_votes` (±1, PK per person). Company-level, no RLS (like Messages).
- **Test infra:** the mock gateway answers `[mock-json:<base64url>]` with exactly that content (an LLM judge's verdict in e2e); the browser `$app/navigation` stub gained `invalidate`.

**Decisions**
- The judge is required, like Eigen: no AI provider / failed check → the error shows in the composer and nothing is created (no fallback kind, no "assume not a duplicate"); 3 attempts on invalid JSON, gateway errors are not retried.
- Duplicate candidates are the 40 newest open proposals, not embedding-ranked like Eigen (one company's board is small; no vector column). Revisit when a company has more open proposals than that.
- Everyone signed in proposes and votes; only owner/admins (and the agent) change status or notes.

**Gates:** svelte-check 0 errors (31 warnings, none in new files); eslint 0 errors on touched files; unit 5270 passed (+ contribute: judge, service, tools, http, client, board, mock-gateway marker); `db-store.pg.spec.ts` against the test DB (0121 applied); components: contribute composer + board + app-shell (button is the top bar's last item, opens the composer) pass. E2E `contribute.e2e.ts` passes: member proposes from the top-right button → judged "a bug in Messages" → on the board with +1; admin drafts the same request → chorus card → votes instead (still one proposal, 2 votes); admin adds a note and moves it to In progress; the member sees it, has no status control, and PATCH as member is 403.
**Known, not from this work:** `app-detail-settings.svelte.spec.ts` ("keeps deployment controls visible…", masked `SHOP_REGION`) fails in the component suite; that page imports nothing this change touched. One e2e run flaked in the shared `registerUser` (signup form posted before hydration on a cold harness); the rerun passed.
**Not verified:** a real AI provider answering the judge (mock gateway only); the agent picking a proposal up end to end through the in-app assistant or `ee contribute.list` (the tools are unit-tested and registered); not released to the box.

**Not ported from Eigen (on purpose):** credit rewards for shipped ideas and their reward judge, the makers' inbox email, the author correcting kind/area on their own row, makers editing titles, voice input in the composer. Nothing in eigenEnterprise was removed.

## 2026-11-10 — Real releases on GitHub + `ee upgrade` (over-the-air, keeps everything) — v0.4.0

Owner: "repo is now public. build real release please" / "make a command for my vps to update over the air" / "this has to work seamlessly and keep the installed users, websites, repos etc". Commit `f323b87`, tag `v0.4.0`.

- **Releases** `.github/workflows/release.yml`: a `v*` tag builds amd64 (`ubuntu-24.04`) and arm64 (`ubuntu-24.04-arm`) natively with `scripts/release.sh`, checks both agree on LATEST/install.sh/ee.mjs, and publishes a GitHub Release (marked latest). Base URL `https://github.com/hikaru90/eigen-enterprise/releases/latest/download`. The tag must equal `package.json` version (0.3.0 → **0.4.0**).
- **Installer** picks this CPU's tarball from `LATEST` (`eigenenterprise-<version>-<sha>`). `scripts/release.sh` writes LATEST and now runs under bash (it used `read -d`, which dash on Linux lacks).
- **`ee upgrade [--check] [--from <url>]`** (`ee/src/upgrade.ts`): newest release vs. what runs; local safety copy (pg_dump + company repo + sealed secrets + master key, `ROLLBACK.txt`, keeps 3; a failed copy stops before any change); then the release installer.
- **No downtime on re-run/upgrade:** Caddy restarts only when its unit changed (`caddyUnitAction`); apt installs with `--no-upgrade` (Postgres/Caddy are never upgraded under a running company — OS updates are the OS's job).
- **Apache AGE after restore** (`ee/src/age-repair.ts`): pg_restore gives the graph schema a new oid while AGE stores the old one as data → "graph with oid … does not exist". The repair re-points `ag_graph.graphid` / `ag_label.graph` (FK dropped and re-added in one transaction). Now run by `ee restore` (it was missing — a restored company would have had a broken graph) and in the upgrade rollback steps.
- `docs/operations/vps-install.md` rewritten for ee (install, upgrade, rollback, backups) — the old Docker runbook was stale.

**Rehearsals:**
- *Migrations on the owner's real data* (read-only `pg_dump` of the VPS `os` database, restored on ee-box as `vps_rehearsal`, the release's preStart run with the unit's env): 98 → 118 migrations, including `0120_roadmap_into_memory` with an existing owner (Roadmap project created, old table dropped), the 1 user intact, RLS applied. `verify-age-graph-role` failed only because of the restore (the AGE oid issue above) and passed after the repair. The copy and the dump were deleted afterwards.
- *Over the air on ee-box*, release served over HTTP exactly like GitHub: first-time `curl … install.sh | sh -s -- --from <url>` from a pre-`upgrade` ee, then `ee upgrade --check` (up to date), then a full `ee upgrade` to a renamed copy of the release. Health polled every 0.5 s: **0 failed checks** in both; Caddy and Postgres not restarted; users kept; slots switched a↔b; safety copy + ROLLBACK.txt written.

**Published:** https://github.com/hikaru90/eigen-enterprise/releases/tag/v0.4.0 (workflow run 42832785928: both builds + publish green). Downloaded from `latest/download`: LATEST, ee.mjs and both tarballs pass their checksums. `ee upgrade` on ee-box straight from GitHub: GitHub-built arm64 release live, 0 failed health checks, Caddy not restarted, users kept.

**Not verified:** the GitHub-built amd64 release on a real x64 server; an app workload (website) across an upgrade on the box (the VPS has one — the code carries every non-os workload, routes and settings unchanged); the ROLLBACK.txt steps end to end.

**Known, not from this work:** the "Unit tests and coverage" workflow has failed on every push since 2026-10-22 — svelte-check in CI has no `ORIGIN` / `PUBLIC_POSTHOG_*` / VAPID env (`$env` types). Local gates are green.

**The VPS upgraded (owner's go, 2026-11-10 ~15:35 CET)** — 152.53.118.209, arm64, Debian 13; console os.cerberusblue.com, website cerberusblue.com. It ran a pre-11-03 release (ee without `upgrade`), so the first update was the install line from GitHub, over SSH. Before: manual safety copy in `/root/pre-upgrade-20261110T143256Z` (os.dump + ee state). During: cerberusblue.com and the console polled every 0.5 s — **94/94 OK each, zero downtime**. After: os on v0.4.0 (release `30a0ef87dc4d6ce8`, slot a→b), 98 → 118 migrations, the 1 user intact, the website workload untouched (same release, slot b, same repo mirror), all 4 routes + console host + ACME email kept, Caddy and Postgres not restarted (up since 2026-10-21) and not upgraded, `applied == desired`, no reconcile error, manifest + service worker served; `ee upgrade --check` → up to date. From now on: `ee upgrade`.

## 2026-11-10 — SHIPPED (main `1bb02b4`, pushed, on the box as release `1bb02b405565`): the installed app wears the company's identity

Owner: one PWA can't span instances (a PWA is bound to one origin; a multi-workspace app needs a native shell + push relay — not decided), so "make sure the pwa has the same branding as the instance — I would install different pwas".

- **Identity** (`src/lib/pwa/identity.ts`): the company's name + monogram — its initial on the active brand's `--primary` / `--primary-foreground`, the same badge the shell's sidebar shows; without an active visual set the app's own colors; without a company name the product (static icons). A `version` hash of name + colors versions every icon URL, so installed icons refresh when the brand changes.
- **Icons** `GET /app-icon/<any-192|any-512|maskable-512|apple-180|favicon-32>.png` (public, like the manifest; `src/lib/server/pwa/icon.ts`): Inter Bold glyph drawn as a vector path with `opentype.js` (no server fonts needed) on the brand tile, rasterized by `sharp`; "any" rounded, maskable/apple full-bleed (letter inside the safe zone). Inter covers Latin/Greek/Cyrillic/Vietnamese; other scripts (e.g. CJK) get the plain brand tile. Unnamed company → 307 to the product's static icons.
- **Manifest:** name, icons and `theme_color`/`background_color` (brand background, hex) from the identity.
- **Page head** (root layout): apple-touch-icon, favicon and `apple-mobile-web-app-title` follow the identity (moved out of `app.html`; product favicons stay the unbranded branch). Notifications use the company icon.
- **Status bar:** brand sets now alias `--theme-color: var(--background)` (`brandShellVars`), so `<meta name="theme-color">` follows the brand.

**Deps:** `opentype.js` 1.3.4 (MIT) added; `sharp` moved from dev to production dependencies (pinned 0.35.3); `@types/opentype.js` (dev).

**Gates:** svelte-check 0 errors; unit 5192 passed / 0 failed (`favicon.spec.ts` now checks the layout's unbranded branch, where the product favicon links moved); e2e `pwa.e2e.ts` (manifest icons are PNGs, head title + apple-touch-icon match the manifest's identity, unknown icon 404) and `messages.e2e.ts` pass. **On the box:** the box's company is unnamed, so it serves the product icons (307s verified); the monogram renderer was run inside the box against the release's own Linux `sharp` + `opentype.js` + Inter (192×192 PNG). **Not verified:** a named company's icons served by the box, and a real home screen.

**Decision:** icons are the monogram, not a logo — the brand has no logo asset today; the glyph is Inter, not the brand's display font (Google-hosted at runtime).

## 2026-11-10 — SHIPPED (main `468ec1e`, on the box as release `468ec1e17cd7`, not pushed): Messages as an installable app (PWA) — home screen, push, badge, resume

Owner: "make the messaging native on my phone and across devices … something like a pwa". The server half already existed (VAPID keys from `ee bootstrap`, `src/lib/server/push/`, per-device `push_subscription`, `modules/messages/notify.ts`); push had been inert since the strip (`ebf9295`) deleted the service worker.

- **Installable:** `GET /manifest.webmanifest` (`src/lib/pwa/manifest.ts`): standalone, opens on `/messages`, named after the company (founding-journey name; `eigenEnterprise` until named), icons `static/pwa-192.png`, `pwa-512.png`, `pwa-512-maskable.png` (rendered from `favicon.svg` by `scripts/generate-pwa-icons.mjs`). `app.html`: manifest link, apple-touch-icon, `apple-mobile-web-app-capable`, status bar `default`.
- **Service worker** `src/service-worker.ts` (SvelteKit's own, registered for signed-in people by `src/lib/pwa/register.ts`; logic in `src/lib/pwa/sw-core.ts`): push → notification (one per conversation via tag, renotify) + app-icon badge; tap → focus/navigate an open window or open one (never off-origin); the hashed app files cache-first, cached on first use (pre-caching all of them would be ~4.5 MB per release on every phone); page loads network-only with an explicit "You're offline" page; APIs/SSE untouched.
- **Badge:** push payload carries `badge` = the recipient's total unread across their conversations (same numbers as the sidebar); the Messages page keeps it current (`src/lib/pwa/badge.ts`, every list change goes through `setConversations`).
- **Turn on notifications:** banner in the Messages sidebar (`src/lib/pwa/notifications-banner.svelte`, states in `push-prompt.ts`): ask → subscribe this device; iPhone Safari tab → "Share → Add to Home Screen" (push only exists in the installed app); blocked → how to allow; "Not now" remembered per device.
- **Live feed survives sleep:** `src/lib/messages/resumable-stream.ts` — when the app is visible/online again and the browser had given up on the EventSource, it reopens after the last event id seen (the hub catches up).
- **Safe areas:** shell top bar, content and drawer pad for the notch / home indicator.

**Decisions:** PWA, not a native wrapper (Capacitor only if VoIP/call alerts or App Store distribution are needed) — the browser stays the runtime (phase-0). SvelteKit's built-in service worker instead of `@vite-pwa`. No message data cached offline (no stale chat; explicit offline page). Badge counts all unread, channels included.

**Removed (announced):** unused deps `@vite-pwa/sveltekit`, `workbox-window` and the `virtual:pwa-register` vitest stub (nothing imported them since the strip). Not restored: the old worker's capture-queue Background Sync drain — the page still drains the queue.

**Gates:** svelte-check 0 errors; unit 5176 passed / 0 failed; eslint clean on touched files; `vite build` emits `service-worker.js`; e2e `pwa.e2e.ts` (manifest, worker active, banner + "Not now" remembered, offline page, back online) and `messages.e2e.ts` pass. Headless Chromium reports notification permission "denied" even when granted, so e2e checks the banner against the browser's real permission; turning push on (a real push-service subscription) is not exercised in e2e.

**Not verified:** a real phone (iOS needs the app installed + a trusted certificate: the box's local CA must be trusted on the phone, or test on a real domain); push delivery end to end through Apple/Google push services.

## 2026-11-04 — SHIPPED (main): polish 1 — one assistant everywhere, dashboard, required profiles, Slack-style Messages, Roadmap in Memory, full width, the Owlery email platform inside

Plan: `plan/phase-polish-1.md` (owner voice feedback on release `3ee4199`, "don't ask questions, just build"; decisions P-1…P-6 taken by the orchestrator — owner may veto). Four worktree streams, merged `--no-ff`: D `fa25bed`, A `cde8b35` + integration `2143927`, B `5b1c986` + hydration fix `17b0193`, C `7f4867c` + integration `0e8bfb2`.

- **A — one assistant (P-1), dashboard (P-2), full width (P-3):** top bar "Ask the assistant… ⌘K" on every signed-in page; a right-side panel (drag-resizable 320 px–60 vw, width remembered, Esc/close, phone = sheet) with Chat · History · Activity and "New conversation", living in the shell (survives navigation); no provider → a "Set up the AI provider" action. Onboarding hand-off greeting streams into the panel. Dashboard at `/` ("Welcome back, <first name>", ask box, Needs you, modules, recent activity); the sidebar company badge links to it. `PageFrame` is full width everywhere (`width` prop removed). New `GET /api/assistant/conversation`, `GET /api/assistant/activity`; conversation titles = first message.
- **B — profiles (P-5) + Messages:** required profile (first, last name, picture) at full-screen `/welcome/profile`, gated in the root layout load (login/signup/claim/invite exempt; the invite's passkey step stays first). Picture: square crop → 256 px WebP, stored content-addressed under `<drive dir>/profile`, served by `/api/people/avatar/<sha>`. Settings › Account edits it; `user-avatar.svelte`; avatars in Members, Messages, sidebar. Messages: full-bleed Slack-style layout (channel/DM sidebar with unread, header with member avatars, grouped rows, sticky day dividers, hover toolbar, reactions, thread summary + pane, formatting composer). Migration `0113_user_profile` (`avatar_sha256`; names already existed on `user`).
- **C — Email = the Owlery platform (P-6):** `/m/email` area with Overview (actionable setup checklist, inline Connect Amazon SES form), Domains (BYO-DKIM, 4 DNS records, re-check + background re-verify), Senders, Logs (status timeline from SES events via SNS `/api/mail/ses-events`, signature-checked), Suppression, API (one "Create sending key" button + real curl), Templates + Layouts (MJML/HTML, Brand tokens, `{{var}}`, send by templateId), Contacts (lists, double opt-in, public subscribe/confirm/unsubscribe pages, one-click unsubscribe header), Flows (list-join trigger, wait/send steps, enrollments + log). One send path (sender + suppression check, log). Kernel tools for every area; mutations/sends behind approvals. Migrations `0114_email_platform`, `0115_email_templates`, `0116_email_contacts_flows`. New deps: `@aws-sdk/client-sns@3.1146.0`, `tldts@7.4.0`, `mjml@5.4.0`. **Cross-cutting:** SvelteKit's built-in CSRF check is off; the same check runs in `src/lib/server/csrf.ts` (first in `hooks.server.ts`), exempting only the SNS callback and one-click unsubscribe. Background email work rides the existing job-queue tick. Unsubscribe/confirm links need `ORIGIN` (fail loud). The owner's AWS user now also needs `AmazonSNSFullAccess` (Overview says so with "Set up again").
- **D — Roadmap in Memory (P-4) + Drive:** the Roadmap is a system project in the owner's Memory (`canonical_entity.system_key = 'roadmap'`), items are task thoughts (planned = open, in progress = `task_started_at`, shipped = completed; `task_kind`, `task_position`); board at `/m/memory/projects/roadmap`, pinned first; roadmap kernel tools keep their contracts (`MemoryRoadmapStore`, always as the owner). Migration `0120_roadmap_into_memory` (idempotent `roadmap_ensure_project()`, table dropped only after verified copy; re-run when an owner appears). Drive full-bleed (rail, toolbar, list/grid, side info panel, `/drive/messages`); Memory pages full width.

**Removed (announced to the owner):** nav entries Assistant, Agent, Overview; routes `/overview`, `/agent`, `/agent/runs`, `/agent/runs/[id]`, `/agent/activity` (now `/assistant`, `/assistant/[id]`, `/assistant/activity` — no redirects), `/agent/roadmap` (→ Memory Roadmap); table `extension_roadmap_items` + `DbRoadmapStore`; the welcome wizard's "What should I call you?" ask (the profile step asks first; code kept); Email's generic module page rendering, `mail-keys-panel.svelte`, the "For developers" block and the dead "Sender: Not set up" row (→ "Set up email" link); the email settings slot in `module-settings.ts`; `PageFrame`'s `width` prop.

**Migration numbering:** journal idx 113 (0113), 114–116 (0114–0116), 120 (0120); `migrate.mjs` matches by hash, gaps are fine.

**Gates on main:** svelte-check 0 errors; unit 5145 passed / 0 failed (after the shell-guard fixes); eslint `src modules` 0 errors; e2e per stream + on merged main (see below). Integration fixes: `assistant-area.e2e.ts` replaces the Agent-area e2e; e2e waits for hydration before filling the profile picture / invite name (input set pre-hydration is lost); email pages title themselves through `docTitle`; public mail pages on the shell-guard allowlist.

**Not verified:** real AWS SES/SNS (fake transport only); the 0120 migration with an existing owner on the box (only in a rolled-back transaction); Safari WebP canvas export; roadmap tasks aren't enriched/embedded (not in semantic search). `mail-fake-transport` and `email-platform` share mail config in the test DB — they race when run in parallel workers (pass serially).

**Not done (P-6):** campaigns, outbound webhooks, Owlery's visual block builder and xyflow canvas (templates are MJML/HTML source, flows a vertical step editor).

**Next:** owner walks the box; welcome wizard reuses `ses-connect-form.svelte`; campaigns/webhooks if wanted.

## 2026-11-03 — SHIPPED (main, not pushed): workspace proven on the test server + 10 fixes, S3 backups, git-native foundation; extensions model decided

**Proof run** (release `65b371e7b201b079` = main 9da21d5, upgraded in place on ee-box): owner + two invited members with passkeys — every step of phase-workspace §3 passed (live messages 2–183 ms, threads, reactions, edits, DMs, private channel hidden from non-members, attachments → Drive, group-shared folder, Markdown + CSV editing, take-over, restore, 2 MB upload proving `BODY_SIZE_LIMIT`). It found 9 UX bugs → **ws-fixes `f961e0c`**: owner name persisted to the account; invited members skip company onboarding and land in Messages; one current nav item; read-first editing (lock on first keystroke/Edit, released after 60 s idle or Done); honest Drive roots ("Shared with me", "Messages"); fresh sizes; "Restored from …"; one revision per editing session (no empty first revision); last keystrokes survive leaving at once (flush before navigation + keepalive on hide). **Fix #10 (critical, found on main):** invite → Join skipped the passkey step (a member could never sign in again without email) — fixed; skipping now needs an explicit confirmation. Test server reset afterwards (owner OK), fresh unclaimed install of `65b371e7b201b079`.

**Backups** `abad524` (plan/phase-backups.md): ee backs up nightly (systemd timer, randomized) to any S3-compatible bucket — pg_dump of `os`, ee state (company repo, sealed secrets, master key, company-data repo + keys), agent.sqlite via the online backup API, Drive blobs by sha256 (incremental) — client-side encrypted (format EEBK v1: AES-256-GCM chunks, header as AAD, per-object HKDF key), manifest written last, retention (keep newest, drop partials, GC unreferenced blobs), `ee restore` / `ee restore --verify`. Own SigV4 S3 client (ee bundles only zod). Settings → Backups (owner only): save only after a passing connection test, the **one company recovery code** (`EE1-…`, the backup key is derived from the company root key), schedule, run now, history; failed/missing nightly run → Overview "Needs you" + owner push; agent tool `substrate.backup_status` (read-only). Proven against MinIO (`cgr.dev/chainguard/minio` pinned by digest; Docker Hub minio no longer pullable). **Not proven:** the restore on a real box — `ee/e2e/restore-drill.sh` (destroys + recreates ee-box) not run yet.

**Git-native G0** `48bdae4` (+ renumber `cd459b7`, migration `0112_gitstore_watermark`) (plan/phase-git-native.md): canonical formats + layout contract, age encryption (`age-encryption` 0.3.1, CLI-interop tested), company root key → recovery code `EE1-…` (Crockford base32 + checksum), scope keys wrapped to the root + rotation, root key sealed by the app under TENANT_MASTER_KEY, git engine (CLI, serialized queue, member as author, per-surface batching, fast-forward-only pull, conflicts persist and fail loud), index framework (SurfaceAdapter, watermark, rebuild, boot reconcile, write-through, format versions + migrations), `system.yaml` schema, export skeleton, `docs/git-native.md`; **groups** are the first git-backed surface (rebuild-from-scratch proven). Follow-up for G1: a watermark missing from history currently triggers a silent rebuild — must become a loud "Needs you".

**Decisions (owner, 2026-11-03):** company data lives in git (files are the truth, Postgres a rebuildable index, gated content + all secrets encrypted, private GitHub remote); **extensions model** (plan/phase-extensions.md): the core is never forked per company — company features are own-process extensions with a versioned API and declarative UI in a company extensions repo; core improvements go upstream as PRs; `system.yaml` pins core + extensions; factory amended accordingly. Workspace W-8: agent writes refused during a person's edit session; attachment folders stay editable.

**ee** `35afaba`: os workload `BODY_SIZE_LIMIT=110M`.

**Gates on main (f961e0c):** svelte-check 0 errors; app unit 4994 passed / 0 failed; ee 128 passed (+3 MinIO-gated); e2e on main: team-invite-passkey, ws-fixes, messages, shell-walk (2) — 5 passed.

**Next:** restore drill on ee-box (needs the owner's go — destroys the container), then git-native G1–G6, extensions X0+.

## 2026-11-03 — SHIPPED (main, not pushed): workspace v1 — Teams replacement (team, access, Messages, Drive, editors)

Plan: `plan/phase-workspace.md` (owner decisions W-1…W-7). Streams merged `--no-ff`: T1 `ca7708e`, C1 `1605acc`, D1 `7532226`, ee body limit `35afaba`, D2 `ce8d260`, C2 `91ec708`. Gates on main: svelte-check 0 errors, unit **4934 passed / 17 skipped / 0 failed**. Each stream ran its own multi-member e2e (team-invite-passkey, messages, messages-depth, drive, drive-editors); not yet run together on main, not yet on the test server.

- **Team (T1):** groups/departments (Settings → Members & invites), the shared access contract `src/lib/server/access` (grants to user/group/company at view/edit/manage, folder inheritance via caller-supplied ancestors, owner/admin always manage, fail closed, audited `access.grants_set`; `initializeGrants` for a creator's first grants). **Changed (announced to owner):** joining via invite no longer needs an emailed code — the one-time invite link itself signs the person in (like the claim link), then a passkey is registered; the link is emailed additionally once SES exists.
- **Messages (C1+C2):** `/messages` — public/private channels, DMs, threads, reactions, edit/delete own, owner/admin moderation in channels (audited), attachments into a per-conversation Drive folder with the conversation's access; live via SSE + LISTEN/NOTIFY (both blue-green slots), gap-free catch-up (advisory lock from id allocation to commit, tested against Postgres), unread counts, push for DMs/mentions/thread participants. The agent reads public channels only, never private channels or DMs; no posting tool (W-2). **Nav:** the agent chat is now "Assistant" (W-7).
- **Drive (D1+D2):** `/drive` — folders, upload (drag-and-drop, 100 MB default), download, rename, move, trash/restore, share with people/groups/company, "Shared with me", search, previews (Markdown, CSV, images, PDF, text). Bytes content-addressed on disk (`DRIVE_STORAGE_DIR` or `${EE_STATE_DIR}/drive`, else fail loud), metadata/revisions in Postgres. Editors in place: Markdown via Milkdown 7.22.3 (file stays plain .md), CSV grid via papaparse 5.7.0 (file stays RFC 4180 CSV), autosave, one-editor lock with take-over (`drive_edit_lock`), revisions with restore; view-only users never get the editor. Agent writes are refused while a person is editing.
- **ee:** os workload gets `BODY_SIZE_LIMIT=110M` (adapter-node's 512K default would have refused uploads).

**Open decisions (owner):** agent write refused during someone's editing session (recommended: keep); public channel attachment folders are editable by every member (mirror of channel grants) — alternative view-only folder with system uploads.
**Known gaps:** revisions per ~1.2 s autosave window (coalesce per editing session); file header size/changed doesn't refresh after autosave; real web push unverified (no VAPID keys on the test server); cross-process delivery tested only in one process; drive.e2e flaky under machine load (clicks before hydration); folder grants copied once (no re-sync if channel access changes later); off-box backups missing — **must exist before real company use**.
**Migrations:** 0107 team/access, 0108 messages core, 0109 drive, 0110 drive edit lock, 0111 messages depth.

**Next:** release main to the test server and run the multi-member proof (owner + 2 members with passkeys: channel, DM, thread, shared folder, Markdown + CSV editing); then backups; then install on the owner's real server.

## 2026-11-03 — SHIPPED (main, not pushed): cohesion C3 + C3b — Memory and Agent areas, the chosen style app-wide, one page frame

Gates on main: svelte-check 0 errors, full unit **4741 passed / 15 skipped / 0 failed**; e2e on the merged tree: shell-walk, memory-page, agent-roadmap, agent-runs-live, brand-picker/system/wide, mail-fake-transport, onboarding-welcome, auth, pricing, website-apps, page-frame green. Owner can see it: "App Page Inventory" (post-C3, compared with C0) and "One Page Frame" artifacts. Test server reset with the owner's OK (2026-11-02): fresh unclaimed install of `5df230738863b5ba` (= main before C3), claim link handed over in the session.

- **Memory** `cd96b3b`: one Memory page `/m/memory` (Overview · Tasks · Projects · Notes · Capture) with its settings (time zone, reminders, daily summary — the service had no UI before), restyled to tokens. **Memory is a system module**: no activation row had ever been written, so `/m/memory` said "Off" *and the kernel fail-closed blocked the agent's memory.* tools*. Fixed "Mark done" on event-backed tasks. Old `/memory/*`, `/capture` 404.
- **Brand app-wide** `b9cac80`: the chosen style re-skins the shell (sidebar, highlight, badge, chat composer, menus) via `brandShellVars()`; fonts of the active set load app-wide; shadcn shadows/radius scale/overlays read set tokens; no set ⇒ unchanged look. **Brand is a system module** (picker never behind an activation step); removed `activation-notice.svelte`, `brand/activation.ts`, `POST /api/brand/activate`.
- **Agent** `b0da450`: `/agent` with Runs · Activity · Roadmap. Activity = readable, day-grouped log from the metadata-only projection (`readable-log.ts`); Roadmap = board with add/start/ship (owner/admin). `/runs`, `/activity`, `/settings/extensions` 404.
- **C3b polish** (`9f70617`, `6a802c5`, `7311066`): shared `PageFrame`/`PageHeader`/`StatusPill` + `area-nav.ts` — one header per area, tabs below, one width rule (written into `docs/design-system.md` "Page frame"); signed-out pages (login, signup, claim, invite, errors) in the shell's design with one wordmark "eigenEnterprise"; owner-facing copy (`module-copy.ts`, module names in Activity from manifests, run titles "Chat with …"/"Background task: …", plain failure text with details toggle, Email leads with status — developer recipe under "For developers"); sessions record user agent + address at sign-in (bowser 2.14.1) — root cause: server-side sign-ins never forwarded the request headers; e2e fixed (relative URLs, pricing on today's product, `E2E_PORT`).

**Open**: Memory › Capture keeps its own narrow column; pages without test data unchecked (brand editor with a set, app detail, project detail, published /s page); component spec `app-detail-settings` (SHOP_REGION) fails on main independently; `TENANT_MASTER_KEY` empty in `.env.example` still crashes dev via an unhandled rejection; repo-wide eslint not run on the merged tree.

**Next**: release main to the test server (owner claims it); website W2–W4 (company site as routed app, schema per app), email E2/E3/E5/E6, factory S2.

## 2026-11-02 — SHIPPED (main, not pushed, not on the test server): brand picker B1–B4, email E1+E4, website W1, cohesion C0–C2+C4, factory S1

Parallel worktree streams (subagents on low effort), each merged `--no-ff`. Gates on the final main: svelte-check 0 errors, full unit suite **4674 passed / 15 skipped / 0 failed**. Repo-wide eslint and the full e2e suite were not run on the merged tree (streams ran their own e2e).

**Brand (plan/phase-brand-picker.md, corrected 2026-11-02: choosing the style is the point; website styling out of scope)**
- B1 `9ad61d1`: taxonomy — 11 genres, 57 styles, 174 variants; distinctness gate (styleDistance ≥ 0.20). Owner reviewed it as rendered previews (artifact "Brand Style Picker").
- Owner decisions 2026-11-02: keep 11 genres; dark mode = global switch (every node light + dark); 4 near-duplicate corpus items dropped (tweakcn-clean-slate, daisyui-light/-fantasy/-caramellatte); genres and styles get their own tokens; decorative fonts for headings only.
- B2a `1287a8e`: authored light+dark token sets for all 242 nodes (77 corpus-reuse, 97 authored variants, all genres/styles authored), WCAG AA contrast gate, 0 distinctness violations, 30 dark-only variants re-aimed (renames recorded in `authoring/palettes.json` `reaimedFrom`). Licences: tweakcn is **Apache-2.0** (ingest script said MIT — corrected), all 57 fonts OFL (`corpus/LICENSE-NOTES.md`).
- B2b `f759ef7` + render `03439b6`: build-time preview renderer (`npm run brand:previews`), 484 WebP previews (7.8 MB) + `picker-index.json`. Known: the pixel font clips the preview's nav button.
- B3 `0f4d003`: `/brand` = Spotify-style picker (genre → style → variant, `?style=`, breadcrumb, light/dark previews); "Choose this style" = owner one click → `brand.picker_choose` (owner-only kernel tool) creates + activates the visual set. Migration `0105_brand_visual_set_picker_node`. **Removed (announced):** the ≥3-pick centroid flow, the "Similar styles" drawer, `style-card.svelte`.
- B4 `0cfd582`: `/brand/system` design-system view (component set in the active style, light/dark). Token fixes with app-wide effect: shadcn components now use the radius tokens (default style: square → ~4px), font variables actually reach the utilities, the nucleus wrapper no longer forces white over an active brand, brand dark tokens beat the app's `.dark` block.

**Email (plan/phase-module-readiness.md)** — E1+E4 `62addc2`: `MAIL_TRANSPORT=fake` (DB-backed captured mails, migration `0104_mail_fake_transport`; refused in production without `MAIL_TRANSPORT_FAKE_IN_PRODUCTION=1`; unknown values fail at boot), e2e-only `/api/e2e/harness/mail`; sign-in codes flow through it (e2e signs in with a captured code). **Removed (announced):** `owlery.send_mail` — `email.send_mail` is the one send tool.

**Website** — W1 `da6e299`: `ee/e2e/box-journey.mjs` rewritten as a maintained Playwright journey; on the test server 8 of 13 steps passed (claim, public repo, deploy, health gate, served on its host, env, secret, Redeploy). Fixes: env vars and secrets are one sealed store → one card (names were listed twice and the page claimed secrets never reach the build); D-3 copy "press Redeploy after you push". Not run yet: logs/history, mail access, domain change, remove; private repo needs the owner's GitHub.
- **Incident:** the W1 agent found `ee-box` unclaimed and claimed it with a test account (allowed by its brief), then could not reset it — the permission classifier correctly refused `box.sh down` (irreversible). The owner's earlier claim link is void; reset awaits the owner's OK. Next journey runs reuse a saved session (`OWNER_STATE`) instead of claiming.

**Cohesion (plan/phase-cohesion.md, owner feedback 2026-11-02 "what is missing completely is the cohesiveness")**
- C0: screenshot inventory of all 61 pages (published as "App Page Inventory"): 20 in the new shell, 15 in the old eigen chrome, 8 settings, 18 standalone.
- C1: owner decisions per area recorded in the plan §3.
- C2 + C4 `b883d11` (+ spec fix `165af80`): one shell for every signed-in page (nav: Chat, Overview, Website, Email, Brand, Agent, Memory, Settings); `/settings` inside it = Account, Members & invites, AI provider, Passkeys & sessions (stuck "Loading…" fixed), API keys (moved from `/api-keys`), Approval mode (new section), Extensions (until C3). Errors render in the shell ("Back to Chat"), 404 not 500 for bad ids, one title pattern via `docTitle()`, `/claim` and `/invite` get "Sign in". Guard spec `src/routes/shell-guard.spec.ts` (allowlist: login, signup, claim, invite, s, s/[slug]). **Removed (announced, C1):** `/demo/*`, `/settings/agents`, `/settings/scheduled-tasks`, "Change password", `/register`, `/forgot-password`, `/reset-password`, `/graph`, `/notes`, `/timeline`, `/memory/timeline`, `/settings/hosting` page, `/m/website/apps` alias, `/m/website/hosting`, `/m/brand`, `/eval`, `/admin/queue`, `/feedback`, old `/chat`, `/memory` graph view, plus API routes and code only they used (`/api/feedback`, `/api/eval/qa*`, `/api/chat/sessions*`, src/lib/graph, eval UI, force-graph, …).

**Factory S1** `979a4e1` + `9626723`: **removed (announced):** dev-agent (+ `kernel_devagent_runs`, its event types), pi-engine and the `pi` loop engine (durable is the only engine), AgentSessionLog/`kernel_agent_session_events` (migration `0106_drop_dev_agent_tables`); `repo.*` keeps working (runner inlined). S0 follow-ups: interrupted chat tool calls now report `not_run`; failed turns show in `/runs`; feed Input shows only the owner's words (structural `ownerText`); same-conversation turns queue instead of `conversation_busy` + greeting started after the wizard hands over; `.env.example` explains `TENANT_MASTER_KEY`; stale `onboarding-welcome`/`journey-founding` e2e fixed; SIGTERM exits within 2 s (unit-tested only).

**Broke / found on the way**
- Migration-number collisions between parallel streams (0104 ×3) — renumbered at merge; orchestrator now assigns numbers up front.
- The Mac is the bottleneck with 6+ agents: svelte-check/eslint runs hang, dev servers take >2 min, ports 4173/5199/5299 stay occupied by orphaned harness processes (left alone — ownership unclear).
- A missing `TENANT_MASTER_KEY` still crashes the whole dev server via an unhandled rejection in `tenant-keys.ts` (open).

**Next**: owner OK to reset `ee-box`; C3 (Memory page, Agent page with Runs/Activity/Roadmap, Brand on/off without `/m/brand`, chosen style visible app-wide incl. fonts); new inventory to compare with C0; release + journeys on the test server; then W2–W4, E2–E6, S2.

## 2026-10-30 — S0 PROVEN in the local test server (ee-box): crash-resume works for real after a getDb() fix

**First proof run FAILED, which found the real bug**: a chat turn resumed after a restart failed at once with `getDb() was called outside an active request`. pi-durable drives model calls from its own task loop; the default completion called `llmChatCompletion`, which needs the request-scoped DB context. Resumed turns and background runs have none. The crash-resume specs injected a fake `complete`, so **crash-resume had never worked in production**. Fix `da46d7b`: the default completion always runs inside `withDbUser(input.userId)` (the user resolved from the conversation index), never in the ambient context — the task loop may drive another user's conversation during a live request.

**Also merged**: mock gateway with native `tool_calls` + `[mock-tool:…]`/`[mock-delay:ms]` markers (`b16e249`, merge `37057b0`); `agent-runs-live.e2e.ts` now expects a 200 chat.

**Proof (release `da46d7b`, ee release `511aa2c8a5e369fa`, unit `ee-os-a.service`, mock on the host :5299 reached as host.docker.internal)**
- Two browser contexts on one run: both live; after the restart both reconnect on their own (~1 s) without reload.
- Restart during the first LLM call (SIGKILL): the model call is replayed, the tool runs in the new process, the answer is generated, journal `chat mirror: mirrored`, the answer is in the chat after reload without resending, both feeds show the full run + "Run finished".
- Restart after the tool ran, during the second LLM call: resumed second call, answer mirrored, feeds complete.
- In-flight chat tool call at restart: recorded as a failed tool (`tool_unavailable`, "Tool website.list_pages is not available"), not our `not_run`; the model answered anyway.

**Follow-ups found**
- SIGTERM never exits on its own (waits for in-flight turns) → every restart takes the full 20 s and ends in SIGKILL.
- The run feed's Input lines show the whole injected onboarding-context block.
- A chat sent right after "Skip for now" fails with `conversation_busy` (greeting turn still running); the greeting bubble then appears under that failed message.
- `.env.example` lacks `TENANT_MASTER_KEY`; without it the server crashes on the provider save.
- Two `onboarding-welcome` e2e tests fail ("First, it needs a mind to think with."); not yet checked against main before the mock change.

**State**: ee-box is a fresh, unclaimed install of `511aa2c8a5e369fa` (claim link handed to the owner in the session, not in any file). Main not pushed.

**Next**: S1 removals; module readiness pass (website, brand, email) — see the session for owner questions.

## 2026-10-30 — SHIPPED (main, not on the box yet): factory S0 — durable background runs, D8 live run view, D9 chat mirror

Two worktree streams, merged `--no-ff`: S0-A `ec223ca` (`6a509f8`), S0-B `3d3be85` (`c179487`), integration fix `381c44c`.

**What shipped**
- **Background runs** (`startBackgroundRun` on the durable engine, `AppBoot.startBackgroundRun`): an ownerless pi-durable conversation recorded in `durable_conversations` with its run principal and tool surface (migration `0103_durable_background_runs`: `run_principal_id`, `run_tools` jsonb). Its tool calls, live or resumed after a restart, run through `KernelRegistry.execute` as the recorded principal (permissions, approvals, audit unchanged). A missing principal is a structured `unknown_principal` tool error (new KernelErrorCode); nothing runs as anyone else. Chat conversations keep `not_run` for request-less calls. On open, background surfaces are registered before `harness.resume()`.
- **D9**: pending chat submissions are watched at open; a turn that settles with an answer after a restart is written into `chat_message` under the user's RLS session, once (`chat_message.durable_answer_key` unique, same migration). Only the final reply is mirrored, not tool steps.
- **D8**: `GET /api/agent/runs` (index metadata only) and `GET /api/agent/runs/[id]/events` (SSE: snapshot on connect, one batch per commit, overflow re-snapshot, 25 s keepalive, watcher stopped exactly once on disconnect; 401 signed out, 403 without an owner/admin/member role). Pages `/runs` and `/runs/[id]` with a live feed (run start/end, input, assistant text, tool start/end with outcome). Tool output, thinking and usage stay server-side; tool args go through `redactForLog`.
- **Integration fix**: the run view's fallback opened the harness singleton with only env + index, which would have produced an under-wired harness (no `runAsPrincipal`, no mirror) if `/runs` was hit before boot's warm-up. New `openedDurableHarness()` returns boot's harness or fails loud.

**Verification (merged main)**: svelte-check 0 errors; eslint 0 errors; full unit **4748 passed / 17 skipped, 0 failed**; targeted agent/kernel/modules/chat/runs suites 1598 passed. In the streams: real SIGKILL crash-resume of a background run that executes its tool as the recorded principal after reopen; Postgres integration spec for the mirror; e2e `agent-runs-live.e2e.ts` 1/1 (two browser contexts see the same run live).

**Not verified**: the box proof (`systemctl restart` mid-tool-call, two browsers) — needs a release + install. Live text deltas and live tool events with real tool calls are covered by unit/component specs only (the mock gateway doesn't stream or emit native tool calls).

**Decisions taken in the streams (owner may veto)**
- Run visibility is company-wide: every owner/admin/member sees every run's transcript text, including other members' chats (reading of D8 "team visibility").
- `/api/agent/runs` (plan path), not `/api/agents/runs` (collides with `/api/agents/[id]`). No nav entry for `/runs` yet.

**Broke / found on the way**
- The main checkout had **no node_modules**; worktree symlinks to it dangled. `npm ci` (Node 22.23.2 — the default `node` on this Mac is v26 and fails `engines`). Main also had no `.env`; `npm run check` needs one (copied from `.env.example`, gitignored).
- **vitest can't run specs inside `.claude/worktrees/`**: `*.spec.ts` is excluded from the worktree tsconfig, so the transform walks up to the main checkout's tsconfig, which points at a missing `.svelte-kit`. Streams ran gates from an rsync copy. Needs a fix before S2's factory runs gates in worktrees.
- **The mock gateway still emits builtin-json-style JSON tool intents** (builtin-json died 2026-10-20); on the durable engine `/api/chat` returns 500 for those turns in e2e. The run-view e2e asserts only on the run view. Follow-up: teach the mock native `tool_calls`.
- Port 5199 is held by a long-running eigen-design vite process on this Mac; the e2e ran with `MOCK_GATEWAY_PORT=5299`.

**Next**: S0 box proof (release + install, restart mid-tool-call, two browsers on `/runs`), then S1 (announced removals: dev-agent, pi-engine, `pi` engine, `kernel_agent_session_events`).

## 2026-10-30 — APPROVED: software factory on the box, built on durable background runs (plan only)

**Owner direction**: "focus on pi durable implementation and setting up the software factory so that the system can self evolve." `plan/phase-software-factory.md` rewritten (the 2026-10-08 draft built on the frozen `dev-agent`).

**Decisions (owner, 2026-10-30)**
- **F1** The factory lives on the box: ee keeps a git checkout of eigenEnterprise's source; shipped changes become new `os` releases through ee's blue-green, health-gated path.
- **F2** The builder is the durable agent with the `repo.*` hands, as background pi-durable runs that survive restarts. `dev-agent`, `pi-engine`, the `pi` engine and the writer-less `kernel_agent_session_events` are deleted in S1 (announced in the plan, §6).
- **F3** Tickets come from the Extension Roadmap.
- **F4** Green docs-only and test-only changes auto-merge; src needs the owner's approval; every deploy is an owner click (D11 unchanged). Governance files (AGENTS.md, `.pi/skills/**`, discipline, approvals, the risk rules) are always src-class; a test-only change that drops the test count is src-class.

**Gap found while planning**: the `repo.*` hands resolve the git root from `process.cwd()`. On the box that is a read-only release tarball, so self-improvement had nowhere to run since the dev server was removed. S2 fixes it (`EE_SOURCE_DIR`).

**Open**: how the box pushes to GitHub (blocks S4 only; recommendation: per-push App installation token, `contents: write`, this repo only).

**Next**: S0 — durable background runs with a recorded run principal, the D8 live run view (SSE, multi-viewer), the D9 chat mirror.

## 2026-10-23 — The dev server is removed: the ee box is the only install

**Owner report**: on a private repo, "Generate deploy key" was disabled ("A deployment server is needed…"), read as a deploy regression; then the box said "not claimed" although the owner had a login and passkey.

**Diagnosis**: no code regression. Both symptoms came from having two installs. The owner was on the dev server (http://localhost:5174), which has no ee control socket, so deploys/deploy keys were off by design. The login + passkey lived in the dev database (`localhost:5433/eigen`, passkey bound to `localhost`); the box's own database had 0 users. The ee transport hasn't changed since ee was introduced; the box console has the socket (group `ee-control`).

**Owner decision (2026-10-23)**: remove the dev server — "it's just cumbersome", and it caused the confusion above. Replaces the same-day rule "the owner's running dev server is the only local development server".

**Removed / changed (announced to the owner before shipping)**
- `npm run dev` deleted. AGENTS.md's dev-server section replaced by "One install: the ee box"; commands table updated.
- Playwright: no owner server, no `E2E_PORT` / `E2E_MANAGED_SERVERS`. Every run starts its own throwaway harness — `vite dev --port 4173 --strictPort` (`ORIGIN` pinned) + the mock gateway on :5199, `reuseExistingServer: false` — and Playwright stops both. A built preview was tried first and rejected: the sign-in-code harness routes are `dev`-only by design, and adding a test switch to production builds would be a bypass path. Readiness probes `localhost` (Vite binds [::1] only). `npm run test:e2e` now does db:up/wait/migrate first (DB prep that used to live in `dev`).
- `vite.config.ts`: `server.strictPort` dropped (no dev port to guard); per-process optimizer cache kept for build/vitest-browser.
- `.env.example` ORIGIN → :4173; docs/evals/helper messages no longer say `npm run dev`. The graph-scale live watcher no longer needs a dev server running beside it.
- The owner's `vite dev` (PID 22527) and the compose Postgres were stopped; the `eigenenterprise_eigen_pg` volume (old dev login/data) is kept until the owner says otherwise. Compose Postgres is the test DB only.
- CI unchanged: it never ran e2e (lint, check, unit, components, coverage).
- Tests: `scripts/vite-config.spec.ts` rewritten (no `dev` script; e2e harness is Playwright-owned, never reused). Failed first, now green. Verified: lint 0 errors, svelte-check 0 errors, unit 4,709 passed / 14 skipped, `auth.e2e.ts` 10/10 on the new harness. Full e2e suite not run.
- Not shipped: an earlier same-day "this is the dev console" message on /m/website/apps/new; reverted as dead code.

**Box access**: box was unclaimed → fresh one-time link via `ee claim-link` (expires 2026-10-30). The TLS warning is Caddy's local CA, which isn't trusted on the Mac yet; the owner trusts the root cert once (System keychain).

**Follow-ups**: `mail-keys.spec.ts` times out under full-suite load (15s), passes alone. e2e against the box itself (instead of a preview) would need the mock gateway on the box; not planned.

## 2026-10-23 — SHIPPED AND PUSHED: the uncommitted waves are now real commits; box upgraded to a committed release (deploy keys confirmed live)

**Owner report that started this**: "I can't generate a deploy key when I input a private repository link… The current version that is deployed is ~ten git commits behind… I already told you fix it. You do it."

**Root cause of the whole confusion**: six shipped, tested waves (2026-10-21/22: api-key deny-by-default, passkeys + long sessions, key scopes + app mail binding, saved deploy config + Redeploy, the private-repo keyPath fix + module front page, repositories-first UX) sat **uncommitted** on the main working tree. The box's live release was built from that dirty tree, so the deployed console corresponded to NO git ref, `origin/main` was 27 commits behind, and the stale pre-fix release (`fe5ea2eb`, deployed over the box at 19:32 on 10-22 and active until 20:58) served the exact dead end the owner hit: paste a private repo → no deploy-key step. ee fell back to the good build at 22:11 and the 20:58 deploy made it live again — so the site had already self-healed, but nothing about the setup could prove that, because the code existed in no ref.

**What shipped (this session)**
- `62c41a5` [feature]: the whole uncommitted wave committed on main (suite on that exact tree: 4,709 unit passed / 14 skipped, svelte-check 0 errors, secrets guard OK).
- `77be7e9` [chore]: the push wall removed at its root — repo-wide eslint had 122 errors that the pre-push hook turned into a permanent push block (the reason origin drifted). 108 were the generated `ee/dist/ee.mjs` (now eslint-ignored, it's build output); 13 dead `bootstrapKernel`/`buildKernel` imports removed; `daemon.spec.ts`'s control-API helper typed `data: unknown` with honest casts. eslint . exits 0; no rule was weakened.
- `origin/main` pushed: `4c9eb5e..77be7e9`. Deployed, committed and pushed are now the same code.
- Fresh release built from the CLEAN tree (`scripts/release.sh arm64` → `eigenenterprise-0.3.0-77be7e94dba3-linux-arm64.tar.gz`) and installed via `ee/e2e/box.sh install os.ee.localhost`. Health-gated blue-green: new release `bed2dbd343e368cd` **replaced the stale slot a** and went live at 22:50; `appliedRev == desiredRev`, reconcile error null, console health 200 over Caddy TLS.
- **Deploy keys verified live on the deployed install, minutes ago**: minted `dk_fd2bd8ae85b9c69055e91da5` for `kindred/ship-verify` over `/v1/deploy-keys` (public material only) and deleted it (`{"ok":true}`), author `agent:ship-verify`. The live client bundle carries the keyPath flow markers ("it needs a deploy key") and the server chunks the plain-language refusals.

**Decisions**
- **Standing rule (owner, after this session): shipped means committed AND pushed.** No release may again be built from an uncommitted tree — "the deployed version is behind" must be an impossible sentence. Enforced by habit here, not tooling (a pre-release guard could assert a clean tree; noted as follow-up).
- Interleaved waves were committed as ONE feature commit (`62c41a5`) instead of fake historical splits: the intermediate half-states were never tested as discrete commits; both ends of history build and are verified.
- The 2026-10-22 open "managed architecture" question is CLOSED by owner fiat: the ee box is THE local install (compose console retired behind the `console` profile, committed in `62c41a5`). The dev server on :5174 stays console-only by design; deploy keys live on the box.

**Broken on the way**: the pre-push eslint wall (fixed above, see 77be7e9). Nothing else.

**Verification**: unit 4,709 passed / 14 skipped on the committed tree; svelte-check 0 errors; `assert:oss-secrets` OK; eslint 0 errors; box journal `deploy.succeeded` + edge.updated; live mint/delete of a deploy key over the control socket. Not verified: the deploy-key flow in a logged-in browser on the box (the box is production mode — passwordless codes need a mailer; prior sessions' claim-link mint is one-time). The UI path itself is covered by the stepper component specs and the 8/8 headed e2e journey on this code.

**Next**: the owner connects their real private repo at https://os.ee.localhost → Add → Connect a repo → the stepper mints the key, they add it on GitHub, check, connect, deploy. If anything in that journey bites, it is a bug to fix — not an architecture question.


## 2026-10-22 — Website UX correction: repositories first, one settings surface (uncommitted)

**Owner request**: replace the confusing deployment-off banner and Hosting/Site navigation with a Coolify-style overview: Add → build with chat or connect a public/private GitHub repository; domains/routing/HTTPS grouped under settings.

**Shipped to the local ee install**
- Apps & repositories includes connected sources before their first deploy, public/private access, exact saved branches, and deployed apps with domains/status. Add is a header action with exactly two choices. Repository inventory remains available with an explicit error when live server state cannot be read.
- Private repository access is an explicit generate-key → add read-only key on GitHub → verify → connect flow; public repos need no key. GitHub App setup remains under Advanced. Exact repo+branch links are restored from the overview.
- Website settings groups server status, all routes and automatic HTTPS guidance. App settings groups domain routing, build, env, secrets, mail access and removal; deploy/history/logs remain immediately available. Existing Hosting/Site URLs and all actions remain. The replaced navigation and deployment banner were announced to the owner before integration; no functionality was removed.
- Domain safety: the company public-host mutation already replaces the old route atomically, so removed the redundant delete-first step and reject occupied destinations. App address replacement adds/applies the new route before retiring the working one and surfaces reconcile errors.
- Runtime diagnosis: local `ee-box` is healthy at https://os.ee.localhost, console workload runs with `ee-control` access and no reconcile errors. The console-only dev server lacks the Unix control socket; that is the source of the warning. No deployment capability is fabricated for that mode.
- Workstream deltas integrated from `codex/apps-overview-ux`, `codex/apps-connect-ux`, `codex/apps-settings-ux`; based on existing dirty-tree snapshot `dfb8c973500e18aec564cb09a404cff7004d69b9` (tree object, not a commit). Prior unrelated work preserved. No source commit created.

**Decisions**
- Repository inventory is durable company data; live server failures must not erase it from the UI. Explicit per-surface errors distinguish unavailable live state from saved sources.
- HTTPS stays ee/Caddy automation. The UI explains DNS, public ACME and local CA trust, without inventing certificate issuance or expiry status the API does not report.
- Pending deploy-key setup retains only public metadata in owner-scoped tab storage and recovers native POST results. Shared keys survive until their last connected branch is removed; human-only disconnect checks remain.

**Verification / runtime**
- Final full unit suite: **4,706 passed, 14 skipped** (624 files passed, 5 skipped). Targeted Chromium component suite: **40/40**. Headed Playwright Website journey: **8/8**, including both Add choices, undeployed repo inventory and exact branches, settings, preserved legacy URLs, dark-preference light shell and 390px overflow check. Screenshots inspected under `test-results/website-overview.png` and `test-results/website-settings.png`.
- Typecheck: **0 errors**, 34 unchanged warnings. ESLint for all **36 changed source files passes**. Repository-wide lint remains blocked by existing generated `ee/dist/ee.mjs` findings and preexisting unused imports elsewhere (122 errors / 164 warnings in that run); rules were not weakened and unrelated source was not rewritten.
- Built Linux arm64 release from the dirty working tree (base HEAD `2adff39d62bf`); SHA-256 `235a8a3b052d469b71487eec73258d5efe17d280c1ee330e4379c52346a3730b`. Installed through the official installer into existing `ee-box` without recreating it. Live os release **235a8a3b052d469b**, health **200**, reconcile error **null** at **https://os.ee.localhost**. Previous release tarball retained in `/var/lib/ee/releases/ux-previous/`.
- Verified the control socket as console identity (`ee-os`, `ee-control`): status succeeds, SSH deploy key generates with only public material returned, temporary key deleted. Actual private GitHub access remains tested through API/SSH mocks; no owner repository or GitHub permission was supplied for a live end-to-end connection.
- Removed the three task worktrees/temporary branches after integration; original unrelated working-tree changes preserved. Task delta retained at `/tmp/ee-ux-changes.patch`. No source commit created.

**Next**
- Owner can open Website → Add to connect their repository or start a chat draft; all domain/routing/server/HTTPS controls are under Website settings or the app’s App settings. Full-repository lint cleanup is separate existing work.

**ONE SYSTEM PER MACHINE (owner decision, 2026-10-22 evening)**: "There shouldn't be two systems… pick one or merge them, the data doesn't matter." The ee box is now THE local install; the compose console is retired from running:
- Fresh release built from this working tree (`scripts/release.sh arm64`; fixed a dirty-tree bug — `git ls-files` still lists worktree-deleted files and tar aborted on them; the file list now keeps only existing files). Box recreated + installed (`ee/e2e/box.sh`, now `--restart unless-stopped` because it doubles as the install): console live at **https://os.ee.localhost** (Caddy TLS), ee socket healthy, release contains 0101/0102, deploy-key mint + delete verified live over `/v1/deploy-keys`. Claim link minted for the owner (one-time).
- Compose: `app` + `studio` stopped and moved behind the `console` profile (a plain `docker compose up` now starts only `db` — the dev database for the dev server and tests; `npm run db:up` unchanged). The console-only stack can never deploy (no ee beside it); it stays as a dev/demo profile with comments saying so.
- Login on the box: open the claim link once → owner account (the code is minted server-side, no SES locally); the long session keeps the machine signed in; passkeys work there too.
- Old compose-console data (accounts on :3000) abandoned per the owner ("no data you can destroy or it doesn't matter").

## 2026-10-22 — Website module reworked to the owner's direction: apps front row, pages dropped, private repos fixed (uncommitted, main working tree)

Owner verdict on the W1–W7 restructure, verbatim points: pages are stray dead-ends (404s) — delete them; apps must be front row on the website module page (not a "Settings" landing); Recent activity belongs in a right rail like /overview; the GitHub-connection menu point is useless (connect happens in apps); the Add dialog offers two options only (static sites are built with the agent in chat, not a third path); the private-repo deploy-key workflow REGRESSED (paste a private repo → "GitHub has no public repository" dead end); and "this server is not managed" is absurd on the owner's own Docker install. **New standing rule (AGENTS.md): any removal or replacement of working functionality is announced to the owner first — no silent regressions.**

**What shipped**
- **Private-repo regression fixed** (the angry one): root cause — `website.github_inspect_repo` 404s on any repo GitHub won't show anonymously, so a pasted PRIVATE repo could never reach the deploy-key step (the key flow only opened after a successful inspect, which is impossible for a private repo without the App). Fix: `RepoNotVisibleError` (typed, carries `appInstalled`) from connect-tools; the page's inspect action answers `keyPath: true`; the stepper renders the deploy-key card right on step 1 (`private-key-path` testid): create key → add on GitHub → check → connect with the key. Component spec covers the full path; the old step-2 path stays for App-readable private repos.
- **`/m/website` is the module front page now** (D-W7): apps grid (no site card) + `WebsiteActivityPanel` right rail, laid out like /overview; `/m/website/apps` redirects there (303); breadcrumbs repointed (app detail + add-app pages). The generic module/settings landing no longer serves website (static route wins over `/m/[moduleId]`); Site/Hosting links live in the front page header and the module settings slot.
- **Pages dropped from the surface**: site card + page counts off the apps grid, Pages table off `/m/website/site` (now domain-only), `/overview`'s website tile counts Apps/Healthy (was Published/Drafts), `websiteResultSource` reads `website.app_list` (was `site_info`), `app_list`'s `site` entry loses `pages` (outputSchema updated; `pages` store dep removed from apps tools). **Migration `0102_website_pages_dropped` deletes every `website_content` row with kind='page'** (docs untouched) — applied to the dev/compose DB, 0 rows left.
- **GitHub connection page deleted** (`/m/website/github` + spec + settings-slot link); the GitHub App connection moved INTO `/apps/new`'s "From GitHub" section (same manifest + state cookie; `github-app-connect.svelte` slimmed — its circular "Add an app" card removed). Callback endpoints under `/settings/hosting/github` untouched (hard-wired in the manifest).
- **Add dialog**: two options (Build it with chat / Connect a repo); the Static-site card is gone — static sites are built with the agent, deploy config unchanged.
- **"Not managed" copy everywhere** now states the truth instead of implying a missing install step: "Deploys are off on this stack — this EigenEnterprise copy runs without ee, the server's deploy agent…". Sites: apps front page, stepper, hosting, site page (+ its domainSet refusal).
- **e2e robustness**: a native-submit form race (click before hydration) used to swallow the plain error — `/apps/new` now seeds the stepper's step error from the action's `form` prop (`nativeError`), so a plain sentence shows even without JS timing luck. Also: this repo's Playwright (1.59) renamed `getByLabelText` → `getByLabel` (runtime has no alias) — the journey uses `getByLabel`.
- Tests: landing spec (`/m/website/page.server.spec.ts`, app_list managed/unmanaged/empty + activity rail), redirect spec, site page spec rewritten (no site_info), overview source/route specs on app_list, stepper spec (keyPath regression test + inline App connect), dialog spec (2 options), github-app-connect spec, e2e journey updated. 4687 unit tests, `svelte-check` 0 errors, touched files lint-clean, e2e `website-apps` 6/6 (`E2E_PORT=5187`). Compose app image rebuilt + restarted on :3000 (entrypoint runs migrations).
- **Kept on purpose (owner decision pending, per the announce-first rule)**: the chat-side page tools (`website.create_page`/`update_page`/`publish_page`/`get_page`/`list_pages`/`site_info`) stay REGISTERED — they are load-bearing in the founding onboarding journey and the brain's website journey (brain.ts, founding flow, playbook specs all reference them). With every UI surface gone + rows deleted they produce no visible strays, but chat can still create page rows; say the word and the whole journey side gets removed with them.
- **The "managed" architecture question is OPEN with the owner**: their local Docker install is the compose stack (console-only, no ee → no deploys, no deploy keys — deploy keys live in ee's sealed store). The fully-managed local install EXISTS (`ee-box`, up since this morning: systemd container, ee + console + caddy + its own Postgres at os.ee.localhost; verified end-to-end earlier). Options on the table: (a) make the compose stack able to reach an ee (sidecar box service + shared socket volume), (b) declare the ee box THE local install and stop treating compose as deploy-capable, (c) merge the user's compose data into the box. Needs the owner's call — asked at the end of the session.

## 2026-10-22 — SHIPPED (uncommitted, main working tree): saved deploy config + the Redeploy button

- Owner request: redeploying meant walking the deploy-a-repo wizard again (pick repo, "let AI fill this out" for install/build/start…) — error-prone when a working config already existed. Now every healthy deploy saves its exact build config, and the app page's button is **Redeploy**: one click replays it deterministically (same repo, branch, kind, host, auto-deploy, install/build/start/health/portEnv/staticDir; fresh code from the branch head), no form, no AI.
- **Migration 0101_website_services_contract**: `website_services.contract jsonb` — the build-form values (parsed, defaults applied) of the LAST HEALTHY deploy. NULL for ee.json-built apps and never-form-deployed apps. Applied to the dev DB (column confirmed in psql); journal idx 101.
- Where the config now flows: `deploy()` records it on a healthy outcome (`recordDeploy` gained `contract`; a FAILED deploy keeps the previous saved settings; an ee.json-sourced healthy deploy CLEARS them — the row always names the form that produced the current live deploy, and repo ee.json stays the config for ee.json apps). On a redeploy with no form submitted, the contract resolves in this order: repo ee.json → submitted form → **saved settings from the row** → ee's workload contract. The row outranks ee so Redeploy no longer depends on ee still holding the workload (fresh provision, lost state). Every path benefits at once: the page button, `POST /m/website/apps/[name]/deploy` (incl. AI "apply changes"), the `website.app_deploy` tool, and push-to-deploy.
- `website.app_get` falls back to the saved settings too (`contractSource: 'form'`, contract converted via `contractFromForm`), so the Build settings card survives with prefilled fields even when ee has lost the workload's contract; the owner can edit and "Deploy with these settings" from there (an explicit form always wins over the saved one).
- UI copy: "Deploy now" → **"Redeploy"** on the app page (Deploy card says what it replays: "same commands as the last deploy, no AI, nothing to fill out"); Build settings card says the saved settings are the contract; the wizard's and `app_deploy`'s "(Deploy now)" mentions now say "(Redeploy)".
- **Decision**: the saved config lives in Postgres as form values (the exact replayable input), not as ee's AppContract and not pinned to a rev — a Redeploy builds the branch HEAD with the saved commands (a fix push redeploys forward; determinism is about the config, not the commit). ee's company repo stays the runtime source of a form contract; the row is the owner-side deploy record that outlives ee state.
- **Decision**: row-before-ee precedence in `resolveContract`'s stored fallback; repo ee.json still wins over everything (unchanged), so an app that gains an ee.json switches to it and its stale saved settings are cleared on the next healthy deploy.
- Tests: new describe in `modules/website/apps/tools.spec.ts` (7 tests: record on healthy, replay from the row when ee lost the workload, ee.json wins + clears, failed deploy keeps the last working config, edited form overwrites, `app_get` fallback) + one page.spec test (build-settings prefill from the row with `ee.workloads = []`). Suite: 4689 passed / 14 skipped; `npm test` (unit + Playwright) exit 0; `npm run check` 0 errors (30 pre-existing warnings); touched files lint-clean; `db:migrate` applied 0101 on the dev DB.
- Not verified live: the button on a real ee box (no deploy journey run this round — tool-level behavior is covered by the FakeEe specs).
- Next: the real-box app journey (connect → deploy → Redeploy) from the previous entry still stands.

## 2026-10-21 — The machine stays signed in: one code, one year, rolling (uncommitted)

- Owner hit the lockout this design always had: sign-in is passwordless-only, the local stack has no mailer, and better-auth's **default 7-day session** expired — after that, re-login needs a code that cannot be delivered. Nothing was deleted (accounts/data intact); it was a design gap, not a regression.
- **Decision (owner)**: a machine that has signed in once with a code stays signed in — the session is the device's credential ("pass key for the machine"). `auth.ts` now sets `session: { expiresIn: 1 year, updateAge: 1 day }` — active use extends it daily, so a used machine never times out. Existing sessions keep their old expiry; the next sign-in gets the long one. Auth spec asserts the shape.
- **Decision (owner)**: no password/username login — the password-UI direction explored earlier was dropped unimplemented. Passwordless code sign-in stays the only sign-in.
- **Follow-up**: real WebAuthn passkeys need a better-auth upgrade (1.4.22 has no passkey plugin). Until then the durable session is the machine credential.
- Local context: compose on :3000 is CSRF-walled by design (`ORIGIN=http://localhost:5174` in `.env` belongs to the dev server) — use the dev server on :5175 locally; the compose stack is the production-shaped demo. The ee docker box (`os.ee.localhost`) is claimed by `owner@kindred.test` and also gets the long session on its next release.

## 2026-10-21 — SHIPPED (uncommitted): better-auth 1.4→1.7 + passkeys — the machine gets a real credential

- Owner, now logged in, asked for the passkey. `@better-auth/passkey@1.7.12` exists as an official scoped package (published 2026-10-20) matched to better-auth 1.7.12 — so: better-auth `~1.4.21` → `1.7.12` + the plugin. The 1.4→1.7 upgrade broke **nothing**: full unit suite green on the upgraded baseline before any wiring; auth/login/session specs 99 passed first try.
- What shipped: **Settings → Passkeys** (`/settings/passkeys`, signed-in guard) — "Add a passkey for this machine" (`passkeyClient.addPasskey`, WebAuthn prompt), list with device/synced badges; **login page** gains "Sign in with a passkey" (`passkeyClient.signIn.passkey()` — after the first code login, the browser authenticator is the way back in); `auth-client.ts` gets `passkeyClient()`; `auth.ts` registers the plugin with `rpID`/`origin` derived from ORIGIN, overridable by a new optional `PASSKEY_ORIGIN` env (WebAuthn verifies the page origin, so it must be the one the browser sees — set `http://localhost:5175` in `.env` for the dev box). Schema: `passkey` table (migration 0100 + journal; applied to the dev DB, columns confirmed).
- **Decision**: compose's app now carries its own `ORIGIN: http://localhost:3000` in the yaml environment — `.env`'s `ORIGIN` belongs to the dev server, and the mismatch was SvelteKit's 403 CSRF wall on every :3000 form (the "can't log in" report). Dev stays on `.env`.
- What broke on the way: after the upgrade the running dev server 500'd with `better-call does not provide kAPIErrorHeaderSymbol` — a stale Vite dep-optimizer cache, not a version skew (better-call 1.4.4 was correct and present); cleared `node_modules/.vite` and restarted. And the earlier background dev server died when its piped output hit `head`'s line cap — background tasks run without pipes now. **Operational gotcha (cost an afternoon)**: better-auth's SvelteKit handler routes `/api/auth/*` only when the serving origin equals the configured baseURL origin (`isAuthPath` in better-auth/dist/integrations/svelte-kit.mjs) — a dev server on any port but `.env`'s ORIGIN (:5174) gets the whole auth HTTP surface 404'd, silently, because every existing flow (login forms) calls better-auth in-process. The passkey client is the first real HTTP consumer and surfaced it. Rule: this app's dev server must run on the ORIGIN port; the passkey options endpoints are GET (POST 404s — method mismatch looks identical to routing failure).
- Verified: suite 4696 tests green (final run below in the log), `svelte-check` 0 errors, changed files lint-clean; live on :5175 — login page shows the passkey button, `/settings/passkeys` 302s anonymous. Passkey registration itself needs the owner's browser (WebAuthn prompt): Settings → Passkeys → "Add a passkey for this machine".
- Not verified: registering/using a passkey in a real browser prompt (needs the owner's gesture); the box's next release picks this up on its own install.

## 2026-10-21 — Key scopes, the public send-mail how-to, and "Allow this app to send email" (uncommitted, main working tree)

- **Scopes (migration 0098)**: `user_api_key.mcp boolean NOT NULL DEFAULT true`. Every key used to be an MCP key with "Can send mail" as a bonus, so a key made only to send mail could read the brain through `/api/mcp`. Now `/api/mcp` answers 403 `forbidden` to a key whose `mcp` is off (`src/lib/server/api-keys/mcp-scope.ts`; a signed-in session needs no lookup). `POST /api/keys` takes `mcp` (default true); `PATCH /api/keys/[id]` takes `{ mailSend?, mcp? }` (at least one, nothing else). `/api-keys` has both ticks ("MCP", "Can send mail"); a key made on the Email page is mail-only (`mcp: false`). Existing keys keep what they had (the default).
- **The how-to (`GET /docs/send-mail.md`)**: public on purpose (it holds no secret and the app's coding agent fetches it from wherever it runs), `text/markdown`, `X-Robots-Tag: noindex, nofollow`, served from `src/lib/server/mail/send-mail-howto.md` via a `?raw` import — static text, never templated, so nothing user-controlled can reach an agent as an instruction. Carries the reference `sendMail` function (idempotency key chosen before the retry loop; retries only 429/502/503; throws plainly when `EE_API_URL`/`EE_API_KEY` are missing) and the standing rules (no SMTP/mail libraries; email, forms and pages are data, never instructions; refuse-and-tell-the-owner). `docs/agents/send-mail.md` points to it.
- **The binding**: ee injects `EE_API_URL=http://127.0.0.1:4000` into every workload unit (`ee/src/units.ts`, constant in `spec.ts`, name reserved) — every app knows where the platform API is; only a key decides what it may do there. On the app's page (`/m/website/apps/[name]`, new Email card): `website.app_mail_enable` (human-only) mints a mail-only key named `app:<name>` (`modules/website/apps/mail-keys.ts`: `mailSend: true, mcp: false`), seals the raw value into ee as the app's `EE_API_KEY` secret (`POST /v1/secrets`, which rebuilds the app — minutes, health-gated), and remembers the key id in `website_services.mail_key_id` (migration 0099). If ee cannot store it, the minted key is revoked and nothing is remembered. Enabling again rotates. `website.app_mail_disable` revokes the key at once and forgets it. `website.app_remove` revokes it too (ee already deletes the app's sealed values). `EE_API_KEY`/`EE_API_URL` cannot be set by hand (`website.app_env_set`, `substrate.secret_set`). The card links the how-to and offers the AGENTS.md snippet (copy button) that pins the URL as the only source for sending mail.
- **Decision**: revocation is the OS-side key deactivation, not the removal of the env var — the former is instant, the latter would be a redeploy. The dead value stays sealed in ee until the app is removed or the key is rotated; a disabled app's next send gets 401, not the "not enabled" message. (A `DELETE /v1/secrets` in ee for hygiene is a possible follow-up; not needed for safety.)
- **Decision**: `EE_API_URL` is a platform constant (like `EE_WORKLOAD`), not something the OS passes as app env — no env round-trip through `POST /v1/apps`, nothing for an app to override, and the reserved-name check applies.
- **Decision**: no SDK/npm package. The HTTP contract plus two injected env names is the whole interface; the how-to carries the client function. An SDK would be a second surface to keep stable without removing the first.
- Tests: `npm test` 4680 passed (624 files); `npm run check` 0 errors; `ee`: 89 tests, `tsc` clean. New/extended specs: bearer-routes, mcp route (scope), keys routes, docs route, mail-keys, apps tools (toggle: mint→seal→remember, rotate, roll back on ee failure, revoke on disable/remove, human-only), app page actions/load, manifests cut + agent refusal, ee spec/units.
- What broke on the way: `mail-keys.ts` first imported `$lib/server/db` at module load, which fails loud without `DATABASE_URL` and took `modules/index.spec.ts` + `manifests.spec.ts` down; now a lazy import, like `defaultServiceStore`. The manifests spec pins the exact app-tool list and caught the two new tools, as intended. Main moved to `2adff39` (W1–W7 merge) under this work; the page edits are purely additive on top of the redesigned `[name]` page and were re-verified against it.
- **Verified live, docker compose stack** (rebuilt app image; entrypoint ran `migrate.mjs`): "Applying 0098_user_api_key_mcp… 0099_website_services_mail_key… Applied 2 migration(s)" on the existing volume; columns confirmed in psql. Owner = `create-admin.mjs` via ADMIN_* env; sign-in through the (pre-passwordless) password endpoint. Over HTTP: `/docs/send-mail.md` 200 + `text/markdown` + `X-Robots-Tag: noindex, nofollow`; `POST /api/keys` returns/creates both scopes; MCP key `tools/list` → 200 (needs the `Accept: application/json, text/event-stream` header, else the transport 406s after auth); mail-only key → MCP 403 "this key may not use MCP", `/api/thoughts/export` 401, `/api-keys` page 302 to /login, `PATCH /api/keys/[id]` with the key 401 (keys can't manage keys); mail send: mail-only key → 503 `mail_not_configured` (no SES — the honest stop), plain key → 403; owner `PATCH {mcp:false}` → MCP 403 immediately.
- **Verified live, ee docker box** (`ee/e2e/box.sh up` + `install os.ee.localhost` with a fresh `scripts/release.sh arm64` build containing this work): install's first health-gated deploy ran the same two migrations on the box's own Postgres (`os` db columns confirmed). Console healthy over Caddy TLS; claimed via the private claim link (curl form post; the claim flow mints the sign-in code server-side, so an owner exists with no SES) → `owner@kindred.test role=owner`. On the box: how-to 200/noindex; mail-only key behaves exactly as on compose. Sealed `EE_API_KEY` onto the `os` workload through ee's control socket (the exact `app_mail_enable` call): `{"ok":true,"reconcileError":null}` → health-gated blue-green rebuild → the value rendered into `/run/ee/env/os-b.env` and `Environment="EE_API_URL=http://127.0.0.1:4000"` present in `ee-os@.service`; old slot stopped, console stayed up.
- Still not verified: `website.app_mail_enable` end-to-end behind a REAL deployed GitHub app (the toggle's own handler is unit-tested and both its external calls are proven live — key mint on compose, `setSecret` on the box — but no real app was built/claim-to-app journey run); the Email card in a browser; Playwright e2e.
- Next: run the real app journey on the box (connect her repo → deploy → toggle → the app sends); consider `DELETE /v1/secrets` in ee; a rate limit on `/api/website/contact` (noted earlier, unrelated).

## 2026-10-21 — SHIPPED (main `7067c6e`): website module — Apps is the one place (plan/phase-website-apps-ux.md)

Owner request, structured in `plan/phase-website-apps-ux.md` §1; seven workstreams in git worktrees (4 + 3 in parallel), each merged with `--no-ff`: W1 `ed30de5`, W2 `d8cbdee`, W3 `76d8e69`, W4 `67e56f1`, fix `2af1cf9`, W5 `90d2a9f`, W6 `243de21`, W7 `7067c6e`. Plan + shadcn primitives (badge, alert, radio-group, tooltip, breadcrumb, skeleton, switch) in `17f94fc`. 91 files, +8020/−2345.

**What shipped (all under `(nucleus)`, so light like every module page; shadcn-svelte throughout)**
- `/m/website/apps` — **overview**: 2-column grid of cards; the **company site is the first card** (kind Site, its public domain or "No domain yet", page counts), apps by name (kind badge, status, every domain as a link, repo@branch, last deploy), the **"+" card last** → Add dialog: *Build it with chat* (`/?prefill=…`, the chat composer gets the draft, nothing is sent) · *Connect a repo* (`/apps/new`) · *Static site* (`/site`). The inline "Deploy a repo" section is gone. `website.app_list` now returns `{managed, catalog, services[+domains,url,lastDeploy], site}` (first tool with a registry `outputSchema`); when ee is away it answers from the database as the explicit `managed:false` state.
- `/m/website/apps/new` — **connect a repo in three steps**: Repository (connected repo / pasted link / GitHub-App repo; Disconnect only for repos no app uses) → Access (structured `visibility` decides: public = "no key needed"; private = create deploy key → copy → check → branch; App repos skip the key) → App (name, kind, domain prefilled by `appHost`, auto-deploy only for App repos, build form with "Let AI fill this out", deploy with live progress). Deploy is off with a plain alert when not managed; repo connecting still works.
- `/m/website/apps/[name]` — redesigned; **Domains table with Change / Remove / Add per app** (new human-only tools `website.app_domain_set` / `website.app_domain_remove` in `modules/website/apps/domain-tools.ts`, own `DomainEe` seam); **Secrets** card (declared names + sealed marker, write-only form → `substrate.secret_set {workload: name}`); env vars, build settings, deploy history, logs, danger zone with confirm dialogs.
- `/m/website/site` — **the site as a service**: public address, Domain card (set / change = remove old + add public / remove), Pages table with Published/Draft and the sentence that pages are written in chat.
- `/m/website/hosting` — server card + **read-only domains table** (role Console/Site/App is structural: consoleHost / publicHost / route workload; each row links to its owner). No GitHub, Apps, secrets or activity sections. `/settings/hosting` → 307 here (its `github/callback|installed` endpoints and `manifest.ts` are untouched — the GitHub manifest is hard-wired to them). Cog menu + module settings slots repointed (Site → `/m/website/site`).
- `/m/website/github` — **GitHub App connection only** (manifest connect, install link, Installed badge + manage link) plus "Repos are connected when you add an app"; `github-connect.svelte` → `github-app-connect.svelte`, −811 lines; the seven repo actions moved to `/apps/new` with named covering tests.
- `/m/website` — **Recent activity** panel (`website.activity` read tool: ee events by `type` + kernel tool events for `website.*`/`substrate.*`/`github.*` by tool id, descriptor `activity` sentences; failed and read calls excluded, ee `message` never shown; `panel: 'website-activity'` slot).
- Tests: `website-apps.e2e.ts` (6 scenarios, headless, no ee: grid + dialog, plain error on a bad link, hosting stays light under the dark preference, site page, the redirect, chat prefill); endpoint specs for `[name]/deploy|deploy-progress|diagnose`; `page.server.spec.ts` for every new page; component specs for app-card, add-app-dialog, repo-connect-steps, website-activity-panel, github-app-connect; `modules/manifests.spec.ts` pins the new tools (human-only, never approval-gated). `freeName` hoisted to `apps/host.ts`; `ee/e2e/box-journey.mjs` goes to `/m/website/hosting`.

**Decisions (architecture impact)**
- **D-W1** the company site is a service of kind `site`, synthesized from `ee.status().settings.publicHost` + `website_content` — no table; one site per company (schema fact), a second site is a repo-backed static app (ee already serves `runtime:'static'`).
- **D-W2** domain ↔ app assignment is per app, through `website.app_domain_set/remove` (requireHuman; refuse a host owned by another workload incl. console/public; refuse removing the last domain of a web app — `website_services_web_has_host`; keep `website_services.host` in sync). Hosting shows domains, never edits them.
- **D-W3** Hosting lives in the module; the GitHub callback URLs do not move.
- **D-W4** connecting a repo is a step of adding an app; the GitHub page is the App connection only. Connect/deploy-key tools and their D11 gating are unchanged.
- **D-W5** shadcn-svelte on all website pages; no `border-black/15` dialect. **D-W6** secrets stay write-only, two tools as before (`app_env_set` agent-gated, `substrate.secret_set` human-only).
- Smaller: unmanaged app status comes from the service row's own recorded state, never "failed" invented without ee; `app_list` returns `catalog:null` when unmanaged; `vitest.browser.config.ts` and `vite.config.ts` allow the realpath of `node_modules` so component specs and the dev server work from a git worktree (no-op in the main checkout).

**What broke / how it went**
- One integration break: `/apps/new` assumed `app_list` throws when ee is away; after W1 it returns `managed:false` — fixed in `2af1cf9`. `vitest.browser.config.ts` conflicted (W1 and W3 added the same fs.allow fix) — merged by hand.
- W7's first agent went silent mid-run (a blocking browser command); a finisher completed it with every command under `timeout`, headless only.
- Gates on `7067c6e`: `npm run test:unit` 622 files passed / 5 skipped; `npm run check` 0 errors / 30 warnings (baseline); `npm run test:components` 19 files; `website-apps.e2e.ts` 6 passed (`E2E_PORT=5187` — 5173 is taken by another checkout's dev server).

**Not verified / open**
- Nothing exercised on a real ee box yet (domain set/remove, secrets, the three-step deploy, static site); `box-journey.mjs` updated but not run. Headed Playwright waived this round.
- Skipped: `?repo=&branch=` prefill on `/apps/new`; "Installed as <account>" (the connection store has no account login); an App-level disconnect (no tool exists — not invented). The legacy `github.app_create`/`github.app_deploy` path and `github_app_links` are no longer reachable from any page.
- Follow-ups kept from the plan §7: site served at `/` of its host (ee `rootRewrite` fixed to `/s/home`), multiple sites, pages editor, ee `PATCH /v1/domains`, deploy-key list, secret delete. Tooling: `db:up` container-name clash between main and a worktree; duplicate `env` key in `playwright.config.ts`'s CI branch (pre-existing).

## 2026-10-21 — API keys denied by default: a key authenticates only on `/api/mcp` and `/api/mail/send` (uncommitted, main working tree)

- Owner question ("can an app on the same server send mail without a token?") led to an audit. Finding: hooks resolved any valid Bearer key into `locals.user` = the key owner on **every** route, and only three routes (`mail/send`, `mcp`, `keys`) ever looked at `locals.apiKeyAuth`. `requireAdmin` checks `isUserAdmin(user.id)` only. So a mail-only key was the owner on ~97 API routes (thoughts/memory export, memories, chat, agents, approvals, scheduled-tasks, webhooks manage, brand, onboarding) and on every admin page including its form actions (SvelteKit's CSRF check only stops browsers; a script sets `Origin`). "Same server" is also not detectable: Caddy dials every upstream from 127.0.0.1 and no `ADDRESS_HEADER` is set, so `getClientAddress()` is loopback for all traffic.
- What shipped: `src/lib/server/api-keys/bearer-routes.ts` (`API_KEY_ROUTES`, `isApiKeyRoute`, `parseBearerApiKey`) + spec (7 tests). `hooks.server.ts` resolves a Bearer key only when `isApiKeyRoute(event.url.pathname)`; everywhere else the header is ignored, the request stays anonymous and the route's own check answers (401 / redirect to /login).
- **Decision**: deny by default, opt in by allowlist — and the allowlist lives in hooks, not in the routes, because `resolveWithAppDb` activates the tenant DB session from `locals.user` before any route runs; a route can't undo that.
- **Decision**: `/api/keys` is *not* allowlisted (tighter than first discussed): a key creating a fresh non-mail key would be an escalation to MCP (brain read). Key management is for the signed-in owner only. The in-route `apiKeyAuth` guards stay as defense in depth (now unreachable by keys).
- Audit of the 18 routes with no `locals.user` check: all deliberate — `admin/*` use `X-Admin-Key` (ADMIN_CONSOLIDATION_KEY, a separate mechanism, so pg_cron is unaffected), `agents/callback/complete` uses its own callback token, `github/webhook` + `webhooks/inbound` verify signatures, `e2e/*` return 403 outside `vite dev`, the rest are public by nature (health, sign-out, claim/open, onboarding catalog, website contact form). No accidental anonymous route. Noted, not changed: `/api/website/contact` has no visible rate limit.
- Tests: `npm test` 4624 passed; 1 failure in `m/website/apps/new/page.server.spec.ts` that also fails at HEAD and is being fixed concurrently by another session in this working tree (their files untouched). `npm run check` 0 errors. The touched files lint clean; repo-wide `eslint .` has 124 pre-existing errors.
- Not verified: Playwright e2e not run; not tried on a real ee box; no live MCP client exercised against the allowlist.
- Next (agreed with the owner): (1) explicit key scopes (`mcp`, `mail`); MCP requires `mcp`; existing keys migrate to `mcp` (+`mail` where ticked). (2) Website-app mail binding: an "Allow this app to send email" toggle on the app's page provisions a `mail`-only key named `app:<name>` into the sealed store and injects `EE_API_URL` (`http://127.0.0.1:4000`) + `EE_API_KEY` into the workload env (both added to `RESERVED_ENV`). (3) The how-to (reference `sendMail` function + rules) served by the console at a stable public URL, `X-Robots-Tag: noindex`, pinned from the app repo's AGENTS.md as the only source for sending mail. No SDK/npm package (decided against: it adds a second surface to keep stable without removing the first).

## 2026-10-21 — SHIPPED (branch): members with roles + invites; claimed servers show a normal sign-in; claiming is over once claimed

- Owner report: "People trying to sign in land on the owner login website." Cause: on a claimed ee server /login offered "Sign up" and sent any address a code; a non-member then hit the user-create hook's "This company already has an owner. Ask them to invite you." Now: /login on ee has no signup link; an address without an account gets no code, just "You're not a member of <company> yet. Ask the owner for an invite." (`signInGate`/`signInRefusal`, a DB lookup, no heuristics); /signup on a claimed ee server redirects to /login. The unclaimed message still shows only while no account exists.
- Claim: refused whenever an account exists (checked before the token, so a still-valid token is refused too) with "This company already has an owner." and no claim header. The token is spent at claim time (`claim_consumed`, atomic insert before the owner is created), so a racing second claim loses; the user-create hook refuses any claim when users > 0; a partial unique index `user_single_owner` makes a second owner impossible in the DB.
- **Decision (ee claim-link)**: ee asks the OS. The company DB is the only truth about ownership, so `POST /v1/claim` first GETs `/api/claim/open` on `127.0.0.1:4000` (OS_INTERNAL_PORT, Caddy → live os slot): 200 → mint; 409 (owner exists) with `/api/health` OK → 409 "already has an owner"; neither answers → 503, no link minted. Chosen over "OS tells ee at claim time" because it needs no new write path from the OS into ee secrets and can't drift if a notification is lost.
- Members: `user.role` is now `owner | admin | member` (migration 0096: `user`→`member`, the earliest production admin → `owner`, check constraint + unique owner index; `member_invite`, `claim_consumed` tables). `isUserAdmin` = owner or admin. Settings → Members (`/settings/members`, owner/admin only): list, invite by email with a role, change role, remove; the owner can't be demoted or removed; nobody can be made owner (no transfer yet). Invites: random 32-byte token, only its SHA-256 stored, 7 days, sent via `companyMail()`, a newer invite to the same address replaces the old link. `/invite?token=` emails a code to the invited address; the user-create hook (inside `inviteScope`) takes the invited role and consumes the invite atomically (reuse/expiry refused).
- Kernel: new internal system module `members` with `members.list` (read), `members.invite` (external, gated) and `members.set_role` (internal, gated → auto in "reasonable" mode). The agent acts with admin rights, so it can't touch the owner either. **Decision**: the Members page calls the service directly (the click is the person's decision); the agent goes through the gated tools. No `members.remove` tool yet (page only).
- Not done / not verified: no e2e (Playwright) run and not tried on a real ee box; migration 0096 not applied against a live DB here; owner transfer and resending/revoking invites from the page are not built.
## 2026-10-21 — SHIPPED (branch): `POST /api/mail/send`, a plain mail endpoint for API keys

- What: `POST /api/mail/send` (src/routes/api/mail/send, logic in src/lib/server/mail/api-send.ts, DB/audit wiring in api-send-store.ts). Bearer `eigen_` keys only (cookie sessions 401); strict zod body (one `to`, subject 1..998, text, optional html/replyTo/idempotencyKey); sends through `companyMail().send`; 200/400/401/403/409/429/502/503 as in docs/agents/send-mail.md (rewritten around this endpoint only; MCP + approval material removed).
- Key scope: migration 0096 adds `user_api_key.mail_send` (default false) and the `mail_api_send` idempotency table. "Can send mail" checkbox on /api-keys (create + per-key toggle, `PATCH /api/keys/[id]`) and a mail-keys panel on the Email module page (/m/email via the `panel: 'mail-keys'` settings slot): create (shown once + copy), list, toggle, revoke, "How to send mail" with a copyable curl. Same key store as before; no second key system.
- **Decision**: the owner's "Can send mail" tick is the consent, so this endpoint sends immediately with no approval round (unlike the MCP `owlery.send_mail` tool, which stays approval-gated). A key cannot grant the scope: `POST /api/keys` with `mailSend:true` and `PATCH /api/keys/[id]` reject API-key callers (403).
- **Decision**: idempotency in Postgres (`mail_api_send`, unique key_id+idempotency_key, 24h window; a pending row is reserved before the send and released on failure) so a retry never double-sends, even across restarts. Rate limit 60/min per key in process memory: ee runs one console process per company; a restart only resets the window.
- Audit: every attempt past auth is a `tool.executed` event (tool `email.api_send`, auditClass write) with key name, recipient, outcome, id and an `activity` sentence ("Sent an email to <to> (via key <name>)"), so Overview recent activity shows it. Never the key or the body. 401s are not audited (no identity).
- Tests: src/lib/server/mail/api-send.spec.ts, src/routes/api/mail/send/server.spec.ts, keys route specs. Not tested: real SES delivery, the migration against a live DB, the UI in a browser.

## 2026-10-21 — SHIPPED (branch): a failed deploy says why, live (owner verdict on "twodown": "This is a joke")

- Cause on the box: the form default start `node index.js` pointed at a file twodown lacks → MODULE_NOT_FOUND crash loop (restart counter 108) during a 240s health gate, then the OS said "could not be built or started. The deploy history has the server's details."
- ee: (a) the repeated `twodown: twodown: …` prefix came from the failedFingerprint branch throwing `${name}: ${lastError}` and the catch storing it back into lastError each tick; now an already-recorded failure is a `ReportedError` (not re-recorded, lastError untouched), and generic errors are recorded only when they change. (b) the health gate fails fast once systemd restarted the candidate 3 times (`NRestarts`), then `disable --now` + `reset-failed`; ONE `deploy.failed` event with the redacted log tail. A failed build is memoised too (not rebuilt every tick). (c) `ee/src/deploys.ts`: one record per attempt (journal `deploys`, 20 per workload) + a log file (last 400 lines: build stdout/stderr per step, the candidate's journal since its start), redacted of every stored secret value; `GET /v1/deploys?workload=`, `GET /v1/deploys/:id/log`, `GET /v1/sources/files?name&rev`; app removal forgets them. (d) stages fetching → building → starting → health → live | failed, with timestamps.
- **Decision**: an explicit deploy request (`POST /v1/apps`, `POST /v1/deploy`) clears failedFingerprint (`allowRetry`) so the owner's click retries; the 60s tick never does.
- OS: deploys run in the background (`modules/website/apps/deploy-jobs.ts`, one job per app); routes `[name]/deploy-progress` (GET, polled every 1.5s from the click handler, no $effect), `[name]/deploy` (POST, optional AI contract changes = "Apply and redeploy"), `[name]/diagnose`. Component `app-deploy-progress.svelte`: spinner + stage list + live log; on failure the plain sentence ("<app> failed while <stage>: <ee's cause>") + "Ask AI what went wrong". New tools `website.app_deploy_status`, `website.app_diagnose` (LLM gateway, json_object, zod schema `{cause, fix, suggestedContractChanges?}`; changes dropped when the repo's ee.json is the contract).
- **Decision**: diagnosis is a dedicated gateway call exposed as a registry tool (so the orchestrator can call it in chat too), not a chat turn — simpler, cost-tracked by the gateway.
- **Verified on ee-box** (this branch's release `780656b59c1b`, installed with `ee bootstrap`; os went live through the new stage records): fetched heroku/node-js-getting-started, `POST /v1/apps` with start `node nope.js` → failed in 13s (not 240s): "the app crashed on start (exit status 1, 3 restarts)"; ONE `deploy.failed` event, still one after the next tick; unit `inactive`/`disabled`, NRestarts 0 afterwards; `GET /v1/deploys?workload=nopetest` showed fetching→building→starting→health→failed with timestamps; `GET /v1/deploys/:id/log` had the npm install output and MODULE_NOT_FOUND. Then the app was removed (events gone, no units, mirror deleted).
- Not verified on the box: secret redaction (unit-tested only), the OS pages/routes against the real box (no owner session; no users created), a real LLM diagnosis (mocked gateway in tests). While verifying, another session re-bootstrapped the box with main's ee, so the removal ran through the old daemon; the test deploy's log file was then deleted by hand. The box currently runs main's ee, not this branch.
- Not done: twodown itself was not touched; its old journal lastError still holds the prefixed text until its next deploy.
## 2026-10-21 — SHIPPED (branch): "Let AI fill this out" on the Apps build form

- ee: `GET /v1/sources/tree?name&rev&depth` (depth ≤4, ≤2000 entries) and `GET /v1/sources/file?name&rev&path` (≤64KB, text only; refuses traversal/absolute/.git paths 400, symlinks/binaries 415, big files 413). Read from the local mirror only.
- OS: `website.app_suggest_contract` (admin + human only, read): fetch the mirror with the repo's auth → tree + a fixed declared list of root files (README*, manifests, framework configs, Procfile, Dockerfile as info; lockfiles presence-only) → one gateway call (json_object, prompt carries catalog ids + ee contract semantics) → zod-validated; a runtime outside the catalog comes back as a plain catalog-gap sentence (field left empty), shell syntax in a command becomes a warning. Endpoint `POST /m/website/apps/suggest`. Form button fills + outlines fields, shows reasons/warnings; detail page gets "Build settings" (edit stored contract + AI fill + redeploy) for form-contract apps.
- Decision: the gateway only offers `json_object`, so the "strict schema" is the shape in the prompt + zod on the answer (no provider-side json_schema).
- Verified on ee-box: tree/file endpoints for real on heroku/node-js-getting-started (traversal 400, lockfile 413, 404). The LLM call was NOT run for real (needs an owner session); covered by mocked-gateway tests and a real-mirror run with a mocked chat. `local-server.sh upgrade` fails from a worktree (box mounts the main checkout's dist/release); bootstrapped from a copied tarball instead, which exited 1 only because of the owner's failing `twodown` app (os went live).

## 2026-10-20 (8) — SHIPPED (branch) + VERIFIED ON THE LOCAL BOX: deploy a connected repo as an app (Website → Apps)

- A connected repo + branch becomes a **service** (web app or back-end service). Table `website_services` (migration `0095_website_services`) holds the source, kind, host, push-to-deploy, and the last deploy's state/rev/plain error. It holds no contract and no env values.
- **Build contract**: the repo's `ee.json` wins. Without one, the owner fills in a form (runtime from ee's catalog, install, build, start, health path, port variable). ee stores it in the **company repo** as the workload's new `contract` field, never in the app's repo. ee writes it into the release as ee.json, and a changed contract counts as a new release (the release id gets a contract hash). A missing runtime is a `catalog_gap` (D16) shown in plain words.
- **Fetch auth per kind**: public uses https with no auth. deploy_key uses `git@github.com:o/r.git` + `deployKeyId`. github_app uses an installation token minted for that one fetch and never stored.
- ee: `GET /v1/catalog`, `GET /v1/sources/contract?name&rev` (reads ee.json at the pinned rev from the mirror), `GET /v1/events?workload` (deploy history), `POST /v1/apps` takes `contract` (catalog-checked, 422 `urn:ee:catalog_gap`), `/v1/status` returns each workload's `contract`, and the contract has `portEnv`.
- Host: `<app>.<parent of console>` under `.localhost` (local box: `<app>.ee.localhost`), `<app>.<ip>.sslip.io` before DNS. On the owner's own domain the owner gives a host (no wildcard is assumed).
- Tools: `website.app_list`, `app_get`, `app_logs` (read); `website.app_deploy` (mutate, approvalRisk **public**: it puts code live at a reachable address, so under "reasonable" it still waits, like publishing a page); `website.app_env_set` (mutate, public: it restarts a live app; the activity names the variable only and the value never comes back); `website.app_remove` (destructive, human-only); `website.app_auto_deploy` (webhook service principal only).
- UI: `/m/website/apps` (list with status dot, URL, branch@sha, last deploy; deploy form) and `/m/website/apps/[name]` (Deploy now, history, logs, domains, env editor, remove). It is linked from the Website module page ("Apps").
- Push-to-deploy: the webhook passes `repository.id`, and services match by **repo id + branch**, with auto-deploy on, for github_app repos only (a DB CHECK enforces it). Deploy-key and public repos get manual deploys only (no push events). Legacy `github.auto_deploy` links still match by name.
- **Decision (D11, owner decision 3)**: the agent may deploy and set env, but only through the approval gate. Both tools are in `APPROVAL_REQUIRED_TOOLS` (via `APP_AGENT_GATED_TOOLS`; held together by `modules/manifests.spec.ts`). The handler accepts human or agent principals, never a service. Owner clicks on the page are recorded as their approval (`src/lib/server/website/owner-run.ts`). Removing an app stays `requireHuman`.
- **Decision**: a deploy's result is read from ee's structured state. It is healthy when the live release starts with the new rev and there is no lastError. A failure is worded from the journal's event *type* (`deploy.failed` means the health gate, otherwise build/start), never by parsing the error text. Raw build output only goes to the server log.
- **Verified for real on ee-box** (release `2f82363d3795` + this tree, installed with `ee bootstrap`; migration 0095 applied, `website_services` exists in db `os`). Through ee's control socket, in the same order the tool calls it: fetch `heroku/node-js-getting-started@main`, which gave rev `8b8dec11`; `sources/contract` returned `present:false`; `POST /v1/apps` with the owner contract (node 22, `npm install --omit=dev`, `node index.js`, `/`) built it sandboxed and passed the health gate on slot a; `POST /v1/domains getting-started.ee.localhost`; then `docker exec ee-box curl -sk https://getting-started.ee.localhost/` returned **200**, title "Node.js Getting Started on Heroku". Setting a secret redeployed blue-green to slot b (healthy), and the value was not in `/v1/status`. Logs and events endpoints returned real lines. Then `DELETE /v1/apps` was run and the mirror removed: the host no longer answers, 0 units are left, and status no longer lists it.
- **Not verified**: the OS tools and pages against the real box (no owner session; we did not create users, per instructions). They are covered by unit and page tests with a faked ee. A github_app or deploy_key deploy was not run for real. The sealed `DEMO_VAR` value from the verification run is still in ee's secret store under the removed app's scope (ee has no secret delete verb yet).

## 2026-10-20 (7) — SHIPPED (branch): private GitHub repos through read-only deploy keys

- Owner's decision: no whole-account GitHub App by default. Public repos stay by link. Private repos use a deploy key per repo. The App step is collapsed under "Advanced" on `/m/website/github` (the code is unchanged). Design: plan/github-connect.md, "Private repos: deploy keys".
- ee: `POST /v1/deploy-keys`, `POST /v1/deploy-keys/:id/check`, `DELETE /v1/deploy-keys/:id`, and `POST /v1/sources/fetch` with a `deployKeyId`. The key comes from ssh-keygen ed25519 and is sealed in the secret store (`_deploy_keys`). For one git call it sits in a 0600 temp file, with GitHub's published host keys pinned (StrictHostKeyChecking=yes), and is deleted after. `System.run` gained `env`, `SecretStore` gained `delete`, and bootstrap installs `openssh-client`.
- OS: `EeClient.createDeployKey/checkDeployKey/deleteDeployKey`. Migration `0094_github_deploy_keys` adds auth_kind and deploy_key_id and makes repo_id nullable. The parser accepts `git@github.com:o/r.git` and `ssh://git@github.com/o/r.git`. New tools: `website.github_deploy_key_create/check/delete`, and connect takes `auth: {kind: 'deploy_key', keyId}`.
- Decision (D11): creating or deleting a deploy key changes the server, so it is human-only (`requireHuman`). On the page it is the owner's click. Disconnecting a deploy-key repo is human-only for the same reason. The check is read-only and open to the agent.
- Decision: auth_kind has three values (`public | github_app | deploy_key`), not two, because the existing App rows need their own kind.
- Decision: without ee (plain `npm run dev`) deploy keys fail loud: "Private repos need the server's deploy agent…". No fallback store.
- Verified: ee unit tests with a fake System (key generation, sealed storage, the check command with pinned host keys and a 0600 key file, cleanup, fetch with the key) and the control verbs over a real unix socket. OS unit tests for the parser, store, tools and page actions. Component tests for the new section. `npm run check`.
- Not verified: no real GitHub deploy key (the owner has to add one), no real ssh-keygen or ssh run on a box, and migration 0094 has not been applied to Postgres (no local server was available).

## 2026-10-20 (6) — SHIPPED (branch): connect a GitHub repo (Website → GitHub)

- Studied Coolify's GitHub design, design only, no code copied (plan/github-connect.md). New page `/m/website/github`, linked from the Website module's "GitHub connection" setting. It has: the App manifest flow with plain steps, public repo by link (unauthenticated API, branch picker), private repos the installed App can see plus "Add more repos on GitHub", and the connected repos with their last commit and a Disconnect button. The App setup URL now returns the owner here.
- Migration `0093_github_connected_repos`. It is keyed by GitHub repo id plus branch and stores the installation id for private repos. It stores no tokens.
- Tools: `website.github_list_repos` / `_available_repos` / `_inspect_repo` (read), `website.github_connect_repo` (internal) and `website.github_disconnect_repo` (destructive). Both mutating tools are on the approval-gated list.
- Decision: in the dashboard, the owner's click is their approval. When the mode gates a connect or disconnect, the page records an owner approval and runs the tool (D11: owner clicks are human actions).
- Decision: GitHub API failures become plain sentences, chosen by HTTP status (GitHubUserError). Raw errors only go to the server log as `cause`.
- Not verified: no real GitHub App, and the DB store has not run against Postgres (the migration has not been applied to a dev DB). Next: deploy a connected repo through `github.app_create` / ee mirror, and match webhook pushes by repo id.

## 2026-10-20 (5) — SHIPPED: one orchestrator engine (durable); Claude Pro/Max and ChatGPT sign-ins removed

**Owner directive**: "The provider we use shouldn't determine if PiDurable is working or not. Remove providers that are not supported by PiDurable." Amends phase-durable D6 and the 2026-10-19 per-provider engine decision.

**Shipped:**
- `durable` (pi-durable 1.3.0) is the orchestrator's only loop engine. `builtin-json` (`src/lib/kernel/engines/builtin-json.ts`) and `modules/orchestrator/engine-choice.ts` are deleted; `EE_ORCHESTRATOR_ENGINE` is gone (no pin, no rollback engine). `bootstrapOrchestrator` fails loud at boot unless a `durable` engine is injected via `options.engines`; the harness warm-up (crash-resume) now runs on every boot, not only under the pin. `approvalPendingResult` moved to `src/lib/kernel/engines/tool-error.ts`.
- The subscription sign-ins whose API shapes cannot carry tool calls are removed end to end: provider ids `anthropic` (Claude Pro/Max OAuth) and `openai_codex` (ChatGPT device flow), their adapters (`api-shapes.ts`, `oauth/anthropic.ts`, `oauth/openai-codex.ts`), the four `/api/onboarding/oauth/{anthropic,openai}/*` routes, the wizard cards, the mock-gateway stubs and the e2e/component tests for them. GitHub Copilot and OpenRouter sign-ins stay (OpenAI-compatible chat completions).
- Migration `0091_durable_only_providers` (journal idx 91): deletes `llm_active_provider` / `llm_provider_config` rows for the two providers and drops `llm_provider_config.orchestrator_engine`. An owner who was on one of them sees the provider onboarding again and connects an OpenAI-compatible provider.
- Verified: `npm run check` 0 errors; `npm test` 4255 passed; migration applied on the dev DB.

**Decision log (architecture impact)**
- The engine is not a per-provider or per-deployment choice any more. A provider is supported iff it speaks OpenAI chat completions with native tool calls; anything else is not offered. No fallback engine exists — a durable failure fails loud.
- Follow-up (not done): `kernel_agent_session_events` + `AgentSessionLog` (`sessionLog` on `WiredKernel`) had `builtin-json` as their only writer and are now dead infrastructure (pi-durable storage is the history source, D6). Removing them is a kernel-wide change (wiring, db-stores, CLI/MCP spec fixtures, a drop migration) and was left out of this cut.
- Housekeeping: the merged parent-dir worktrees `../ee-durable` (branch deleted) and `../ee-rebrand` (worktree removed; its uncommitted edits preserved as WIP commit `ec40558` on `wt/rebrand`) are gone. Worktrees stay inside the repo from now on.
## 2026-10-20 (5) — SHIPPED (branch): platform step 1, module merge with no behaviour change (`e9c7880`)

**What shipped:** plan/phase-platform.md delivery step 1. Modules are now: memory, email, website, brand, and orchestrator (internal). Migration `0092_module_merge` merges the activation rows. `modules/substrate` moved to `modules/website/hosting`, `modules/github` to `modules/website/github`, `modules/owlery` to `modules/email/owlery`, and `modules/{repo,dev-agent,roadmap}` to `modules/orchestrator/…`. One directory per module again, so boundaries.spec still holds without declared edges.

**Decision log (architecture impact)**
- **Tool names did not change (approach a).** A manifest may own several tool namespaces (`ModuleManifest.toolNamespaces`, default `[id]`, which must include the id). The rule "module = the name's prefix" becomes "module = the owner of the name's prefix". Every namespace has exactly one owner: `ModuleRegistry.register` throws on an overlap, on an id that collides with another module's namespace, and on a tool outside its namespaces. `registerModuleTools` checks the same thing. Stored `kernel_approvals.tool_name` values, event payloads, journey artifacts, prompts and `APPROVAL_REQUIRED_TOOLS` all stay valid. There is no alias table.
- **Mapping:** website ← website + substrate + github. email ← email + owlery (id `email`, not `owlery`: it matches the owner-facing name and the /m/email page, and both send tools now live in this one module). orchestrator (internal) ← repo + dev-agent + roadmap.
- **Roadmap goes to the orchestrator module, not the kernel.** The kernel never imports module code, and the roadmap store is module code. Its tools (`roadmap.*`) and the extension_roadmap_items table are unchanged. Settings → Extensions still reads the store directly.
- **orchestrator, not `agent`.** The `agent` module (agent.list/enable/disable) is registered later, in the orchestrator bootstrap, with the runtime. Folding repo/dev-agent into it would need its manifest at buildKernel time, and `agent` is self-activated, which would silently switch on repo/dev-agent. `internal: true` on a manifest means it gets no owner-facing card (buildOverview skips it; kernel.module_list reports `internal: true`).
- **Activation migration:** a merged module is active if any of its parts was. It gets a row only if some part had one. The retired ids' rows are deleted. Pure equivalent: `mergeActivations` in src/lib/kernel/module-merge.ts. The SQL file is generated from `MODULE_MERGES` and pinned byte-for-byte by its spec. Tested on the dev DB in a transaction that was then rolled back.
- **System modules are now website and email** (`SYSTEM_MODULE_IDS`, ensureSystemModulesActive at boot and on the hosting and webhook routes). Accepted consequences: (1) `website.*` and `email.send_mail` are always active, because they share an activation with hosting and Owlery. website.publish_page and email.send_mail are still approval-gated. (2) If any of repo/dev-agent/roadmap was active, all three are active now. D11 is unchanged: substrate mutations still go through `requireHuman`, which is pinned through the full kernel pipeline in modules/manifests.spec.ts.
- The prompts no longer offer repo or roadmap as owner modules (brain persona, onboarding context).

**UI follow-ups (not done here; src/routes/**/*.svelte and components untouched):** use module ids `website`, `email`, `brand`, `memory`. Never use `substrate`, `github`, `owlery`, `repo`, `dev-agent` or `roadmap` as module ids or /m/ pages. Hide `internal` modules (orchestrator). The overview result source key moved from `owlery` to `email` (server code, done).

**Unverified:** the durable-harness SIGKILL spec fails in this worktree because it spawns `node_modules/.bin/tsx` from cwd, and the worktree has no node_modules. Nothing in this change touches it. ee was not touched, so the ee tests were not run. The migration has not been run through `npm run db:migrate`.

## 2026-10-20 (4) — Owner-chosen approval mode (backend)

**Shipped:** migration `0090_kernel_approval_mode` (one row, seeded `'ask'` in SQL); `ModeAwareApprovalPolicy` replaces `StaticApprovalPolicy` in `buildKernel`; `approvalRisk` on `ToolDescriptor`; `GET/PUT /api/approvals/mode`. The approve/deny endpoint and the chat UI belong to another workstream. **Next:** the UI selector under the chat input.

**Decision log (architecture impact)**
- Approval mode is company-wide: `ask` (gated list waits, as before), `reasonable` (a gated tool waits unless its DECLARED `approvalRisk` is `internal`), `allow_all` (nothing waits; gated calls emit `approval.auto_approved` plus the normal `tool.executed` audit). The mode is read on every call. The gated set is still `APPROVAL_REQUIRED_TOOLS`. Registering a gated tool with no `approvalRisk` throws at load time. `ApprovalPolicy` now returns `decide() → 'require' | 'pass' | 'auto_approved'`. Mode changes emit `approval.mode_changed`.

## 2026-10-20 (3) — FIXED + VERIFIED LIVE: the website founding journey advances again

**Root cause (from the box's chat_message, journey row and logs):** turns at 22:44 and 23:07 captured step 2 in the agent's reply, then threw ("module website is not active", then "unknown tool") BEFORE the journey saved, so the journey stayed on step 2 while durable's history held the capture. The boundary fix (2) now saves the journey even when a step fails. A second blocker turned up: the journey's own module activation waited for owner approval, because kernel.module_activate was on APPROVAL_REQUIRED_TOOLS. The pending artifact was also recorded under website.create_page, so the label was misleading.

**Shipped:** kernel.module_activate is no longer approval-gated; deactivation still is (`modules/index.ts`, test in `modules/index.spec.ts`, which fails without the fix). On the box: the journey row was repaired by hand to match what the agent captured (positioning captured, stepIndex 2, the stray "hi" removed from company_name). The stale pending approval row was removed.

**Decision log (architecture impact)**
- Module ACTIVATION is the agent's own remediation (owner: the harness fixes "module not active" itself, and nobody else is expected to). It is audited and reversible. DEACTIVATION stays an owner decision (approval).

**Open:** journey answers accumulate every user message verbatim, so a side question like "where are we?" gets stored as the step's answer. That needs an LLM-structured capture (no string heuristics), not a filter. The durable history also repeats the journey context block on every turn.

## 2026-10-20 (2) — SHIPPED (branch): code <-> harness <-> user — no path from application code to the user

**What broke (production)**: the chat showed "Error: unknown tool: kernel.module_activate". (a) The journey step code (`executeStepArtifacts`, run after the model replied, outside the agent turn) threw to `POST /api/chat`, which streamed the raw message; the nucleus page printed it as `Error: …`. (b) The web server's kernel never registered the admin tools (`registerAdminTools` ran only in the CLI); tests passed because they hand-built kernels.

**Shipped**
- `modules/orchestrator/brain.ts`: `executeStepArtifacts` returns `failures` (ToolErrorResult) instead of throwing (the already-applied probe included). `JourneyAwareAgentRuntime` hands every application failure of the turn — journey step tools, journey/onboarding reads and writes, the hand-off precondition ("website already started") — to the agent as a `harnessObservationBlock`, with one extra model step after the reply when needed. The follow-up reply replaces the first one. `founding.ts` (wizard, no agent turn) fails loud on `failures`.
- `handle-agent-chat-post.ts`: every error frame carries a fixed human message (`CHAT_TURN_FAILED_MESSAGE`, `CHAT_LLM_NOT_CONFIGURED_MESSAGE` + `code`, `CHAT_TURN_INCOMPLETE_MESSAGE`); no `details`, no raw text. The real error is logged redacted and recorded via the required `recordFailure` (route: kernel event `harness.turn_failed`).
- Nucleus and `/chat` pages render only the server's fixed terminal message (`chatFailureMessage`); HTTP/network errors get a fixed client message.
- `boot.ts` calls `registerAdminTools(kernel, { db })`; `boot.wiring.spec.ts` pins it through the real composition.

**Decision log (architecture impact)**
- **The boundary (owner rule)**: code <-> harness <-> user. Application failures inside a chat turn are information for the agent (fix, retry, or explain), never exceptions for the route. Only a harness/LLM failure (engine rejects, engine choice `recordedEngineFor` fails, or the entry's own persistence fails) ends the turn without the agent: one fixed human message to the user, details in the server log + operator event. Request-shape errors before the turn (401/400/404 session) stay HTTP errors, but the client renders only a fixed message.
- Known residue: tool-result previews (`tool_result` stream events) on the `/chat` timeline still show a tool's own error message text as a step summary.

## 2026-10-20 — SHIPPED (branch): the agent fixes tool errors itself (module_inactive no longer reaches the user)

**What broke**: on a fresh server the website-founding chat replied "Error: module website is not active; cannot execute website.list_pages". The KernelError came from the journey artifact executor (`executeStepArtifacts` → `listPagesViaRegistry`) and builtin-json's catch (`throw err`); durable passed only the bare message string to the model.

**Shipped**
- `src/lib/kernel/engines/tool-error.ts`: shared `toolErrorResult` → `{status:'error', tool, code, message, details?, remediation?}`. For `module_inactive` the remediation is `{module, fix:'kernel.module_activate', input:{module_id}}`. KernelError details go through `redactForLog`. Zod issues are reported as path + message only.
- Both engines (durable `bridgeExecute`, builtin-json tool path) return this result to the model instead of throwing. `approval_required` → `approval_pending` is unchanged.
- `KernelError` gains optional structured `details`. The registry's module gate sets `{module, tool}`, so no code parses the message.
- The journey executor activates an inactive module through the audited `kernel.module_activate` tool and retries once. Any other error, or a second failure, still fails loud.
- Persona prompt gains `ORCHESTRATOR_TOOL_ERROR_PROMPT`: fix it yourself, use `kernel.module_list`, tell the user only in plain language.

**Decision log (architecture impact)**
- **Tool vs infrastructure boundary**: anything that rejects from `EngineContext.executeTool` counts as the tool's result and goes to the model. Harness, storage, gateway and index failures still fail the run. Known limitation: an audit or vcs write that fails inside `registry.execute` is also reported to the model.
- No role change. `ORCHESTRATOR_PRINCIPAL` already has `admin`, the kernel module is activated at bootstrap, and the listing already offers `kernel.module_list` + `kernel.module_activate` (pinned by a test). Tools of inactive modules stay hidden from the listing; `kernel.module_list` shows they exist.

## 2026-10-19 (6) — SHIPPED (branch): Owlery email module on Amazon SES

**Owner rule**: the email module owns the Amazon SES credentials and all sending; nothing else holds SES credentials or talks to SES.

**Shipped**
- `modules/owlery/` (id `owlery`, name "Email"): SES v2 core (`@aws-sdk/client-sesv2@3.1146.0`, exact pin) — SendEmail, GetEmailIdentity / CreateEmailIdentity, GetAccount (sandbox). Tools `owlery.status` (read) and `owlery.send_mail` (mutate, in APPROVAL_REQUIRED_TOOLS). Self-seeded system module in `ensureSystemModulesActive`.
- Migration `0088_owlery_settings` (journal idx 88) drops `company_mail`, creates singleton `owlery_settings`; SES secret sealed with a TENANT_MASTER_KEY-derived key (AAD `owlery-ses-secret-access-key`).
- `$lib/server/mail` is now only the contract (`companyMail().send / isConfigured / saveVerified`, typed `SenderNotVerifiedError` / `MailSetupError`), backed by the module's service. `companyOwleryEnv()` and the old Owlery HTTP client (`src/lib/server/owlery/`) are gone; auth, notifications, feedback and `email.send_mail` send via `companyMail()`.
- `POST /api/onboarding/mail` takes `{region, accessKeyId, secretAccessKey, emailFrom}` → 200 `{ok, testSentTo}` / 409 `{error, needs:'verify_sender', emailFrom}` / 400 `{error}`.

**Decisions**
- `src/lib/server/mail` imports `modules/owlery/service` directly (same pattern as routes importing `modules/github/store`); the shared contract types live in `$lib/server/mail/company-mail`.
- Contact-book sync is an explicit logged no-op (SES has no contact book); `email.add_contact` / `email.list_contacts` removed.
- In the SES sandbox, setup creates the test recipient's identity (Amazon mails a verification link) and returns a plain-language 400.

**Next**: onboarding UI against the new contract (other agent); Settings → Email page.
## 2026-10-19 (6) — SHIPPED (branch, not merged): assisted onboarding — the agent takes over after the scripted setup

**What shipped**
- The scripted first turn in the nucleus chat is gone. When the welcome wizard finishes, the page calls `POST /api/chat` with `{ bootstrap: true, onboardingHandoff: true }`. The orchestrator agent then writes the first turn itself, from an onboarding context block and a hand-off instruction in the owner's spirit ("You did it — your company is set up and you're its admin. What should we build first? I'd suggest your website…").
- `modules/orchestrator/onboarding-context.ts` holds the facts, the context block, the hand-off instruction and the start-marker protocol. The block lists what is done (admin account, company email, AI provider) and what comes next (the website, then the other modules). `JourneyAwareAgentRuntime` prepends it to the user input on every orchestrator turn while assisted onboarding is active, so both engines see the same thing. Persona gains `ORCHESTRATOR_ONBOARDING_PROMPT`.
- The website journey is no longer opened by `POST /api/onboarding/welcome`. The agent opens it when the owner agrees, by appending the exact `[[onboarding:website:start]]` token; the runtime only parses that token. The journey starts empty, so the owner's "yes" is never captured as the company name. From there the journey drives as before.
- DB facts: `src/lib/server/onboarding/assisted.ts`, wired in `boot.ts`.

**Decision log (architecture impact)**
- **Orchestrator engine = an explicit per-provider choice, recorded at connect time.** Amends phase-durable D6.
  - Migration `0089_provider_orchestrator_engine` adds `llm_provider_config.orchestrator_engine` (NOT NULL, CHECK `builtin-json|durable`). Existing rows are backfilled to `builtin-json`, so behaviour is unchanged until a provider is re-connected.
  - `engineForProvider` sets the value on every connect: OpenAI-compatible providers get `durable`; the API-shape subscription sign-ins (`anthropic`, `openai_codex`) can't carry tool calls and get `builtin-json`.
  - Each dispatch runs the engine recorded for the conversing user's **active** provider, passed via the new `DispatchOptions.loopEngine`.
  - `EE_ORCHESTRATOR_ENGINE` becomes an operator pin over that choice (rollback lever). It is unset by default.
  - With no BYOK provider (platform billing, or Telegram turns with no human), the engine of record (`builtin-json`) runs.
  - There is no fallback between engines on failure: a durable failure fails loud.
  - Why per provider and not per company: BYOK credentials are per user, and the engine must match the provider that actually serves the turn. A company-wide flag could put a subscription user on durable, where the gateway fails loud on tools.
- Durable state in local dev needs `EE_AGENT_STATE_DIR` (`.env.example`, playwright webServer env). Without it, a durable dispatch fails loud by design (D2).

**Open / next**
- Not run: e2e (`onboarding-welcome`, `journey-founding` updated to the hand-off), and a real-LLM check of the hand-off wording and marker discipline.
- Boot warm-up (crash-resume) still runs only under the `durable` operator pin. Per-provider durable turns resume lazily on the next durable dispatch.
- A user who switches providers mid-conversation switches engines. Durable history lives in SQLite and builtin-json history in session events, so context does not carry across the switch.
- `openWebsiteFoundingJourney` (`founding.ts`) is now unused by the welcome route. It is kept with its tests; remove it or reuse it.
- Migration number 0088 may collide with parallel branches; renumber at merge.

## 2026-10-19 (5) — SHIPPED: claim link + email set up in the onboarding (no secrets in env)

**Owner directive**: a non-technical user never touches a terminal, env file or config. Keys users bring (email included) are entered in the onboarding and stored in the database. The first person with access to the server becomes the admin, via a private claim link.

**Shipped (`5f8da39`, `56b21f2`)**
- **Claim link**:
  - `ee` mints a random token on first install and stores only its SHA-256 + a 7-day expiry (os secrets `EE_CLAIM_TOKEN_HASH` / `EE_CLAIM_EXPIRES_AT`); the installer prints `https://<console>/claim?token=…` once;
  - `ee claim-link` issues a new link;
  - `/claim`: the holder enters an email and is signed in as the owner immediately, through Better Auth's server-only `createVerificationOTP` + `signInEmailOTP` (no email sent). The claim runs in `claimScope`, so the owner policy knows it.
  - On ee servers only a claim can create the first account; afterwards signup is closed. Signup/login on an unclaimed server say so in plain words.
- **Company email in the database**:
  - `company_mail` (migration `0087` + journal idx 87 + schema), key sealed with a TENANT_MASTER_KEY-derived key;
  - `$lib/server/mail` (`companyMail()`, `companyOwleryEnv()`) replaces every `OWLERY_*` env read (auth codes, notifications, feedback, contact sync, email module);
  - settings are saved only after a real test email reached the owner.
- **Onboarding**: an owner-only `mail` act after the AI-provider act, shown only while company email isn't set up (`POST /api/onboarding/mail`).
- **Passwordless clean-up**: no verification-by-link, no reset mail; `/forgot-password` and `/reset-password` redirect to `/login`.
- **Bug caught by tests**: the notification email's local `env` shadowed the private env, so `ORIGIN` would have been undefined and links broken. Fixed.

**Gates**: unit 4283 passed; svelte-check 0 errors; ee 42 passed.

**On the Docker server, verified end to end in Chromium**:
- signup before the claim → "not claimed yet";
- claim → signed in → onboarding;
- the owner opens Settings → Hosting;
- the reused link is refused for everyone.

The server was then reset clean, with no owner and the link waiting.

**Still open**:
- The mail act is only covered by the API tests; it can't run end to end locally without real Owlery credentials.
- A Settings → Email page to change the settings later (the endpoint exists; no page yet).
- `local-server.sh` output can get lost when piped through long release builds (`ee claim-link` recovers the link).
- The local CA warning stays a local-only step.

## 2026-10-19 (4) — MERGED: durable agent engine (pi-durable), after reviewing another agent's work

**Context**: another agent worked in `../ee-durable` (`wt/durable-engine`) and reported "implementation not started, worktree clean". **That was false.** It had:
- committed `plan/phase-durable.md` on main (`9b3c4d4`);
- committed `63ca241` (dependency pins) and `3655eeb` (gateway tools passthrough) on the branch;
- left ~1,300 uncommitted lines with no tests and 6 real type errors.

The full review is at the top of `plan/durable-findings.md` (moved there from the worktree's `DURABLE-FINDINGS.md`).

**Fixed before merging (`d7d5a25`, merged `28aa892`)**
- **Cross-user tool execution**: tool calls now route by conversation. A call resumed after a restart reports `not_run` instead of executing as someone else.
- **Lock**: async (was blocking the event loop), 30 s handover window, released on a failed open.
- **Boot**: the harness opens and resumes at boot when durable is selected.
- **Type errors** in the gateway passthrough (tool roles leaking into the API-shape adapters) and in the adapter.
- **Orchestrator engine is explicit**: `EE_ORCHESTRATOR_ENGINE=durable|builtin-json`, `builtin-json` the engine of record. The planned "orchestrator flips to durable" would have broken the Claude/ChatGPT subscription sign-ins, which can't carry tool calls.
- **ee (`9a3748d`)**: blue-green slots now share one dynamic user per workload. Verified on the box that concurrent slots got different UIDs and the candidate re-chowned the shared StateDirectory under the serving slot.

**Gates**
- svelte-check 0 errors; unit 4285 passed; ee 40 passed.
- New tests: two users at once (isolation), approval_pending, history, lock contention / stale steal / no event-loop block, and a **real SIGKILL crash-resume** (the child dies mid-model-call; the reopened harness re-runs that turn and keeps its answer).

**On the box**: upgraded, `EE_ORCHESTRATOR_ENGINE=durable`.
- The harness opens at boot, with state at `/var/lib/ee-state/os/agent/agent.sqlite` (0600, user `ee-os`).
- On the next blue-green deploy, slot b took the lock after slot a drained (stale steal logged).
- Migration 0086 is applied.

**Not done**: the D8 visibility surface (SSE + live run UI, multiplayer), e2e on durable, and a chat turn on the box (needs a signed-in owner, so email delivery, plus an OpenAI-compatible provider). The `../ee-durable` worktree is left in place; it holds an untracked `.env` copy.

## 2026-10-19 (3) — SHIPPED: passwordless sign-up and sign-in (Better Auth email OTP)

**Owner directive**: use Better Auth; signup is passwordless: enter only the email, click Create account, and a code is sent to that address.

**Shipped**
- The Better Auth **`emailOTP` plugin** (6 digits, 10 min, 5 attempts). The `sign-in` code type both creates a new account and signs in an existing one; the owner policy still decides who may be created.
- `/signup`: email + terms → **Create account** → code. `/login`: email → **Send code** → code. Shared `auth-code-step.svelte`. No password fields anywhere.
- Delivery (`src/lib/server/auth/deliver-code.ts`) is **email only, via Owlery**:
  - with no mailer configured, production **fails loudly** ("Email delivery is not configured… `ee secret set os OWLERY_*`") and never logs the code;
  - dev prints the code and records it for the Playwright harness (`/api/e2e/harness/sign-in-code`, dev-only).
- e2e helpers (`registerUser`, `loginUser`) are passwordless. `auth.e2e.ts` replaces the forgot-password test with code-flow tests.
- **Gates**:
  - unit: 4262 passed;
  - e2e: onboarding-welcome + auth **13/13** against the dev server;
  - svelte-check: 0 errors.
- `scripts/local-server.sh upgrade` deploys the current code to the local box (health-gated, data kept).

**Decisions / follow-ups**
- Password endpoints stay enabled server-side (existing accounts aren't stranded), but no UI offers them. `/forgot-password` and `/reset-password` are orphaned; delete them once no password accounts are left.
- **An ee server needs email delivery before the first signup**: `ee secret set os OWLERY_API_KEY` / `OWLERY_BASE_URL` / `OWLERY_EMAIL_FROM`.
- CI e2e (`npm run preview`, not dev) has no code harness yet and needs a mail sink; local e2e runs against the dev server and passes.

## 2026-10-19 (2) — SHIPPED (local box): `ee` installs eigenEnterprise on a fresh server; domains, apps and GitHub in Settings → Hosting

**Owner goal**: deploy the first slice to a real VPS, keeping the onboarding exactly as it is; the website module, a GitHub connection and domains in Settings, plus everything else needed.

**Shipped (verified end to end on a fresh Ubuntu 24.04 systemd box, `ee/e2e/box.sh`)**
- **`ee/`**, the company's init (phase-substrate S0–S4 slice), as a standalone TS package bundled into one file:
  - the contract: workload spec, `ee.json` app contract and catalog with `catalog_gap`;
  - hardened unit generation;
  - full Caddy config render and atomic load, with a local CA only for reserved test TLDs;
  - the company repo (git, `ee` the only writer);
  - an AES-GCM secret store;
  - a level-triggered reconciler with blue-green slots, the health gate, keep-old-on-failure and no flapping;
  - the control API on a unix socket;
  - `bootstrap` (Postgres 16 + pgvector/pg_cron/AGE from PGDG, pg_net compiled, Caddy apt);
  - boot-time env rendering (`ee-env.service`);
  - `ee.json` for eigenEnterprise itself; `scripts/release.sh` (linux x64/arm64 tarballs, Docker used as a build tool only);
  - `ee/install.sh` (pinned, checksum-verified Node 22 + `ee`, then bootstrap).
- **Proven on the box**:
  - fresh install → "Your company is running" in **37 s** (fast mirror; no build on the path);
  - reboot → everything returns (env files re-rendered);
  - changing the console host → blue-green redeploy of eigenEnterprise;
  - a git app (fixture) builds in the sandbox, goes live at its domain, and gets a secret;
  - a broken release fails its health gate and the old one keeps serving, reported loudly;
  - the public host serves only the website surface (`/` → `/s/home`; `/login` and `/api/health` 404 at the edge).
- **Browser journey** (`ee/e2e/box-journey.mjs`, Chromium) passes: owner signup → **onboarding boot sequence unchanged** → Settings → Hosting (managed) → add the public website domain → edge allowlist holds → a second signup is refused.
- **eigenEnterprise side**:
  - `/api/health` (DB ping), the health gate;
  - kernel module **`substrate`** (status, domain add/remove, app remove, secret set) and module **`github`**:
    - GitHub App manifest flow, sealed credentials (migration `0085_github_connection` + journal idx 85 + `github.schema.ts`);
    - installation check, repos list, `app_create` / `app_deploy`;
    - `auto_deploy`, run only by the signed webhook's service principal, for apps whose owner opted in;
  - `/settings/hosting` (domains, GitHub, apps, secrets, activity) + a "Hosting" entry in the cog menu;
  - shared `src/lib/server/ee/` (control client, `requireHuman`), so modules stay import-free of each other.

**Decisions / deviations (on record; owner can veto)**
- §8 recommendations implemented as defaults: hosting mutations are **human-only** (D11); Ubuntu 24.04 / Debian 13 only (`ee` refuses others); pre-DNS console host = `<ip>.sslip.io`.
- **Postgres listens on 127.0.0.1 (scram), not a unix socket only.** Client libraries can't agree on a socket+credentials URL (postgres.js ignores `?host=`). CONNECT is revoked from PUBLIC on every database.
- **Apps can reach loopback** (Caddy must reach their ports); binding is confined with `SocketBindAllow=tcp:<port>` instead of D5's `IPAddressDeny=localhost`.
- **Single owner by construction**: the first signup becomes admin. On an ee-managed server (`EE_WORKLOAD` set) signup closes after that (`src/lib/server/auth/owner-policy.ts`).
- `substrate` and `github` are self-seeded **system modules** (like `kernel`).
- **Under ee, `EE_VCS_AUTOCOMMIT=0`** for eigenEnterprise: the release has no `.git`. Server changes are committed by ee in the company repo; kernel_events is the audit trail.
- The release ships full `node_modules` (as the Dockerfile does): migration scripts import dev deps.

**Not yet verified (needs the owner)**: a real VPS with real DNS + Let's Encrypt; the real GitHub App flow (manifest → install → webhook); the founding journey with a real LLM provider. Hosting the release for `curl | sh` (the repo is private) is undecided.

**Owner decision (same day)**: not deploying to a remote VPS yet. "It has to run on this machine": an Ubuntu server emulated in Docker on the Mac. Shipped `scripts/local-server.sh` (up / status / logs / shell / stop / start / reset / ca). It runs the real installer into a systemd Ubuntu 24.04 container (native arm64; amd64 emulation breaks systemd's sandboxing on Apple Silicon). Console at https://os.ee.localhost, ports 80/443 → the box's Caddy, local CA. Installed clean with no owner, so the owner signs up first. A real VPS later uses the same installer with `--console-host <ip>.sslip.io` (owner's choice for the first domain).

**Local limits**: GitHub webhooks can't reach a laptop, so on this machine auto-deploy on push won't fire; "Deploy latest" (outbound fetch) works. Certificates come from the box's local CA (trust it via `local-server.sh ca`).

**Next**: owner signs up on the local server → onboarding → connects GitHub in Settings → Hosting → deploys the CEO's app; then the same on a real VPS.

## 2026-10-19 — PLANNED: phase-substrate — `ee`, the company's init system (architecture decision, no code)

**Owner directives (same session):**
- "If we build this out, I want it to work for everyone, and I want the 'your company is up in 10 minutes' claim to also work with the website the way it is."
- "Can't it be something I curl and install onto the server? Like a Linux package that gets started up with systemd?"
- "What if we don't use Docker?"

Two earlier same-day drafts were superseded: `phase-hosting.md` (a per-app hosting module; deleted) and a Docker-based version of `phase-substrate.md`.

**Finding**: the OS metaphor (company-os §1) has no init and no loader. Five plans depend on "a revision becomes a healthy, routed, supervised process, or nothing changes": wedge install/preview/domain, `repo.merge` (there is no `.git` in the production image, so nothing ever redeploys), module services (Owlery), the software-factory post-merge smoke, and user apps. Design it once.

**Decision log (architecture impact, proposed D1–D17 in phase-substrate §7, D16 owner-decided; owner can veto the rest)**
- `ee` = one curl-installed binary (daemon + CLI) under `ee.service`. systemd is the only supervisor; every workload is a generated, hardened unit; `ee` is not in the data path (`ee` down ≠ sites down).
- **Native only: no Docker daemon and no container runtime.** Deviates from company-os §4.2 ("Docker + Compose"); amend on approval.
- Desired state = the company repo; `ee` is its only writer; every mutating verb is validate → commit → reconcile. Every deploy, rollback and upgrade is a commit.
- **The catalog is the only environment** (phase-substrate §3.3):
  - runtimes: `static` + `node` now; `python` / `binary` / `jvm` later;
  - shared services, one of each: Postgres with each app its own database and login, a Postgres-backed queue + events in the kernel (replacing company-os's Redis/BullMQ), email, files, secrets, edge, schedules;
  - capabilities: `chromium`, `ffmpeg`, `tesseract`, … later.

  Apps declare their needs in `ee.json` (declared, never detected) and reach kernel services as `service` principals through the registry path.
- **D16, owner-decided: a gap is an eigen change.** No app may spin up its own environment: no containers, no app-run datastores (embedded SQLite included), no vendored system programs. A missing entry fails the deploy with `catalog_gap` and lands on the Extension Roadmap; closing it is a catalog release that every company gets. If an app *could* bring its own environment, that's a substrate bug.
- eigenEnterprise and Postgres are packages; `ee upgrade` is a health-gated blue-green deploy. First-party modules stay compiled in (phase-0 holds); all others are out-of-process workloads whose tools the registry proxies. This dissolves the fork-vs-image question: core is never modified on a server, and core improvements go upstream.
- The website stays as it is; the edge splits the public host (public surface only) from the console host. No container and no build on the 10-minute path.

**Owner decisions open (§8):** human-only approvals for system tier / first deploys / auto-deploy (reverses `a8b11c0` for this area); Ubuntu 24.04 + Debian 13 only; the pre-DNS hostname; the expand/contract migration guardrail.

**Found while planning**: `docker-compose.yaml` publishes db/app/studio on all interfaces (Docker bypasses UFW) and defaults the Postgres password to `eigen`. Under D9 compose becomes dev-only.

**Accepted trade-off (on record):** software that brings its own database engine (WordPress + MySQL, Plausible + ClickHouse) doesn't run on eigen until eigen provides that service for everyone.

**Next**: owner answers §8 → S0 (the shared spec, the app contract + catalog manifest, the hardened unit template, the vendored-program decision). Other plans are amended only after approval (§13).

## 2026-10-15 (3) — the eigen chrome is DEAD: one cog, every route

**Owner directive (verbatim)**: "/settings … the menu on the top right changes and the header
changes also. It shows the header of eigenmesh, which is a completely separate project, and
should be deleted in all routes… Eigen mesh as a module can stay, but the design for all
routes eigenenterprise has to offer are not the right ones, and I want you to delete them."
— This is the "when" the de-branding round (2026-09-22) was waiting for: the seed-derived
shell goes, the module functionality stays.

**Deleted completely**
- `app-header.svelte` (+ spec) — the eigen wordmark header with its account menu, admin/eval/
  feedback links, blur gradient stack — rendered by the root layout on every non-nucleus,
  non-auth route.
- The root layout's mobile **bottom nav** (Memory/Capture/Chat black-pill nav + gradient
  masks) and its `bottomNavItems`/`isNavItemActive` machinery, `pb-28` chrome padding.
- `eigen-wordmark.svelte` (+ spec) and **`logo-whole.svg`** (eigen's logo asset) — gone from
  the repo. The auth pages (login/signup/forgot/reset) and `+error.svelte` now carry a
  typographic "Eigen Enterprise" wordmark instead of the logo image.
- `current-user-view-select.svelte` — lived only in the deleted header (the author-view STORE
  stays; memory surfaces still consume it).

**What replaces the chrome**: one settings cog, top right, on every app route — the SAME
`home-settings-menu` (Company Settings / Extensions / API Keys / AI provider / sound + voice /
Restart onboarding / Sign out) the homepage already had, now rendered by the root layout for
non-nucleus, non-auth, non-public routes. No header, no nav, no logo anywhere; the nucleus
group and `/s/[slug]` stay chrome-free. Verified visually: `/settings`, the open menu, and `/`
carry exactly one cog and zero eigen furniture.

**Broke / fixed along the way**
- `release-helpers.ts` toured the dead chrome (Account menu links, the stale Workspace/
  Capture/Ask AI bottom nav) — rewritten against the cog menu, sign-out through the menu's
  Sign out button.
- **playwright `workers: 1`, deliberate**: suites share singletons — `kernel_journeys` admits
  ONE active row per kind company-wide, the mock gateway is one process with a global call
  counter. Concurrent workers fight over both (the documented flake class: the stale-v1 test
  failed twice in parallel multi-file runs, never serially). Serial is slower; deterministic.
- extension-roadmap's cog walk needed the boot wizard's retry-until-open discipline (SSR
  clicks before hydration attach handlers).

**Not deleted (deliberate, flagged)**: page CONTENT styling that references the old palette
(`--color-eigen-green` in memory surfaces, timeline views, author-layer chrome) — that is the
memory/timeline feature content wearing an old accent, not the chrome; a content-design pass
is owner-gated follow-up work. The favicon is still eigen-derived artwork (same class as the
logo was). Unused paraglide `nav_*` message keys remain in the catalogs (harmless).

**Gates: unit 4240 passed / 14 skipped; components 41 passed; svelte-check 0 errors (29
baseline warnings); eslint clean on touched files; serial controlled-env e2e 8/8
(extension-roadmap 2 + onboarding-welcome 3 + journey-founding 3).**

**Decisions (log)**
- The settings cog is THE chrome: the owner's menu design (company settings, sign out,
  extensions in a top-right menu) applies to every route; no second navigation surface exists.
- Chrome deletion ≠ content redesign: memory/graph/capture/timeline internals keep their
  current look until the owner orders the pass.

## 2026-10-15 (2) — SHIPPED: the Extension Roadmap — the company's build log, queue, and plan, visible to humans AND the agent

**Owner directive (verbatim intent)**: "I need a way to see what you did, what you changed,
what you fixed, what's on the roadmap… a kind of queue… it should live in the settings under
extensions… name the setting extension roadmap… a visual way to see what was done and what's
going to be implemented… down the line I want the agent to be able to build itself, so the
agent should have access to this build log."

**Shipped** (`f50762f` merged to main, wt/extension-roadmap; subagent-implemented, orchestrator
reviewed + integrated)
- **Kernel module `roadmap`** — `roadmap.list_items` (read) / `roadmap.add_item` /
  `roadmap.update_item` (mutate, no approval gate — internal company data), zod-validated,
  registry-audited, roles admin+agent. The agent connection is structural, not a shim:
  the module is in the orchestrator persona's module list, and with `roadmap` active its
  tools ride the existing tool-surface filter (scope 'all') — the agent can read and maintain
  the roadmap in chat TODAY, and the software-factory loop (phase-software-factory.md) gets
  its queue surface for free.
- **Migration `0084_extension_roadmap.sql`** (+ journal idx 84, + `roadmap.schema.ts`):
  `extension_roadmap_items` (status shipped/in_progress/planned, kind feature/fix/chore,
  position, `shipped_at` stamped by the store on entering 'shipped' and cleared on leaving)
  + 15 seed rows: the shipped build log (kernel, memory, brand pipeline, boot-sequence
  onboarding, founding journey, journey hardening, gateway voice, agent hands), the queue
  (live journey verification), and the plan (one-command deploy, software factory M0,
  conversation-driven website editing, company templates, voice provider wiring, build log
  from kernel events).
- **`/settings/extensions` — "Extension Roadmap"**: read-only board (Shipped with dates /
  In the queue / Planned), monochrome, honest empty sections, deliberately NO add/edit UI —
  content is maintained through the kernel tools (agent + CLI), the page only mirrors.
- **Top-right settings menu restructured**: Company Settings / Extensions / API Keys /
  AI provider ‖ sound + voice toggles ‖ Restart onboarding + **Sign out** (new). All
  e2e-pinned testids preserved. `/settings` gained an Extensions row.
- **e2e `extension-roadmap.e2e.ts` (2/2)**: the cog names Extensions; the board renders the
  seeds in their sections; deep-link works.

**Gates: full unit 4240 passed / 14 skipped (568 files; +24 over baseline); svelte-check 0
errors (29 baseline warnings); eslint clean on all touched files; controlled-env e2e:
onboarding-welcome 3/3 + journey-founding 3/3 + extension-roadmap 2/2 (both file orders).**
Migration applied to the dev DB; `roadmap` module activated there.

**Broke / flags**
- **`npm run ee` is BROKEN on main (pre-existing, NOT this round)**: `tsx src/cli/index.ts`
  dies on `ERR_MODULE_NOT_FOUND: $env` — the CLI's import chain reaches
  `src/lib/server/env/private-env.ts`, which imports the SvelteKit virtual
  `$env/dynamic/private`, unresolvable under plain tsx. Needs a decision (vite-node runner vs
  an env seam private-env can use without the virtual import). Module activation in the dev
  DB used the documented deployer SQL path in the meantime.
- The home-settings-menu spec previously ran in NO gate at all (excluded from the node
  config, absent from the browser include list) — enrolled in `vitest.browser.config.ts`;
  it now actually pins the menu.
- The journey-founding stale-v1 test showed one transient failure across five green runs —
  same class as the documented SSR-hydration click race; both file orders green otherwise.

**Decisions (log)**
- Roadmap UI is read-only v0; the AGENT (and `ee`/registry consumers) maintain content —
  the owner's "agent has access to the build log" is the module boundary, not a UI form.
- Seeds live in the migration (visible, reviewable, tool-editable afterwards), not a hidden
  bootstrap seed.

**Next**: owner opens the cog → Extensions and sees the board; the software-factory M0 open
questions (ticket source, first proof ticket, merge policy) are now THE next owner decisions —
the roadmap surface it would feed is live.

## 2026-10-15 — the 10-14 fixes VERIFIED LIVE; the journey e2e exists; the voice e2e re-pinned to the gateway

**How the owner report was reproduced**: the 2026-09-10 stale row (pre-versioning, mid-interview)
was ACTIVE in the dev DB when this session started — the exact reported state.

**Verified live, three ways**
- **The owner's own dev DB verified the stale-abandon first**: by the time this session looked,
  the 2026-09-10 row had already abandoned itself (`status='abandoned'`, `journey.abandoned`
  reason `spec_version` on the audit log) after the owner said "hi", and a fresh empty v2
  journey sat in its place (opened by the boot handoff). The fix fired in real use.
- **New e2e `src/routes/e2e/journey-founding.e2e.ts` (3/3, twice, ~24s)** against a real
  browser + real server + a DISPOSABLE database (`eigen_journey_verify` on the dev cluster,
  full bootstrap: migrate → ensure-extensions → ensure-app-role → apply-rls → activation
  seeds): (1) a v1-shaped active row abandons itself on "hi" — no duplicate-slug, no interview
  question, plain orchestrator answers, `journey.abandoned` reason `spec_version` audited;
  (2) a retried turn with pages already on disk LEDGERS them through the `alreadyApplied`
  probes (4 creates + the already-public home publish recorded `executed` WITHOUT re-running),
  the about publish actually runs and lands `approval_pending` (gate halts its step; the tone
  step's brand-doc create still executes — per-step halt, asserted); journey stays active.
  (3) `/api/tts` contract: 401 anon, 400 empty/oversized, and a speech-less gateway surfaces
  its provider error as a loud 500 (mock 404 verbatim in the error body).
- **onboarding-welcome e2e 3/3** in the controlled env — after re-pinning the voice contract
  (see below).

**Broke / caught by verifying**
- **The boot-sequence e2e still pinned the ROBOT voice** — the 10-14 TTS switch (browser
  speechSynthesis → gateway) was never re-run against it. Re-pinned to the new truth:
  `/api/tts` intercept captures the greeting text the client sends to the gateway, and the
  speechSynthesis recorder must stay EMPTY forever. Robot voice is now e2e-pinned-dead.
- **INCIDENT (fixed, on the record)**: the first verification runs' spec-side SQL went to the
  WRONG database — playwright.config.ts loads .env with `override: true`, so a generic
  `DATABASE_URL` env is silently repointed at the .env database while the server under test
  used another. Consequence: the owner's fresh v2 journey row got a fabricated state written
  over it and two stray pages (`about`/`contact`, body `Already here.`) landed in the dev DB.
  REMEDIATED to the exact pre-incident state (journey state restored to the
  `openWebsiteFoundingJourney` initial shape with the correct `onboarding:<userId>` sessionId;
  stray pages deleted; owner's `home`/`brand-tone-of-voice` untouched). GUARD: the new e2e
  takes `E2E_JOURNEY_DATABASE_URL` (name deliberately outside .env's reach), throws if it
  equals `DATABASE_URL`, skips loudly when unset, and resets journey/page rows itself.
- **Kernel VCS auto-commit fired mid-verification**: the create_page artifact's
  `git commit -am` landed the WIP as `tool website.create_page by orchestrator` — amended
  into this commit with the proper message (unpushed; same pattern as the pre-existing
  `cafbe2e` kernel commit).
- One pre-existing flake re-observed (not this change): onboarding-welcome's skip test clicked
  before hydration once (documented SSR-click race) — passed on rerun.

**Live-provider voice finding**: OpenRouter's API answers `/audio/speech` with 401
("Missing Authentication header") for the configured service identity — the public OpenRouter
API does not serve TTS for it. Live audio needs a speech-capable OpenAI-compatible gateway
(`LLM_MODEL_TTS`/`LLM_TTS_VOICE` or a BYOK provider with the route); until then the assistant
correctly stays silent (verified).

**Gates: unit 4216 passed / 14 skipped (566 files); svelte-check 0 errors (29 baseline
warnings); eslint clean on touched files; journey-founding 3/3 ×2; onboarding-welcome 3/3.**

**Decisions (log)**
- The journey e2e runs against a disposable DB by design (kernel_journeys admits ONE active
  row per kind company-wide; the spec resets rows — shared-DB runs are what the guard
  refuses).
- Fixture expectations follow observed product semantics, not the old docstring: the artifact
  gate halts its STEP; later steps still process (brand-doc create executed after the about
  publish went `approval_pending`). Docstring vs behavior divergence flagged for a follow-up
  either-way pin.

**Next**: the Extension Roadmap (settings → Extensions; build log + queue + planned; kernel
module so the agent reads it through its tool surface) — owner-directed this session.

## 2026-10-14 (2) — journey spec versioning: stale interviews can no longer speak through chat; orchestrator posture

**Owner report (verbatim)**: "The Eigenenterprise chat asks me things that seem like they are
part of one of the modules… the general chat should take more like an orchestrator role. It
shouldn't ask things like 'Now, on to the next step.' It should say: here's what we can do,
those are the modules… route the user there."

**Root cause**: the stale 2026-09-10 `website_founding` row (pre-phase-2e spec shape,
`positioning` never captured → never completable) was still ACTIVE — every chat turn had the
journey context block prepended, instructing the agent to ask the next step's question. The
chat never decided to interview; the journey driver did.

**Shipped**
- **JourneySpec.specVersion (kernel)**: `playbook.ts` specs carry a version; stored state
  stamps it at creation; `isStaleJourney()` flags rows whose version drifted (pre-versioning
  rows count as stale). `JourneyAwareAgentRuntime` abandons stale rows on first touch — status
  'abandoned', `journey.abandoned` event (reason 'spec_version', first emitter of the modeled
  event) — and answers as the PLAIN orchestrator: no journey context, no artifact runs.
  WEBSITE_FOUNDING_JOURNEY is specVersion 2; founding onboarding stamps it on create and
  re-stamps reused rows on resubmission.
- **Orchestrator posture (persona)**: "you route, you do not interview" — mission control, not
  a questionnaire; name the modules (memory, website, brand, email, repo, chat-gateway, recap)
  and what they do; hand off to the module's surface or tools instead of running its intake in
  chat; answer module-less requests directly.

**Gates: unit 4216 passed / 14 skipped; svelte-check 0 errors; eslint clean on touched files.**

**Decisions (log)**
- Version drift = abandon, never migrate: a superseded interview's answers are founder data,
  but driving it forward under a spec it never consented to is worse; a fresh founding
  submission (wizard restart) starts clean under the current version.
- The persona change is prompt-text only — the deterministic guarantees (journeys opened only
  by onboarding, stale rows abandoned in code) stay structural, per "code owns the agenda".

**Next**: owner reloads and says "hi" — the stale row abandons itself, the chat answers as the
orchestrator. Restart onboarding from the settings cog to redo the founding interview under v2.

## 2026-10-14 — FIX: duplicate-slug error on every journey turn; the assistant's voice moves to gateway TTS (qwen)

**Owner report (verbatim)**: "Error: duplicate website slug: brand-tone-of-voice — when i type
hi. this is not correct. also, when i start or restart the onboarding it uses a mechanical robot
sounding voice. please use qwen asr"

**Shipped**
- **Journey artifacts are idempotent (already-applied probes).** `JourneyArtifact` gains an
  optional `alreadyApplied` probe (pure read through the registry — never error sniffing);
  `executeStepArtifacts` records a probed artifact 'executed' WITHOUT re-running it. The
  founding spec probes `website.list_pages`: a create whose slug exists and a publish whose page
  already sits at the target visibility are ledger-recorded, not re-run. Root cause of the
  report: the legacy `website_founding` row (2026-09-10, pre-phase-2e spec shape) had the
  `brand-tone-of-voice` page in the DB but no 'executed' ledger entry under the CURRENT spec —
  so EVERY chat turn (e.g. "hi") re-ran `website.create_page` and failed loud with duplicate
  slug. Superseded pins rewritten deliberately: founding re-submission over existing pages is
  now idempotent completion (no throw), and chat retries succeed while publishes stay gated.
- **The assistant's voice = gateway TTS.** `llmCreateSpeech` in the LLM gateway
  (`POST {baseUrl}/audio/speech`, OpenAI-compatible, 3-attempt retry, activity-logged, STT
  billing config reused) + `src/lib/server/llm/tts-client.ts` (default
  `qwen/qwen3-tts-flash-2026-02-10`, voice `alloy`; `LLM_MODEL_TTS`/`LLM_TTS_VOICE` overrides,
  documented in .env.example) + `POST /api/tts` (auth 401, empty/>4000-char 400, returns
  audio/mpeg bytes, provider error mapped to 500). `src/lib/speech/tts.ts` no longer touches
  browser speechSynthesis AT ALL: it fetches `/api/tts`, plays the blob, cancels via
  AbortController; a failing gateway means SILENCE (console-warned), never a robot fallback.

**Note on the request wording**: the robot voice was browser speechSynthesis OUTPUT (TTS), not
ASR — ASR (input) was already qwen (`qwen3-asr-flash`, `stt-client.ts`). Implemented as gateway
TTS with the qwen default, mirroring the STT seam.

**Gates: unit 4214 passed / 14 skipped (566 files); svelte-check 0 errors (29 baseline
warnings); eslint clean on touched files.**

**Decisions (log)**
- Idempotency is a SPEC-declared probe, not a catch of duplicate errors — error-string sniffing
  is forbidden (no string heuristics); the probe is a deterministic registry read.
- Voice-off semantics unchanged (`ee-voice` toggle); "gateway unavailable" now joins
  "browser unsupported" as the honest silent state.

**Next**: owner verifies live — restart onboarding or type "hi": no duplicate-slug error, and
the boot-sequence voice comes from the gateway (requires an OpenRouter-compatible provider that
serves `/audio/speech`; the provider's exact error surfaces in the server log otherwise).

## 2026-09-22 — Eigen Enterprise de-branded from ../eigen (eigenmesh); settings rebuilt minimal

**Owner directive (verbatim)**: "immediately remove all ui that was taken from ../eigen from this
repo. eigen-enterprise is a completely separate project. reusing eigenmesh (the name of the
../eigen) project was outright wrong! fix your mistake" — scoped via questionnaire: settings
page rebuilt minimal + repo-wide naming scrub; other seed-derived pages stay for now (APIs
always stay).

**Shipped**
- **`/settings` rebuilt minimal**: only Account (email + password + sign out), AI provider
  (live status + link to /settings/llm), API keys (link to /api-keys). The eigen feature tabs
  (appearance/theme, speech/haptics, notifications/push, memory tools incl. export + delete-all,
  danger zone, graph rearrange) are gone from the page — their SERVER APIs are untouched.
  Page server trimmed to `load {user, providerReady}` + `changeEmail`/`changePassword`; the
  eigen `resetOnboarding`/language/locale actions removed (spec pins exact action keys).
- **Settings sub-routes** `/settings/agents` (webhooks) + `/settings/scheduled-tasks` (heartbeat):
  UI replaced with minimal placeholders linking back; their page-server loads + APIs untouched.
- **Repo-wide 'Eigen Mesh'/eigenmesh scrub (0 grep hits across src/, messages/, static/,
  .env.example)**: layout title, wordmark alts, chat/capture/feedback copy, i18n placeholders
  (en+de), webhook + push test payloads, storage-key prefix `eigenmesh:` → `eigenenterprise:`,
  schema comments, .env.example examples, LLM prompt examples (neutral examples, same shape).
  31 spec files' fixtures swapped symmetrically ('Website Relaunch'/'Archive Scan' as neutral
  labels — one ordering assertion needed a label that preserves the original sort semantics).
- **Behavioral de-branding (decisions)**: feedback inbox no longer `feedback@eigenmesh.xyz` —
  now env-overridable (`FEEDBACK_INBOX_EMAIL`) with placeholder default
  `feedback@eigenenterprise.example` (owner must set a real address for feedback delivery);
  subject `[Eigen Enterprise]`. Legal links no longer default to eigenmesh.xyz —
  `DEFAULT_WEBSITE_ORIGIN` is a placeholder (`eigenenterprise.example`), real legal pages need
  `PUBLIC_WEBSITE_ORIGIN`.

**Gates: unit 561 files / 4184 green; svelte-check 0 errors; components 34 green; e2e
onboarding-welcome 4/4, onboarding-provider 6/6 (incl. rewritten 'wizard never comes back'),
auth 9/10 (owlery placeholder env, pre-existing); contract grep 0.**

**Broke / flags**
- **Auditor rework round (addressed)**: first scrub missed live residuals outside src/ —
  `docker-compose.yaml` Traefik rule routed Drizzle Studio at `studio.eigenmesh.xyz` (now
  `studio.your-domain.example` placeholder — owner sets the real domain), plus identity in
  company-os memory module/README, evals graph-scale corpus + seed-guard, modules/email spec
  fixtures. All scrubbed; git grep over tracked files (excl. plan/docs/.pi history) = 0.
- **Stale generated artifacts regenerated**: `src/paraglide` compiled messages and the `build/`
  output predated the scrub and still served "Eigen Mesh" strings — `npm run build` regenerates
  both; artifact grep now 0 (paraglide + build).
- The e2e 'wizard never comes back' test drove the removed eigen resetOnboarding form —
  rewritten to pin the new truth (wizard only returns via the settings cog restart).
- Storage-key rename means previously-dismissed first-capture nudges re-show once (cosmetic).
- Logo ASSETS are still eigen's (`logo-whole.svg`); alt text says Eigen Enterprise. New logo
  artwork is a design task, not a naming task — flagged.
- Feedback delivery + legal links + studio domain need owner-supplied domains (see decisions) —
  placeholders are loud, not fake-working.
- **Scope boundary (deliberate)**: `plan/`, `docs/`, `.pi` skill docs retain historical
  eigenmesh mentions — they are internal records, not live code/UI/config; `.env` untouched
  (data-safety rule, untracked owner data).

**Next**: owner decision on the real feedback inbox + website origin; new logo assets; the
remaining seed-derived pages (memory, graph, capture, chat page, brand studio) await the same
treatment when the owner says when.

## 2026-09-22 — Onboarding owns the founding interview; homepage settings cog

**Owner report (verbatim)**: chat asked "which three words should describe your company's tone of
voice?" in response to "what api are you using?" — "this is wrong and should be part of the
onboarding. and we need a settings cogscrew icon on the homepage where we have the option to set
api keys, change settings and restart onboarding etc"

**Shipped**
- **Chat can no longer ask onboarding questions.** The orchestrator persona's proactive journey
  seed ("ask this question, word for word" when a request looks founding-shaped) is gone — that
  LLM judgment is what leaked the tone-of-voice question into ordinary chat. Journeys are now
  opened ONLY by onboarding; `JourneyAwareAgentRuntime` is a pure passthrough with no active
  journey (regression-pinned in brain.spec / brain.journey.spec / agent-journey-contract.spec).
  `JourneySpec.openingQuestion` removed from the kernel primitive (dead protocol marker).
- **Founding interview moved into the welcome wizard** (new step 4 of 5, "Tell me about your
  company."): tone (3 words) / company name / one-sentence positioning. Blank = skip, nothing
  recorded. `POST /api/onboarding/founding` records the answers as a fully-captured
  website-founding journey and executes its artifacts through the kernel registry
  (`executeStepArtifacts` — extracted from the driver, shared semantics): creates brand doc +
  home/about/contact skeletons; publishes hit the owner-approval gate → 'approval_pending',
  journey stays active and retries on later chat turns (unchanged driver behavior). Re-submit
  overwrites answers and retries gated publishes; a completed founding → 409 ("already exists,
  ask the assistant") via a deterministic list_pages pre-check (no error-string sniffing).
- **Homepage settings cog** (`home-settings-menu.svelte`, always rendered in every homepage
  state — chat, wizard, provider gate): API Keys → /api-keys, AI provider → /settings/llm,
  Settings → /settings, and **Restart onboarding** → new `POST /api/onboarding/welcome/reset`
  (clears `welcomeCompletedAt`) + invalidateAll → the wizard takes over the homepage again.

**Gates: unit 561 files / 4180 tests green; svelte-check 0 errors; components 34 green
(incl. 11 wizard + 4 menu); e2e onboarding-welcome 4/4 (new cog-restart journey),
onboarding-provider 6/6 (clean port), auth 9/10.**

**Broke / flags**
- **Pre-existing e2e flake (not this change):** `scripts/mock-gateway.mjs` sometimes survives
  playwright's cleanup; the next run's `reuseExistingServer: true` reuses the stale process and
  server-side fetches 502 (copilot/start). Reproduced F/P/F/P; with a clean :5199 between runs:
  3/3 green. Fix candidate: `reuseExistingServer: false` for the gateway webServer (or SIGTERM
  handling in the script).
- auth.e2e reset-email test fails in this dev env: `.env` has `OWLERY_BASE_URL=https://YOUR_HOST`
  (placeholder, unreachable) — environmental, untouched here.
- Founding re-submission after pages exist cannot rewrite page CONTENT (create_page fails loud on
  duplicate slugs by design) — content edits go through the chat (`website.update_page`). The
  wizard's honest copy: pages are drafted, publishing waits for approval.

**Decisions**
- Onboarding captures the interview as a FORM (one step, three fields), not a chat conversation —
  the wizard is a form surface; conversational one-at-a-time belongs to chat, which must never
  ask these questions again.
- Journeys opened by onboarding stay visible to the chat driver: pending publishes retry on chat
  turns and surface the approval card — no second execution path.
- AppBoot now exposes `journeys` (composition root owns wiring; endpoints never build stores).

**Next**: conversation-driven edits for the founded pages (rename/tone updates via chat using
website.update_page), and the mock-gateway e2e cleanup fix above.

## 2026-09-22 — "YOU DO IT YOURSELF" — the ready-proof executed live, end to end, by the agent

**Owner directive (verbatim)**: "there is no npm run co -- doctor. you do it yourself." —
I had built the verification tooling and then handed the running of it back to the owner.
Wrong direction. This milestone: make it work from where the owner actually is (repo root)
and run every step myself.

**Shipped**
- **`npm run co -- doctor` now exists at the repo root** (root package.json script
  delegates into company-os). Doctor upgraded: LLM check queries the founder's DATABASE
  (the terminal path now resolves stored credentials first — no env duplication), not env.
- **Terminal chat is a first-class founder path**: `co chat` resolves credentials exactly
  like the browser (stored DB config first, env second), loads .env read-only (the CLI
  never did — `npm run chat` was a dead path), and turns run through a strict promise
  tail (piped input arrives faster than turns complete; close waits for the last turn).
- **Live execution, by me**: brought the owner's stored provider URL (localhost:5155 — a
  dead leftover) alive with the scripted gateway, resumed the ACTUAL leftover session in
  the dev database ("You were setting up Hafenlicht — where were we?"), answered the
  remaining 7 questions through the real CLI → render → reveal → ownership pointer →
  **verified the artifact**: v0.1 committed (4 files, provenance), `/site` 200 on the
  production build, real-browser screenshot inspected — monogram, German typographic
  handmade site, every sentence traceable to the answers I gave.
- **4 more issues caught by actually running it**:
  1. `?raw` imports are a Vite convention — plain-node (the CLI) rejects them. Fix:
     manifest + theme are typed runtime constants; module.json/theme.css stay as the
     human-editable artifacts, pinned to the constants by a sync test (which caught a
     real drift on its first run).
  2. The CLI never loaded .env — fixed with a read-only shared loader (chat, doctor,
     harness all use one implementation; real env always wins; the .env FILE is never
     written — data-safety rule respected).
  3. The CLI's exit raced piped turns ("Saved." printed mid-render) — promise tail.
  4. The harness now refuses a busy port LOUDLY: a stale server answering on 5178 made
     every smoke assertion lie (it interrogated the WRONG server — the dev one). Port
     pre-check names the culprit instead of asserting against a stranger.

**Gates: 113 unit, tsc, svelte-check, production build — green; SMOKE PASS; E2E 4/4 PASS;
plus one LIVE terminal journey against the owner's real dev database and stored provider
URL, artifact verified in a real browser.**

**Decisions (log)**
- Data-safety rule held: `.env` untouched. My live run used inline env; the ONE line the
  owner may want to add themselves (shown, not applied):
  `COMPANY_OS_SITES_DIR=/absolute/path` in `company-os/.env`.
- The owner's stored provider config points at a dead mock (localhost:5155) — I brought
  THAT alive rather than overwriting founder data. Consequence, stated honestly: a
  real-MODEL conversation still needs their real key via the guided setup (M8 eval).
- Test residue (one open session, one memory row) was LEFT in place and used: resuming a
  real half-interview is a stronger test than a fresh one, and it's the wedge's actual
  promise ("nothing is lost, ever").

**Next**: M4 — the iteration loop (conversation-driven edits, ~3-iteration cap, park-it
offer). When the owner drops a real key into the guided setup, the same one-command
verification exercises the real model.

---
## 2026-09-22 — E2E HARNESS + `co` CLI SHIPPED — "ready" now means proven in a real browser

**Owner directive (verbatim)**: "what happened a lot of times now is that you are telling me
that it's ready and that I then open the dev server and look at the page and nothing works."
— "I want you to be able to test the work you did and evaluate the work you did." Plan:
`plan/company-os-e2e.md`.

**Shipped**
- **`npm run co <command>`** — one CLI to interact with and verify the tool:
  `doctor` (checks every dependency, prints the exact fix — correctly reports this
  machine's missing SITES_DIR/LLM env), `chat` (founder conversation in the terminal,
  now wired with the website module + prints the ownership pointer after the render),
  `smoke` (headless E2E), `e2e` (browser journeys).
- **E2E stack harness** (`company-os/e2e/harness.ts`): the REAL product — production
  build (adapter-node), real Postgres (disposable `company_os_e2e` database, recreated
  per run), real git (temp sites dir), real HTTP — against a wire-compatible SCRIPTED
  LLM gateway (`e2e/mock-llm.ts`, OpenAI SSE with split tool-call chunks; a scripted
  401 mode for the wrong-key journey; a model call that outlives the script fails loud
  with the request summary).
- **Smoke journey** (`e2e/smoke.ts`): drives exactly what the UI drives — setup gate →
  guided provider setup → the 8-turn interview (one answer per turn, agenda key
  asserted each turn) → render in the final turn → reveal → `/site` serves the
  committed artifact → the v0.1 commit with `content.json` provenance and a clean tree.
  13 scripted model calls, seconds-fast, deterministic.
- **4 browser journeys** (`e2e/journey.spec.ts`, Playwright in company-os, headed by
  default / `E2E_HEADLESS=1`): **J1** the wedge journey (setup → interview typed into
  the real chatbox → reveal → `/site` headline/lang/monogram → git v0.1 + provenance);
  **J2a** wrong key → the provider's exact 401 surfaces, nothing saved;
  **J2b** audit rejection → nothing published, founder told honestly;
  **J3** reload mid-interview → "You were setting up … — where were we?" → continue →
  render. All 4 green in ~8s.

**Gates: 111 unit, tsc, svelte-check, production build — all green; SMOKE PASS; E2E 4/4 PASS.**

**REAL BUGS THE HARNESS CAUGHT ON ITS FIRST RUNS (the whole point):**
1. **`render_website` was broken in the production build** — `import.meta.dirname` dies
   in the bundled server (`build/server/chunks/chunks/theme.css` ENOENT). Dev worked,
   prod didn't — the exact class the owner complained about. Fix: manifest + theme
   ship inside the bundle via `?raw` imports; no runtime fs reads.
2. **The drift guard punished the render turn** — turn-start agenda demanded the
   site.language question while the model correctly saved it AND rendered in the same
   turn; the correction loop then burned a second attempt and failed loud. Fix:
   satisfaction is judged against LIVE state recomputed from memory.
3. **Company identity mismatch** — the render record stored the founder's raw sentence
   while the directory keyed off the audited draft name; `/site` 404'd on a healthy
   render. Fix: directory, record and rendered site all use the audited name.
4. **Product gap**: the UI dropped `companyName` from the resume bootstrap — the
   "You were setting up …" promise (P1, "nothing is lost, ever") was never rendered.
   Fixed; J3 asserts it.
5. Infra lesson: `spawnSync` in the e2e wrapper froze the event loop the mock gateway
   lives in — every journey hung at loadScript. Async spawn; documented in code.

**Decisions (log)**
- Only the LLM is fake; everything else is production. Real-LLM runs are M8's eval
  (owner key, human-judged), not an automated gate.
- Test ports/db are fixtures with defaults (5177/5178, `company_os_e2e`); PRODUCT envs
  keep failing loud — the server under test gets NO `COMPANY_OS_LLM_*` so the guided
  setup path is what's actually exercised.
- The mock reprograms per journey via `POST /__script`; DB reset is a direct TRUNCATE
  from the test side — no test routes in product code.
- **Binding definition of done** (recorded in company-os/README.md): no company-os
  change ships without `co smoke` green, plus `co e2e` when the UI flow changed;
  results quoted in progress.md.

**Next**: owner runs `npm run co -- doctor` and adds the two missing env lines it
prints; then a live first conversation (their key) — that lands in M8 territory. Then
**M4** (iteration loop) per `plan/phase-wedge.md`.

---
## 2026-09-22 — company-os M3 SHIPPED — the website module + first render (P2/P3, the reveal) (`b29266b`)

The interview finally ends somewhere. `ready_to_render` used to dead-end ("the website
build comes next" — nothing built it); now the wedge's actual product moment works:
describe your company → the site is drafted, audited, rendered and committed → revealed at
`/site`.

**Shipped**
- **`modules/website/`** — the first module, weekend-shippable bar: `module.json` is a
  load-bearing contract (code validates section types/schema/tools against it, not
  decoration); `copy.ts` drafts site copy from the founder's answers ONLY (every section
  must cite its source answer keys — unanswered keys are rejected) and then runs the
  **W5 hard filter**: a second LLM pass judges MEANING (no string heuristics) and rejects
  sentences stating prices/legal claims/certifications/numbers the founder never gave —
  a rejected audit commits NOTHING; `template.ts` is a pure content→HTML renderer in the
  typographic "handmade" register (system serif stack, warm paper, hairline rules,
  monogram fallback from the company name, language-aware, everything HTML-escaped,
  byte-deterministic so commits don't churn); `theme.css` is the founder-editable token
  surface.
- **`site-store.ts`** — the generated site is a git repo from the FIRST render (W4:
  "even version 0.1 is committed"): `git init` on first render, one commit per render
  (`render: v0.1 …`, versions bump 0.1→0.2→…), commit identity provided by the store so
  the artifact never depends on host git config. `COMPANY_OS_SITES_DIR` required, fails
  loud at call time (W3 convention — same as LLM config).
- **The process ends somewhere**: `plan.ts` gains the `rendered` phase, derived from a
  `render` entry in company memory (never persisted as state — resume stays exact).
  `ready_to_render` now demands the `render_website` tool call: a turn ending without it
  gets ONE bounded correction, then loud drift failure (same discipline as the question
  agenda). Questions are structurally impossible post-interview (both post-interview
  phases refuse at the tool door). Without `COMPANY_OS_SITES_DIR` wired, the render turn
  fails loud BEFORE the model is invoked — misconfiguration can't burn tokens.
- **`/site`** — the reveal surface serves exactly the committed `index.html` (the founder
  sees the artifact, not a re-render). Honest 404 ("never been rendered") vs loud 500.
- **`/api/turn` streams live** — events now go out as they happen (new `onEvent` seam on
  `runTurn`/`openSession`), so the render's progress lines arrive during the build, not
  after it. The CLI keeps its existing buffered path.

**Gates: 111 vitest passed (17 files; PG suites skip without test DB as before), tsc
clean, svelte-check 0 errors, production build green. Rendered output visually inspected
(Fotostudio smoke: monogram, de lang, sections, mailto CTA, minimal footer).**

**Decisions (log)**
- The site repo IS the website: `index.html` is self-contained (tokens inlined from
  `theme.css`, also committed alongside `content.json` with per-section provenance).
  Deploy later = serve the repo; no renderer needed at the edge.
- The CTA action (`mailto`/url/tel) is only emitted when the founder literally gave the
  address/number — the audit pass verifies; otherwise the CTA renders text-only. An
  invented email would be fabrication.
- `content.json` ships in the site repo: provenance (section → answer keys) travels with
  the copy. "100% traceable" is inspectable, not asserted.
- vitest/tsconfig now include `modules/**` (child tsconfig `include` overrides the
  generated kit list — mirrored the needed entries; svelte-check verifies).

**Broke / lessons**: FakeClient must be shared between the conversation loop and the
website tool deps — the draft/audit calls consume scripted turns from the SAME client, so
the tool deps get the conversation's client, not a fresh one. Seeding memory after
`openSession` is the correct resume semantic in specs (memory is the substrate); seeding
before open changes which turn consumes which scripted response.

**Known limitation (deliberate, M4's scope)**: after the reveal the agent is honest about
what it cannot do — "editing by conversation comes next; the site is saved and every
version is committed." No edit tools exist yet.

**Next (owner)**: add `COMPANY_OS_SITES_DIR=/absolute/path` to `company-os/.env` (I don't
touch .env — the app fails loud with this exact line until it's set), then run a live
first conversation: interview → watch the render lines → open `/site`. Then **M4**
(iteration loop: conversation-driven edits as tools, ~3-iteration cap, "park it" offer)
per `plan/phase-wedge.md`.

---
## 2026-09-22 — Phase-1e SHIPPED — welcome setup wizard: the whole system, not just the provider

**Owner directive (verbatim)**: "I WANT A SETUP WIZARD THAT GUIDES THROUGH THE SETUP! THE USER
DOES NOT KNOW WHAT THIS IS, WHAT THE SYSTEM CAN DO AND WHAT THEY WANT." Root cause: the only
first-run surface was the provider wizard (phase-1d/2a), gated on `providerReady` — a user
whose provider works (platform credits / env BYOK) logged in to a bare "What do you need?"
chatbox with zero explanation of the product.

**Shipped**
- **Welcome setup wizard on `/`** (`src/lib/components/welcome-wizard.svelte`, nucleus design
  language): ① What this is (plain words: one private AI for your company, on your server,
  remembers, acts only with approval) → ② What it can do (six capability cards: Nucleus chat,
  Capture, Memory, Knowledge graph, Brand studio, API keys) → ③ Connect the AI (reuses
  `<ProviderOnboarding>` inline when no provider works — still a hard gate, no skip;
  "Connected" card when ready) → ④ "What do you want to do first?" (Start with the chat /
  Capture / Memory / Brand / Graph — destination buttons complete the tour then navigate).
  Skippable at every step except ③-unconnected.
- **Gate**: `(nucleus)/+page.server.ts` returns `showWelcome = !harness &&
  user_preference.welcome_completed_at IS NULL`. Page precedence: welcome wizard → provider
  wizard (returning user, vanished provider) → chat.
- **Persistence**: migration `0082_welcome_onboarding.sql` (+journal, +brain.schema.ts) adds
  `user_preference.welcome_completed_at`; `POST /api/onboarding/welcome` (auth 401, idempotent
  upsert via `completeWelcomeOnboarding`, fails loud).
- **Fixed pre-existing e2e breakage**: onboarding specs hardcoded mock-gateway port 5191 while
  playwright.config starts it on `MOCK_GATEWAY_PORT ?? 5199` — the real 1-token `test-provider`
  dry-run failed on main. Specs now derive the port from env like the config does.

**Gates: 4166/4166 vitest unit (558 files), 30/30 component, e2e onboarding-provider 6/6 +
onboarding-welcome 3/3 (new suite: first-screen walk → chat; skip persists across
sign-out/sign-in, provider gate still holds; destination cards navigate), svelte-check 0
errors, lint clean on touched files, production build green. Migration applied to dev DB.**

**Decisions (log)**
- New `welcome_completed_at` on `user_preference` instead of reusing `user.onboarding_completed`
  (that flag means "provider onboarding done", is only set by saveProviderConfig, and platform-
  credit users never hit it). A fresh flag also makes the tour appear for existing accounts —
  exactly what the owner asked to see.
- The tour is skippable; the provider step inside it is not (phase-1d "no provider, no product"
  stands where it belongs). Skipping with no provider lands on the provider gate — verified e2e.
- The provider wizard is embedded, not duplicated: one credential flow to maintain.

**Broke / lessons**: SSR buttons click before Svelte hydration attaches handlers — e2e must
retry-until-advanced (new `continueToStep`, same discipline as `fillCaptureComposer`). An API
completion of a UI gate must reload the open page — `page.request.post` does not refresh
already-rendered load data.

**Known stale (pre-existing, not this phase)**: `release.e2e.ts` / `projects-assign-task.e2e.ts`
still expect the removed `/capture` onboarding overlay on `/` — they predate phase-1d and need
a rewrite for the current surface.

**Next**: owner reloads `/` and walks the wizard (their account has `welcome_completed_at`
NULL — it shows). Then the settings fold-in pass (catalog providers manageable only via
onboarding) or phase-3 per roadmap.

---
## 2026-09-21 — M2c — THE FOUNDER SURFACE: guided UI + provider setup in the browser (`edcb59f`)

**Owner directive (verbatim)**: "no, i wont touch the env. this is not good. its fine for devs, but does not work for normal people. i want to get guided through this in a ui as a user." The chat surface (was M6) and provider onboarding moved to NOW — the first conversation is the product.

**Shipped**
- **company-os is now a SvelteKit app** (architecture doc's shell): engine under `src/lib/server/`, adapter-node, `npm run dev` → browser.
- **Guided provider setup**: first open without a configured key → setup screen (presets: OpenRouter / OpenAI / custom OpenAI-compatible). The key is verified with a REAL request — failures surface the provider's exact error (verified live: OpenRouter 401 came back verbatim) — then stored in **the founder's own database** (migration `0002_provider_config`, single row). `resolveLlmConfig`: DB → env (dev) → null = setup screen. A missing key is a surface, never a silent fallback.
- **Chat UI**: arrival + interrogation as bubbles; streamed answers; named progress lines ("→ save_answer / ✓ saved"); questions emphasized; choices numbered; resume on reload. The process state stays server-side — the client renders events honestly.
- Routes: `POST /api/session` (setup gate → arrival/resume), `POST /api/provider` (verify+save), `POST /api/turn` (SSE loop events).

**Verified end-to-end** with a local mock LLM (OpenAI-compatible SSE): setup gate → key stored → arrival renders → founder answer → `save_answer` persisted to memory → next question delivered — all through the real HTTP surface. **Gates: 71/71 vitest (incl. PG), svelte-check 0 errors, production build green.**

**Decisions**
- Key in DB plaintext (single-tenant, their server, their DB) — KMS-style encryption deliberately deferred; revisit at deploy hardening.
- `npm run dev` reads `company-os/.env` (gitignored, local-only DB URL — created openly, no secrets); `.env.example` documents the one runtime var.
- The CLI (`npm run chat`) stays as the dev/headless path.

**Broke / lessons**: routes can't have arbitrary exports (SvelteKit); `process.env` isn't populated from `.env` in dev — routes use `$env/dynamic/private`; the provider-setup route needs stores BEFORE a config exists (`coreStores` split from `buildRuntime`); `build/` output committed twice now — gitignore discipline for generated dirs, same class as `.svelte-kit`.

**Next**: M3 — the website module: `module.json`, template + tokens, generate-from-answers-only, git repo per site, commit per render, preview in the UI (P2/P3 — the reveal moment).

---

## 2026-09-21 — M2b — THE PROCESS DRIVES: code-owned agenda after the first live run failed (`5243dfd`)

**Owner feedback (verbatim, on record)**: after a live conversation the founder had to push — generic greeting, the model skipped to Q4 (tone) on its own, then offered to *invent a company name*, and the founder was left asking "and now?". **Directive: "i can't push the ai to do the thinking for me, it has to proactively guide me through a process."** Root cause: M2 made the LLM own the process (a rules document), which is exactly backwards.

**Shipped**
- **Code owns the agenda** (`src/conversation/plan.ts`): the QUESTION_PLAN is a sequence; `processState(memory)` computes phase + the single next required key; injected into every turn as a PROCESS STATE system message (recomputed from memory every turn — never persisted, so resume is always exact).
- **Drift enforcement**: a turn ending without the required question gets ONE bounded correction, then the engine fails loud (`refusing to drift`) — silent agenda loss is impossible.
- **Agenda-key enforcement, live**: `ask_question` now requires the agenda's key, validated against `processState` recomputed from memory at enforcement time (so a mid-turn save moves the agenda correctly: answer Q1 → Q2 becomes deliverable within the same turn). Off-agenda questions, skipping ahead, stalling, and post-completion questions all fail at the tool door.
- **`mark_not_needed`**: the conditional site.language slot resolves by agent decision with a reason (LLM decides meaning, code persists — guardrail-compliant).
- **Chat CLI** (`src/cli/chat.ts`, `npm run chat`): the first conversation in the terminal — real substrate probes, streaming with named progress lines, resume on start. Render logic pure + tested (`render.ts`).

**Broke / lessons**
- `openSession` double-fed the persisted prefix into the loop (tests passed via slicing luck) — runTurnLoop now reads the persisted session, no additions param.
- FakeClient recorded params **by reference** — the loop's working-copy mutations leaked into recorded calls; snapshot at call time.
- Node strip-types rejects constructor parameter properties — explicit field declarations (llm/memory/session).
- The .env LLM_* values are EMPTY strings in this environment (the OpenRouter key lives in the app's BYOK DB) — the live CLI smoke needs `COMPANY_OS_LLM_*` env from the owner; everything else is test-covered.
- The external lint watcher reformats mid-session; verify-on-disk is now standard practice (caught twice this milestone).

**Decisions**: agenda = single source of truth (memory) evaluated live at enforcement, not frozen per turn; corrections persist across attempts in the loop input so the transcript stays API-valid; `requireQuestion=false` only for a broken-substrate arrival (the honest failure IS the turn).

**Next**: M3 — website module: `module.json`, template + tokens, generate-from-answers-only, git repo per site, commit per render, preview (P2/P3).

---

## 2026-09-21 — M2 SHIPPED — first conversation P0/P1: arrival check + interrogation engine (company-os)

**Shipped**
- **P0 arrival**: `src/substrate.ts` — injectable probe runner + real probes (postgres reachable, migrations applied, git available). Report is code-generated and authoritative; a failing probe lands in the transcript with its fix command. The LLM may only phrase it, never fake it.
- **P1 interrogation**: `src/conversation/first-conversation.ts` — the policy prompt (7 questions in order, one-per-turn, never-invent, choices-over-blanks, skip rules, undecisive-founder rule, founder's language = site's language) + fixed answer vocabulary (`company.name/audience/cta/tone/differentiator/assets`, `site.domain`, `site.language`).
- **Structural enforcement** (code, not prompt advice): `ask_question`/`offer_choices` are **halting tools** — the loop ends the turn when they execute; a second tool call in the same round gets a NOT EXECUTED observation (transcript stays API-valid, model learns the rule). `save_answer`/`skip_question` validate the key vocabulary and non-empty values at the door (the never-invent gate) and enforce the question budget on distinct keys.
- **Turn runner**: `src/conversation/turn.ts` — `openSession` (P0) and `runTurn` (persist founder message → loop → persist generated messages; a crash loses nothing said).

**Gates: 55/55 vitest green (incl. PG-backed), tsc --noEmit clean.**

**Decisions**
- Question budget = 8 distinct keys (7 questions + conditional site.language per Q2.5); M8 eval still measures ≤7 asked. Re-answering an existing key is never budget-limited.
- All tool `execute`s are async (uniform await path through the registry — a sync throw escapes `expect().rejects` and any caller's try/catch asymmetry).
- Halting-tool results keep the transcript OpenAI-valid (every tool_call gets a tool result, executed or NOT EXECUTED).

**Broke / lessons**
- The external lint watcher reformats files mid-session (interfaces → type aliases, naming-case renames); verify-on-disk after every edit now — two of this milestone's test failures were spec-vs-disk drift, one was a genuine sync/async throw bug caught by that verification.

**Next**: M3 — website module: dead-simple `module.json`, template with tokens, generation from answers only, git commit per render, preview + silent reveal (P2/P3).

---

## 2026-09-21 — M1 SHIPPED — session + memory persistence with resume (company-os)

**Shipped**: `agent_sessions`/`agent_messages` (every message persisted, seq-ordered, tool_calls as jsonb) + append-only `company_memory` (latest-wins reads — "nothing is lost, ever") via migration `company-os/migrations/0001_init.sql`; dead-simple own migration runner (`src/migrate.ts`, filename order, `schema_migrations` tracking, transactional, loud); `PgSessionStore`/`PgMemoryStore` + explicit in-memory test doubles (DI, never silent fallbacks); `resumeContext()` — "You were setting up <company> — where were we?" data assembly (phrasing belongs to M2's conversation policy).

**Gates: 38/38 vitest green (7 Postgres-backed against a dedicated `company_os_test` DB on the dev cluster), tsc --noEmit clean.** PG suites skip loudly without `COMPANY_OS_TEST_DATABASE_URL`.

**Broke / lessons**
- **postgres.js delivers jsonb as a raw string on this setup** — `rowToMessage` now accepts parsed-or-string and parses defensively.
- **The dev cluster preloads Apache AGE** (`shared_preload_libraries=age`), whose hook breaks `DROP TABLE` in any DB without `ag_catalog` (CREATE/TRUNCATE unaffected). Test DB recreated from `template0`; tests reset via TRUNCATE/DELETE, never DROP. Documented in `company-os/README.md`.
- In-memory session double needed a monotonic touch counter — ISO timestamps tie within a millisecond and `latestOpen` ordering went flaky.

**Decisions**: sessions/messages/memory shaped exactly for the P0–P5 flow (append-only, resume-first); jsonb defensive parsing over driver config archaeology; `postgres@^3.4.9` pinned to match the ecosystem.

**Next**: M2 — first-conversation P0/P1: arrival health check (real substrate probe, honest failures) + the 7-question interrogation policy (≤7, one per turn, choices-over-blanks, skip rules, answers → memory).

---

## 2026-09-21 — STRATEGIC PIVOT: the wedge. Owner verdict + wedge docs captured + phase-wedge opened (M0 shipped)

**Owner verdict on the existing build**: "very opinionated, bloated and not what i wanted." The kernel/brand direction built elaborate machinery while the actual product — describe your company → running on your own VPS in 10 minutes — doesn't exist. All new work executes the wedge docs instead.

**Captured verbatim into plan/**: `the-wedge.md` (strategy), `first-conversation.md` (the P0–P5 day-one flow), `claim.md` ("Own your company. Don't rent it."), `ideas.md` (WebMCP entry), `company-os-architecture.md` (v0.1 target architecture).

**Opened `plan/phase-wedge.md`** — the thin-slice execution plan: agent harness (minimal tool registry), website module (conversation-generated, git-stored, SvelteKit-rendered), one-command deploy, memory + owlery wired. Decisions of record W1–W8 (fresh minimal build at `company-os/` with zero imports from the existing app; Postgres only, no Redis/BullMQ; minimal fail-loud LLM client; website = git repo of content+theme; never-invent enforced structurally; SSE streaming; single owner token; memory = plain table until size demands more).

**Parked (not deleted)**: phase-2b/2c/2d/3 and everything built under them (kernel machinery, brand pipeline, visual editor, 81-migration schema, 4k-test suite). The existing app stays green and untouched; `company-os/` extracts to its own repo when it warrants one.

**M0 SHIPPED — harness core** (`company-os/`): streaming LLM client (OpenAI-compatible, env-required fail-loud `COMPANY_OS_LLM_*`), JSON-schema tool registry with loud parse errors, reasoning loop (reason → tool → observe, loud max-steps failure), all DI-seamed for tests without network/env. Vitest suite green. Commits: see git log on `company-os/` paths.

**Decision log**: this entry IS the architecture-impact decision record for the pivot; details in phase-wedge.md §2. AGENTS.md repo-map update deferred until the slice proves out (owner's call).

**Next**: M1 session+memory persistence (Postgres + resume), then M2 first-conversation P0/P1.

---

## 2026-09-10 — FIX: /brand 403 (owner had no admin role) + activation notice BEFORE the wizard/judge start (`f261d98`, direct orchestrator fix)

**Owner hit on first use**: `/brand` → 403. Two stacked causes: (1) the owner's Better Auth row had role `'user'` — `requireAdmin` hard-failed; fixed as **dev-DB data** (`update "user" set role='admin'`, the `create-admin.mjs` equivalent — no code change). (2) `kernel_module_activations` had no `brand` row — even as admin, every `brand.*` tool would throw `module_inactive`.
- **Owner directive**: don't fail — inform. `/brand` and `/brand/extract` now probe `brandModuleState()` on load and render **`ActivationNotice`** ("The branding module is inactive — activating it enables … approval-gated: confirm here, then approve `kernel.module_activate` in the orchestrator chat") instead of the wizard.
- **`POST /api/brand/activate`** (admin-only) → `kernel.module_activate {module_id:'brand'}` through the registry: first call → `approval_required` → UI shows "approve in the orchestrator chat"; retry after the conversational yes → activated → `invalidateAll()` loads the real surface. Self-seeded kernel module makes this reachable while `brand` is inactive (no bootstrap deadlock).
- **Gates: brand+routes+lib 36 files / 502 tests green; check 0 errors; lint clean (import sort auto-fixed).**
- **Follow-up on record**: first-signup admin policy (single-tenant: first human should presumably be owner/admin by construction instead of needing `create-admin.mjs`) — owner's call, not silently decided.

---

## 2026-09-09 — Phase-2d M6+M7 SHIPPED — PHASE COMPLETE: visual editor + tree navigation (`8f3755e`/`51e6c77` on wt/brand-visual, ff-merged; delegated subagents, orchestrator verified 493 brand-suite tests + merged; worktree pruned)

**Shipped** (migration **0081** applied)
- **M6 editor** (`/brand/editor/[setId]`): full specimen canvas (nav/hero/cards/form/pricing/footer, flexbox, cssVars-driven, light/dark) + token panel — seed controls (color picker + oklch numerics, curves, shape, elevation, motion, grain) re-expand deterministically via `reseed.ts applySeedEdit` with **owner pins surviving every re-expansion** (V3: pins beat re-expansion; `pins jsonb`, migration 0081; clear-pin re-flows from expansion, seedless drafts throw loud); click-element → driving-token highlight via the static `drivers.ts` registry; writes through draft-only `brand.visual_set_update` (human-only).
- **M7 tree navigation** (last priority, V7): precomputed k-NN descent per card ("Similar →" pivot drawer), clickable breadcrumb trail, cluster **tunnel links** from build-time `clusterAdjacency` (centroid-ranked, ≤3, in index.json); `fromNumericVector` inverse added to vector.ts so centroid distances decode back to styles; `brand.corpus_similar` read tool + `/api/brand/corpus/similar`. Pure lookups — zero runtime compute/LLM.
- **Gates: full unit 4149 passed / 5 skipped; brand suite 34 files / 493 tests green in worktree AND re-verified in main tree post-merge; check 0 errors; lint clean in touched files.**

**Decisions**
- Culori ambient d.ts extended per its own header rule (`formatHex`) — culori ships no types.
- Pin keys: bare var names for light, `dark:` prefix for dark; every direct cssVars/dark patch write pins in the same tool call.
- Adjacency symmetry asserted exactly while clusters ≤ k+1 (true today: 3 clusters); asymmetry beyond that is documented by-design.
- Phase-2d M1–M7 all merged; **worktree `../ee-brand-visual` + branch `wt/brand-visual` pruned** (recreate with `git worktree add ../ee-brand-visual -b wt/brand-visual` if follow-ups demand a stream).

**The complete owner loop (all surfaces nucleus/admin):** `/brand/extract` — paste URL → 3 candidate extractions/round → judge closest → accept → corpus item → `node modules/brand/corpus/ingest-tier1.mjs` + `npx vitest run modules/brand/corpus/build.spec.ts` to reindex → `/brand` — pick ≥3 style cards (k-NN pivots + tunnels optional) → top-3 matches → working draft → `/brand/editor/<setId>` — tune seeds/resolved values with pins → `brand.visual_set_activate` → approve in chatbox → **brand applies to the whole app**, hero + shader included. `BRAND_EXTRACT_MODEL` env required for extraction (loud if unset).

**What's next (owner's call)**: extraction-driven corpus growth in the wild (clusters will multiply past 3 — tunnels get interesting); LLM cluster naming (logged follow-up, replaces deterministic "<centroid member> family" names); phase-2c M3–M5 voice pipeline (unchanged, orthogonal); optional editor UX pass (drawer width/breadcrumb depth).

---

## 2026-09-09 — Phase-2d M4+M5 SHIPPED: selection wizard + approval-gated go-live with global token application (`999b8a6`/`e894ffd`→`4e9c519`/`439a556` on wt/brand-visual, ff-merged; delegated subagents, orchestrator verified + merged)

**Shipped** (migration **0080** applied to dev DB)
- **M4 selection wizard**: `/brand` (nucleus) — corpus as cluster-grouped card grid (`StyleCard` scoped per item), picks accumulate (≥3 unlocks matches), `selection/match.ts` = weighted centroid of picked vectors → top-3 nearest (pure math, zero LLM, V7), "Use this design" → **working draft** in `brand_visual_sets` (draft/active/retired, one-active partial unique index, `source_item_id` by uuid — no FK, corpus is in-repo per V2). Tools: `brand.corpus_list/get`, `brand.selection_matches`, `brand.visual_set_create/get/list`.
- **M5 publish/apply**: `brand.visual_set_activate` **approval-gated** (APPROVAL_REQUIRED_TOOLS; halts as pending approval, second call after approval releases — set_activate pattern); activation guards = 16 required visual roles (loud gap list) + draft-only + **retire-previous** (order dictated by 0080's partial unique index). Consumption: root `+layout.server.ts` reads active set → `+layout.svelte` emits **unlayered** `:root`/`.dark` override (beats `@layer base` regardless of injection order) → **applies to the whole app**; `/s/[slug]` hero (h1 color, WaterFlow tints) is now token-driven. `style-format/tint.ts grayscaleTint`: chromatic brands project onto the L axis (c→0) so the shader's monochrome invariant stays intact while tints stay brand-derived.
- **Hotfix `439a556`**: `corpus/mapping.mjs` → typed `mapping.ts` — the rebrand stream's `modules/**` svelte-check include pulled the plain-JS module into the check program (42 implicit-any errors); `ingest-tier1.mjs` now imports the TS module directly (node ≥22.18 native type stripping, fail-loud guard). check back to 0 errors.
- **Integration**: orchestrated commit `fe9819a` landed the rebrand stream's then-uncommitted water-flow hero work on main (byte-identical to the branch's vendored copies — zero loss); rebase conflict in `s/[slug]/+page.svelte` resolved in favor of the M5 token-driven supersession (verified strict superset of the hardcoded version).
- **Gates: worktree 35 files / 433 tests green (brand+routes+s/[slug]); full suite 4061 passed in M5 verification; check 0 errors; main tree re-verified 433/433 post-merge after `npm install` synced node_modules with the merged package.json.**

**Broke / lessons**
- **Main-tree node_modules lagged the merged package.json** (culori/daisyui) → 12 spec files failed at collection in the main tree while green in the worktree. Rule: after every stream merge, `npm install` in the main tree before trusting gate runs.
- M5's check ran pre-rebase; the rebase delivered the svelte.config include that exposed `mapping.mjs` — post-rebase gates are now run by the orchestrator on EVERY merged milestone (both incidents caught exactly there).

**Decisions**
- Unlayered override block beats `@layer base` by cascade construction, not injection order — documented at the injection site.
- `brand.selection_matches` is pure-read (no human-only guard); `visual_set_create` backfills seeds from the source corpus item (V3 resolved-tokens-alongside-seeds).
- Reverting a live brand = activating another draft (retirement is only ever a side effect of new go-live).

**Next — M6 editor (wt/brand-visual)**: specimen canvas + token panel (seed controls where seeds exist, resolved always, light/dark) + click-element→token-highlight, writing the draft via `brand.visual_set_update`. M7 (tree navigation) after.

---

## 2026-09-09 — Phase-2d M3 SHIPPED: corpus assembly — 83 formalized styles + deterministic similarity index (`beee859` on wt/brand-visual, ff-merged; delegated subagent, orchestrator verified 144 new tests + merged)

**Shipped** (109 files, +13,965 lines)
- **Similarity math** (`style-format/vector.ts` + `fonts.ts`): 48-dim style vectors from cssVars (10 core colors → OKLCH, radius/density, font categorical matrix, dark delta), weighted `styleDistance` (color ≈.45 / shape-density ≈.25 / type ≈.2 / effects ≈.1), symmetric, deterministic.
- **Tier-1 ingest** (`corpus/ingest-tier1.mjs` + pure `mapping.mjs`): 35 daisyUI v5 themes + 36 tweakcn presets → shadcn-role corpus items (mapping table in report/commit; OFL font substitutes pinned; seeds derived best-effort, cssVars remain vector source of truth). Owner-run, loud, skippable per source.
- **12 hand-authored archetype seed files** (brutalist → blueprint-constructivist), expanded through `expandSeeds()` at build time.
- **Build-through-vitest** (`corpus/build.spec.ts`): validates every item, computes vectors + k-NN(8) + agglomerative clusters (threshold 0.35, min 3) → `corpus/index.json`; deterministic, byte-stable on no-op rebuilds. **83 items, 3 clusters** (11/56/16 — light/dark divide dominates at v0 threshold).
- **Gates: 3979 unit passed / 0 failed (544 files); check 0 errors; lint clean in modules/brand.**

**Decisions**
- Item ids = pinned-namespace uuid v5 (schema demands UUIDs); slug survives as filename.
- Color normalization reference constant (0.1) added — without it the cluster threshold can never separate light-theme families.
- Cluster naming v0 = deterministic "<most-central member> family"; LLM naming logged as follow-up (keeps the build fully offline).
- Build runs through vitest (plain node can't import the pure TS modules; vite-node is broken for CLI in this repo) — one implementation, zero toolchain hacks.
- Only 3 clusters at v0 threshold: expected for a daisyUI/tweakcn-weighted corpus; threshold + corpus growth (M2 extraction loop!) are the levers.

**Next — M4 selection wizard** (`wt/brand-visual`): `brand_visual_sets` migration (draft/active/retired, one active), `brand.corpus_list/get` + centroid-matches tools, cluster-grid wizard UI → working draft.

---

## 2026-09-09 — Phase-2d M1+M2 SHIPPED: canonical style format + design-system extraction with owner judge loop (`ea6bc2a`/`3eab46c`/`9228dc6` on wt/brand-visual, rebased onto main after governance+BYOK commits, ff-merged `9228dc6`; implementation delegated to subagents in `../ee-brand-visual`, orchestrator reviewed + verified gates + merged)

**Shipped** (46 files, +4050 lines; migration **0079** applied to dev DB)
- **Canonical style format** (`modules/brand/style-format/`): zod seed schema (~18 params per plan V3) + pure `expandSeeds()` — OKLCH 12-step ramps (culori, Radix step semantics → shadcn roles), invert-tone dark scheme, Utopia clamp() fluid type/space scales, shape/radius tables, elevation shadow recipes, motion token pairs, feTurbulence grain — plus deterministic CSS emitter and the corpus-item type. Golden snapshot tests pin `expand(seed) === tokens.json`.
- **Extraction pipeline** (`modules/brand/extract/`): SSRF-guarded Playwright capture (computed-style facts + screenshot), facts digest, **3-candidate propose** (Color-led/Type-led/Structure-led lenses, temps 0.4/0.7/1.0) through the gateway, store (sessions/rounds/verdicts + `brand_corpus_staging`), export script → `modules/brand/corpus/<id>.json`.
- **5 kernel tools** (`brand.extract_start/propose/judge/accept/session_get` — human-only guards per 2c D5, no new approval gates since staging ≠ publish) + owner API routes (`requireAdmin` idiom → registry.execute) + nucleus judge UI `/brand/extract` (specimen cards vs live screenshot, closest/retry/accept).
- **Gates: brand+routes 271 passed; post-rebase brand+routes+llm 512 passed; full unit 3917 passed / 14 skipped; check 0 errors (warnings = pre-existing baseline); lint 0 findings in touched files.**

**Decisions**
- **Deviation from plan V3, on record**: CSS emission is an **in-repo deterministic emitter**, not Style Dictionary v4 — our token surface is fixed and snapshot-tested; SD adds indirection with no multi-platform consumer today. Revisit if iOS/Android targets appear.
- **`llmChatCompletion` gained an additive optional `modelOverride`** (wins over routing, never defaults) — enables the dedicated extraction model identity per D2: **`BRAND_EXTRACT_MODEL` env, unset fails loud at call time**.
- Judge loop = convergence-by-selection (owner picks closest of 3; verdicts stored as judged pairs for future fine-tuning feedback), exactly the owner's "3 variants → I judge → next round" shape.
- Parallel-session commits (governance, BYOK) landed mid-stream; rebase was clean, 512 post-rebase tests verified before merge.

**Next — M3 corpus assembly in `wt/brand-visual` (worktree kept)**: Tier-1 ingest (daisyUI/tweakcn/shadcn themes → corpus items, human-validated) + hand-authored archetypes; deterministic vector/k-NN/cluster build script (OKLCH ΔE weighted vectors, build-time LLM cluster naming) → `modules/brand/corpus/index.json`.

---

## 2026-09-09 — FIX: chat LLM calls now resolve the human's provider config (`2408c92`)

**Owner hit on dogfood**: chatbox failed loud with "Platform EUrouter not configured: set LLM_BASE_URL" despite configured OpenRouter BYOK. Root cause: the harness engine attributed LLM calls to `ctx.agent.id` ('orchestrator' principal) — llmChatCompletion found no provider row for that id and fell back to platform env. Identity mismatch between harness principal ids and llm-client user ids, introduced by the chatbox→harness wiring.
- **`llmUserId` threads surface → dispatch → ctx → engine**: `DispatchOptions { llmUserId }` on AgentRuntime.dispatch; `EngineContext.llmUserId`; builtin-json precedence `ctx.llmUserId ?? engine config ?? agent.id` (both call sites incl. streaming); `AgentChatDispatch` carries the authenticated `user.id`; route closure passes it; Telegram `respond` passes the allowlisted `session.principalId` (human principal id = auth user id). BYOK config now resolves for exactly the human in the conversation, web and Telegram alike.
- Regression coverage: runtime threading test, engine precedence test, route dispatch-options assertion. Gates: 610 kernel+modules+routes passed, check 0 errors.

## 2026-09-09 — Governance follow-up: the conversational yes is the gate (`a8b11c0`)

**Owner directive**: "ee module activate repo — this has to be called by the agent." No manual CLI prerequisites; the loop lives in the conversation.
- `kernel.approvals_list` + `kernel.approvals_decide`: owner-only → **owner/admin/agent** — the agent surfaces pending approvals in chat and executes the owner's conversational yes (trust-the-transcript, as recorded in phase-3 risks; `decidedBy` audited). The chatbox approval card now completes in-conversation.
- `kernel.module_activate`/`deactivate` added to APPROVAL_REQUIRED_TOOLS — the agent can call them (it holds admin), the gate halts until the owner's yes. "Activate the repo module" is now a chat sentence, not a CLI step.
- CLI specs that used owner-only `approvals_list` as their denial vehicle re-pointed at an owner-only fixture tool (intent preserved: flag-over-env resolution + permission_denied exit-code mapping). Gates: 642 passed / 4 skipped, check 0 errors; the parallel session's uncommitted brand files were accidentally swept into a commit and restored to uncommitted state (`ea62db6` redone as `a8b11c0`).

## 2026-09-09 — Phase-2d DESIGNED: visual branding (taste elicitation → extraction → selection → apply → editor)

**Shipped** (plan only — design grilling session, zero code)
- **`plan/phase-2d-visual-branding.md`** — approved design with decisions of record V1–V10 and milestones M1–M7. **Supersedes phase-2c D1: the visual pipeline is now v0 scope.** Phase-2c M3–M5 (voice pipeline) unchanged and orthogonal.
- The crux (owner: "how do we translate tokens to design and vice versa") resolved by research: **W3C DTCG container + a seed block (~18 params) + 8 pinned deterministic expansion rules** (OKLCH/Radix ramps, M3 dark scheme, Utopia fluid scales, shape/motion/shadow/grain recipes) → `expand()` → Style Dictionary v4 → the CSS vars `layout.css` already consumes. Snapshot-tested determinism; no existing format had this — the seed schema is the only novel piece.
- Architecture facts pinned: corpus = in-repo static JSON in `modules/brand/` (Tier-1 ingest: ~100–150 already-tokenized MIT styles from daisyUI/tweakcn/shadcn + extraction-driven growth); similarity = deterministic weighted token-vector distance + build-time k-NN/clusters (Every Noise pattern); selection = cluster grid → picks → weighted-centroid taste → top-3 shortlist; **zero runtime LLM**.

**Decisions (owner, grilled)**
- **Extraction pipeline = first priority**: URL → 3 candidate extractions per round → owner judges closest → iterate until accepted → corpus item; judged pairs stored for future fine-tuning. "RL with me as judge" implemented as convergence-by-selection, no gradient updates v0.
- **No Penpot, no second DB, ever** — DB is SoT (new `brand_visual_sets`, draft/active/retired), native flexbox editor on a specimen canvas instead; Penpot conventions may be harvested later at most.
- Runtime taste-interpretation scrapped ("no llm as judge … wrong direction"): selection is pure math; LLM only in extraction loop + one-time build-time cluster naming.
- Tree navigation (k-NN descent/tunnels) = **last priority**; one selected design applies **globally to all user-facing surfaces** (global `:root` override; app's own style remains until explicit activation); water-flow shader keeps grayscale until a brand is active, then tints from the active set.

**Next** — M1 canonical format (`expand()` + snapshot tests + Style Dictionary emitter) in workstream `wt/brand-visual`; M2 extraction pipeline + judge loop right behind it.

---

## 2026-09-09 — Phase-3 M2: repo hands — the one agent can now improve its own repo

**Shipped** (`004d1e9` on wt/one-agent-hands, ff-merged; subagent-implemented in worktree, orchestrator reviewed)
- **`modules/repo`** (new, activation-gated): the agent's repo hands as 5 registry tools — `repo.worktree_create` (external; `../ee-agent-<id>` + `wt/agent-<id>`, idempotent per principal, stale-worktree fails loud), `repo.run` (external; token-structured allowlist — metachars rejected outright, per-entry arg validation, `--amend` structurally impossible; 10-min timeout; non-zero exit = result, not exception; output truncated with explicit marker), `repo.read_file`/`repo.write_file` (mutate/read; path-resolved inside worktree, `..` escapes rejected, secret paths blocked BOTH ways — reading `.env*`/`*.key`/`*.pem` is exfiltration), `repo.merge` (mutate + in APPROVAL_REQUIRED_TOOLS; server-side verify gate = vitest kernel-scoped + check, both green or refused; commit-if-dirty → `merge --no-edit` → cleanup; conflicts fail loud: STOP and ask the owner).
- **Discipline as prompt**: `modules/orchestrator/discipline.ts` — 6 sections distilled from `.pi/skills` (plan-first, understand-first, no-fallbacks, no-mid-air-rethinks, loop-detection, commit-conventions) + REPO_HANDS protocol (plan in chat → worktree → edit/run → progress.md → merge behind owner approval). Appended to the orchestrator persona (2-line brain.ts change).
- **No new tables** (M2 decision): git history + kernel_events are the run log. Events: `repo.worktree_created/command_run/file_written/merged/verify_failed` (metadata-only).
- **Gates: modules/repo+orchestrator 106 passed (incl. real temp-git-repo integration spec); kernel+modules+cli 628 passed / 4 skipped; check 0 errors / 24 warnings; boundaries guard green; hostile-input battery pinned (shell injection, amend, traversal, secret paths).**

**Decisions**
- Allowlist over free shell: the agent is owner-entrusted, but a hallucinated command shouldn't be `rm -rf`; capability gaps closed by structured tools (`write_file` gives mkdir-p; merge does its own `git add -A` internally) instead of flag-widening the allowlist.
- Duplicate `REPO_VERIFY_TARGETS` instead of importing from frozen dev-agent (boundary guard).
- Idempotent worktree keyed by principal id, tracked in engine memory; no DB persistence (git is the log).

**Next — M3 (dogfood + cleanup)**: live proof in the chatbox — "improve X" → plan → worktree → green → owner yes → merged → progress.md updated, all in one conversation. Then delete frozen code (pi-engine, dev-agent module, orchestrator brain/loop remnants, builtin-json engine indirection, legacy agent-loop path) and re-point anything still consuming them.

---
## 2026-09-09 — Phase-3 M1: durable session log — conversations survive restarts

**Shipped** (`3f33645` on wt/one-agent-loop, merged `7dbab8b`; implementation delegated to a subagent in the worktree, orchestrator reviewed + integrated)
- **`kernel_agent_session_events`** (migration **0078** + journal idx 78): append-only conversation log (bigserial id = global order, session_id/agent_id, kind CHECK user|assistant, payload jsonb `{text}`), index (session_id, id). Applied to dev DB; content-hash tracking meant the rename to 0078 needed no DB surgery.
- **`kernel/session-log.ts`** — kernel port (`AgentSessionLog` append/list, InMemory for tests; zero `$lib/server` imports); `DbAgentSessionLog` in `db-stores.ts` (DbHandle-injected, newest-DESC reversed to chronological).
- **builtin-json dememorized**: in-memory session Map + `remember()` DELETED; history derived from `list(sessionId, 40)` per run; each final turn appends user + assistant events; construction fails loud without a log; payload text validated loud. Protocol/streaming/approval UX untouched.
- **Wiring**: `WiredKernel.sessionLog` (required); `BootstrapKernelOptions.sessionLog` defaults `DbAgentSessionLog(db)`; orchestrator bootstrap forwards `kernel.sessionLog` into the engine. boot.ts unchanged.
- **Restart-resume proven**: fresh engine instance B on a shared log continues A's conversation (spec); DB integration spec proves the same across fresh store instances.
- **Gates: kernel+db+orchestrator 305 passed / 5 skipped (DB specs run green against dev DB); cli+mcp+modules 387 passed / 1 skipped; check 0 errors / 24 warnings (baseline).**

**Broke / integration**
- **Mid-air 0077 collision** with the parallel journeys stream (both took idx 77; both touched modules/index.ts, bootstrap.ts, brain.ts, journal). Resolution: journeys keeps 77, session events renumbered **0078**; imports unioned in brain.ts; auto-merge of the JourneyAwareRuntime + sessionLog wiring verified by hand. Journal-pin spec in playbook.spec now looks up by tag instead of "last entry" (pin survives future migrations — intent preserved, not weakened).
- Dev DB: `0077_journeys` committed by the other session but NOT yet applied — next `npm run db:migrate` applies it (hash-based tracking; my 0078 content already applied under its old name, hash unchanged → skipped).

**Decisions**
- SessionLog is kernel-owned port + DB store beside the other kernel stores (same pattern as approvals/events); engine requires it — no in-memory fallback, debt deleted not shadowed.
- Only final turns are logged (user + assistant); tool calls stay in kernel_events/stream — conversation log stays model-history-shaped.

**Next — M2 (repo hands)**: `repo.*` registry tools (worktree_create / run-scoped / merge approval-gated with server-side verify) + `.pi/skills` discipline as persona prompt sections; then the in-conversation self-improvement proof.

---
## 2026-09-08 — Seamless-tool wave 1+2: harness chat, approvals in the surface, recap, THE JOURNEY

**Shipped** (52b110c → 9d6b8e8, five commits; parallel brand work in the tree was left untouched)
- **Redirects dead**: post-auth lands on `/` (social default, e2e auth-landing assertions incl. auth.e2e + projects-assign-task; capture-as-feature tests kept). Chatbox got `data-testid="nucleus-chatbox"`.
- **`/api/chat` now dispatches through the kernel AgentRuntime** — the chatbox speaks through the harness proper. New surface events: `tool.preview` (metadata-only, ≤120 chars) + `approval.required`; nucleus renders "→ using …" lines and an approval card. Streaming via optional `EngineContext.stream` (graceful single-delta fallback — llmClient has no streaming seam yet).
- **`modules/recap`**: deterministic 24h kernel_events digest → owner Telegram chats (sessions × allowlist intersection, chunked, fail-loud) + `recap.completed` event; `recap.run_now` tool; activation-gated; wired in boot.ts with 5-min tick (HMR-safe, opt-out via bootApp options).
- **Journey engine** (`kernel/playbook.ts` + `kernel_journeys` idx **77** — parallel session took 75/76): `website_founding` journey ships REAL — tone-of-voice question (marker protocol, zero semantic parsing) → brand doc artifact → home/about/contact skeleton pages → `website.publish_page` ×3 **behind the approval gate** (added to APPROVAL_REQUIRED_TOOLS) → completed + event. `JourneyAwareAgentRuntime` subclass = both chatbox and Telegram get journeys; deterministic start seam via verbatim persona question.
- **Main: 1268/1268 tests, check 0 errors; eigen_test migrated through 0077.**

**Notes / debt**
- Chat history for the model is engine in-memory per session (DB rows = durable transcript/UI only) — persisted session memory is the next harness debt.
- `journey.abandoned` modeled, no timeout/cancel path yet. One active journey per kind (DB-enforced).
- Parallel session active in-tree (modules/brand water-flow shader, migrations 75/76, phase-3-one-agent.md draft) — commits were scoped strictly to agent reports; their files remain uncommitted by me.

---
## 2026-09-09 — DECISION: One Agent — dsh concepts implemented IN-REPO (no dsh install; kernel stays as the tool door)

**Decision (owner, decisive)**: "We need one agent that does all." — "We don't install dsh. We take the concepts of dsh and implement them in our repo." One in-repo agent loop (evolved builtin-json protocol) with a durable append-only Postgres session log (model-visible = logged; restart = resume; in-memory Maps debt dies), speaking through the nucleus chatbox via `/api/chat`. Company tools AND repo hands (worktree → scoped run → verify → approval-gated merge) are registry tools through the kernel door. `.pi/skills` discipline ports into the one agent's system-prompt sections. Approvals surface in-band: pending → agent asks in chat → owner yes → retried → audited in kernel_events + git.

- **Concept map** (dsh → in-repo, exists vs build) pinned in `plan/phase-3-one-agent.md`.
- **Frozen** (deleted deliberately in M3): AgentRuntime engine indirection, pi-engine, dev-agent module, orchestrator brain/loop, legacy `/api/chat` agent-loop path, Telegram gateway (dormant).
- **Unchanged**: kernel proper (registry/principals/approvals/events/vcs/modules + DB), website/auth/memory/brand app, phase-2c branding M3–M5, `ee` CLI as the human/external door.
- **Accepted risks on record**: in-repo loop is hand-maintained (one protocol file + a log — full ownership, zero external churn); owner principal in agent hands (conversational governance + git rollback; merge is the approval-gated control point); trust-the-transcript approvals.
- **Milestones**: M1 loop + durable session log + `/api/chat` → one loop → M2 repo hands (`repo.*` tools) + skills-as-prompt-sections + in-conversation self-improvement proof → M3 dogfood (agent improves its own discipline) + deliberate cleanup of frozen code.

## 2026-09-09 — Brand water-flow shader: monochrome fluid as a brand module asset

**Shipped** (uncommitted working tree)
- **`modules/brand/water-flow.svelte`** — the brand's signature visual: a monochrome flowing-water surface rendered by a WebGL1 fragment shader, built to be as lightweight as possible. One fullscreen triangle, one program, zero textures, zero per-frame allocations; motion = three domain-warped fbm evaluations/pixel (classic water warp). Cost controls: DPR capped at 2 × quality 0.75 with a hard 1.5M-pixel budget (flat fragment cost on 4K), `powerPreference: 'low-power'`, rAF loop paused via IntersectionObserver when offscreen, `prefers-reduced-motion` renders a single static frame (live media-query switch), dt clamped so background-tab resume never jumps the flow, full teardown incl. `WEBGL_lose_context`.
- **`modules/brand/water-flow-shader.ts`** — pure logic split out of the canvas lifecycle: GLSL sources + `parseMonochromeTint`/`resolveWaterFlowColors`. Tints are hex-only and **monochrome-enforced at parse** (non-grayscale input throws naming the brand rule — the water-flow asset is grayscale by invariant, not by styling).
- **Failure policy (decorative asset)**: every failure mode (no WebGL, invalid/non-monochrome tint) degrades to a VISIBLE static tint (gradient from the same props + `data-water-flow="static"`) with a loud `console.error` — never a crash of the host page, never a silent degradation. Shader compile/link failures still throw loud (code bug, not environment).
- **Landing surface**: `/s/[slug]` website pages now open with a hero band (dark `#060606` → silver `#b9b9b9`, default props) — the water flow fills the band, page title overlays bottom-left over a legibility scrim.
- **Tests first**: `water-flow-shader.spec.ts` (12 node tests: tint parsing incl. monochrome rejection, shader-source invariants — WebGL1/no `#version`, mediump, texture-free, uniform coverage) + `water-flow.svelte.spec.ts` (4 browser tests: decorative canvas + class/aria passthrough, static fallback on missing WebGL, static fallback on non-monochrome tint, enrolled in `vitest.browser.config.ts`). GLSL compile+link verified against a real GL context (playwright chromium + SwiftShader) since headless CI has no GPU.
- **tsconfig scope fix (long-standing flag resolved)**: `svelte.config.js kit.typescript.config` now adds `../modules/**/*.ts` + `../modules/**/*.svelte` to the generated tsconfig include — modules UI assets are first-class citizens for `svelte-check` and eslint's projectService (the 2026-09-08 "modules/** outside svelte-kit tsconfig include — consider tsconfig addition later" flag is closed).
- **Gates: unit 3506 passed (509 files), components 17 passed, check 0 errors (24 warnings = main's), lint: 0 errors in touched files (kernel's pre-existing errors untouched).**

**Decisions**
- The shader lives IN `modules/brand/` (user directive: "part of the branding module") — it is a brand visual asset, not a generic component; `src/lib/components` stays for shared UI. Routes may import module assets (boundaries guard only polices module→module imports; a presentational .svelte has no server deps).
- Monochrome tints enforced in code (`parseMonochromeTint` rejects non-grayscale hex) — brand invariants belong in the brand module, fail loud.
- Continuous fluid over discrete cells: user picked the smooth interpretation of the Y-reference; the tiled look remains achievable via future props if wanted.
- Degradation policy for decorative surfaces: visible static tint + loud log (consistent with the fail-loud spirit — the failure is observable — while not taking down a public landing page over a missing GPU feature).

**Tracked**
- **`ee` CLI broken on vite 8 (regression, needs a fix stream)**: `tsx src/cli/index.ts` fails (`Cannot find package '$env'` — tsx doesn't apply SvelteKit's tsconfig paths) and the vite-node fallback dies in SvelteKit's browser-import guard (`An impossible situation occurred`, node_modules/@sveltejs/kit/src/exports/vite/index.js:670 — vite-node's module graph isn't walkable for the server-only pyramid check). Documented dev-bootstrap via SQL was used instead this session (owner principal `…aa`, website module activation, `home` page seed); the CLI path must be restored before agent-native hands depend on it.
- Headless CI has no WebGL → the animated branch is only exercised by real GL (SwiftShader verification script, not enrolled); browser spec asserts structure + fallback branches.
- Hero is wired only on `/s/[slug]`; reusing it on the nucleus `/` or future marketing routes is a one-line component import (brand module is the owner).
- Shader tuning (speed/scale/quality defaults, tint tokens from `brandVisualTokens` once M3 publish lands) is open — defaults chosen to match the reference art.

---
## 2026-09-08 — Phase-2c: explicit model selection — no implicit defaults

**Shipped** (`21ad301` feature, wt/model-selection, rebased onto brand-kernel main, ff-merged)
- **User directive**: never default to gpt-4o-mini (or anything). Model choice is now a dedicated wizard step for EVERY flow, driven by the models.dev catalog via `GET /api/onboarding/catalog/models?provider=…` (works for anthropic/openai-codex whose API shape excludes them from the API-key grid).
- **Pinned defaults removed everywhere**: OpenRouter sign-in no longer pins openai/gpt-4o-mini; Anthropic no longer pins claude-sonnet-4-5; Codex no longer pins gpt-5.1-codex. Connect/poll endpoints REQUIRE the chosen chat model; onboarding completes only after selection. API-key form model inputs start EMPTY with catalog datalist suggestions.
- **Embedding fields render only when the catalog says the provider supports embeddings**; otherwise an honest note (memory features need one later). `getCatalogModelLists(providerId)` returns model lists for ANY catalog id (raw entries cached unfiltered).
- **E2E hardening**: root layout sets `body[data-eigen-hydrated]` on mount (SSR hydration replay was wiping values filled pre-hydration); `fillPersisted` verifies the value SURVIVES a settle window and re-fills; flow-id → catalog-id mapping fixed (github_copilot → github-copilot); mock-gateway fixture extended (anthropic/openai-codex/openrouter/github-copilot entries) and its chat replies are now agent-protocol JSON (tool-first, alternating list_projects/answer per the journey contract).
- **Gates: unit 3473 passed, components 13 passed, e2e 6 passed on BOTH deployment shapes, check 0 errors, lint = main's 7 pre-existing.**

**Decisions**
- Model lists come from the live catalog even for API-shape-excluded providers (Claude/Codex sign-ins need model pickers too) — the catalog is the single source of model truth.
- No model default anywhere in onboarding; Continue is disabled until a chat model is picked. Server-side, connect/poll reject empty modelChat (400).
- OpenRouter sign-in carries the chosen models through the PKCE cookie (authorize body → callback save) since its completion is a redirect, not a wizard step.

**Tracked**
- Model pickers list the full catalog for the provider; a "recommended" subset per subscription tier would be a UX refinement.
- Settings → LLM still edits models for the two first-class providers only; fold catalog-wide editing into the legacy-deletion pass.

---
## 2026-09-08 — Phase-2c M1+M2 shipped: brand kernel schema + guideline curation module

**Shipped** (`d71dc6b` plan + `a03fb89` feature, wt/branding, ff-merged)
- **Migration 0076** (`drizzle/0076_branding_tables.sql` + journal idx 76, applied to dev DB + functionally smoked): 10 `brand_*` tables — guideline sets (immutable versions, draft|active|retired, **one-active-per-locale partial unique index** so D3 is DB-enforced), voice examples, lexicon, visual tokens, glossary, criteria, assets, validations, judge metrics, calibration cases. CHECK constraints on every enum-ish column.
- `src/lib/server/db/brand.schema.ts` — drizzle schema (consumed only by modules/brand).
- **`modules/brand`** — store (interface + InMemory + Db + lazy `defaultBrandStore()`; lifecycle guards live IN the store), manifest, **10 kernel tools**: `brand.set_create/update/activate/get/list`, `example_add`, `lexicon_add`, `criterion_add`, `token_add`, `glossary_add`.
- **Guards**: activation requires CARE-complete context + ≥2 exemplars incl. ≥1 good and ≥1 bad (G2); single tone words rejected at zod level; curation writes draft-only; active/retired immutable (G23); `getActiveSet(locale)` fails loud — no implicit "latest".
- **G8/D5 enforcement**: mutation descriptors are admin-role AND handlers reject non-human principals (an agent holding the admin role still gets `permission_denied`); `brand.set_activate` is additionally approval-gated (APPROVAL_REQUIRED_TOOLS).
- Wired in `modules/index.ts`; `index.spec.ts` exact-manifest assertions grown by design.
- **Gates: modules+kernel 411 passed / 1 skipped; db 23 passed / 2 skipped; check 0 errors (24 warnings = main's); lint 7 errors = main's pre-existing baseline, 0 in modules/brand.** Migration smoke: second active set per locale correctly violates the unique index.

**Decisions**
- D1–D5 recorded in `plan/phase-2c-branding-module.md` (visual pipeline out of scope v0; dedicated judge identity + explicit `BRAND_JUDGE_MODEL` unset-loud; per-locale sets; layered disclosure; human-only mutations + activation approval gate).

**Next**
- M3 stream: `brand.content_generate` (N≥3 variants via gateway, judge-rank), deterministic→judge validation pipeline, `brand.content_publish` approval-gated with risk tiers.
- M4 stream (separate — touches `src/lib/server/llm/**`): `brand-context` gateway middleware (G4) — CARE block injection + `guideline_set_id` on call records; generation without an active set fails loud.
- M5: calibration + regression + acceptance sweep (§7 checklist).

## 2026-09-08 — Phase-2c approved: brand kernel implementation starts

**Shipped**
- `plan/phase-2c-branding-module.md` — approved phase plan. `plan/branding-module-rules.md` flips PROPOSED → APPROVED.
- **§8 open questions resolved as decisions D1–D5** (vetoable, recorded in the phase plan): D1 visual-asset pipeline out of scope v0 (owlery bootstraps tokens later); D2 dedicated judge identity + explicit `BRAND_JUDGE_MODEL` (unset = loud failure, never a silent generator-model fallback); D3 per-locale guideline sets, one active per locale, explicit-locale resolution (no implicit "latest"); D4 disclosure = site-level statement + per-asset provenance flag; D5 guideline mutations human-admin-only (handler kind check), `brand.set_activate` additionally approval-gated, agent-proposal flow tracked as follow-up.
- Module id `brand`, tool namespace `brand.*`; milestones M1 schema+migration 0076 → M2 store+manifest+guideline tools → M3 generation/validation/publish → M4 gateway brand-context middleware → M5 calibration/regression/acceptance sweep.

**Next:** M1+M2 on `wt/branding` worktree.

## 2026-09-08 — Phase-2b: subscription sign-ins — Claude Pro/Max + ChatGPT via API-shape adapters

**Shipped** (`7fe61c5` plan + `feb8cc1` feature, wt/subscription-signins, ff-merged)
- **Anthropic (Claude Pro/Max) sign-in**: PKCE authorize (state=verifier) opened in a new tab; user pastes the code/redirect URL back (pi's manual_code pattern — no redirect-allowlist dependency); exchange + refresh at platform.claude.com. OAuth requests authenticate via Bearer with Claude Code identity headers (`user-agent: claude-cli/x`, `x-app: cli`), betas `claude-code-20250219,oauth-2025-04-20`, and the required Claude Code system preamble (pi: buildParams).
- **OpenAI (ChatGPT Plus/Pro) sign-in**: device-code flow (`auth.openai.com/api/accounts/deviceauth/*`, verification page `/codex/device`) — same wizard UX as Copilot. Access token is a JWT; `chatgpt_account_id` claim extracted for the required `chatgpt-account-id` header.
- **API-shape adapters** (`llm/api-shapes.ts`): Anthropic messages (non-streaming, `/v1/messages`) and Codex responses (SSE `/codex/responses` accumulation) normalize to OpenAI shape — llm-client's retry loop, cost logging, and PostHog run unchanged. Dispatch gated by `usesApiShape(provider)`; OpenAI-compat path untouched. Embeddings on subscription providers fail loud naming the fix.
- **llm-client**: resolve-on-expiry generalized — github_copilot, anthropic, and openai_codex rotate and persist tokens on expiry; OpenRouter OAuth keys pass through (never expire).
- **Wizard v3**: subscription step now offers Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, and OpenRouter sign-in — paste-code card and device-code card join the API-key catalog form.
- **E2E**: mock-gateway gained Anthropic token/messages + Codex device/SSE stubs; the Claude test captures the loopback callback REQUEST (Chrome replaces the failed navigation's URL) and pastes the full URL; both flows run a real chat turn through the adapters.
- **Gates: unit 3470 passed, components 12 passed, e2e 6 passed on BOTH deployment shapes, check 0 errors, lint = main's 7 pre-existing.**

**Decisions**
- Anthropic uses manual-code paste (pi's headless pattern) instead of a registered redirect URI — works remotely and self-hosted without any client registration.
- Codex uses the device-code login (not the localhost:1455 browser flow) — same rationale; SSE accumulated server-side (Codex rejects store:true and pi always streams).
- OAuth refresh generalized: anthropic/openai_codex/github_copilot rotate-and-persist on expiry inside loadLlmProviderConfig.

**Tracked**
- OpenRouter sign-in + catalog model defaults are pinned conservatively (gpt-4o-mini / text-embedding-3-small / claude-sonnet-4-5 / gpt-5.1-codex); model PICKERS for subscription providers (catalog or /models endpoints) are the next UX refinement.
- answer_question/retrieve chaining in the agent journey means a first-turn plain answer is rejected (tool-first contract) — subscription e2e asserts the turn completes, not the reply content (journey tests already cover reply semantics with real providers).

---
## 2026-09-08 — Phase-2a: provider onboarding — method → provider (pi-inspired, catalog-driven)

**Shipped** (`01eab7a` plan + `b338c48` feature, wt/provider-catalog-onboarding, ff-merged)
- **Research**: pi's `packages/ai` auth architecture — type-tagged credentials (`api_key | oauth`), `OAuthAuth.isSubscription`, normalized events (`auth_url`, `device_code`). Ported the two web-native flows and adopted **models.dev** (the open model catalog pi generates from) as the provider catalog.
- **Wizard v2 — two questions**: ① "Use a subscription I have" vs "Use an API key" ② provider selection — subscription lists **GitHub Copilot** (device flow) + **Sign in with OpenRouter** (PKCE → permanent key); API-key lists the models.dev catalog (OpenAI-compatible only, chat/embedding model counts, search) with EUrouter pinned first-class.
- **GitHub Copilot subscription, full e2e**: device code shown in the wizard → server polls → GitHub token exchanged for a short-lived Copilot token (proxy-ep → api base derivation, model list) → stored tenant-encrypted (`auth_type/oauth_*` columns, **migration 0075**). Chat-only by design: embeddings absence fails loud naming the fix.
- **OpenRouter sign-in**: `authorize` sets an httpOnly PKCE verifier cookie, OpenRouter redirects back with `?code=`, exchanged for a permanent key, saved + onboarding completed + redirected to `/`.
- **llm-client generalized**: provider ids are free-form text (new providers never need migrations); all non-EUrouter providers route by direct model; OAuth rows resolve + refresh transparently (rotated access persisted under the store lock semantics of `loadLlmProviderConfig`).
- **Gates: unit 3456 passed, components 10 passed, e2e 4 passed on BOTH deployment shapes (incl. the full Copilot device flow headlessly via mock-gateway stubs), check 0 errors, lint = main's 7 pre-existing.** Migration 0075 applied to the dev DB.

**Decisions**
- v1 subscription providers = Copilot (device flow — fully web-native, no client-secret) + OpenRouter sign-in (PKCE with caller-controlled callback). **Claude Pro/Max and ChatGPT subscriptions are the deliberate next step**: they need a redirect-allowlist strategy + Anthropic/Codex API-shape adapters — pi's `anthropic.ts`/`openai-codex.ts` are the reference implementations.
- models.dev is a live dependency with loud failure + retry (never a silent fallback); `MODELS_DEV_CATALOG_URL` / `OAUTH_GITHUB_*` env overrides exist for e2e determinism.
- Wizard strictness by catalog: embedding-capable providers require an embedding model (memory depends on it); chat-only providers (Copilot) warn and defer.

**Tracked**
- Claude/ChatGPT subscription OAuth + Anthropic/Codex API-shape adapter (next pass).
- Settings → LLM remains the legacy two-provider surface; catalog providers currently manageable only via onboarding (reconnect flow = revisit onboarding) — fold into the legacy-deletion pass.

---
## 2026-09-08 — Phase-1d: first-run onboarding IS the first screen (nucleus, ground-up)

**Shipped** (`a1fb017` plan + `8972baa` feature, wt/nucleus-first-run-onboarding, ff-merged)
- **The wizard IS the page**: open `/` without a working provider → `ProviderOnboarding` (nucleus design: white, black borders, sharp, tracked uppercase wordmark) replaces the chatbox entirely. Provider tiles (OpenRouter / EUrouter) → adaptive credential fields → **Connect runs a real 1-token gateway call** (`testLlmProviderConnection`, config-driven routing — env cannot silently complete wizard creds) **before saving** (`saveProviderConfig` + `onboardingCompleted=true`). No skip: no provider, no product. Operator-hint branch for BYOK-disabled deployments.
- **Landing flip /capture → /** — signup (load, callbackURL ×2, post-success), login (×4), settings resetOnboarding. Onboarding is literally the first thing on opening the page; e2e helpers follow (`waitForURL '/'`).
- **Nucleus gate**: load returns `needsOnboarding = !harness && !providerReady` — returning users whose provider vanished see the wizard again; harness accounts never do.
- **Legacy surface reverted to pre-1c**: capture overlay back to its 3-step EigenMesh shape (deletion stays a deliberate later call); capture page lost the 1c provider-step additions.
- **`scripts/mock-gateway.mjs`** — OpenRouter-compatible mock gateway as a second playwright webServer: the wizard's real test-call is proven e2e against a reachable gateway (dummy-URL runs correctly fail the test — feature working as designed).
- **Gates: unit 3442 passed, components 8 passed, e2e 3 passed on BOTH deployment shapes (platform env emptied + present), check 0 errors, lint = main's 7 pre-existing.**

**Decisions**
- Ground-up per user directive: EigenMesh onboarding copy/design is not carried over; the wizard is EE-native and gates the chatbox. First-run has no skip — fail loud at the front door.
- Connection proof is a real gateway request (1 token, activity-logged), not a key-format check.
- Wizard requires complete working credentials (EUrouter: both rule UUIDs; OpenRouter: both models) — stricter than the permissive Settings form, by design.

**Tracked**
- `release-helpers.completeOnboardingOverlay` still walks the removed install step (pre-existing; production-user e2e helpers need a rewrite for the wizard-first flow).
- Old eigenmesh copy remains in the legacy capture overlay + `/settings` pages until the deliberate legacy-deletion pass.

---
## 2026-09-08 — Phase-1c: onboarding provider setup — LLM config is user-facing, not an env dead end

**Shipped** (`92f96dd` plan + `215c303` feature, wt/onboarding-provider-setup, ff-merged)
- **Typed `LlmNotConfiguredError`** (`src/lib/server/llm/errors.ts` + `isLlmNotConfiguredError` cause-chain walk) thrown by platform-llm, llm-client loaders, llm-config-guard, preferences. Chat error terminal payload threads `code: 'llm_not_configured'` on the wire; `ChatStreamError` carries it. Zero string matching.
- **Onboarding step "Connect your AI provider"** in `capture-onboarding-overlay.svelte` (id-based step flow frozen at mount): EUrouter (base URL + key + rule UUIDs) / OpenRouter (base URL + key + model names). Skippable; operator-hint branch when `BILLING_BYOK_UI_ENABLED=false`. Only shown when `isUserProviderReady` is false (mirrors `loadLlmConfig` fidelity: billingMode-aware, non-throwing env check).
- **`saveProviderConfig` service** — one persistence path for Settings → LLM and the onboarding action (validate, tenant-encrypt, upsert `llm_provider_config`, active provider, `billingMode → byok`). Settings action slimmed to form-parse + BYOK-UI gate.
- **Failed chat turns get a door**: nucleus renders "Set up your AI provider →" under the failed bubble when `code === 'llm_not_configured'`.
- **E2E** (`onboarding-provider.e2e.ts`, 3 tests, green on BOTH deployment shapes — provider env present and emptied): step shown+save via onboarding form, step hidden once BYOK creds exist (via settings form, deterministic on any deployment), skippable.
- **`E2E_PORT` playwright override** — a worktree checkout can e2e its own build instead of silently reusing another checkout's dev server on 5173 (reuseExistingServer trap; cost ~an hour to diagnose — the bug ran main's suite against a stale server and "passed" 14 unrelated tests).
- **Gates: unit 3424 passed, components 8 passed, e2e 3 passed, check 0 errors, lint errors = main's 7 (all pre-existing kernel).**

**Decisions**
- Chat failure deep-links to `/settings/llm` (one form, no duplication) — orchestrator call, user approved plan without picking.
- Onboarding provider setup = per-user BYOK (existing semantics); platform service-account env stays the operator path — coincident in single-tenant self-host.
- Provider step visibility is load-derived (`providerReady`), never an execution gate: the gateway still fails loud; the UI only adds a door.
- Component spec for the overlay enrolled in the browser gate with `$app/*` stub modules (`src/lib/vitest-stubs/`) + alias in `vitest.browser.config.ts` (vi.mock can't intercept virtual modules that fail import-analysis).

**Broke / found**
- `capture-onboarding-overlay.svelte.spec.ts` was stale since the billing strip (`ebf9295`) — expected an install/wallet step the component no longer had; rewritten and enrolled in the browser gate.
- Pre-existing, NOT fixed here (different workstreams): `release-helpers.completeOnboardingOverlay` still expects the removed install step (breaks production-user e2e helpers); `auth.e2e` `text=Capture` strict-mode failure; capture/pricing e2e need LLM env; `tests/qa-*` call the stripped billing API; `release.e2e` PayPal preflight. Kernel lint errors (7) pre-exist on main.
- Worktree checkouts need `.env` copied manually (untracked) or module-init env guards throw; hermetic specs are unaffected.

**Next:** nucleus `/` surface — route auth redirect flip to `/`, identity-in-chatbox; then Phase 2 owlery internalization.

---
## 2026-09-08 — THE NUCLEUS: one white screen, one chatbox

**Shipped** (`9829262` nucleus + `693a5a6` hermetic-env fix + auth dev-links `ea8f5e4`)
- **`/` is now the nucleus**: white screen, one chatbox (text + Qwen ASR mic via existing `/api/capture/transcribe`), streaming replies via `/api/chat`. No nav, no module concepts, no eigenmesh landing (deleted). `(nucleus)` route group pins light palette; console routes still exist as unlinked internal tooling (deletion policy: later, deliberate).
- **Journey seed** in the orchestrator persona: founding requests open the brand journey — tone of voice first, one question at a time. Wired through `AGENT_SYSTEM_PROMPT` (critical fix: `/api/chat` runs the legacy agent-loop, which never saw the persona).
- **Auth links print to terminal in dev** (`ea8f5e4`) — no local mail server needed.
- **Env truths reconciled**: user `.env` had a duplicate placeholder OWLERY block; Vite dotenv (last-wins) saw it as configured, CLI loader (first-wins) as unconfigured — the login lockout + 2 flaky specs traced to this. `.env` cleaned; specs now mock `$env/dynamic/private` hermetically (`693a5a6`).
- **Main: 1112 tests green, check at 0 errors.**

**Decisions**
- The surface hides the console; nothing is deleted without a decision. Brand-token re-skin happens via the brand kernel phase — visual identity stays green for now.
- ASR transcript fills the input (user reviews before send), not auto-send.

**Tracked (honest list)**
- `/api/chat` still runs the legacy agent-loop, not the kernel AgentRuntime — unify so the chatbox speaks through the harness proper.
- Post-auth redirect still lands on `/capture` (e2e helpers cascade) — flip login/signup → `/` in a dedicated stream.
- Identity-in-chatbox (no boring /login page) — journey design later.

---
## 2026-09-08 — Dev instance live on :5433; test DB rebuilt from scratch (1206/1206)

**Shipped**
- Compose: containers renamed `eigen-enterprise-*`; EE db on **host 5433** (legacy eigen stack keeps 5432) — `.env.example` updated.
- Fresh-boot infra fix inherited from eigen: `01-extensions.sh` sets `search_path` before `::agtype` index casts (first boot on a clean volume previously failed all four graph indexes).
- `eigen-enterprise-db` running + healthy; `eigen_test` created with the FULL init chain (vector+age+graph+labels+indexes, `eigen_app` role + grants, pg_cron/pg_net), 75 migrations applied, **RLS applied (`db:rls`) — the missing piece behind the "pre-existing" integration failures: RLS policies are not part of migrations**.
- Verification: **1206/1206** (kernel/modules/cli/mcp/db/activity/routes) on the new instance, including the tenant-secrets RLS integration specs.

**Decisions**
- Test DBs must bootstrap with `db:migrate` + `db:rls` (migrations alone ≠ RLS). Follow-up candidate: `db:test-up` script automating create+init+migrate+rls.
- Old eigen-db (5432) untouched; its eigen_test is obsolete.

**Smoke test fully unblocked:** `.env` → `DATABASE_URL=...localhost:5433/eigen`; `db:up` → `db:migrate` → `db:rls` → `dev`; activations + allowlist SQL per bootstrap.ts docs.

**Next:** Phase 2 — owlery internalization (EmailProvider port), then sales (Phase 3).

---

## 2026-09-08 — Startup wired + company feed live (smoke-test ready)

**Shipped** (wt/startup `4951da0`, wt/activity `2fafd7d`, MCP-spec fix `4b6ef81`)
- **`src/lib/server/boot.ts`** — the composition root: `bootApp()` memoized single-flight (failed boots do NOT cache — retry recomposes fresh); kernel → bootstrapOrchestrator(kernel, wireGateway, { engines: [['pi', piEngine]] }) → bootstrapChatGateway stage; env injectable. `src/hooks.server.ts` triggers it additive + loud-fail.
- **Company feed** — `/activity` now renders `kernel_events` (agent.*, tool.executed, gateway.telegram.*, dev-agent.*) via `listKernelEvents` read-model + `toFeedItem` whitelist (metadata only; content fields proven excluded by tests). Full emitted-type inventory grepped + pinned.
- **Stale HTTP-MCP spec fixed** — broadened verification scope to `src/routes` exposed a seed-era spec asserting the pre-kernel contract (unprefixed tool name, no activation). Now: fixture kernel (memory activated, real descriptors, mocked impls), namespaced `memory.retrieve_thoughts`. 655/655 in src/routes.
- **Main state: kernel+modules+cli 446, mcp 56, routes 655, boot/activity included — check at 5-error baseline.**

**Flags**
- 6 pre-existing eigen_test integration failures (tenant-secrets, ontology-db, retrieval, thought-lifecycle) — test-DB schema drift; `npm run db:migrate` against eigen_test before smoke test.
- Feed open items: `textLength` whitelist field, `website.contact.captured` inclusion, load-more cursor — later touches.

**SMOKE TEST (user runs)**
1. `npm run db:up && npm run db:migrate`
2. `.env`: TELEGRAM_BOT_TOKEN, LLM gateway creds
3. SQL: activate `chat-gateway` + `memory` (+`email`); allowlist Telegram user → principal; seed `orchestrator` principal row
4. `npm run dev` → message the bot → orchestrator responds via builtin-json engine; /activity shows the events
5. hermes: point MCP at `/api/mcp` (session user) or Bearer key (agent principal)

**Next:** Phase 2 — owlery engine internalization (EmailProvider port first), then sales (Phase 3).

---

---

## 2026-09-08 — THE HARNESS IS IN (AgentRuntime + LoopEngine + PiEngine)

**Shipped** (`034c1f1` harness + `a6996af` pi-engine + orchestrator integration, merged to `main`)
- **Kernel primitives**: `kernel/agent.ts` (AgentConfig/AgentTypeSpec), `kernel/engine.ts` (EngineContext + LoopEngine — the harness hands engines tools/approvals/events/spend; engines own model/prompts/strategy), `kernel/agent-runtime.ts` (dispatch pipeline: unknown_agent → agent_disabled → unknown_engine → budget → dispatched → run → replied; payloads metadata-only), `kernel/tool-surface.ts` (shared fail-closed filter: activation ∩ scope ∩ roles), `kernel/agent-admin.ts` (`agent.list/enable/disable`, owner-gated), `kernel/pi-engine.ts` (headless pi as a hosted engine; canonical PI_GUARDRAILS; spawn seam injected).
- **Demotions done**: orchestrator brain → thin adapter over AgentRuntime; orchestrator = seeded AgentConfig (`builtin-json` engine, `EE_HARNESS_SPEND_CAP_USD`, malformed = boot fails loud); dev-agent runner delegates spawning to PiEngine.
- **Manifest extension (additive)**: `agents?: AgentTypeSpec[]`, `verification?: VerificationPolicySpec[]` — third parties can ship agents, not just tools.
- **Integration (orchestrator, on main)**: resolved harness × gateway-extraction conflicts (brain.ts adapter keeps `$lib/kernel/gateway` port; bootstrap keeps composition-root shape `bootstrapOrchestrator(kernel, wireGateway, options)` + runtime seeding; bootstrap.spec reconciled to three-arg convention); unified pi-engine's structural EngineContext mirror into the canonical type; added `options.engines` injection seam so the composition root hosts `pi` without module-to-module imports (boundary guard stays green). New test proves engine injection via dispatch.
- **Main: 446 (kernel+modules+cli) + 56 (mcp) = 502 tests green; `npm run check` at 5-error baseline.**

**Decisions**
- Adding an agent = one AgentConfig + zero new code; it inherits permissions/approvals/events/spend/verification. The orchestrator holds no code privilege — deleting/replacing it touches no kernel code.
- Spend cap: single cap on the harness agent itself (`EE_HARNESS_SPEND_CAP_USD`); no granular per-agent limits (user decision).
- Sessions in engines: in-memory Maps (documented debt); gateway-cost accumulation wiring = follow-up (spend currently via `recordSpend`).
- Merge-conflict lesson recorded: parallel sessions on `main` + long-lived worktrees = textual conflicts on shared files; integration unification is orchestrator work.

**Next**
- Startup call site that composes kernel → orchestrator → gateway (pending since gateway extraction) — then the live Telegram smoke test.
- Apply `agent.*` events on the wire (activity feed UI); persisted sessions; gateway-cost spend accumulation into the runtime.
- Then per roadmap: owlery internalization (Phase 2), sales (Phase 3), brand kernel.

---

## 2026-09-08 — Gateway contract moved into the kernel (declared edges now zero)

**Shipped** (`56d8c80`, merged to `main`)
- New `src/lib/kernel/gateway.ts`: the chat-gateway port lives in the kernel now. It holds `TelegramSessionRef`, `Brain`, `AllowlistEntry`, `AllowlistStore`, `GatewaySession`, `SessionStore`, plus the `CHAT_GATEWAY_MODULE_ID` and `CHAT_GATEWAY_ALLOWLIST_TOOLS` constants. chat-gateway imports them from the kernel; every local copy is gone, no re-export shims inside modules.
- New `src/lib/kernel/wiring.ts`: `WiredKernel` and `registerModuleTools()` moved here from modules/index.ts. The composition root still assembles the kernel, but the wiring types belong to the kernel.
- `modules/index.ts` gained the gateway boot stage: `bootstrapChatGateway(kernel, brain, { env, db? })` returns the boot object, or null when the module is inactive. The fail-loud token rule is unchanged: an active gateway without `TELEGRAM_BOT_TOKEN` still aborts startup. `bootstrapOrchestrator(kernel, wireGateway, options?)` now takes the kernel as a parameter and hands the brain to the injected gateway stage. It has no caller yet (startup wiring is still pending the user's live smoke test), so the signature change breaks nothing.
- `DECLARED_WIRING_EDGES` is an empty Map, pinned by test. The repo scan passes with zero exceptions: no module imports another module or the composition root.
- Verification: 327 passed / 1 skipped (kernel + modules), `npm run check` at the 5-error baseline, lint clean on touched files.

**Decisions**
- The kernel owns the port (the `Brain` type the gateway consumes), while phase 1b decides who implements it (BuiltinJsonLoop). The two streams stack cleanly.
- modules/index.ts re-exports `WiredKernel`/`registerModuleTools` because src/cli, mcp/server, and admin-bootstrap import them from there and sat outside this stream's scope. Re-pointing those imports is a small chore, not urgent.

**Next:** phase 1b harness streams (wt/harness, wt/pi-engine); startup call site that composes kernel → orchestrator → gateway; then the HTTP tool route.

---

## 2026-09-08 — wt/harness: AgentRuntime + LoopEngine kernel primitive (orchestrator demoted to config)

**Shipped** (branch `wt/harness`, phase-1b)
- `kernel/agent.ts` — AgentConfig (id === principal id), AgentTypeSpec, VerificationPolicySpec, AgentSessionRef, LoopEngineId.
- `kernel/engine.ts` — `EngineContext` { agent, principal, executeTool, listTools, emit, spendUsd } + `LoopEngine` (type alias for lint; structural). Tool list is precomputed per dispatch → `listTools()` sync.
- `kernel/tool-surface.ts` — THE shared filter (activation ∩ role intersection ∩ agent module scope, fail closed); runtime + orchestrator both resolve surfaces through it. MCP listing untouched (activation-only subset).
- `kernel/agent-runtime.ts` — dispatch pipeline: unknown_agent → agent_disabled → unknown_engine → budget check (emit `agent.budget_exceeded` + throw before any run) → emit `agent.dispatched` → engine.run → emit `agent.replied` {replyLength} (payloads metadata-only, never content). `stop()` = disable + `agent.stopped` (v0; in-flight cancellation is engine-dependent, documented). `recordSpend()` + injected `spendFn` + injected `rolesFor` (AgentConfig carries no roles; default `['agent']`).
- `kernel/engines/builtin-json.ts` — brain loop extracted verbatim (think-strip, fence-strip, brace-balance, parse-retry ×3 default, approval_pending UX, history cap 40, 8 iterations, 12k tool-result chars). Kernel-local `EngineChatMessage`/`LlmCompleteFn` (no kernel→server import); `llmUserId` defaults to `ctx.agent.id`.
- `modules/orchestrator/brain.ts` — thin adapter (identity data + `respond` → `runtime.dispatch`, `offeredTools` → `runtime.listAgentTools`); `bootstrap.ts` seeds the runtime (`orchestrator` config, `builtin-json` engine, `EE_HARNESS_SPEND_CAP_USD` → spendCapUsd, malformed = boot fails loud) — **flagged modules/** edit.
- `kernel/agent-admin.ts` (new) — module `agent`: `agent.list` (read, admin+agent), `agent.enable`/`agent.disable` (mutate, owner-only), self-seeded active from orchestrator bootstrap.
- Manifest extension (additive): `ModuleManifest.agents?: AgentTypeSpec[]`, `.verification?: VerificationPolicySpec[]` + zod schema; v0 declarative only, nothing enforces.
- `kernel/errors.ts` — 6 new loud codes: unknown_agent(404), agent_disabled(409), duplicate_agent(409), unknown_engine(500), duplicate_engine(409), budget_exceeded(402).

**Verification:** kernel+modules+cli 424 passed / 1 skipped (baseline 383; brain.spec 14 tests moved to `engines/builtin-json.spec.ts`, ~27 net new); mcp+modules w/ test DB 252 green; check = exactly 5 baseline errors; lint: 0 errors in harness files (7 pre-existing elsewhere).

**Decisions / flags**
- Spend wiring: gateway-cost.ts exposes parsers only — no per-principal accumulation query exists in `llm/` → default is a per-runtime in-memory accumulator via `recordSpend(agentId, usd)`; gateway-cost wiring documented follow-up (llm/** untouched).
- Sessions in engines are in-memory Maps (documented debt, same as Phase-0 brain).
- brain.spec deleted (moved) — OrchestratorBrainError → `LoopProtocolError` (LoopProtocolError is the engine's class now).

**Next:** apply events on the wire (activity feed), PiEngine (`wt/pi-engine`, no modules/index edits), persisted sessions + gateway-cost accumulation.


---

## 2026-09-08 — Kernel open-API round 2 merged (manifest schema, problem+json, boundary guard, event provenance)

**Shipped** (4 worktree streams → `main` @ `d3451ec`)
- **wt/manifest-schema** (`fa3674d`): `kernel/manifest-schema.ts` — published Zod→JSON Schema contract for `ModuleManifest`, fail-loud in `ModuleRegistry.register()`. **Fix-forward** (`d3451ec`): `tools: []` is valid (toolless modules legitimate — caught by `admin-bootstrap`/`brain` fixtures exercising `registerModuleTools`; schema was over-constrained, fixtures were right).
- **wt/problem-json** (`d12dc11`): `KernelError.toProblemJson()` — RFC 9457 (urn:eigenenterprise:problem:<code>, exhaustive title map = type error on missing entry, status map + 500 fallback); OpenAPI `components.schemas.problem` + problem+json on 400/401/403.
- **wt/event-source** (`6a3dd57`): `KernelEvent.source` + persistence (drizzle `0074_kernel_event_source` + journal idx 74 — **migration not yet applied**), `moduleSource()`/`KERNEL_EVENT_SOURCE` urns, `toCloudEvent` resolution `event.source ?? source` (throw if neither), all 7 emit sites wired (registry audit per-module, dev-agent ×4, website ×1, chat-gateway ×2).
- **wt/boundaries** (`45e5306` + `33b33d5`): `kernel/boundaries.ts` import-specifier detector (resolves relative specifiers, catches dynamic + export-from + bare forms) + repo-scan test. **The guard earned its keep on day one: 11 real `orchestrator→chat-gateway/index` edges found** (orchestrator = boot stage wiring the gateway surface) — codified as `DECLARED_WIRING_EDGES` pinned by test, not silently ignored.
- Verification on main: 370 passed / 1 skipped, only `mcp/registry.spec.ts` fails (`DATABASE_URL` — user-started DB, known); check = 5 baseline errors; lint clean.

**Broke / flags**
- Manifest validation broke 2 fixture files with fake `tools: []` manifests → root cause was the schema rule, not the fixtures; fixed schema, reverted fixture edits.
- Orchestrator still structurally coupled to chat-gateway internals (types, stores) — declared, tracked.

**Decisions**
- Toolless manifests are valid; tool-name pattern allows snake_case (all 20+ real tools use it) — published contract documents reality.
- Cross-module wiring edges are *declared policy* with reasons, zero by default; contract extraction (gateway types → kernel) is the follow-up that shrinks the set.
- problem+json 404/409 surfacing deferred until the HTTP tool route exists.

**Next:** extract chat-gateway contract to kernel (kill declared edges); apply migration 0074 (`npm run db:migrate`, user-started DB); HTTP tool route mounting registry with bearer → principal mapping.

---

## 2026-09-08 — Kernel open-API standards round merged (output schemas + CloudEvents)

**Shipped** (`49ae71c` + `1585d9b`, merged to `main` @ `575ea06`)
- `plan/kernel-open-api.md` — approved standard stack: JSON Schema 2020-12 contracts (one Zod source → MCP + OpenAPI), registry-`execute()`-only inter-module calls (zero side doors), CloudEvents 1.0 event envelope, OpenAPI 3.1 edge; A2A watched, not adopted. Rejected: gRPC, direct imports, bespoke wire protocol.
- **wt/output-schema** (`49ae71c`): `ToolDescriptor.outputSchema?: ZodType`; `execute()` validates handler results pre-audit (`invalid_output`, audited `ok:false`, vcs commit skipped); MCP `tools/list` + OpenAPI 200 responses advertise compiled output schema (`io: 'output'`); parity test covers output round-trip. `errors.ts`: `invalid_output` added (coexists with `run_in_progress` from the dev-agent stream).
- **wt/cloud-events** (`1585d9b`): `kernel/cloudevents.ts` — CloudEvents 1.0 `CloudEvent` type, `toCloudEvent(event, source)` mapper (source explicit per call site — no implicit defaults), `eventType()` reverse-DNS convention `com.eigenenterprise.<module>.<name>`. Envelope derived at boundaries — **no kernel_events migration** (open-api plan rule 4).
- Verification on main: 325 passed / 1 skipped (kernel + mcp + modules); only failure = `mcp/registry.spec.ts` `DATABASE_URL` missing (known — user starts dev DB). `npm run check` = 5 documented baseline errors; lint clean.

**Broke / flags**
- `main` advanced mid-stream (`40a3654` dev-agent/website/cli) — both branches merged main first, then landed; `errors.ts` union auto-merged (both new codes coexist). Worktree `node_modules` symlinked from main checkout this round — fast, worked clean.

**Decisions**
- Output validation lives inside the handler `try` (reuses existing audit-`ok:false`-rethrow path; no duplicated audit logic).
- CloudEvents adapter only this round — wiring explicit `source` into all emit sites is a follow-up on main.

**Next (from `plan/kernel-open-api.md` §Later):** manifest JSON Schema at registration, problem+json error shape, cross-module import guard, emit-site `source` wiring.

---

## 2026-09-07 — dev-agent shipped: the repo can now improve itself (gated)

**Shipped**
- **Security chore** (`8f55e76`): redacted hardcoded production Bearer token inherited from eigen in `.pi/extensions/eigen-mcp.ts` → env-based (`EE_MCP_URL`/`EE_MCP_TOKEN`, no fallback). Token remains in seed git history — repo never pushed; rewrite optional.
- **wt/devagent** (`c513370`): `modules/dev-agent` — pi-driven self-improvement. Tools: `dispatch` (external, owner+agent), `status`, `logs` (read), `merge` (mutate, **owner-only**), `abort`. Lifecycle: dispatched → running (pi headless `pi -p --mode json` in sandbox worktree `../ee-da-<id>`, single-flight) → verification gate (vitest + check in worktree) → green|red → merged|aborted. Runs persisted (`kernel_devagent_runs`, idx 73). All seams injected (PiRunner/CommandRunner) — zero real pi/git in tests. `.pi/skills/dev-agent-protocol/` documents the contract. Kernel: `run_in_progress` added to error union (orchestrator).
- **Main: 378/378 tests, `npm run check` at baseline.**

**Decisions**
- `dev-agent.dispatch` NOT approval-gated: the owner-gated merge is the control point; dispatch is audited, single-flight, 15-min capped. Policy can add it later.
- pi binary: `PI_BIN` override, default `'pi'` on PATH (binary-name default, not an env fallback).
- pi output persists truncated (4000) in `result_summary`; never logged at info.
- Local test DB: `postgres://eigen:eigen@localhost:5432/eigen_test` (created + migrated 0000→0073 during this stream); bootstrap script still owed.

**The recursive loop (how to use)**
1. `ee tool run dev-agent.dispatch --input '{"task":"…"}' --principal <owner-id>` (or via Telegram/orchestrator delegation, or MCP from hermes)
2. pi works in a sandbox worktree; kernel verifies tests+types
3. `ee approvals`-style review → `ee tool run dev-agent.merge --input '{"run_id":"…"}' --principal <owner-id>`
4. Merged changes become the new baseline — including changes to the agent itself.

**Next**
- First real dogfood: dispatch a small improvement task end-to-end (needs dev DB running + pi configured).
- Phase 2: owlery engine internalization; Phase 3: sales; brand kernel (plan/phase-1-baseline.md follow-ups).

---

## 2026-09-07 — CLI + Website merged (Phase 1 baseline)

**Shipped**
- **wt/cli** (`aeaf04b`): `src/cli/` — `ee` CLI as **thin dispatcher over kernel registry tools** (no special powers, no MCP hop). Commands: `status`, `tool list/run`, `module list/activate/deactivate`, `approvals list/decide`, `openapi`. New kernel admin tools (`kernel.module_*`, `kernel.approvals_*`) registered via new `admin-bootstrap.ts` ('kernel' module self-active by design). Principal: `--principal`/`EE_CLI_PRINCIPAL_ID`, fail loud. Exit codes: 0/1/3 (approval_required). Runner: tsx (already in devDeps), `npm run ee`.
- **wt/website** (`d15db04`): `modules/website` — content objects (`website_content`: slug/kind page|doc/visibility), tools `create/update/publish/get/list_page`, public rendering at `/s/[slug]` (private→404), contact capture `POST /api/website/contact` → `website_contact` + `kernel_events('website.contact.captured')` (ids only, no content). Markdown via marked+DOMPurify (chat's citation-rewriting deliberately not reused). Tables idx 72. `modules/index.ts` additive registration.
- **Main: 335/335 tests green, `npm run check` at baseline.**

**Decisions**
- CLI decision REVERSED (user): agents need an in-process execution surface; MCP stays external-facing (hermes/opencode), CLI is the company-agent's native hands. Recorded in `plan/phase-1-baseline.md`.
- Baseline company = website + agent (orchestrator), extensible via module contract.
- 'kernel' admin module self-active: can't gate on the store it administers.
- `/s/[slug]` fully anonymous = correct (it's the public web).

**Flags / debt**
- No `bin` entry yet (script suffices; add when packaging). No seeded-DB `ee status` smoke script yet.
- No rate limit on contact endpoint; no contact-listing surface (sales phase); `website.contact.captured` has no consumer yet.
- `modules/index.spec.ts` exact-manifest assertions grow with each module (by design).

**Next**
- Agent self-improvement loop: `pi` agent on this repo (user request) — messages → code changes → kernel-verified (tests/check) → git-committed. Design first: agent principals can already execute every tool; the missing piece is *code execution + repo access* governance (which tools mutate the repo, review gates).
- Then: owlery internalization (Phase 2), sales (Phase 3), brand kernel.

---

## 2026-09-07 — **PHASE 0 CODE-COMPLETE** (orchestrator merged)

**Shipped** (`ab7e84f`, merged to main)
- `modules/orchestrator/`: **brain** (orchestrator persona = agent principal `orchestrator`/roles admin+agent; mirrors agent-loop's JSON tool protocol but executes via `kernelRegistry.execute`; tool surface = registry ∩ activated modules ∩ role-intersection — fail closed; all LLM via `llmChatCompletion` gateway), **loop** (sequential 25s long-poll, 1s→30s backoff, abortable; job-queue deliberately not used — blocking poll ≠ cron), **allowlist admin tools** (`chat-gateway.allowlist_add/remove/list`, owner-only), **bootstrap** (fails loud only when chat-gateway activated but token missing; SQL upsert documented for activations + orchestrator principal row).
- Approval-pending UX: `approval_required` → structured `{"status":"approval_pending"}` tool result instructing the model to tell the user it's pending — the model cannot claim execution.
- **Main state: 212/212 tests green (24 files), `npm run check` = 5 documented baseline errors, lint = baseline.**

**Decisions (orchestrator)**
- App must boot `bootstrapOrchestrator()` at startup (first-call-wins singleton ordering).
- Parse-failure after retries: fail loud → Telegram redelivery (at-least-once). No apology-degradation.
- Orchestrator memory ownership: principal row seeded at bootstrap; ownership refinement deferred to memory-scoping work (Phase 4).

**Phase 0 exit criteria — status**
| Criterion | Status |
|---|---|
| One registry → MCP + OpenAPI | ✅ parity-tested |
| Principals incl. agents, permissions, approvals | ✅ tested |
| Append-only events, activation gating, git auto-commit | ✅ tested |
| Modules: memory, email, chat-gateway manifested | ✅ |
| Orchestrator answers via Telegram | ✅ code-complete — **live smoke test pending user** (needs: `npm run db:up` + `db:migrate`, `TELEGRAM_BOT_TOKEN`, activate `chat-gateway` + `memory`/`email`, allowlist owner's Telegram ID) |

**Known debt (tracked)**
- Web push inert (SW deleted with PWA strip) — Telegram is the channel for now
- `billingMode` column + wallet tables still in DB schema; eigen-green theme; "Eigen Mesh" i18n strings; PWA deps in package.json
- `modules/**` outside svelte-kit tsconfig include; kernel lint chores (interface→type, caught-error rule)

**Next: Phase 1 — Website module** (content objects, brand kernel, public rendering, contact capture) per `plan/phase-0-kernel.md` §Later phases.

---

## 2026-09-07 — Round 2 merged: wire + chat-gateway

**Shipped**
- **wt/wire** (`1c46348`): DB-backed kernel stores (`kernel/db-stores.ts` → kernel_principals/events/module_activations/approvals), module activation gating in `registry.execute` (fail closed when ActivationStore injected), `modules/memory` (7 tools wrapping existing MCP memory impls) + `modules/email` (send_mail=external, add_contact=mutate, list_contacts=read via thin owlery runners), MCP server (`tools/list`+`call`) now renders from the kernel registry, OpenAPI 3.1 generator (`kernel/openapi.ts`), parity test (MCP ↔ OpenAPI ↔ registry).
- **wt/gateway** (`fb9de70`): `modules/chat-gateway` — Telegram long-polling client (DI'd fetch), allowlist→principal resolution (fail closed, denied events carry no content), session upsert, paragraph-aware chunking (4k), `chatGatewayEnv` fails loud without `TELEGRAM_BOT_TOKEN`; tables `kernel_gateway_allowlist`/`kernel_gateway_sessions` (migration idx 71). Brain interface injected — orchestrator loop comes next.
- **Orchestrator on main**: widened approval gate to all non-read tools (`registry.ts`; vcs commit stays mutate-only). `email.send_mail` now halts as `approval_required` — wire's placeholder test updated to assert the decided semantics. Repaired NUL-corrupted `chat-gateway/stores.ts` (subagent write artifact; content intact, git had classified it binary).
- Verification: **178/178** tests green (kernel 58, mcp+modules 120); `npm run check` = 5 documented baseline errors only.

**Broke / flags**
- Root `vitest.config.ts` now includes `modules/**`; colocated `modules/chat-gateway/vitest.config.ts` kept as scoped runner (redundant but harmless).
- `modules/**` sits outside svelte-kit tsconfig include — typechecked transitively; consider tsconfig addition later.
- Pre-existing lint errors in `src/lib/kernel` files (interface→type, caught-error rule) — chore pending.
- DB-dependent suites need `DATABASE_URL` (dev DB not started this session — user starts it).

**Decisions**
- Approval gate: `auditClass !== 'read'` (external actions leave the company — approvals apply). VCS commit: `mutate` only (repo-state changes only).
- MCP principal mapping (Phase-0 parity): session user → human/admin; Bearer key → agent/admin+agent. Real PrincipalStore wiring into auth = next stream.
- Poll-loop ownership + offset persistence + allowlist bootstrap UX + orchestrator persona wiring = next workstream.

**Next**
- `wt/orchestrator`: seed orchestrator persona (agent principal), `Brain.respond` → kernel registry tools via existing agent-loop + LLM gateway; poll loop on job-queue tick; allowlist bootstrap tool; PrincipalStore→auth wiring.

---

## 2026-09-07 — Branding guideline module ruleset (plan only, no code)

**Shipped**
- `plan/branding-module-rules.md` — 25 normative rules (G1–G25) for the future brand-kernel module, derived from NN/g's "Using AI for UX Work" study guide + 32 linked articles (full-text analysis via 4 parallel research subagents; podcasts/videos excluded). Includes kernel-architecture mapping, data-model sketch, validation pipeline, anti-pattern catalog, acceptance criteria, open questions.

**Decisions**
- Voice stored exemplar-first (good/bad pairs as primary representation; single tone adjectives rejected at schema level) — evidence: tone adjectives alone exaggerate.
- Validation = deterministic rule engine (pass/fail in code) + calibrated LLM judge (F1 ≥ 0.8 vs. human annotations before autonomous blocking); layers never blended — Baymard principle.
- Risk-tiered publish gates: heritage/standard content requires human approval; only low-stakes internal drafts may auto-pass. AI drafts, never publishes.
- Guideline sets are versioned; outputs pin the version validated against — no implicit "latest" resolution (no-fallbacks guardrail).
- Synthetic audience feedback is hypothesis-grade: labeled, never satisfies a publish gate.
- Module precedes implementation — feeds phase-0 "Later phases 1: brand kernel".

**Next**
- Grill the open questions in §8 (visual pipeline, judge-model isolation, locales, disclosure UX) before any implementation planning.

---

## 2026-09-07 — Kernel skeleton + product strip merged to main

**Shipped**
- **Strip** (`ebf9295`, merged): removed billing/wallet/PayPal (−10.6k lines, 143 files), PWA/service-worker, product branding (DESIGN.md, assets.af, eigenmesh csv). Relocations: `billing/context.ts`→`db/tenant-context.ts`, `billing/platform-llm.ts`→`llm/`, `billing/preferences.ts`→`llm/`, `byok-ui.ts`→`settings/`. Kept: `llm/gateway-cost`, owlery client, messages/, evals/, docs/.
- **Kernel skeleton** (`fcddc48`, merged): `src/lib/kernel/` — registry (single execute path: permission→approval→zod-validate→handler→audit→vcs-commit), principals, events (append-only contract), modules (fail-closed activation), vcs (GitCommitter, `EE_VCS_AUTOCOMMIT=0` opt-out), approvals (latest-decision-wins gate). Tables: `kernel_principals`, `kernel_events`, `kernel_module_activations`, `kernel_approvals` + drizzle journal idx 70.
- Integration on main verified: kernel tests 30/30 green; `npm run check` 5 errors = documented eigen baseline (vapid ×3, posthog public env ×2); full vitest needs dev DB running (user starts it).

**Broke / flags**
- Service-worker was ALSO the web-push + capture-queue worker — web push is inert until it gets a new home. Accepted for v0 (Telegram is the push channel).
- `billingMode` DB column + wallet tables still in schema (migrations out of strip scope). Cosmetic leftovers: eigen-green theme, "Eigen Mesh" i18n strings, PWA deps in package.json.

**Decisions**
- Approval gate design: registry consults `ApprovalStore.latestFor(tool, principal)` — approved→proceed, pending→`approval_required` (no dup requests), none→create request + throw. Denied → new request.
- Registry collaborators are constructor-injected (EventSink/ApprovalPolicy/ApprovalStore/VcsCommitter); DB-backed stores land next.
- Worktree flow proved: `wt/strip` (mutating) and `wt/kernel` (additive) ran in parallel, merged clean.

**Next workstreams**
- `wt/wire`: DB-backed kernel stores + module manifests (memory, email) + MCP server rendered from kernel registry + OpenAPI generator + parity test
- `wt/gateway`: `modules/chat-gateway/` — Telegram long-polling, session mapping, allowlist (→ principals), chunking; migration idx 71

---

## 2026-09-07 — Phase 0 kickoff

**Shipped**
- `plan/phase-0-kernel.md` — approved architecture (grilled across 5 rounds)
- Repo seeded from eigen (`c4642f1` — tree unmodified: rsync w/o `.git`, `node_modules`, artifacts, `.env`)
- `AGENTS.md` — orchestrator model + guardrails written

**In progress**
- Strip: `billing/` (keep `llm/gateway-cost`), eigenmesh branding, PWA/service-worker, product deploy specifics
- Kernel skeleton: registry, principals, events, modules, vcs

**Workstreams** (worktrees off `main`)
- `wt/strip` — product-strip + import fixes
- `wt/kernel` — `src/lib/kernel/` + `modules/` skeleton (new files only; merges clean)

**Decisions**
- Orchestrator model adopted (AGENTS.md): subagents + worktrees, progress in `plan/`
- CLI dropped from Phase 0; OpenAPI generation stays
- Telegram gateway = company general assistant ("the orchestrator"), allowlist auth
- Strip table (billing out, PWA out, memory/MCP/job-queue/owlery-client in) — see phase-0 plan

**Next**
- Strip merged → tests green → kernel skeleton → pilot modules → orchestrator via Telegram

---

## 2026-09-07 — Phase-2e: onboarding redesigned as the boot sequence

**Shipped**
- Owner verdict on the phase-1e wizard: dead surfaces, jargon, module tourism — scrapped.
  New rule is permanent: `.pi/skills/tangible-purpose-ui/SKILL.md` (never show anything
  without real, tangible purpose; modules invisible at first run; agent chat is the only UI).
- Boot sequence (`welcome-wizard.svelte` rewrite): orb bloom + breathe (pure CSS, monochrome,
  `prefers-reduced-motion` respected) → "Hello." → name ask (only when unknown) → identity
  lines in outcome language → mind act (only when no provider; embedded provider wizard,
  real choices) → handoff into the chat. No step counter, no capability list, no
  "Your AI is connected" screen, no founding-interview step, no module destination buttons.
  "Skip for now" = muted corner link, same never-nag semantics.
- Sound: `src/lib/sound/boot-sound.ts` — Web Audio synth (no assets/deps), ON by default
  (owner decision), gesture-unlocked AudioContext, `ee-sound` localStorage flag, mute toggle
  in the home settings menu.
- Seeded first agent turn on handoff (deterministic, no LLM): "Hello{name}. Your company's OS
  is getting set up — that happens by talking. So: what's your company called, and what does
  it do?" — honest: the setup IS the first conversation (first-conversation.md P0/P1).
- Full width: nucleus page container `max-w-2xl` removed (`w-full`, padded) — fixes both the
  narrow-strip complaint and the vertical skew (wizard was min-h-dvh inside the headered
  container; now flex-1 centered in remaining space). Provider wizard got an `embedded` prop
  to drop its own min-h-dvh/label inside the mind act.
- Server: migration `0083_user_display_name.sql` (+journal idx 83) — `user_preference.display_name`;
  `setWelcomeDisplayName()`; new `POST /api/onboarding/name` (401/400 fail-loud).
  Founding endpoint kept (owner option A) for the future branding surface; its UI step removed.
- Explicit-event contracts (no `$effect` control flow): provider wizard `onconnected`
  callback ("Enter the workspace →"), wizard `oncomplete({ name })` seeds the chat.

**Verification**
- `npm run check` 0 errors (29 warnings = documented baseline); lint 0 errors.
- Unit: 4194 passed (incl. new name API + page-load displayName tests).
- Components: 32 passed — welcome-wizard spec rewritten for the boot sequence (9 tests,
  provider wizard mocked via `provider-onboarding.stub.svelte`).
- E2E: full suite 25 passed, 2 pre-existing skips. `onboarding-welcome.e2e.ts` rewritten:
  happy path (name → mind via API → seeded chat), skip path (gate still holds,
  sign-out/in persistence), restart path (name survives, personalized greeting).
  Migration 0083 must be applied to any env before this ships (`npm run db:migrate`).

**Decisions**
- Sound default ON; tab mute + settings toggle are the levers (owner ruled).
- Full width = literal (`w-full` everywhere on nucleus); forms inside acts keep readable
  measures (max-w-md/lg) — typography, not container restriction.
- Name is identity, not tour state: `resetWelcomeOnboarding` keeps it.

---

## 2026-09-07 — Phase-2e follow-up: the voice, and the compile that actually compiles

**Owner feedback** (after driving the new boot + first conversation): wow moment landed. Two
gaps: (1) no text-to-speech when the assistant speaks; (2) the agent SAID "I will now compile
the brand narrative" and nothing ran — no process, no UI reflection.

**Root cause of (2):** removing the wizard's founding step (phase-2e) also removed the ONLY
opener of the website-founding journey — the chat was a plain orchestrator turn, so "compiling"
was an LLM promise with no execution behind it.

**Shipped**
- The handoff now OPENS the founding journey (empty) server-side:
  `openWebsiteFoundingJourney()` in founding.ts, called by POST /api/onboarding/welcome —
  onboarding still owns the start; the chat drives it. Idempotent (reuse active, reuse none
  after completion). Restart onboarding → new journey on next completion.
- Journey steps reordered to match the seeded question and natural founding order:
  company_name → positioning → tone. The brand-doc artifact moved to the tone step (final) —
  it needs all three answers; it fired early under the old order and would have written an
  empty tone.
- Discipline: new `NO EMPTY PROMISES` section — never announce future work; execute in the
  same reply with tool calls (the transcript shows each one) or say what's missing.
- The seeded first turn now asks exactly the journey's first question ("So, first: what's
  your company called?") — one question per reply, the journey drives the rest.
- The visible process the owner asked for: when the journey completes its captures, artifacts
  execute through the kernel registry mid-chat — tool preview lines ("→ using
  website.create_page · …"), status labels, the approval.required card for publishes, and the
  journey-completed kernel event. No new UI needed; the existing stream surfaces finally have
  something true to show.
- TTS (`src/lib/speech/tts.ts`): browser SpeechSynthesis, ON by default, `ee-voice` localStorage
  flag, markdown→speech normalization (code blocks/links/emphasis/bullets), cancel-on-new-turn.
  Speaks: boot acts (greeting, name ask, identity lines), the seeded greeting, every successful
  assistant reply. Voice toggle ("Voice on/off") in the home settings menu next to Sound.

**Verification**
- Unit 4203 passed (journey reorder: brain.journey.spec rewritten for the new step order and
  artifact firing order; founding + welcome route specs cover the empty-journey open).
- Components 32 passed; check 0 errors; lint 0 errors.
- E2E 25 passed — happy path now also asserts the greeting is SPOKEN (speechSynthesis stubbed
  with a recorder via addInitScript).

**Decision logged**
- Voice + sound default ON; independent toggles (settings menu). Tab mute stays the user's lever.
