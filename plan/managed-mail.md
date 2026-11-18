# Managed mail: hosted companies send and receive on our SES, one tenant each

**Status:** plan only, no code. Owner decision 2026-11-18: "Our SES, tenants". A hosted company
gets working email without opening an AWS account, verifying anything in the AWS console or
waiting for Amazon to review a production-access request.
**Must stay congruent with:** `phase-managed-box.md` (pull only, desired state, signed, the
control plane lives in the private `eigenEnterprise-cloud` repo), `email-inbox.md` (receiving
via S3 + SNS, exact-address routing), `contribute-phone-home.md` (the signing pattern).

## Why

Today a company needs **its own Amazon SES account** (`modules/email/manifest.ts`). The owner
creates it, makes IAM keys, verifies the domain, publishes DNS and asks Amazon for production
access. Amazon reviews that request separately per account and per region, answers within
24h and gives no reason when it says no. On production this has blocked inbox S7 since 2026-11-12.
AWS's own pattern for a SaaS sending on behalf of its customers is one account with an
**SES tenant per customer**. Each tenant has its own reputation and its own auto-pause, so one
company's bad sending stops only that company.

## Shape

```
control plane (eigenEnterprise-cloud)            our AWS account, eu-central-1
  reconciles per managed box ───────────────────▶ tenant ee-<boxId>
                                                   identities (company domains, Easy DKIM)
                                                   config set ee-<boxId> ─▶ SNS box topic + metering topic
                                                   IAM user ee-<boxId> (send as own domains, read own S3 prefix)
                                                   receipt rule(s): domains → S3 inbound/<boxId>/ + SNS inbound-<boxId>
box ── poll: report {mail.domains wanted} ──▶ control plane
box ◀── desired {mail: region, tenant, config set, key, bucket/prefix, topics, per-domain status + DNS}
box ── SendEmail(TenantName, ConfigurationSetName) ──▶ SES            (no relay through us)
SES ── SNS https ──▶ box /api/mail/ses-events, /api/mail/ses-inbound  (AWS pushes, we never connect in)
```

## Decisions of record

- **D1 Who gets it.** Managed (hosted) boxes only. Self-hosted installs keep "your own Amazon SES"
  exactly as today, and a hosted owner can still choose their own SES. **Nothing is removed.**
  Production (os.cerberusblue.com) stays on its own SES account.
- **D2 One account, one region, one tenant per company.** Our AWS account (dedicated to the
  hosted mail platform), eu-central-1, tenant `ee-<boxId>`, AWS's standard reputation policy
  (high-risk sending auto-pauses the tenant). One production-access request, for us.
- **D3 The box holds a scoped key; we don't relay.** The control plane hands each box its own IAM
  key in desired state, the same way `backup` hands it S3 credentials, and rotates it. The key
  can only send as that company's identities through its config set (and tenant, if IAM can
  scope it; T0 checks) and read/delete its own `inbound/<boxId>/` prefix. A leaked key can do no
  more than the box already does. Sending never goes through the control plane, so it can't
  take mail down.
- **D4 Provisioning lives in the control plane.** In managed mode the box never calls
  CreateEmailIdentity, receipt-rule, SNS or bucket APIs. `owlery/*` provisioning stays for own-SES mode.
- **D5 Easy DKIM in managed mode.** SES makes the key and the box shows the three CNAMEs
  (`DomainIdentityInfo.dkimTokens`), so no private key ever leaves the box. BYO-DKIM stays for own-SES.
- **D6 Receiving by domain, not by address.** Only one receipt rule set can be active per
  account, at 200 rules x 100 recipients. Listing addresses would cap the whole platform at 20,000
  mailboxes, so rules list **domains** (20,000 domains). The box keeps exact-address routing.
  Mail to an address nobody holds is accepted by SES, then the box deletes it (ids only in the
  log, no bounce, to avoid backscatter). Past that ceiling: SES Mail Manager, which would get its own plan.
- **D7 Two event destinations.** The config set feeds the box's topic (the existing `ses-events`
  flow, unchanged) and a metering topic the control plane reads. Counts per tenant drive
  billing, abuse checks and the paused status.
- **D8 Plain words, managed edition.** In managed mode the box never calls GetAccount (the
  scoped key can't), so the sandbox message never shows. If the tenant is paused, desired
  state says so and the Email page reads: "Sending is paused because too many mails bounced or
  were marked as spam. Contact support." Only structured status is used, never Amazon's wording.
- **D9 SNS pinned to desired state.** Besides the signature check (`platform/sns-signature.ts`),
  the box accepts only TopicArns that desired state names, since the topics now live in an
  account the box doesn't own.

## Slices (TDD; worktrees under `.claude/worktrees/`)

| # | Slice | Where | Done when |
|---|---|---|---|
| T0 | Spike on our account: tenant + Easy DKIM identity + IAM policy scoped to identity/config set (+ `ses:TenantName` if it exists) + domain receipt rule to an S3 prefix + SNS to an HTTPS endpoint | AWS, docs | Confirmed IAM policy JSON (IAM policy simulator + one real send and one denied send as another domain); written into this file |
| T1 | Protocol: feature `mail`; `report.mail.domains` (`{name, receive}`); `desired.mail` (region, tenant, configurationSet, key, inbound bucket/prefix, topic ARNs, per-domain verification + DNS records + receiving + paused) | `ee/src/fleet/protocol.ts` (+ spec) | Schema tests; an older box ignores and reports `mail` |
| T2 | Box: mail provider `managed` in `companyMail()` from desired state; sends pass TenantName + config set; Setup → Domains shows managed status + Easy DKIM records; no provisioning calls in managed mode; SNS TopicArn pinning; inbound reads `inbound/<boxId>/`, unknown address → delete raw | `modules/email/*`, `src/lib/server/mail/*` | Unit + component tests with fakes; own-SES flows unchanged (existing specs green, untouched) |
| T3 | Control plane reconcile per box: tenant, identities, config set + 2 destinations, IAM user/policy/key rotation, receipt rules chunked by domain, per-box topics + subscriptions, metering, paused status, teardown on offboard (DeleteTenant, identities, rules, IAM, S3 prefix) | `eigenEnterprise-cloud` | Its own tests against AWS fakes; idempotent re-run |
| T4 | Real proof on a hosted test company: send out, a reply lands in the inbox, a bounce and a complaint show in the log, a send as a foreign domain is denied | box + control plane | Recorded here; also closes inbox S7 for managed boxes |

T0 → T1 → T2 / T3 in parallel (disjoint repos) → T4.

## Owner steps (not code)

A dedicated AWS account for the hosted mail platform. SES production access for it in
eu-central-1 (we draft the use-case text: transactional and person-to-person mail for hosted
business customers, tenant isolation, bounce/complaint handling, double opt-in lists). A
sending-quota increase sized for the first customers. Tracked in `plan/progress.md`.

## Open (owner, product choices)

- **Price:** is managed mail part of the hosted seat, or a paid add-on with a fair-use cap?
  Metering (D7) supports either way.
- **Domains:** let the customer buy their domain inside ee (reseller API, customer as
  registrant, DNS records written automatically). Researched 2026-11-18; it needs its own plan.
- **Self-hosters:** offer managed mail to self-hosted installs later (they would need to enrol with the control plane)?
