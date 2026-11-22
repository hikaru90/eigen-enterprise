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
- **Three copies of the owner check**, each slightly different: the company-site page
  (`m/website/site/+page.server.ts:77`), `website.app_domain_set` (`domain-tools.ts:107`) and
  `website.app_deploy` (`apps/tools.ts:371`). ee itself **moves** a host to a new owner instead of
  refusing (`ee/src/domains.ts:87,92`), and `removeDomain` checks no owner.
- **The site error names no owner** ("already assigned to another route"), while the app path does.
- **Settings › Domains shows bought + mail domains only**; web hosts are only in Website › Settings'
  routing table (which labels the calls host "App livekit", linking to a page that doesn't exist).
- **Nothing shows DNS for web hosts:** no A-record check before ACME, no certificate status, and the
  `_ee-verify` TXT a managed box needs is never shown on the box.
- **Copies:** `website_services.host` duplicates the app's route; three hostname validators.
- **Control plane:** a claim row is first-come per host; the company that reports a host first
  holds it, and the rightful company's TXT never matches.

## The model

**A domain (zone) has hostnames; a hostname has uses; each use has one owner and needs records.**

```
zone eigenenterprise.app            (connected · bought → renewal)
├─ eigenenterprise.app   web   → app eigen-enterprise-website   A @ → 159.195.209.90  ✓  cert ✓  claim ✓
│                        mail  → Email (receiving)              MX, SPF, DMARC         ✓
├─ www.eigenenterprise.app  web → (none)
├─ one.eigenenterprise.app  web → Console                       A → …                  ✓  cert ✓
├─ rtc.one.…                calls → Calls                        A → …                  ✓
└─ mail.… / *._domainkey.…  mail → Email (MAIL FROM, DKIM)       MX, TXT, 3 CNAME       ✓
```

- **Zone** = the registrable domain. Source: *bought* (control plane) or *connected* (the
  company's own DNS). Derived for every claimed host, so a zone appears as soon as anything uses it.
- **Claim** = `{ host, use, owner }`. Uses: `web` (owner: console | site | app:<name>),
  `calls` (the rtc host), `mail` (the email domain; sending and/or receiving). **One web owner per
  host**, refused — never moved — unless the caller says `move`. A web and a mail use on the same
  host coexist (A and MX don't clash).
- **Records** = what each claim needs, computed (no model; structure): web → A/AAAA to the box's
  public address, plus on a managed box `_ee-verify.<host>` TXT = the company's token; calls → A;
  mail → today's `dnsRecords()`. Each record carries **observed** status from a live lookup:
  ok · missing · wrong (shows what DNS returns).
- **Readiness per web host** in the order it fails in practice: DNS → claim verified (managed) →
  route at the host router (managed) → certificate (Caddy, with its last ACME error and next retry).

## Who does what

- **Storage stays where the runtime needs it** (mine): web/calls claims in ee's company repo
  (Caddy's source), mail in `mail_domains`, bought domains at the control plane. No new table
  copying them. `website_services.host` is dropped in favour of the app's routes.
- **One kernel module `domains`** owns the rules and the view: `domains.list` (zones → hostnames →
  uses → expected vs observed records → readiness), `domains.claim {host, use, owner, move?}`,
  `domains.release {host, use, owner}`, `domains.recheck {host}`, `domains.retry_certificate {host}`.
  The site page, `website.app_domain_*`, `website.app_deploy` and `email.domain_add` call it; their
  own owner checks are deleted. Registry first (CLI, MCP, agent get it); UI is a client.
- **ee enforces too:** `addDomain` refuses a host another owner has (unless `move`), `removeDomain`
  takes the expected owner; ee status reports per-host certificate state and last ACME error.
- **Conflict messages name the owner and link to it:** "eigenenterprise.app already serves the app
  eigen-enterprise-website" → [open it] · [move it here].

## Settings › Domains (the one place)

- A list of zones; each opens to its hostnames table: host · use · owner (link) · DNS · claim ·
  certificate, and a **"Records to add"** block (copyable name/type/value; only what is missing or
  wrong). "Check now" per zone; "Retry certificate" when Caddy is in backoff.
- **Add a hostname here** too: pick the host, then what it is for (company site, an app, email).
  Module pages keep their own "add domain" field, calling the same `domains.claim`, and link here.
- Buy / connect stay as today (`managed-domains.md`).
- Website › Settings' routing table becomes a link to this page.

## Contract changes

- **ee API:** `POST /v1/domains` gains `move?: boolean` and refuses `409 {owner}` otherwise;
  `DELETE /v1/domains` takes `{host, workload}`; `GET /v1/status` adds
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
| D1 | ee: refuse instead of move, owner on remove, certificate status + retry, `callsHost` in kernel status | `ee/src/*`, `src/lib/server/ee/client.ts` | ee specs; a site/app taking another's host is refused at ee |
| D2 | Kernel `domains` module: list/claim/release; site, app_domain_*, app_deploy, email.domain_add delegate; one hostname validator; drop `website_services.host` (migration) | `modules/domains/`, `modules/website/*`, `modules/email/*`, `drizzle/` | Unit specs; the three old checks are gone; errors name the owner |
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

## Questions for the owner (product only)

1. **Where you add a domain:** both Settings › Domains and the module pages (same action), or only
   Settings › Domains with the module pages just showing and linking?
2. **Moving a host between owners** (site ↔ app): allowed with an explicit "move it here", or always
   remove first?

## No silent removals

- Website › Settings' "Domains & routing" table is replaced by a link to Settings › Domains (same
  data, more of it).
- "Connect one you have" today adds a mail domain only; it becomes "connect a domain", then choose
  its uses (mail stays one tap).

## Not in this plan

Writing records into the customer's DNS (Cloudflare API etc.), wildcard hosts, preview hosts,
DNSSEC.
