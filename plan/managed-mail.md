# Managed mail: hosted companies send and receive on our SES, one tenant each

**Status:** approved 2026-11-18 ("Our SES, tenants"; "build it then after you scrutinize the plan").
A hosted company gets working email without opening an AWS account, verifying anything in the
AWS console or waiting for Amazon to review a production-access request.
**Must stay congruent with:** `phase-managed-box.md` (pull only, desired state, signed, the
control plane lives in the private `eigenEnterprise-cloud` repo), `email-inbox.md` (receiving
via S3 + SNS, exact-address routing).

## Why

Today a company needs **its own Amazon SES account** (`modules/email/manifest.ts`): the owner
creates it, makes IAM keys, verifies the domain, publishes DNS and asks Amazon for production
access (reviewed per account and per region, no reason given on denial). On production that has
blocked inbox S7 since 2026-11-12. AWS's own pattern for a SaaS sending on behalf of its customers
is one account with an **SES tenant per customer**: each tenant has its own reputation and its own
auto-pause.

## Shape

```
control plane (eigenEnterprise-cloud), our AWS account, eu-north-1
  provision job  → tenant ee-<boxId>, config sets ee-<boxId> + ee-<boxId>-tracking,
                   SNS topics ee-<boxId>-mail-events / ee-<boxId>-inbound (https → the box),
                   IAM user ee-<boxId> + key, receipt rule ee-<boxId> in the shared active rule set
  mail_sync job  ← report.mail.domains: identities (Easy DKIM + MAIL FROM, tag ee-box=<boxId>),
                   tenant associations, the rule's recipients = the receiving domains
box ee  ── poll: report {mail.domains} (from os on loopback) ──▶ control plane
box ee  ◀── desired {mail: static config + key}  → os secrets EE_MAIL_* (like platformAi)
box os  ── SendEmail(TenantName, ConfigurationSetName) ──▶ SES        (no relay through us)
        ── GetEmailIdentity / GetTenant (own resources only) ──▶ SES  (status, DKIM CNAMEs, paused)
SES/SNS ── https ──▶ os /api/mail/ses-events, /api/mail/ses-inbound   (AWS pushes, we never connect in)
```

## Decisions of record

- **D1 Who gets it.** Managed (hosted) boxes only. Self-hosted installs keep "your own Amazon SES"
  exactly as today. On a managed box, credentials the owner saved for their own SES **take
  precedence**; without them the box uses managed mail. **Nothing is removed.** Production
  (os.cerberusblue.com) stays on its own SES account.
- **D2 One account, one region, one tenant per company.** A dedicated AWS account, **eu-north-1**
  (owner, 2026-11-18: the account is an AWS "new experience" project, which AWS locks to the
  Region of its contact country; eu-central-1 is denied by AWS's managed SCP. Stockholm is in the
  EU and has SES sending and receiving), tenant `ee-<boxId>`, tenant-scoped suppression list (one company's bounces never block another
  company's mail), AWS's standard reputation policy (high-risk sending auto-pauses the tenant).
- **D3 The box holds a scoped key; we don't relay.** The key arrives in desired state, like
  `platformAi`, and becomes os secrets. IAM (proven by T0 with real calls, see "T0 result"):
  `ses:SendEmail` on `identity/*` and on its two config sets + its tenant, all with
  `ses:TenantName = ee-<boxId>` (SES refuses identities not associated with that tenant; a tag
  condition on identities never matches for SendEmail); `ses:GetEmailIdentity` on its tagged
  identities; `ses:GetTenant` and suppression list/get/delete on its tenant ARN; `s3:GetObject` + `s3:DeleteObject` on
  `<inbound bucket>/<boxId>/*`. Nothing else: no GetAccount, no Create*, no receipt rules.
- **D4 Provisioning lives in the control plane.** In managed mode os never calls
  CreateEmailIdentity, DeleteEmailIdentity, receipt-rule, SNS, bucket or event-destination APIs.
- **D5 Static config in env, domain status from SES.** Desired `mail` carries only what never
  changes per box (region, key, tenant, config sets, topic ARNs, bucket, prefix), so os isn't
  redeployed when a domain changes. os reads each domain's verification and its Easy DKIM tokens
  with its own GetEmailIdentity, and the paused state with GetTenant. The domains the company
  wants (and which receive mail) go up in `report.mail.domains`, read from os on loopback like
  seats.
- **D6 Easy DKIM in managed mode.** SES makes the key and `dns.ts` already renders the three
  CNAMEs from `dkimTokens`; no private key leaves anything. BYO-DKIM stays for own-SES.
- **D7 Receiving: one rule per company.** Only one receipt rule set can be active per account,
  at 200 rules. Each company gets rule `ee-<boxId>` (recipients = its receiving **domains**, up to
  100; S3 action to the shared bucket with key prefix `<boxId>/`, notifying its inbound topic).
  That caps one account+region at about 195 companies. Past that, more accounts (AWS's documented
  fallback); the control plane stores which account a company is on from day one. os keeps
  exact-address routing; mail to an address nobody holds is deleted (ids only in the log, no
  bounce, to avoid backscatter).
- **D8 Plain words, managed edition.** No sandbox message (managed mode never calls GetAccount).
  Tenant `SendingStatus` DISABLED → "Sending is paused because too many mails bounced or were
  marked as spam. Contact support." A domain SES doesn't know yet → "eigenEnterprise Mail is
  adding this domain (a minute or two)." Senders are domain senders only; a single address on
  another domain is refused in plain words.
- **D9 SNS pinned.** The webhooks accept only the topic ARNs in os's managed config; inbound also
  requires the key to start with `<boxId>/`.
- **D10 Rollout order.** The control plane's report schema is strict, so the control plane ships
  the new protocol first, then boxes. An older box simply never sends `mail` and ignores it.
- **D11 Later, not now:** metering per tenant (a second event destination) waits for the pricing
  decision; dedicated IPs; Mail Manager.

## Contract (fixed, so the streams build in parallel)

- `FLEET_FEATURES` += `'mail'`.
- `report.mail`: `{ domains: [{ name, receive: boolean }] (max 50) } | null`, optional
  (absent = box doesn't do mail).
- `desired.mail`: nullable optional `managedMailV1` = `{ region, accessKeyId, secretAccessKey,
  tenant, configurationSet, trackingConfigurationSet, eventsTopicArn, inboundTopicArn,
  inboundBucket, inboundPrefix }`, all strings, strict. `inboundPrefix` is the bare box id (no
  slash); S3 keys are `<inboundPrefix>/<messageId>`.
- os secrets (ee sets them like `PLATFORM_AI_SECRETS`): `EE_MAIL_REGION`, `EE_MAIL_ACCESS_KEY_ID`,
  `EE_MAIL_SECRET_ACCESS_KEY`, `EE_MAIL_TENANT`, `EE_MAIL_CONFIG_SET`, `EE_MAIL_TRACKING_CONFIG_SET`,
  `EE_MAIL_EVENTS_TOPIC_ARN`, `EE_MAIL_INBOUND_TOPIC_ARN`, `EE_MAIL_INBOUND_BUCKET`,
  `EE_MAIL_INBOUND_PREFIX`. All or none; a partial set fails loud at start.
- os loopback: `GET /api/fleet/mail-domains` (bearer `EE_FLEET_LOCAL_TOKEN`, like seats) →
  `{ domains: [{ name, receive }] }`.

## Slices (TDD; worktrees under `.claude/worktrees/`)

| # | Slice | Where | Done when |
|---|---|---|---|
| T0 | Spike on our account: tenant, Easy DKIM identity, the D3 policy, a rule with an S3 prefix, SNS to HTTPS | AWS | Policy JSON confirmed (simulator + one real send, one denied send as another company's domain); recorded here. **Done 2026-11-18**, see "T0 result" (T3 policy needs 3 fixes) |
| T1 | Protocol + ee: the contract above; `applyMail` (secrets on os, like platform AI); report reads os loopback | `ee/src/fleet/*` | Schema + agent specs |
| T2 | os managed mode: settings from `EE_MAIL_*`, TenantName on sends, domains without provisioning (Easy DKIM via GetEmailIdentity), receiving flag only, pinned webhooks + prefix, unknown recipient deleted, tenant pause + suppression, Setup UI + onboarding, loopback route | `modules/email/*`, `src/lib/server/mail/*`, `src/routes/*` | Unit + component tests with fakes; own-SES specs green and untouched |
| T3 | Control plane: AWS driver (+ fake), instance mail columns, provision/deprovision steps, `mail_sync` from the report, `desired.mail` | `eigenEnterprise-cloud` | Its tests against the fake; idempotent re-run |
| T4 | Real proof on a hosted test company | box + control plane | Send out, reply lands in the inbox, bounce + complaint logged, foreign-domain send denied |

T1 ∥ T2 → T3 (vendors T1's protocol) → T0 + T4 need the owner's AWS account.

## Owner steps (not code)

A dedicated AWS account for hosted mail; SES production access for it in eu-north-1 (we draft
the use-case text); a sending-quota increase for the first customers; an IAM key for the control
plane (env `MAIL_AWS_*`). Tracked in `plan/progress.md`.

**Account (2026-11-18):** AWS "new experience" project, account `234768039527`, eu-north-1,
Free plan ($100 credits, upgrade to Paid required by 2027-05-18 or when credits run out;
irreversible, applies to all projects). AWS's managed SCPs allow `ses:*`, `sns:*`, `s3:*` and
IAM users + access keys (groups, login profiles, providers are denied). Risks: near the spend
limit AWS denies `ses:CreateConfigurationSet` and `sns:CreateTopic` (no new companies), and at
the limit it **pauses the whole project** (every company's mail stops). SES sandbox: 200/day,
1/s, production access not yet requested.

## T0 result (done 2026-11-18; account above, eu-north-1)

Everything below was proven with **real calls as a box key**. The IAM policy simulator can't
decide `ses:TenantName` (even a policy that only checks that key is `implicitDeny`), so it is no
proof for sends.

**Resources left in place** (for T4 to compare against): tenant `ee-t0spike`
(`…:tenant/ee-t0spike/tn-b6532c81c100087b8cf9853d6575b`, suppression scope TENANT), identities
`t0.eigenenterprise.app` (verified, Easy DKIM, tag `ee-box=t0spike`, default config set,
associated) and `t0-other.eigenenterprise.app` (unverified, tag `ee-box=t0other`), config sets
`ee-t0spike` + `-tracking`, SNS `ee-t0spike-mail-events` (event destination on the config set) and
`ee-t0spike-inbound`, bucket `ee-mail-inbound-234768039527-eu-north-1` (public access blocked; SES
may PutObject from rule set `ee-mail`), **active rule set `ee-mail`** with rule `ee-t0spike`.
Removed: IAM user `ee-t0spike` and its key, the SQS probe queues. DNS in Cloudflare: three DKIM
CNAMEs + MX `t0` → `inbound-smtp.eu-north-1.amazonaws.com` on `eigenenterprise.app`.

**What works**
- Sending as its own tenant: delivered to the success, bounce and complaint simulators. Events on
  the topic: Send, Delivery, Bounce, Complaint (`abuse`). Each event carries `mail.tenant` and the
  tag `ses:tenant`, plus `ses:configuration-set` and `ses:caller-identity`.
- `ses:TenantName` scoping: a send with no tenant name, or with another company's tenant name, is
  denied. A tenant that doesn't exist is `NotFoundException` ("Tenant X for AwsAccountId … not found").
- **SES enforces the tenant association:** a send through a verified identity that isn't associated
  with the named tenant fails with `AccessDeniedException` "Tenant not associated with resources
  [identity/…]". IAM pins the tenant name, so a box can only send through identities the control
  plane associated with its tenant.
- Reads: GetEmailIdentity on its own tagged identity works and on another company's is denied;
  GetTenant on its own tenant works; the tenant-scoped suppression list works.
- No Create*: CreateEmailIdentity and the account-level suppression list are denied.
- Receiving round trip: a mail to `hello@t0.eigenenterprise.app` landed under `t0spike/` with a
  `Received` notification on the inbound topic (spam, virus, DKIM and SPF all PASS). The box key
  read and deleted it; it is denied another company's prefix.

**What T3's policy (`eigenEnterprise-cloud` `drivers/mail-policy.ts`) needs to change**
1. **Sending with a tag condition on identities is always denied.** SES checks the verified domain's
   ARN (`identity/<domain>`; while the domain is unverified, the sending address's ARN), but
   `aws:ResourceTag` on an identity doesn't match for SendEmail. It does match for GetEmailIdentity
   and on configuration sets. Fix: `SendAsOwnIdentities` = `Resource: identity/*`, condition
   `ses:TenantName` only. That is safe because of the enforced association above, and the policy
   never changes when a company's domains change (D5 holds). Naming each domain's ARN also works,
   but it would rewrite the box policy on every domain change.
2. **Suppression:** `Resource: "*"` + `ses:TenantName` denies the box its own tenant's list.
   Fix: `Resource: [tenantArn]`, no condition (calls pass `TenantName`).
3. **New:** SES emails bounce and complaint reports back to the sender by default ("feedback
   forwarding"), so they arrive as inbound mail. Managed mode gets them from SNS. So the control
   plane should switch forwarding off per identity (`PutEmailIdentityFeedbackAttributes`,
   `EmailForwardingEnabled=false`), otherwise they land in the company's inbox, or are deleted as
   unrouted.

Proven box policy (box `t0spike`):

```json
[
  { "Sid": "SendAsOwnIdentities", "Action": "ses:SendEmail", "Resource": ["arn:aws:ses:eu-north-1:234768039527:identity/*"],
    "Condition": { "StringEquals": { "ses:TenantName": "ee-t0spike" } } },
  { "Sid": "SendThroughOwnConfigSetsAndTenant", "Action": "ses:SendEmail",
    "Resource": ["…:configuration-set/ee-t0spike", "…:configuration-set/ee-t0spike-tracking", "…:tenant/ee-t0spike/<id>"],
    "Condition": { "StringEquals": { "ses:TenantName": "ee-t0spike" } } },
  { "Sid": "ReadOwnIdentities", "Action": "ses:GetEmailIdentity", "Resource": ["…:identity/*"],
    "Condition": { "StringEquals": { "aws:ResourceTag/ee-box": "t0spike" } } },
  { "Sid": "ReadOwnTenant", "Action": "ses:GetTenant", "Resource": ["…:tenant/ee-t0spike/<id>"] },
  { "Sid": "OwnTenantSuppressionList", "Action": ["ses:ListSuppressedDestinations", "ses:GetSuppressedDestination", "ses:DeleteSuppressedDestination"],
    "Resource": ["…:tenant/ee-t0spike/<id>"] },
  { "Sid": "OwnInboundMail", "Action": ["s3:GetObject", "s3:DeleteObject"], "Resource": ["arn:aws:s3:::<bucket>/t0spike/*"] }
]
```
(all `"Effect": "Allow"`; a send without a configuration set is denied, which is fine because os
always names one.)

**Not tested:** SNS → HTTPS to a real box (T4); production access (still in the sandbox).

## Open (owner, product choices)

- **Price:** part of the hosted seat, or a paid add-on with a fair-use cap?
- **Domains:** buying the domain inside ee (reseller API, customer as registrant, DNS written
  automatically). Researched 2026-11-18; its own plan.
- **Self-hosters:** offer managed mail to self-hosted installs later?
