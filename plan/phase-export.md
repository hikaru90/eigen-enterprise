# Phase: Export — take the whole company with you

**Status:** APPROVED direction (owner, 2026-11-23: "we promise our customers no vendor lock in. we need an export function that exports everything!"; two exports decided, §6). X1 in progress.
**Must follow:** claim.md ("Exit = das ganze Repo mitnehmen"), AGENTS.md (registry tool first, no UI-only action, fail loud, secrets never in plain text), phase-backups.md, phase-git-native.md.

## 1. What exists today, and why it's not enough

| What | Who | Gap |
|---|---|---|
| Settings → Your data → Memory export (`src/lib/server/export/memory-export.ts`, zip of CSV + graph JSON) | each member, own Memory | Memory only |
| Encrypted S3 backup (phase-backups.md) | ee, nightly | Our own encrypted format, and only `ee restore` can read it. That's a backup, not an exit. |
| Git-native repo (phase-git-native.md) | ee | Only groups have moved (G0). G1–G5 are still open, so the repo doesn't hold the company yet. |

No way exists to get *the company* out in formats another tool can read. In the end, git-native **is** the exit. Until G5 ships, the export is how we keep the promise, and after that it's still the readable "open it in anything" view of the repo.

## 2. The promise, made checkable

"Everything" has to be something a test can prove, not a feeling:

- **Every table is classified.** A coverage spec reads every `pgTable` in `src/lib/server/db/**` and `modules/**`. Each one is either **claimed by an exporter** or **excluded with a written reason** (`EXPORT_EXCLUDED` in `src/lib/kernel/export-coverage.ts`, e.g. sessions, rate-limit counters, caches, derived embeddings). A new table fails the gate until someone classifies it. Same pattern as `ui-parity.ts`.
- **Every Drive blob is in the archive**, checked by hash against the manifest.
- **Secrets never leave in plain text.** API keys, OAuth tokens, passkeys and deploy keys are listed in `RECONNECT.md` as "connect again on the new system" with their name and provider, never their value.

## 3. The archive: open formats, one folder per module

`<company>-export-<timestamp>.zip`:

```
README.md            what's inside and how to open it (plain words)
manifest.json        export version, app version, per-file sha256 + row counts, exclusions with reasons
RECONNECT.md         the integrations and keys to set up again
company/             settings, logo, members (name, email, role), groups, access grants   JSON
website/             pages as HTML + Markdown, assets, site config                         files
drive/               the real folder tree with the original files; revisions/ per file     files
messages/            one JSONL per channel + transcript.md, attachments next to it         JSONL + MD
email/               mailboxes as mbox, templates as HTML, lists + contacts as CSV         mbox/HTML/CSV
contacts/            contacts.vcf + contacts.csv                                           vCard/CSV
calendar/            one .ics per calendar                                                 iCalendar
memory/              thoughts, projects, tasks, text files as Markdown; graph as JSON      MD/JSON
brand/               guideline sets, tokens, social posts + media                          JSON/files
calls/  recap/  contribute/  reminders/  repos/  domains/  agents/                         JSON
data/                every exported table again, raw, as JSONL + schema.sql                JSONL
```

The readable folders are for people and other tools. `data/` is the safety net, so nothing is lost even where a module's readable form leaves a column out. Each module ships its exporter next to its code (`modules/<id>/export.ts`, an `ExportSection` with `tables` it claims + `write(zip, ctx)`). The kernel puts the archive together. No module reaches into another one.

## 4. Surfaces (CLI and agent first)

- **Registry tools** (module `kernel`):
  - `kernel.export_company`: starts a job, owner only, approval risk `external` and always asks (the whole company leaves as a file), audited as a kernel event. It returns the export.
  - `kernel.export_status`: progress, then the download path (`/api/exports/<id>/download`, the owner's signed-in session).
  - `kernel.export_list` / `kernel.export_delete`: past exports; delete removes the archive, the history keeps the entry.
  - `kernel.export_mine`: any member's own data, including the private things only they can see. This grows the Memory export into every module.
- **CLI:** `ee tool run kernel.export_company` and friends (no separate verb; the download is the owner's signed-in link).
- **UI:** Settings → **Export**: "Export everything", progress, download, history, and a plain "How to move to another system" text. A client of the tools, nothing UI-only.
- **Runs in the app**, triggered by a job-queue job (so a CLI call starts it too). The export row is claimed once and the build runs detached, because the queue requeues jobs running over 5 minutes. A restart mid-build marks it failed at boot. It streams into `${EE_EXPORT_DIR}` or `${EE_STATE_DIR}/exports` (Drive can be gigabytes, so never in memory). Kept 7 days, then pruned.

## 5. Milestones

- **X1 Everything, raw (built 2026-11-23):** every table of the company database classified (`rules.ts`: full / private-as-meta / excluded with reason; whole plumbing schemas excluded), streamed as `data/<table>.jsonl`; `files/drive/<real folder tree>` for live Drive files plus `files/blobs/<store>/<sha256>` for every other blob a table points at; README, RECONNECT, manifest with sha256 per entry. Tools `kernel.export_company/status/list/delete` (the CLI reaches them as `ee tool run kernel.export_company`), Settings → Export, download route. Proof so far: a full export of the test database, unzipped and counted. Readable per-module folders (§3) are X2.
- **X1b App databases:** website apps keep their own Postgres databases (`ensureDatabase`, D17). They are not in X1. ee (root) dumps each into `apps/<name>.sql` (plain `pg_dump`), and the app asks ee for it like a backup run.
- **X2 Readable formats:** per-module exporters (vCard, iCalendar, mbox, Markdown, Drive tree, channel transcripts), each with a spec that round-trips through a standard parser (ical.js, a vCard parser, Python's `mailbox` in a script).
- **X3 Personal export:** `kernel.export_mine` across every module.
- **X4 Import proof:** a script that reads our own export into a fresh empty install. That proves the format carries everything, and it doubles as the migration path.

## 6. Two exports (owner decision, 2026-11-23)

Owner: "we need 2 different exports. one that exports everything the company owns (including private data as metadata)."

1. **Company export** (`kernel.export_company`, owner only): everything the company owns, in full. A member's **private** item (private Memory, private contacts, DMs, personal mailboxes, private Drive items, private calendar events) is in it **as metadata only**. That means the id, kind, owner, other people involved (DM participants, event attendees), created/updated time, size or count, and visibility. Nothing that is content: no title, body, name, subject, file bytes or summary. Titles count as content, so they're left out too. This keeps W3 ("RLS hides it from everyone incl. admins"): the company can see that the data exists and whose it is, and can't read it.
2. **Personal export** (`kernel.export_mine`, every member): everything that member can see, including their own private items in full. It grows the Memory export into every module.

What decides whether a field is metadata or content is the per-table classification in `src/lib/server/export/company/rules.ts` (§2). Every column of a table with private rows is marked `meta`, `content` or `secret`, and the export (and `rules.integration.spec.ts`) fails on an unmarked column. No heuristics on column names.

**Where "private" ends (decision taken building X1, 2026-11-23):** what the app shows the owner is company data and is exported in full. What the app hides from the owner is metadata only. So these are **full**: contacts (owner and admins see unshared ones), Drive (owner and admins manage everything), private channels, shared mailboxes (company mail; the owner can join the group). These are **metadata only**: DMs and their attachments, personal mailboxes, private Memory (everything not on a company project), calendar event details, two-person assigned tasks, DM calls and their transcripts, unshared call-brain answers, assistant chats, reminders and personal settings. One known cut: a company-visible calendar event also loses its title in the company export, because notes and titles share the event row (the personal export has them).

## 7. Out of scope

Importing *from* other tools (separate phase). A hosted "transfer to another provider" button.
