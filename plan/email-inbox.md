# Email inbox — personal and shared mailboxes on SES receiving (approved 2026-11-12)

Source: Contribute board `eb674853` (+ round-1 `b8a87a25`): "Das Email-Postfach sollte sofort den
Posteingang zeigen." Owner, 2026-11-12: every owner and member gets their own address
(`firstname.lastname@<company domain>`) with their own Inbox, Spam, etc. — a webmail in the Email
module, not only sending. Status: **plan only, no code.**

**Owner decisions (2026-11-12):**
- **Receiving:** Amazon SES email receiving on the company's own SES account (MX → SES, receipt
  rule → S3 + SNS → the console). No mail server on the box.
- **Privacy:** a personal inbox is readable **only by its member**. The owner can't open it; agents
  can't read it. Shared addresses (info@, hello@) are separate mailboxes for a members group.
- **Addresses:** the **owner assigns each mailbox** by hand. Nothing is created on join. The form
  suggests `firstname.lastname` from the member's profile as a prefill only.
- **Landing:** `/m/email` opens on **your inbox**. Today's view (Pending + last 10 sent, company-wide)
  moves to a **Company mail** tab for admins. Nothing is removed; it moves (announced here and in
  `progress.md`).

## Where we start

- Outbound only: `modules/email/owlery/ses.ts` (SESv2 client per company, `SesCredentials` with
  region), `modules/email/platform/*` (domains, DNS records in `dns.ts`, senders, templates, flows,
  logs, suppression). Delivery events come in over SNS at `/api/mail/ses-events`, with signatures
  checked in `platform/sns-signature.ts`, and `owlery/sns.ts` creates topics and subscriptions.
- Nothing receives or stores inbound mail (progress.md: "Inbound mail isn't stored (no inbox)").
- Access: `src/routes/(nucleus)/m/email/access.server.ts` — every member reads, admins change.
  Tabs in `.../m/email/tabs.ts` (Mail, Lists, Setup).
- Members groups exist (`members.group_*` tools) — reused for shared-mailbox access.
- Realtime pattern to copy: Messages SSE over Postgres LISTEN/NOTIFY (`MessagesHub`).

## Shape

```
sender MTA ──smtp──▶ SES inbound-smtp.<region>   (MX of each receiving domain)
                       │ receipt rule: recipients = assigned addresses, spam + virus scan on
                       ├─▶ S3  ee-<company>-inbound/<messageId>   (raw MIME)
                       └─▶ SNS topic "inbound" ──https──▶ console /api/mail/ses-inbound
console: verify SNS signature → fetch raw from S3 → parse MIME → route to mailbox(es) → store
         → NOTIFY → open webmail tabs update over SSE
reply/compose: console → existing SES send path, From = the mailbox address → Sent folder
```

### 1. Data (`drizzle/NNNN_mailboxes.sql` + journal + schema in `src/lib/server/db/`)
- `mailbox` — id, `address` (unique, lowercase), `domain_id` (a verified email domain),
  `kind` `personal|shared`, `owner_user_id` (personal) or `group_id` (shared), `display_name`,
  `disabled_at`.
- `mailbox_alias` — extra addresses delivering into a mailbox (owner-managed).
- `mail_message` — id, `mailbox_id`, `folder` `inbox|sent|spam|trash|archive`, `thread_id`,
  RFC `message_id`, `in_reply_to`, `references[]`, from/to/cc (jsonb), subject, snippet,
  `text_body`, `html_body` (sanitized at render, stored as received), `received_at`, `read_at`,
  `starred`, SES verdicts (`spam`, `virus`, `spf`, `dkim`, `dmarc`), `raw_s3_key`, `size_bytes`.
- `mail_attachment` — message_id, filename, content type, size, MIME part index (bytes are read
  from the raw S3 object on download, not copied into Postgres).
- One inbound mail to two of our addresses is stored once per mailbox (privacy: no shared rows).

### 2. Receiving setup (Setup → Domains, admin only)
- New per-domain action **"Receive mail on this domain"**. It adds an `inbound_mx` record to
  `dns.ts` (`MX 10 inbound-smtp.<region>.amazonaws.com` on the domain itself). **Warning shown
  first:** if the domain already has MX records (Google Workspace, etc.), switching moves *all*
  mail for that domain to eigenEnterprise.
- Provisioning in `owlery/ses.ts` + `owlery/sns.ts` (+ an S3 client): create bucket
  `ee-<company>-inbound` with the SES-write bucket policy, the `inbound` SNS topic subscribed to
  `/api/mail/ses-inbound`, and an active receipt rule set with one rule whose recipients are the
  exact assigned addresses + aliases (kept in sync on every mailbox change), `ScanEnabled: true`,
  actions S3 then SNS. Missing IAM permissions come back as a plain setup error (no fallback).
- Status line in Setup → Account: receiving on/off per domain, MX seen/not seen (DNS check like
  the existing verification).

### 3. Ingest (`/api/mail/ses-inbound`)
- Reuse `sns-signature.ts`; confirm the subscription like `ses-events`.
- Fetch raw from S3, parse MIME (`mailparser`), match recipients to mailbox/alias addresses
  (exact address lookup — not a heuristic), store, NOTIFY.
- Folder: SES `spamVerdict`/`virusVerdict` FAIL or DMARC FAIL with reject policy → **Spam**
  (virus: attachments blocked from download); otherwise **Inbox**. Structured verdict fields
  only — no keyword logic. "Not spam" / "Spam" buttons move mail between folders.
- Threading: `In-Reply-To`/`References` header ids → existing `thread_id`, else new thread.
- Idempotent on SES message id (SNS retries).
- No mail content in activity log, PostHog, server logs or memory ingestion (ids + sizes only).

### 4. Webmail UI (`/m/email`)
- Landing = your mailbox's Inbox. Mailbox switcher when you can read several (personal + shared).
- Folders: Inbox, Sent, Spam, Trash, Archive, unread counts. Thread list + reading pane;
  search over subject/from/snippet in the mailbox.
- HTML mail in a sandboxed iframe, sanitized, **remote images blocked** until "Show images".
- Compose / reply / reply all / forward: sends through the existing SES path with From = the
  mailbox address, sets `In-Reply-To`/`References`, files a copy in Sent. Attachments upload.
- New mail live over SSE. A member with no mailbox sees "No mailbox yet — the owner assigns one."
- Tabs become: **Inbox**, Lists, **Company mail** (admins: today's Pending + Sent log), Setup.

### 5. Mailboxes admin (Setup → Mailboxes, owner/admin)
- Assign a personal mailbox to a member (address prefilled `firstname.lastname`, editable; clash →
  error, owner picks another), create shared mailboxes for a group, aliases, disable.
- Admins see address, owner, counts, size — **never** message contents.

### 6. Access rules (enforced in the store, tested)
- Personal: only `owner_user_id`. Shared: members of `group_id`. Everyone else gets 404, the owner
  included. No kernel/MCP tool reads mailbox contents (agent access is out of scope; if ever,
  opt-in per member).

## S0 result (2026-11-12, docs + production read-only)

**Region: OK.** Production (os.cerberusblue.com) uses SES in **eu-central-1**, which has an
email-receiving endpoint: `inbound-smtp.eu-central-1.amazonaws.com`. The topic, the KMS key
(if any) and the receipt rules must be in the same region. The bucket may be elsewhere, but
we keep it in eu-central-1 too.

**Blockers on production (the owner's own steps in AWS / DNS, none are code):**
1. **No verified domain.** `email.domain_list` is empty; only the address `hello@cerberusblue.com`
   is verified. Receiving needs a verified **domain** identity ("create and verify a domain
   identity", SES receiving walkthrough). Add `cerberusblue.com` under Setup → Domains and publish
   its DKIM records first. This step already exists in the Email module.
2. **Account is in the SES sandbox.** The docs only tie the sandbox to *sending*. Receiving should
   work, but no page says so explicitly, and S7 proves it. Replies and new mail to outside
   addresses fail until the owner requests SES production access in the AWS console. The
   webmail then has to say plainly why a send failed (no silent drop).

**Design changes from the docs:**
- **Use one S3 action with its notification topic**, not a separate SNS action. The SNS action
  carries at most 150 KB of mail, and anything larger bounces. The S3 action takes up to 40 MB
  and can publish to a topic after writing. The notification carries `receipt.action.bucketName`
  / `objectKey` (= `mail.messageId`), and the console fetches the raw mail from S3.
- **Only one receipt rule set can be active per account.** Setup reads the active set first.
  If the company's account already has a different active set (used outside ee), setup **stops
  with an explicit error** and never replaces it. Otherwise we create and activate `ee-inbound`
  and add rules to it.
- **Unknown recipients:** with recipient conditions, SES "blocks the email" when no rule matches.
  The docs don't say whether that is an SMTP reject or a silent drop, so S7 checks which.
  Either way, mail to an address nobody holds never reaches the console.
- **Recipient limit:** the quotas page says 500 recipients per rule; the console walkthrough says
  100. Plan for **100 per rule**: chunk the addresses into rules `ee-inbound-1..n` (at most 200
  rules per set).
- **Verdicts** (`receipt.spamVerdict|virusVerdict|spfVerdict|dkimVerdict|dmarcVerdict.status`)
  are `PASS|FAIL|GRAY|PROCESSING_FAILED`. `receipt.dmarcPolicy` (`none|quarantine|reject`)
  appears only on a DMARC failure. Routing: spam or virus `FAIL`, or DMARC `FAIL` with policy
  `quarantine`/`reject` → Spam. Virus `FAIL` → attachments blocked. Everything else → Inbox.
  Route on `receipt.recipients` (the envelope RCPT TO), not on the `To:` header, so Bcc arrives.
- **Permissions on resources:** the bucket policy allows `ses.amazonaws.com` `s3:PutObject` on
  `arn:aws:s3:::<bucket>/*` with `AWS:SourceAccount` = account and `AWS:SourceArn` =
  `arn:aws:ses:<region>:<account>:receipt-rule-set/ee-inbound:receipt-rule/*`. A same-account SNS
  topic needs no topic policy (the docs give one only for cross-account topics). No custom KMS
  key: SSE-S3 on the bucket. Object Lock must stay off (SES can't write into those buckets).

**Code dependencies:** receipt rules exist only in the **SES v1 API** (`@aws-sdk/client-ses`:
`DescribeActiveReceiptRuleSet`, `CreateReceiptRuleSet`, `SetActiveReceiptRuleSet`,
`CreateReceiptRule`, `UpdateReceiptRule`, `DescribeReceiptRuleSet`), not SESv2. That package plus
`@aws-sdk/client-s3` are new dependencies.

**IAM for the company's keys:** they have `AmazonSESFullAccess` + `AmazonSNSFullAccess` today
(the setup errors in `owlery/ses.ts` and `owlery/service.ts` say so). SESFullAccess covers the
`ses:*Receipt*` actions. **New:** S3 on the inbound bucket only — `s3:CreateBucket`,
`s3:PutBucketPolicy`, `s3:PutBucketPublicAccessBlock`, `s3:PutEncryptionConfiguration`,
`s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::ee-<company>-inbound[/*]`. Setup shows this
policy as copyable JSON, and a missing permission comes back as a plain message, like the
SES/SNS ones.

Sources: AWS SES Developer Guide (receiving concepts, console walkthrough, permissions, S3 and
SNS actions, notification contents, quotas) and the AWS General Reference SES endpoints table.

## S3 notes (2026-11-12, decisions the plan left open)

- **Status codes for SNS:** wrong topic 403; malformed, non-S3 action, foreign bucket, over 40 MB or
  no sender at all → 400 (never retried); raw fetch or DB failure → thrown → 5xx (SNS retries, and
  `(mailbox_id, ses_message_id)` makes the retry a no-op). No stored inbound bucket yet → 503 (retry,
  don't drop). A well-formed notification that is not `Received` (SES's setup test) → 200, ignored.
  `UnsubscribeConfirmation` on our topic sets receiving `failed`, like the delivery events.
- **Received time** is SES's `mail.timestamp`, not the sender's `Date:` header.
- **No `From:` header:** the envelope sender (`mail.source`) is used as From; with neither, 400.
- **Attachments** (migration 0131): every mailparser attachment, inline `cid:` parts included, is
  found again by `part_index` (its position in mailparser's list) and proven by `checksum` (md5).
- **Threading:** the earliest stored mail in the same mailbox whose Message-ID is the
  `In-Reply-To` or any `References` id gives the thread; otherwise a new one.
- **HTML-only mail:** `text_body` and the snippet come from mailparser's own HTML-to-text output.

## S2 notes (2026-11-12, decisions beyond the plan)

- Setup order: the active rule set is read **first**, so a foreign set stops setup before any
  topic, bucket or subscription is created. Then topic (its ARN gives the account id, no STS;
  stored before subscribing) → bucket → subscription → `ee-inbound` created + activated → rules.
- Bucket name is `ee-inbound-<account>-<region>` (one per AWS account and region), not per host:
  only one rule set can be active per account anyway, so two installs can't share an account
  for receiving.
- Status: `waiting` once the bucket is ready; `ready` straight away when SNS says the
  subscription is already confirmed (a re-run, or the fake transport); otherwise S3's callback
  flips it. A not-yet-confirmed Subscribe never overwrites a `ready` that arrived first.
- A failed rule sync keeps the status and stores Amazon's reason in `receiving_error`; the
  mailbox or domain change stays saved, and the admin sees the reason. The next good sync clears it.
- The inbound MX status is looked up live (DNS MX) whenever a receiving domain is shown — no
  stored column, no migration. A failed lookup shows as TEMPORARY_FAILURE, never as "seen".
- The non-https refusal moved its wording to neutral ("Amazon only delivers to an https
  address…") because events and receiving share the SNS seam.

## Slices (TDD; worktrees under `.claude/worktrees/`)

| # | Slice | Done when |
|---|---|---|
| S0 | Spike: SES receiving in the company's region | **Done 2026-11-12** (see S0 result): eu-central-1 OK; production needs a verified domain + SES production access |
| S1 | Schema + mailbox store + access rules + Mailboxes admin | **Done 2026-11-12** on `email-inbox-s1`: owner can't read a member's mail; shared = group only |
| S2 | Receiving setup (MX record, bucket, rule set, SNS) with fakes | **Done 2026-11-12** (`6eb8c75`), fakes only — real AWS unproven until S7 |
| S3 | Ingest webhook: verify, fetch, parse, route, spam, thread | **Done 2026-11-12** (`efd1bfa`), fakes only — real AWS unproven until S7 |
| S4 | Webmail read UI + SSE | Component + e2e: inbox opens first, read pane, spam/not spam, trash |
| S5 | Compose / reply / forward + Sent | e2e against mock: reply threads, From is the mailbox |
| S6 | Tabs: Inbox first, Company mail tab | Old landing reachable under Company mail; nothing lost |
| S7 | Real proof on a test domain | A real mail from outside lands in a real inbox on the box; reply arrives back |

S1 → S2/S3 in parallel (disjoint files: `owlery/*` vs ingest route) → S4/S5 → S6 → S7.

## Open (decide before S7)
- **Phones / desktop clients:** SES receiving gives no IMAP. Webmail (and the installed app) is
  the only client. IMAP/JMAP would need a mail server — a separate decision.
- **Retention + storage:** keep forever, or trash auto-empties after N days? S3 cost is the
  company's.
- **Member leaves:** disable the mailbox and keep mail (whose is it then?), forward to someone,
  or delete after N days.
- **Size:** SES receiving caps a mail at 40 MB including attachments.
