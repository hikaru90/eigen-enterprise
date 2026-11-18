# Managed domains: buy a domain in onboarding, connected automatically

**Status:** draft 2026-11-18, waiting for the owner's approval.
**Owner's words:** "I want there to be an option to buy a domain here and automatically connect a
SES tenant there." "Domain and email step should be disjunct."
**Must stay congruent with:** `managed-mail.md` (one SES tenant per company, provisioning only in
the control plane), `phase-managed-box.md` (pull only, desired state, signed), the control plane's
domain claims (`_ee-verify.<host>` TXT before a custom host is routed).

## Owner decisions (2026-11-18)

- **Registrar: Route 53 in our AWS project** (account `234768039527`). Domain, DNS zone and SES
  tenant live in one account and one API, so every record is written by us, not the customer.
  **Precondition:** the project is upgraded to the Paid plan (AWS Settings; irreversible, applies to
  all projects). On the Free plan every Route 53 Domains call is refused ("Free Tier accounts are
  not supported for this service"); hosted zones work on Free.
- **Price: AWS's price plus a margin**, charged to the company's card on file through Stripe, at
  purchase and at each yearly renewal.
- **Registrant: the company** (its legal name, address, email, phone), with privacy protection on.
  The company owns the domain and can transfer it away; we run it technically.

## The two onboarding steps (separate, as the owner asked)

The wizard today: boot → hello → name → lines → **mail** → mind. The mail act mixes "you need
your own domain" with the SES setup. It becomes two acts:

1. **Domain: "Your company's address on the internet."** (managed boxes; a self-hosted box keeps
   only option b)
   - **a) Buy one here.** Search a name → available names with their yearly price → the
     registrant form (prefilled from the company) → a confirmation that names the price, the yearly
     renewal and that a registration can't be refunded → "Buy for €X / year". The step then shows
     progress (paid → registering → DNS ready) and continues on its own. No DNS step for the
     customer.
   - **b) I already have one.** Enter it; the step shows the DNS records to add (the existing
     records view) and checks them.
   - **c) Skip for now.**
2. **Email: "Your sender address."** Uses the domain from step 1: pick the address (`hello@…`),
   done. Managed boxes need no keys (eigenEnterprise Mail); a self-hosted box gets the existing
   "your own Amazon SES" form here. Without a domain the step says so and offers to go back.

The same two things exist outside onboarding: **Settings › Domains** (buy, connect, renewal date,
status) and Email setup as today.

## Shape

```
box ee ◀── desired {domains: {apiBase, token}} → os secrets EE_DOMAINS_*
box os ──Bearer──▶ control plane /api/domains/v1/  search / purchases / domains (status)
control plane ── charge (Stripe) ──▶ RegisterDomain (Route 53, us-east-1, company as registrant)
              ── 'configuring': the domain joins the company's mail domains (SES identity, tenant)
              ── hosted zone (created with the registration) ──▶ records:
                   SES: 3 DKIM CNAMEs, MAIL FROM MX + SPF, DMARC (p=none to start)
                   receiving: MX → inbound-smtp.eu-north-1.amazonaws.com
                   website: apex + www A, _ee-verify TXT for both (custom host claims verify)
              ── 'active'
```

## Decisions of record (mine; owner may veto)

- **DM1 Prices are set per TLD by the operator,** in EUR, in Cloud ops (a Domains page that shows
  AWS's USD cost next to each price and refuses a price below cost). Only TLDs with a price are
  offered. Reason: AWS bills in USD, Stripe charges in EUR, and a fixed table avoids exchange-rate
  math in code. This is how the margin is applied.
- **DM2 Charge first, then register.** A failed registration refunds the charge in full
  automatically. Renewal is charged 30 days before expiry; a failed charge turns off auto-renew and
  tells the owner in plain words (the domain stays theirs until it expires).
- **DM3 Registrant data is passed through, not kept.** The control plane sends it to Route 53 and
  stores only the domain, its state, price and dates. Route 53 holds the contact (it must).
- **DM4 Records are written only to zones we host and only for that company's domain.** A domain
  the customer brings (option b) stays in their DNS; we never ask for their DNS credentials.
- **DM5 Bought domains become mail domains automatically** (sending and receiving), so the Email
  step only picks the address. The control plane does it at `configuring` (DKIM needs the SES
  identity before the domain can be `active`); os adding an `active` domain is idempotent.
- **DM7 (control plane, at build):** registrant data lives in process memory only until Route 53
  accepts it; a restart in between fails the purchase in plain words (refunded if charged). A
  renewal charges the price the company accepted. A 409 says `reason: taken | price_changed` with
  the current `priceCents`, so os never reads error text.
- **DM6 os calls the control plane's domains API with a per-box token** handed in desired state,
  like `platformAi`'s key. ee's own API is a root-only unix socket os can't reach, and going through
  the poll would make a search wait up to a poll interval. The token only reaches that company's
  domains; the control plane stores its sha256 and a sealed copy (to hand it out again).

## Contract (fixed, so the streams build in parallel)

- `FLEET_FEATURES` += `'domains'` (append).
- `desired.domains`: nullable optional `managedDomainsV1` = `{ apiBase: https origin (no path; os
  joins the full `/api/domains/v1/...` paths), token: string (32–256) }`, strict. Sent only to boxes announcing `domains`, for companies with a Stripe
  customer. ee sets os secrets `EE_DOMAINS_API_BASE`, `EE_DOMAINS_TOKEN` (all or none; a partial
  set fails loud at os start), null removes them, like platform AI.
- Control-plane API, `Authorization: Bearer <token>`, JSON, errors `{ error: string }`:
  - `GET /api/domains/v1/search?q=<label>` → `{ results: [{ name, available, priceCents|null,
    currency: 'EUR' }] }`: `q` is one label (a-z, 0-9, hyphen, 1–63), tried on every TLD with an
    operator price, at most 10 results.
  - `POST /api/domains/v1/purchases` `{ name, acceptedPriceCents, registrant }` → 202
    `{ name, state }`. `registrant` = `{ firstName, lastName, organization, email, phone
    ("+49.301234567"), addressLine1, addressLine2?, city, postalCode, countryCode (ISO 3166-1
    alpha-2), state? }`. 409 `{ error, reason: 'taken' | 'price_changed', priceCents|null }`, 402 when the
    company has no payment method, 400 on invalid fields.
  - `GET /api/domains/v1/domains` → `{ domains: [{ name, state: 'charging' | 'registering' |
    'configuring' | 'active' | 'failed', error|null, renewsAt|null, autoRenew }] }`.
- Records the control plane writes in a bought domain's zone (`configuring` → `active`): the SES
  identity's 3 DKIM CNAMEs (it waits for mail_sync to create the identity), MAIL FROM `mail.<d>`
  MX + SPF TXT, `MX 10 inbound-smtp.<region>.amazonaws.com`, `_dmarc` TXT `v=DMARC1; p=none`,
  `_ee-verify.<d>` and `_ee-verify.www.<d>` TXT (the company's claim token), apex + `www` A to
  the company's host IPv4.
- os, on a domain turning `active`: adds it as a mail domain with receiving on (managed mode),
  which goes up in `report.mail.domains` as today.

## Slices (TDD; worktrees under `.claude/worktrees/`)

| # | Slice | Where | Done when |
|---|---|---|---|
| DM0 | Owner: upgrade the AWS project to Paid; then a spike: availability, prices, one real registration of a cheap test domain (owner approves the purchase), zone records, SES identity verifies | AWS | Recorded here with the real error names and timings |
| DM1 | Protocol + ee: `desired.domains`; ee sets `EE_DOMAINS_*` on os (like platform AI) and announces `domains` | `ee/src/fleet/*` | Schema + agent specs. **Done** (`fa24949`) |
| DM2 | os: Domain act and Email act split; Settings › Domains; status from desired; bought domain → mail domain | `src/lib/components/*`, `modules/email/*`, `src/routes/*` | Component + unit tests; own-SES and "I have a domain" paths unchanged |
| DM3 | Control plane: Route 53 Domains + zone driver (+ fake), domains table, TLD price table in ops, Stripe charge/refund/renewal, register + records jobs | `eigenEnterprise-cloud` | Tests against the fakes; idempotent re-runs |
| DM4 | Real proof on `one.eigenenterprise.app`: buy a domain in onboarding, mail sends from it, the website answers on it | box + control plane | Owner sees it working |

DM1 ∥ DM2 ∥ DM3 against the fixed contract above; DM0 and DM4 need the Paid plan.

## Not in this plan

Domain transfers in, buying for self-hosted installs, premium domains, TLDs Route 53 doesn't sell.
