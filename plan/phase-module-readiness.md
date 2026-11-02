# Phase: Module readiness — Website, Email, and the self-improving agent

**Status:** APPROVED (owner, 2026-11-02) — decisions in §5. Brand runs in parallel under `plan/phase-brand-picker.md`; the factory milestones are `plan/phase-software-factory.md`.
**Owner direction (2026-10-31):** "eigenEnterprise is your company in a single place, on your VPS. I want the website module, branding module, email/owlery module ready. Durable pi should work and be ready for self-improvement." SES setup is skipped for now (2026-10-31).

**"Ready" means:** every owner journey of the module runs end to end in a logged-in browser on the local test server (the `ee-box` container, same install as a real VPS), is pinned by a Playwright journey that runs against every release, and nothing a non-technical owner meets first is broken or confusing.

## 1. Where things stand (audits 2026-11-02)

**Website** — almost everything is built and unit-tested (connect public/private repos, deploy through ee with health gate, saved config + Redeploy, live failure explanation + "Ask AI", logs, env/secrets, per-app mail access, domains, remove). **No journey has ever run end to end in a logged-in browser on the test server.** Contradictions: the company domain still rewrites to `/s/home`, which renders pages migration 0102 deleted (empty list / 404), while the page tools are still registered and used by the founding journey; "Build it with chat" only drops a draft into the chat; the code gives every app its own Postgres database (`ensureDatabase`, D17), the platform plan says own schema + role; deploy-key and public repos have no push-to-deploy; `ee/e2e/box-journey.mjs` is stale.

**Email** — sending is solid and unit-tested behind a clean SES seam (`SesApi`, `FakeSes`): onboarding setup with verification + real test mail, `email.send_mail` / `owlery.send_mail` (approval-gated, two overlapping tools), `POST /api/mail/send` for API keys (scopes, idempotency, rate limit, audit), per-app "Allow this app to send email". **Not ready because:** setup exists only in the welcome flow (no settings page), the running app can't use a mock transport, so nothing is provable without SES; no sent-mail log; the contact form stores submissions but sends nothing; the module page is developer-ish (curl/API keys up front, sandbox state hidden).

**Agent (durable pi + factory)** — S0 shipped and proven on the test server after the `getDb()` fix (crash-resume, live run view, chat mirror). S1–S6 planned in `phase-software-factory.md`.

## 2. Website milestones

- **W1 — Real owner journey, then fix what bites (M).** Rewrite `ee/e2e/box-journey.mjs` as a Playwright journey on the test server: claim → connect a public repo → deploy → own domain → Redeploy → env + secret → logs → per-app mail access → remove; then a private repo with a deploy key. Fix every failure found. Runs on every release from then on.
- **W2 — The company site at the root (M).** Per decision D-1: replace the dead `/s` + `rootRewrite: /s/home` path, and align the page tools and the founding journey with it. Announced removal of whatever goes.
- **W3 — Push-to-deploy for every repo kind (S–M).** Per decision D-3.
- **W4 — App data (S).** Per decision D-2: make code and plan agree; show "this app has a database" (name, connection secret present) on the app page.
- **W5 — ee hygiene (S–M).** Secret delete, deploy-key list + cleanup of unused keys, atomic `PATCH /v1/domains`, a DNS pre-check with a plain message before HTTPS is attempted.
- **W6 — First-run access (S).** On the test server: plain instructions for trusting the local certificate; a sign-in that works without SES (the claim link already does; make "lost session" recoverable via `ee claim-link`-style owner link, never a bypass).
- **W7 — Cleanups (S).** Remove the unreachable legacy `github_app_links` / `app_create` path (announced), rate limit on `/api/website/contact`, pre-release clean-tree guard, SIGTERM exits promptly (today every restart waits 20 s and is SIGKILLed).
- **Later:** "Build with chat" becomes real through the factory (the agent creates the source, writes `ee.json`, deploys, the app appears) — after factory S3/S4.

## 3. Email milestones (ready without SES)

- **E1 — Mock mail transport for the running app (M).** `MAIL_TRANSPORT=fake` wires `FakeSes` into `owleryService()`, captured mails stored and readable through an e2e-only route (like the existing e2e harness routes). Refused when `NODE_ENV=production` unless explicitly overridden by the test server config — fail loud, never a silent fallback.
- **E2 — The Email page (M).** `/m/email` becomes a real page: status (sender, verified, sandbox, region) with plain-language errors when SES rejects; "Set up email" when not configured (reuses `POST /api/onboarding/mail`); change keys/sender; send test email; re-check verification; a short SES checklist. The API-key panel moves under "For developers".
- **E3 — Sent-mail log (M).** A table of every send (recipient, subject, source: agent / app key / system, status, time) on `/m/email`, written by the one send path.
- **E4 — One send tool (S).** Keep `email.send_mail`, alias or remove `owlery.send_mail` (announced), fix stale comments and plan text.
- **E5 — Contact form sends (M).** A submission emails the owner through `companyMail()` (tested on the mock); rate limit on the endpoint.
- **E6 — Journeys on the mock (M).** Playwright: onboarding mail step (success, sender not verified, sandbox), settings change, send via API key → appears in the log, per-app mail switch on a deployed app, contact form → owner notified, sign-in code arrives through the mock.
- **When SES credentials exist:** real onboarding run, domain verification (DKIM records shown), bounce/complaint tracking into the sent-mail log, production access request, per-app mail with a real deployed app.

## 4. Agent milestones (from `phase-software-factory.md`)

S1 removals (dev-agent, pi-engine, `pi` engine, dead session log) → S2 source checkout on the server (`EE_SOURCE_DIR`, gates in a sandboxed unit; also fixes vitest-in-worktree) → S3 first roadmap ticket built by the system (risk-tiered merge) → S4 ship (owner-clicked self-upgrade; needs the push credential decision) → S5 reviewer → S6 friction → roadmap. Follow-ups found in S0 go into S1: chat tool calls interrupted by a restart, failed turns in the run feed, onboarding-context noise in the feed, `conversation_busy` after "Skip for now", `TENANT_MASTER_KEY` missing from `.env.example`, two failing `onboarding-welcome` e2e.

## 5. Owner decisions (2026-11-02)

- **D-1 Company site = an app, routed by eigenEnterprise.** (Owner, dictated; interpretation recorded for confirmation.) The easy default is a static site, or a site the agent builds; alternatively a GitHub-connected app that is deployed like any other. eigenEnterprise does the routing: one app is marked as the company site and the company domain's root goes to it. The dead `/s` pages + `rootRewrite: /s/home` go (announced); page tools get aligned with "the agent builds a static site app".
- **D-2 App data = own schema + login role inside the company database** (the 2026-10-20 decision). The code (`ensureDatabase`, D17: own database per workload) changes to match.
- **D-3 Push-to-deploy for deploy-key/public repos = manual only**, said clearly in the UI ("press Redeploy after pushing"). Only GitHub-App repos auto-deploy.
- **D-4 Order:** start E1 + E4, S1 and W1 now, in parallel with brand.

## 6. Proposed order and parallelism

Worktrees in parallel where file sets are disjoint; subagents on low effort.

1. Now, alongside brand: **E1 + E4** (email, disjoint from brand and website) and **S1** (agent removals).
2. Then: **W1** (needs a release on the test server; brand + E1 merged first so the journey covers them), **E2 + E3**, **S2**.
3. Then: **W2–W4** per decisions, **E5 + E6**, **S3**.
4. Then: **W5–W7**, **S4–S6**, and "Build with chat" once S4 ships.
