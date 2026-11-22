# Domains: one claim system, one place

**Status:** draft 2026-11-22, waiting for the owner's approval.
**Owner's words:** "there should be one dedicated place in the settings where the whole domain, the
whole DNS records … would show up and not only the email specific ones" · "I would say we have one
claim system."
**Trigger:** putting `eigenenterprise.app` live on ee-one took five layers (Cloudflare A record, the
app's domain, the control plane's claim rule, a `_ee-verify` TXT nobody was shown, Caddy's ACME
backoff) and no page showed any of them.
**Must stay congruent with:** `managed-domains.md` (bought domains, records written by us only in
zones we host), `phase-substrate.md` (ee owns routes and Caddy), the control plane's domain claims
(`_ee-verify.<host>` TXT before a custom host is routed; `hosted-names.ts` `claimableHost`).

## What is wrong today (2026-11-22 map)

- **Three stores that never meet:** web hosts in ee's company repo (`routes.json`, `settings.json`
  `publicHost`), mail domains in `mail_domains`, bought domains only at the control plane.
- **Three copies of the "is this hostname already used" check**, each slightly different: the
  company-website page (`m/website/site/+page.server.ts:77`), `website.app_domain_set`
  (`domain-tools.ts:107`) and `website.app_deploy` (`apps/tools.ts:371`), because a domain can be
  entered in several places. ee itself silently switches a hostname to whatever asked last
  (`ee/src/domains.ts:87,92`).
- **The website page's error doesn't say what the hostname shows now** ("already assigned to another
  route"), and it sends you to remove it elsewhere instead of letting you switch it.
- **Settings › Domains shows bought + mail domains only**; web hosts are only in Website › Settings'
  routing table (which labels the calls host "App livekit", linking to a page that doesn't exist).
- **Nothing shows DNS for web hosts:** no A-record check before ACME, no certificate status, and the
  `_ee-verify` TXT a managed box needs is never shown on the box.
- **Copies:** `website_services.host` duplicates the app's route; three hostname validators.
- **Control plane:** a claim row is first-come per host; the company that reports a host first
  holds it, and the rightful company's TXT never matches.

## The model

**The company owns its domains. Each hostname under them shows one thing on the company's server,
and each needs certain DNS records.** (Owner, 2026-11-22: "the owner is the company itself … it's
the same server that owns the domain.")

```
zone eigenenterprise.app            (connected · bought → renewal)
├─ eigenenterprise.app      shows the app eigen-enterprise-website   A @ → 159.195.209.90  ✓  cert ✓
│                           + email (receiving)                       MX, SPF, DMARC         ✓
├─ www.eigenenterprise.app  shows nothing yet
├─ one.eigenenterprise.app  shows the console                         A → …                  ✓  cert ✓
├─ rtc.one.…                calls                                      A → …                  ✓
└─ mail.… / *._domainkey.…  email (MAIL FROM, DKIM)                    MX, TXT, 3 CNAME       ✓
```

- **Zone** = the registrable domain. Source: *bought* (control plane) or *connected* (the
  company's own DNS). Derived for every claimed host, so a zone appears as soon as anything uses it.
- **Claim** = the company proving it owns a hostname. On a managed box that is the control plane's
  `_ee-verify.<host>` TXT; on a self-hosted box the A record pointing at the server is enough.
- **What a hostname shows** = one of: the console, the company website, an app, calls (`rtc.`).
  One at a time; changing it is an ordinary setting change ("now shows X instead of Y"), not a
  conflict. Email is not something a hostname *shows*: it rides alongside on the same name
  (A and MX don't clash).
- **Records** = what each claim needs, computed (no model; structure): web → A/AAAA to the box's
  public address, plus on a managed box `_ee-verify.<host>` TXT = the company's token; calls → A;
  mail → today's `dnsRecords()`. Each record carries **observed** status from a live lookup:
  ok · missing · wrong (shows what DNS returns).
- **Readiness per web host** in the order it fails in practice: DNS → claim verified (managed) →
  route at the host router (managed) → certificate (Caddy, with its last ACME error and next retry).

## Who does what

- **Storage stays where the runtime needs it** (mine): what each hostname shows in ee's company repo
  (Caddy's source), mail in `mail_domains`, bought domains at the control plane. No new table
  copying them. `website_services.host` is dropped in favour of the app's routes.
- **One kernel module `domains`** owns the rules and the view: `domains.list` (domains → hostnames →
  what each shows → expected vs observed records → readiness), `domains.add {domain}`,
  `domains.set_target {host, shows: console | site | app:<name> | nothing}`, `domains.remove {host}`,
  `domains.recheck {host}`, `domains.retry_certificate {host}`. `website.app_deploy`'s automatic
  `<app>.<console host>` and `email.domain_add` call it; the three hand-written checks are deleted.
  Registry first (CLI, MCP, agent get it); UI is a client.
- **ee:** setting what a host shows replaces the previous target **and says which one it replaced**
  (returned, logged in the activity), so a change is never silent; ee status reports per-host
  certificate state and last ACME error.

## Settings › Domains (the one place)

- **Domains are a global setting, edited only here** (owner, 2026-11-22: "maybe domain should link
  to settings, so we make it a global setting").
- A list of the company's domains; each opens to its hostnames: host · shows (a picker: console,
  website, an app, nothing) · email on/off · DNS · claim · certificate, and a **"Records to add"**
  block (copyable name/type/value; only what is missing or wrong). "Add a hostname" (e.g. `www.`,
  `shop.`). "Check now" per domain; "Retry certificate" when Caddy is in backoff.
- **Module pages only show and link:** the company website, each app and Email show their address(es)
  with their status and "Change in Settings › Domains" (deep link to that hostname). They no longer
  have their own domain fields.
- Buy / connect stay as today (`managed-domains.md`).
- Website › Settings' routing table becomes a link to this page.

## Contract changes

- **ee API:** `POST /v1/domains` returns the target it replaced (`replaced: workload | null`);
  `GET /v1/status` adds
  `certificates: [{ host, state: 'issued' | 'pending' | 'failing', lastError, nextRetryAt, notAfter }]`
  (from Caddy's events/storage); `POST /v1/certificates/retry {host}` (graceful forced reload).
  Kernel `EeStatus.settings` gains `callsHost`.
- **Fleet protocol (managed boxes):** `desired.claims: [{ host, verified, txtName, txtValue }]`
  (control plane → box), so the box shows the claim step with the exact TXT. Appended feature
  `claims`.
- **Control plane:** claims become per `(company, host)`; a verified claim wins and routes; others
  stay pending and are shown as "another company also claims this". Ops can drop a claim.

## Slices (TDD; worktrees under `.claude/worktrees/`)

| # | Slice | Where | Done when |
|---|---|---|---|
| D1 | ee: `replaced` on set, certificate status + retry, `callsHost` in kernel status | `ee/src/*`, `src/lib/server/ee/client.ts` | ee specs |
| D2 | Kernel `domains` module: list/add/set_target/remove; app_deploy + email.domain_add delegate; site/app domain fields removed (announced); one hostname validator; drop `website_services.host` (migration) | `modules/domains/`, `modules/website/*`, `modules/email/*`, `drizzle/` | Unit specs; the three old checks are gone |
| D3 | DNS observer: A/AAAA/CNAME/TXT/MX lookups (`node:dns` Resolver), expected vs observed per record, cached, `domains.recheck` | `modules/domains/dns/` | Specs with a fake resolver incl. NXDOMAIN vs lookup failure |
| D4 | Claims in the fleet + control plane: `desired.claims`; per-company claims, verified wins, ops drop | `ee/src/fleet/*`, `eigenEnterprise-cloud` | Protocol + flow tests; the first-come gap closed |
| D5 | Settings › Domains rebuilt on `domains.list`; module pages link; Website › Settings table → link; calls host labelled "Calls" | `src/routes/(nucleus)/settings/domains`, components | Component tests; e2e: add a host, see records, see it go green |
| D6 | Proof on ee-one: `eigenenterprise.app` + `www.` shown with every record, claim and certificate green | box + control plane | Owner sees it |

D1 ∥ D3 ∥ D4 against the contract above; D2 needs D1; D5 needs D2 + D3.

## Decisions of record (mine; owner may veto)

- No new claims table on the box: the stores that run things stay the truth; `domains` composes
  them and owns the rules.
- Observed DNS uses the system resolver (what Caddy and Let's Encrypt see is public DNS; a split
  horizon on the box would be the operator's choice, not ours).
- Records ee doesn't need (e.g. Google verification, `cloud.` A) are not shown: reading a whole
  zone needs DNS-provider credentials, which we don't ask for (`managed-domains.md` DM4).
- Site URLs (`website.site_info`) use the site's own host when it has one, not `ORIGIN`.

## No silent removals

- The domain fields on the company-website page and on each app's Settings (`website.app_domain_set`
  / `_remove` in the UI) go away; their address shows there with a link to Settings › Domains. The
  registry tools stay as thin calls to `domains.set_target` so agents and the CLI keep working.
- Website › Settings' "Domains & routing" table is replaced by a link to Settings › Domains (same
  data, more of it).
- "Connect one you have" today adds a mail domain only; it becomes "connect a domain", then choose
  its uses (mail stays one tap).

## Not in this plan

Writing records into the customer's DNS (Cloudflare API etc.), wildcard hosts, preview hosts,
DNSSEC.
