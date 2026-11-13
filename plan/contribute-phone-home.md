# Contribute phone-home (plan final, not started — all owner answers in, 2026-11-13, see §8)

Owner, 2026-11-13: "currently the contributions board is only running on the box, right? we need it
to be local to the company, but also send it to a place i own without personal informations".

Goal: every install keeps its own Contribute board exactly as it is, **and** sends a de-personalised
copy of each proposal to one central board the owner runs, so the owner sees what all companies ask
for in one place.

## 1. Current state (confirmed 2026-11-13)

- **Storage:** the company's own Postgres only. `contributions` + `contribution_votes`
  (`drizzle/0121_contributions.sql`, schema `src/lib/server/db/contribute.schema.ts`), company-level,
  no RLS. Access in `modules/contribute/service.ts`.
- **An item holds:** `id` (random UUID), `title` (free text ≤ 2000, often dictated), `kind`
  (idea|bug|polish) and `area` (11 surfaces) from the LLM judge (`judge.ts`, gateway, JSON schema),
  `status` (requested|in_progress|shipped|declined), `author_id` (member id), `note` (makers'/agent's
  free text ≤ 1000), `created_at`/`updated_at`/`shipped_at`. Votes: `(contribution_id, user_id,
  direction ±1)`. The DTO adds `authorName` (from members: name or **email**) and `score`.
- **Nothing syncs anywhere.** No outbound call in `modules/contribute/`; the only side effects are
  kernel events `contribute.proposed` / `contribute.status_changed` (local activity feed). The
  owner reads production today by hand over the cerberusblue MCP (`contribute_list/get/update`).
- **What production's titles actually contain** (read over MCP, 37 items; not copied here): first
  names of teammates, the company's own domain inside pasted URLs and error messages, personal
  remarks and moods, German colloquial speech. Notes contain the makers' replies, some personal.
  ⇒ **The free text cannot be sent as is, and no field-level filter can make it safe.** Redaction of
  `title` has to be an LLM rewrite (AGENTS.md: LLM + JSON schema, no regex for meaning).

## 2. Shape

```
install (each company)                                  central board (owner)
──────────────────────                                  ─────────────────────
contributions ──(service hook)──► contribute_outbox ──► worker on job-queue tick
                                   pending → scrubbed      │ 1. scrub: LLM rewrite (gateway, schema)
                                   → sent / failed         │ 2. build payload (strict allowlist)
                                                           │ 3. POST signed ──────────────► /api/hub/contributions
                                                                                            hub_installs, hub_contributions
                                                                                            /contribute → "All installs" tab
                                                                                            contribute_hub.* tools (MCP / ee)
```

Local board: untouched. The hook only enqueues; a failure in sharing never blocks or changes a local
proposal, and it is shown, never swallowed (§5).

## 3. The central endpoint

- **Where (owner, Q1): the production install at https://os.cerberusblue.com.** A new module
  `modules/contribute-hub/` in this same codebase, activated only there (off everywhere else;
  activating it is an owner action, not self-seeded). Its API lives under
  `https://os.cerberusblue.com/api/hub/…`. The hub install's own board is already local to the
  owner, so it does **not** send to itself (decision).
  Consequence to keep in mind: the product's feedback from every company sits in cerberusblue's
  database and backups, readable by cerberusblue's owner/admins and agent.
- **Owned by:** the owner (the project). Apache-2.0: anyone forking can run their own hub; the
  hub URL is configuration, not hard-wired logic.
- **Auth: one key per install, made by the install.**
  - On enabling sharing, the install makes an Ed25519 keypair (private key in the install's
    secrets store, like other substrate secrets) and a random `install_id` (UUID v4, derived from
    nothing).
  - `POST /api/hub/register {install_id, public_key, app_version}` → hub stores it. Every later
    request is signed (`install_id`, timestamp, body hash; hub rejects > 5 min skew and replays).
  - The hub can revoke an install (spam, abuse); the install then shows "the central board refused
    this install" in Settings — no silent retry loop.
  - Open registration means anyone can post. **Q2 (owner): any install may register**; safety
    is a per-install rate limit (e.g. 60 requests/h), size limits from the
    schema, and revocation. No enrollment token.
- **Hub API (all JSON, zod-strict on both ends, versioned `v: 1`):**
  - `POST /api/hub/register`
  - `PUT /api/hub/contributions/:remote_id` — upsert (idempotent: same body twice = no change)
  - `DELETE /api/hub/contributions/:remote_id` — withdraw one
  - `DELETE /api/hub/installs/:install_id` — withdraw everything (opt-out with deletion)
- **How the owner reads it:**
  - On the hub install, `/contribute` gets an **"All installs"** tab: same board component,
    grouped by kind/area/status, showing install count and summed score per proposal; no
    voting/authors (there are none).
  - Kernel tools `contribute_hub.list` / `contribute_hub.get` (agent + admin), so the owner's agent
    reads it over the hub's MCP the same way it reads production today. (Later: an LLM pass that
    clusters the same request across installs — gateway + schema, like the judge.)
  - Hub tables (hub install only, migration in the same sequence): `hub_installs (install_id,
    public_key, app_version, registered_at, last_seen_at, revoked_at)` — no company column,
    `hub_contributions (install_id, remote_id, summary, language, kind, area, status, score,
    app_version, created_day, updated_at, received_at)`, PK `(install_id, remote_id)`.

## 4. What leaves the install

### 4.1 Payload (strict allowlist — the only fields that exist)

```ts
type HubContributionV1 = {
  v: 1
  remote_id: string        // the local contribution UUID (random; links back only for this install)
  summary: string          // LLM rewrite of title in English, PII-free, ≤ 500 chars (§4.2)
  language: string         // BCP-47 of the original, from the same LLM call (Q10, owner)
  kind: ContributionKind   // closed enum, already structured
  area: ContributionArea   // closed enum
  status: ContributionStatus
  score: number            // net votes, a count — never who voted
  app_version: string      // e.g. "0.5.9"
  created_day: string      // YYYY-MM-DD (day, not timestamp: less correlation)
  shipped_day: string | null
}
```

**Never sent, by construction (owner, Q4: "dont send names"):** `author_id`, author name/email,
votes per person, `note` (makers' replies), exact timestamps, the company name/domain, hostnames,
member count. There is **no** opt-in to send company or person names — the field does not exist.
The payload is built by one pure function `toHubPayload(row, scrubbed, version)` from named fields;
a zod `.strict()` schema rejects any extra key on both the install and the hub; a unit test asserts
the exact key set so adding a field is a deliberate, reviewed change.

### 4.2 Scrubbing the title (the only free text)

- One gateway call, `logContext: 'contribute_scrub'`, on the company's AI provider
  (`onCompanyProvider`, like the judge). JSON schema:
  `{ summary: string, language: string, removed: ("person"|"contact"|"company"|"location"|"credential"|"url"|"other")[] }`.
  Instruction: restate the request in English as a product request; drop names of people, emails,
  phones, company/product names of the customer, domains/URLs/hosts, IDs, secrets, places, personal
  remarks and moods; keep what the app should do and where; never add content.
- Post-LLM code validates the schema (3 attempts, like the judge), length, and nothing else. No
  regex "second opinion" on meaning.
- **Fail loud, never fall back:** no provider, empty wallet or 3 bad answers → the outbox row is
  `failed` with the reason, visible in Settings and on the item. The raw title is **never** sent
  as a substitute.
- Scrub runs once per proposal (titles don't change); status/score updates reuse the stored
  summary.
- **Owner, Q5: "strip pii"** — PII is stripped on the company's own server before anything leaves.
  Cost: one small call per new proposal on the company's provider, tracked by the gateway like
  every call. Scrubbing on the hub is ruled out: the raw text would leave the install.
- If the company has no AI provider, nothing can be scrubbed, so nothing is sent: items stay
  Waiting with "connect an AI provider to share" in Settings (fail loud, no raw fallback).

### 4.3 Human control (recommended)

- Each item on the local board shows its sharing state to owner/admins: *Waiting · Shared · Not
  shared · Failed (reason)*, and **"Show what was sent"** (the exact payload).
- Owner/admins can mark one proposal **"Don't share"** (before or after; after = DELETE on the hub).
- **Q3 (owner): no hold window.** A proposal is sent on the next tick after it is scrubbed. An
  admin revokes afterwards: "Don't share" on one item withdraws it from the hub (DELETE), and the
  Settings toggle stops sending (optionally withdrawing everything already sent).
- The composer and the board say in one line that proposals are shared with the eigenEnterprise
  makers without names, linking to "Show what was sent" and the Settings toggle.

## 5. Opt-in, Settings, queue, retry, offline

- **Setting:** owner-only, Settings → Company → "Share proposals with the eigenEnterprise makers",
  with the exact field list from §4.1 and a link to "What was sent". States: On / Off. No company
  identity option (Q4).
- **Owner, Q6: "sharing on by default, toggleable"** — opt-out. A new install and an upgraded
  install both start with sharing **on**; the owner can switch it off at any time. The migration
  seeds the settings row with `enabled = true`. A one-time notice to the owner (dashboard "Needs
  you" item) says sharing is on and links to the toggle — informational, not a consent step.
- **Q7 (owner): no backfill.** Only proposals created after the feature
  lands on an install are shared; earlier ones are marked `excluded` by the migration. With
  sharing on by default, sending months of old proposals on upgrade would surprise people.
  Turning sharing off and on again also does not backfill what was proposed while it was off.
- **Turning it off:** stops sending; the owner chooses "keep what was sent" or "delete it from the
  central board" (`DELETE /installs/:id`).
- **Outbox** (new migration, e.g. `0136_contribute_outbox` + journal idx 136 + schema in
  `src/lib/server/db/contribute.schema.ts`):
  `contribute_outbox (contribution_id PK/FK cascade, state pending|scrubbed|sent|failed|excluded,
  summary, language, last_sent_hash, attempts, next_attempt_at, last_error, updated_at)` and
  `contribute_share_settings` (single row: enabled default true, install_id, registered_at,
  revoked_at). Private key in the secrets store, not this table. The migration number is taken at
  build time (next free idx).
- **Enqueue:** `shareProposal` / `updateProposal` / `voteProposal` mark the row dirty in the same
  transaction (only when sharing is on). Votes coalesce: the worker sends the current snapshot, not
  each vote.
- **Worker:** `tickContributeShare()` on the global job-queue tick (like `tickRepos`), SKIP LOCKED,
  batch of 20. Sends only when the payload hash changed. Backoff: 1 min → 2 → 4 … capped at 6 h,
  no attempt limit for network errors (offline boxes catch up); **4xx other than 429 = `failed`,
  no retry** (schema mismatch, revoked) — shown in Settings.
- **Offline / hub down:** proposals pile up as Waiting; Settings shows "N waiting, last tried …,
  last error …". Nothing local is affected.
- **Hub URL:** an explicit setting written by the installer for official releases
  (`CONTRIBUTE_HUB_URL=https://os.cerberusblue.com` in the app env from `ee`). No default in code:
  sharing on with no URL shows "central board not configured" in Settings and sends nothing — loud,
  never guessed.
- **Q8 (owner):** the local box (os.ee.localhost) and e2e point at a
  box-local mock hub, never production — test data stays off the real board.

## 6. Build order (TDD, one workstream each after the owner's answers)

1. **Payload + scrub (install side, pure):** `modules/contribute/share/payload.ts`, `scrub.ts` —
   specs first: exact key set, strict schema rejects extras, scrub parser (schema, 3 attempts, no
   fallback), payload hash.
2. **Outbox + settings:** migration 0136 + journal + schema; `db-store.pg.spec` for the outbox;
   service hooks (sharing off → no row; on → dirty row); worker spec with fake clock + fake hub
   (backoff, 4xx stop, 429/5xx retry, hash skip, exclusion → DELETE).
3. **Hub module:** `modules/contribute-hub/` — register, signature verify (skew, replay), upsert
   idempotency, revoke, delete; `contribute_hub.list/get` tools; migration for hub tables; specs.
4. **UI:** Settings → Company sharing card; board badges + "Show what was sent" + "Don't share";
   hub "All installs" tab. Component specs.
5. **E2E:** mock hub process next to the mock gateway (Playwright harness): owner turns sharing on
   → member proposes with a name and a URL in it → mock hub receives a payload without them,
   exactly the allowlisted keys → admin marks one "Don't share" → hub gets DELETE.
6. Release, install on the box against the box-local mock hub; then activate the hub module on
   os.cerberusblue.com and ship a release with `CONTRIBUTE_HUB_URL` set (owner's go for each).

## 7. Decisions (logged in `plan/progress.md`, 2026-11-13)

- D1 Hub = module `contribute-hub` in this repo, active only on **os.cerberusblue.com** (owner, Q1).
- D2 Per-install Ed25519 key, random install id, signed requests; hub can revoke; any install may
  register, rate-limited (owner, Q2).
- D3 Only an allowlisted, strict-schema payload leaves the install; title goes only as an LLM
  rewrite done on the install; notes, authors, per-person votes, exact times, company and person
  names never leave, with no opt-in to send names (owner, Q4 + Q5).
- D4 Scrub failure or no AI provider = not sent and shown; never the raw title.
- D5 Sharing **on by default**, owner toggle in Settings → Company (owner, Q6); outbox + job-queue
  tick; offline = visible queue; no hold — admins revoke after sending (owner, Q3); no backfill
  (owner, Q7); box + e2e on a mock hub (owner, Q8); English summaries (owner, Q10); no
  back-channel in this plan (Q9, not raised).
- From here on, implementation details are decided by the builder and logged as decisions in
  `plan/progress.md`; only real product choices go back to the owner.

## 8. Owner's answers (2026-11-13, relayed verbatim by the orchestrating session)

> "q1: the machine on https://os.cerberusblue.com / q4: dont send names / q5: strip pii /
> q6: sahring on by default, toggleable"

| Q | Answer | Source |
|---|---|---|
| Q1 Where the hub runs | os.cerberusblue.com | owner |
Second round, verbatim: "Whoa. Those questions are far too finely granulated. Who may register? I
don't know. Everybody?ly. Per default, you send data, you can revoke the sending of the data when
you are in admin. There is no backfill. Test installed, and the language should be English, yeah,
fine."

| Q | Answer | Source |
|---|---|---|
| Q1 Where the hub runs | os.cerberusblue.com | owner |
| Q2 Who may register | everybody; rate limit + revocation kept as safety | owner |
| Q3 Hold window | none — sent by default, an admin revokes afterwards | owner |
| Q4 Company identity | never sent; no opt-in | owner |
| Q5 PII | stripped on the company's server (LLM scrub on its provider) | owner |
| Q6 Default | on by default, toggle in Settings (opt-out) | owner |
| Q7 Backfill | none — only proposals made after the feature lands | owner |
| Q8 Test installs | box + e2e use a mock hub, never production | owner |
| Q9 Back-channel | out of scope | not raised; kept out |
| Q10 Language | English summary + original language code | owner |

Accepted risk (Q3 + Q6): with sharing on by default and no hold, the LLM scrub is the only thing
between a dictated title and the central board, and an LLM can miss something. A miss is caught
after the fact: "Show what was sent" and "Don't share" (withdraws it from the hub).
