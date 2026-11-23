# Hosted address: a free `<slug>.eigenenterprise.app` for mail and the website

**Status:** APPROVED (owner, 2026-11-23): "a company should get a default subdomain if they dont have a domain right now. currently the only options are buying one, and having one." Scope picked by the owner: **mail + website**.

## 1. What a hosted company gets

Every company hosted on our cloud already runs the app at `<slug>.eigenenterprise.app` (the console host). It now also gets, for free and until it brings its own domain:

- **Mail** on `<slug>.eigenenterprise.app`: a sender like `hello@<slug>.eigenenterprise.app` through eigenEnterprise Mail, sign-in codes from it, and receiving (MX).
- **Website** at `www.<slug>.eigenenterprise.app`: the public site, served as the box's public host. The console host can't be the public host (ee refuses it), and one-level wildcard DNS doesn't cover `www.<slug>.…`, so the record is written explicitly.

The Domain step in the welcome tour gets a third choice, **"Use `<slug>.eigenenterprise.app` for now"**. On hosted boxes it replaces "Skip this step". Settings › Domains shows it as the company's free address, with buy/connect next to it. Self-hosted boxes don't change: there is no hosted address without the cloud, so they keep Skip.

## 2. Decisions (2026-11-23)

- **H1 — One contract field.** The fleet desired state gets `hostedAddress: { mailDomain, siteHost } | null`, behind the feature flag `hostedAddress` (ee announces it; cloud sends it only to boxes that do). Both values are derived from the slug: `mailDomain = <slug>.<HOSTED_DOMAIN>`, `siteHost = www.<slug>.<HOSTED_DOMAIN>`. Adopted boxes (their own console host) get `null`.
- **H2 — The cloud writes the DNS.** `eigenenterprise.app` is a Cloudflare zone, so the control plane gets a Cloudflare DNS driver (with a fake for tests). It uses a zone-scoped API token from env `CLOUDFLARE_DNS_TOKEN` + `CLOUDFLARE_ZONE_ID`, and fails loud when the token is unset and a hosted address is due. Per company it writes:
  - `www.<slug>` CNAME `<slug>.<hosted>`
  - the 3 Easy DKIM CNAMEs
  - `mail.<slug>` MX + SPF TXT (MAIL FROM)
  - the `<slug>` MX to SES inbound

  DMARC comes from the org domain (`_dmarc.eigenenterprise.app`). Every write is idempotent, and deprovisioning deletes them.
- **H3 — A box can only use its own hosted name.** The cloud refuses any reported mail domain or host under `HOSTED_DOMAIN` that isn't that box's own `mailDomain`/`siteHost`, including the apex. Today nothing filters reported mail domains by name, so this guard is new and part of the change. A refused name is logged on the instance (like `mail_error`) and never synced.
- **H4 — The mail domain enters through os, like any domain.** When the owner picks the free address, os adds `mailDomain` to its mail domains (the existing `email.domain_add` path). Fleet reporting and `mail_sync` then create the SES identity unchanged. The only new part is that the cloud writes this identity's records to Cloudflare instead of Route 53 or the customer. The sender is `hello@<mailDomain>` once the identity is ready.
- **H5 — The website enters through ee.** On `hostedAddress`, ee adds `siteHost` as the os public host, but only while os has no public host yet. An own domain the owner connects always wins and is never overwritten. ee status exposes `hostedAddress` to os.
- **H6 — No marketing mail from the shared domain.** Flow (marketing) mail can't use a sender on the hosted address, because a shared parent domain carries everyone's reputation. Personal and transactional mail can. The refusal says why and points to connecting your own domain.
- **H7 — Existing hosted companies** get it on their next poll (the step is idempotent). No migration of their data.

## 3. Workstreams

- **HA-cloud** (eigenEnterprise-cloud): contract field + feature, Cloudflare driver + fake, `hosted_address` records step (provision after `wait_enrolled`, and backfill on poll), the H3 guard, mail_sync writing hosted-identity records to Cloudflare, deprovision cleanup, tests.
- **HA-ee** (eigenEnterprise `ee/`): protocol field + feature announce, apply `siteHost` as the public host per H5, expose `hostedAddress` in ee status, tests.
- **HA-os** (eigenEnterprise `src/`, `modules/`): read `hostedAddress` from ee status; the wizard choice (replaces Skip when present); Settings › Domains free-address card; the sender path; the H6 refusal; registry tools for "use the free address" (no UI-only action); tests.
- **Owner:** a Cloudflare API token scoped to Zone › DNS › Edit on eigenenterprise.app, put in Coolify as `CLOUDFLARE_DNS_TOKEN` + `CLOUDFLARE_ZONE_ID`, then a Coolify redeploy.
