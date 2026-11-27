# Mail reputation: watch the SES sender reputation, flag what hurts it, hold sending before Amazon does

**Status:** owner ask 2026-11-27 ("a setting in the email setup that keeps track of our SES sender
reputation … flag emails that are looking suspicious … not allow people to send email when they don't
pass the SES sender reputation criteria"). Built the same day.
**Must stay congruent with:** `managed-mail.md` (tenant per company, D2 standard reputation policy, D3 box
key scope), `email-inbox.md` S5 (webmail privacy: no log row, no ids), `phase-polish-1.md` P-6 (the one
send path, `OwleryService.send`).

## What Amazon says (docs read 2026-11-27)

- **Bounce rate** (hard bounces only; "mailbox full" and other transient failures don't count): keep it
  **below 2%**; at **5%** Amazon puts the account **under review**; at **10%** it may **pause** sending.
- **Complaint rate** (complaints through mailbox-provider feedback loops): keep it **below 0.1%**; at
  **0.1%** under review; at **0.5%** it may pause.
- Both are computed over a **representative volume**, not a fixed period. Tenant metrics are typically a
  rolling 24 h to 7 day period.
- Enforcement state: SESv2 `GetAccount.EnforcementStatus` = `HEALTHY | PROBATION | SHUTDOWN` (poll it:
  there is no event for an account pause; `SendingEnabled` is only the owner's own switch). A tenant:
  `GetTenant.SendingStatus` = `ENABLED | REINSTATED | DISABLED` (REINSTATED = sending allowed despite
  open findings).
- Best practice: alarm **before** the thresholds, remove bounced and complaining addresses at once, find
  the cause (the list, the source), double opt-in, never bought lists.

## Shape

```
SES event (SNS) ─▶ applySesEvent ─▶ mail_reputation_ledger   one row per Send / hard Bounce / Complaint,
                                                             no addresses, no content (webmail too)
tick (hourly)   ─▶ GetAccount (own) | GetTenant (managed) ─▶ mail_reputation_checks (the history)
every send      ─▶ ReputationService.refusal(origin, sender, ref) ─▶ null | the reason it is held
```

- **R1 Our own rates, from the same events.** Rates are computed on the box from the SES events it
  already receives (Send, Bounce with `bounceType: Permanent`, Complaint), over the **last 2,000 mails of
  the last 30 days** (our "representative volume"), counted per recipient like Amazon. Bounces SES makes
  itself for addresses on a suppression list (`OnAccountSuppressionList`, `OnSuppressionList`) never
  count. Amazon's exact numbers live in CloudWatch (`AWS/SES Reputation.BounceRate/ComplaintRate`), which
  neither the managed box key (D3) nor the SES policy we ask own-SES owners for may read; in managed mode
  CloudWatch is account-wide (every company) anyway. So the box judges with the same events Amazon
  counts, and reads Amazon's verdict (`EnforcementStatus` / tenant `SendingStatus`) on top.
- **R2 Judged only on enough mail.** Bounce rate from 100 recipients, complaint rate from 1,000 (one
  complaint in 100 mails is 1%, which says nothing yet). Below that: "not enough mail to judge".
- **R3 Bands.** `healthy`; `watch` (bounce ≥ 2% or complaint ≥ 0.05%, or the tenant REINSTATED);
  `held` (bounce ≥ 5% or complaint ≥ 0.1%, Amazon's review level, or `EnforcementStatus` PROBATION);
  `paused` (Amazon paused: SHUTDOWN, `SendingEnabled` false, tenant DISABLED).
- **R4 Flag the source, not just the company ("suspicious mail").** The same rates per slice: the
  kind of mail (transactional sources, flows, API, personal mail), the sender address, and the one flow or
  API key it came from. A slice with 50+ recipients over the watch line is **flagged**; over the review
  line it is **held** on its own, before it drags the company down. Webmail is one slice ("Personal
  mail"), never per mailbox (S5 privacy).
- **R5 Held means nothing goes out.** While the company is held or paused, every send is refused with
  the reason in plain words: the assistant, the API, templates, flows, tests, double opt-in and personal
  mail. While a slice is held, only that slice's mail is refused. **System mail (sign-in codes,
  invites) is never held**, or nobody could sign in to fix it; Amazon still refuses it when it paused the
  account. A scheduled mail due while held is marked failed with the reason.
- **R6 Resume is a person's decision, recorded.** An admin resumes after cleaning the list
  (`email.reputation_resume`, with a reason): the window then restarts from that moment, so the next mail
  is judged fresh; the reset keeps who, why and the rates at that moment. It is refused while Amazon
  itself holds the account (PROBATION, SHUTDOWN, DISABLED): that is lifted at Amazon, not here. The
  assistant cannot resume (admin only, not agent).
- **R7 Recorded.** Every hourly check (and every "Check now") writes a row: band, rates, volume,
  Amazon's status or its error. The Reputation tab shows the history.
- **R8 CLI parity.** `email.reputation_get` (read: state, flagged slices, history, resets),
  `email.reputation_check` (re-reads Amazon now, records a check), `email.reputation_resume`.

## Not now

- Notifying the owner when sending gets held (no "notify admins" path exists yet; the Setup page and
  every refused send say it).
- GetReputationEntity / tenant findings in managed mode: needs `ses:GetReputationEntity` in the control
  plane's box policy (`eigenEnterprise-cloud` `drivers/mail-policy.ts`), cross-repo.
- Excluding hard bounces to our own verified domains (Amazon doesn't count those; negligible).
