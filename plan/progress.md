# Progress Log

Format: newest entries on top. Every milestone gets: what shipped, commit refs, what broke, decisions, what's next.

## 2026-10-19 (6) — SHIPPED (branch, not merged): assisted onboarding — the agent takes over after the scripted setup

**What shipped**
- The scripted first turn in the nucleus chat is gone. When the welcome wizard finishes, the page calls `POST /api/chat` with `{ bootstrap: true, onboardingHandoff: true }`. The orchestrator agent then writes the first turn itself, from an onboarding context block and a hand-off instruction in the owner's spirit ("You did it — your company is set up and you're its admin. What should we build first? I'd suggest your website…").
- `modules/orchestrator/onboarding-context.ts` holds the facts, the context block, the hand-off instruction and the start-marker protocol. The block lists what is done (admin account, company email, AI provider) and what comes next (the website, then the other modules). `JourneyAwareAgentRuntime` prepends it to the user input on every orchestrator turn while assisted onboarding is active, so both engines see the same thing. Persona gains `ORCHESTRATOR_ONBOARDING_PROMPT`.
- The website journey is no longer opened by `POST /api/onboarding/welcome`. The agent opens it when the owner agrees, by appending the exact `[[onboarding:website:start]]` token; the runtime only parses that token. The journey starts empty, so the owner's "yes" is never captured as the company name. From there the journey drives as before.
- DB facts: `src/lib/server/onboarding/assisted.ts`, wired in `boot.ts`.

**Decision log (architecture impact)**
- **Orchestrator engine = an explicit per-provider choice, recorded at connect time.** Amends phase-durable D6.
  - Migration `0088_provider_orchestrator_engine` adds `llm_provider_config.orchestrator_engine` (NOT NULL, CHECK `builtin-json|durable`). Existing rows are backfilled to `builtin-json`, so behaviour is unchanged until a provider is re-connected.
  - `engineForProvider` sets the value on every connect: OpenAI-compatible providers get `durable`; the API-shape subscription sign-ins (`anthropic`, `openai_codex`) can't carry tool calls and get `builtin-json`.
  - Each dispatch runs the engine recorded for the conversing user's **active** provider, passed via the new `DispatchOptions.loopEngine`.
  - `EE_ORCHESTRATOR_ENGINE` becomes an operator pin over that choice (rollback lever). It is unset by default.
  - With no BYOK provider (platform billing, or Telegram turns with no human), the engine of record (`builtin-json`) runs.
  - There is no fallback between engines on failure: a durable failure fails loud.
  - Why per provider and not per company: BYOK credentials are per user, and the engine must match the provider that actually serves the turn. A company-wide flag could put a subscription user on durable, where the gateway fails loud on tools.
- Durable state in local dev needs `EE_AGENT_STATE_DIR` (`.env.example`, playwright webServer env). Without it, a durable dispatch fails loud by design (D2).

**Open / next**
- Not run: e2e (`onboarding-welcome`, `journey-founding` updated to the hand-off), and a real-LLM check of the hand-off wording and marker discipline.
- Boot warm-up (crash-resume) still runs only under the `durable` operator pin. Per-provider durable turns resume lazily on the next durable dispatch.
- A user who switches providers mid-conversation switches engines. Durable history lives in SQLite and builtin-json history in session events, so context does not carry across the switch.
- `openWebsiteFoundingJourney` (`founding.ts`) is now unused by the welcome route. It is kept with its tests; remove it or reuse it.
- Migration number 0088 may collide with parallel branches; renumber at merge.

## 2026-10-19 (5) — SHIPPED: claim link + email set up in the onboarding (no secrets in env)

**Owner directive**: a non-technical user never touches a terminal, env file or config. Keys users bring (email included) are entered in the onboarding and stored in the database. The first person with access to the server becomes the admin, via a private claim link.

**Shipped (`5f8da39`, `56b21f2`)**
- **Claim link**:
  - `ee` mints a random token on first install and stores only its SHA-256 + a 7-day expiry (os secrets `EE_CLAIM_TOKEN_HASH` / `EE_CLAIM_EXPIRES_AT`); the installer prints `https://<console>/claim?token=…` once;
  - `ee claim-link` issues a new link;
  - `/claim`: the holder enters an email and is signed in as the owner immediately, through Better Auth's server-only `createVerificationOTP` + `signInEmailOTP` (no email sent). The claim runs in `claimScope`, so the owner policy knows it.
  - On ee servers only a claim can create the first account; afterwards signup is closed. Signup/login on an unclaimed server say so in plain words.
- **Company email in the database**:
  - `company_mail` (migration `0087` + journal idx 87 + schema), key sealed with a TENANT_MASTER_KEY-derived key;
  - `$lib/server/mail` (`companyMail()`, `companyOwleryEnv()`) replaces every `OWLERY_*` env read (auth codes, notifications, feedback, contact sync, email module);
  - settings are saved only after a real test email reached the owner.
- **Onboarding**: an owner-only `mail` act after the AI-provider act, shown only while company email isn't set up (`POST /api/onboarding/mail`).
- **Passwordless clean-up**: no verification-by-link, no reset mail; `/forgot-password` and `/reset-password` redirect to `/login`.
- **Bug caught by tests**: the notification email's local `env` shadowed the private env, so `ORIGIN` would have been undefined and links broken. Fixed.

**Gates**: unit 4283 passed; svelte-check 0 errors; ee 42 passed.

**On the Docker server, verified end to end in Chromium**:
- signup before the claim → "not claimed yet";
- claim → signed in → onboarding;
- the owner opens Settings → Hosting;
- the reused link is refused for everyone.

The server was then reset clean, with no owner and the link waiting.

**Still open**:
- The mail act is only covered by the API tests; it can't run end to end locally without real Owlery credentials.
- A Settings → Email page to change the settings later (the endpoint exists; no page yet).
- `local-server.sh` output can get lost when piped through long release builds (`ee claim-link` recovers the link).
- The local CA warning stays a local-only step.

## 2026-10-19 (4) — MERGED: durable agent engine (pi-durable), after reviewing another agent's work

**Context**: another agent worked in `../ee-durable` (`wt/durable-engine`) and reported "implementation not started, worktree clean". **That was false.** It had:
- committed `plan/phase-durable.md` on main (`9b3c4d4`);
- committed `63ca241` (dependency pins) and `3655eeb` (gateway tools passthrough) on the branch;
- left ~1,300 uncommitted lines with no tests and 6 real type errors.

The full review is at the top of `plan/durable-findings.md` (moved there from the worktree's `DURABLE-FINDINGS.md`).

**Fixed before merging (`d7d5a25`, merged `28aa892`)**
- **Cross-user tool execution**: tool calls now route by conversation. A call resumed after a restart reports `not_run` instead of executing as someone else.
- **Lock**: async (was blocking the event loop), 30 s handover window, released on a failed open.
- **Boot**: the harness opens and resumes at boot when durable is selected.
- **Type errors** in the gateway passthrough (tool roles leaking into the API-shape adapters) and in the adapter.
- **Orchestrator engine is explicit**: `EE_ORCHESTRATOR_ENGINE=durable|builtin-json`, `builtin-json` the engine of record. The planned "orchestrator flips to durable" would have broken the Claude/ChatGPT subscription sign-ins, which can't carry tool calls.
- **ee (`9a3748d`)**: blue-green slots now share one dynamic user per workload. Verified on the box that concurrent slots got different UIDs and the candidate re-chowned the shared StateDirectory under the serving slot.

**Gates**
- svelte-check 0 errors; unit 4285 passed; ee 40 passed.
- New tests: two users at once (isolation), approval_pending, history, lock contention / stale steal / no event-loop block, and a **real SIGKILL crash-resume** (the child dies mid-model-call; the reopened harness re-runs that turn and keeps its answer).

**On the box**: upgraded, `EE_ORCHESTRATOR_ENGINE=durable`.
- The harness opens at boot, with state at `/var/lib/ee-state/os/agent/agent.sqlite` (0600, user `ee-os`).
- On the next blue-green deploy, slot b took the lock after slot a drained (stale steal logged).
- Migration 0086 is applied.

**Not done**: the D8 visibility surface (SSE + live run UI, multiplayer), e2e on durable, and a chat turn on the box (needs a signed-in owner, so email delivery, plus an OpenAI-compatible provider). The `../ee-durable` worktree is left in place; it holds an untracked `.env` copy.

## 2026-10-19 (3) — SHIPPED: passwordless sign-up and sign-in (Better Auth email OTP)

**Owner directive**: use Better Auth; signup is passwordless: enter only the email, click Create account, and a code is sent to that address.

**Shipped**
- The Better Auth **`emailOTP` plugin** (6 digits, 10 min, 5 attempts). The `sign-in` code type both creates a new account and signs in an existing one; the owner policy still decides who may be created.
- `/signup`: email + terms → **Create account** → code. `/login`: email → **Send code** → code. Shared `auth-code-step.svelte`. No password fields anywhere.
- Delivery (`src/lib/server/auth/deliver-code.ts`) is **email only, via Owlery**:
  - with no mailer configured, production **fails loudly** ("Email delivery is not configured… `ee secret set os OWLERY_*`") and never logs the code;
  - dev prints the code and records it for the Playwright harness (`/api/e2e/harness/sign-in-code`, dev-only).
- e2e helpers (`registerUser`, `loginUser`) are passwordless. `auth.e2e.ts` replaces the forgot-password test with code-flow tests.
- **Gates**:
  - unit: 4262 passed;
  - e2e: onboarding-welcome + auth **13/13** against the dev server;
  - svelte-check: 0 errors.
- `scripts/local-server.sh upgrade` deploys the current code to the local box (health-gated, data kept).

**Decisions / follow-ups**
- Password endpoints stay enabled server-side (existing accounts aren't stranded), but no UI offers them. `/forgot-password` and `/reset-password` are orphaned; delete them once no password accounts are left.
- **An ee server needs email delivery before the first signup**: `ee secret set os OWLERY_API_KEY` / `OWLERY_BASE_URL` / `OWLERY_EMAIL_FROM`.
- CI e2e (`npm run preview`, not dev) has no code harness yet and needs a mail sink; local e2e runs against the dev server and passes.

## 2026-10-19 (2) — SHIPPED (local box): `ee` installs eigenEnterprise on a fresh server; domains, apps and GitHub in Settings → Hosting

**Owner goal**: deploy the first slice to a real VPS, keeping the onboarding exactly as it is; the website module, a GitHub connection and domains in Settings, plus everything else needed.

**Shipped (verified end to end on a fresh Ubuntu 24.04 systemd box, `ee/e2e/box.sh`)**
- **`ee/`**, the company's init (phase-substrate S0–S4 slice), as a standalone TS package bundled into one file:
  - the contract: workload spec, `ee.json` app contract and catalog with `catalog_gap`;
  - hardened unit generation;
  - full Caddy config render and atomic load, with a local CA only for reserved test TLDs;
  - the company repo (git, `ee` the only writer);
  - an AES-GCM secret store;
  - a level-triggered reconciler with blue-green slots, the health gate, keep-old-on-failure and no flapping;
  - the control API on a unix socket;
  - `bootstrap` (Postgres 16 + pgvector/pg_cron/AGE from PGDG, pg_net compiled, Caddy apt);
  - boot-time env rendering (`ee-env.service`);
  - `ee.json` for eigenEnterprise itself; `scripts/release.sh` (linux x64/arm64 tarballs, Docker used as a build tool only);
  - `ee/install.sh` (pinned, checksum-verified Node 22 + `ee`, then bootstrap).
- **Proven on the box**:
  - fresh install → "Your company is running" in **37 s** (fast mirror; no build on the path);
  - reboot → everything returns (env files re-rendered);
  - changing the console host → blue-green redeploy of eigenEnterprise;
  - a git app (fixture) builds in the sandbox, goes live at its domain, and gets a secret;
  - a broken release fails its health gate and the old one keeps serving, reported loudly;
  - the public host serves only the website surface (`/` → `/s/home`; `/login` and `/api/health` 404 at the edge).
- **Browser journey** (`ee/e2e/box-journey.mjs`, Chromium) passes: owner signup → **onboarding boot sequence unchanged** → Settings → Hosting (managed) → add the public website domain → edge allowlist holds → a second signup is refused.
- **eigenEnterprise side**:
  - `/api/health` (DB ping), the health gate;
  - kernel module **`substrate`** (status, domain add/remove, app remove, secret set) and module **`github`**:
    - GitHub App manifest flow, sealed credentials (migration `0085_github_connection` + journal idx 85 + `github.schema.ts`);
    - installation check, repos list, `app_create` / `app_deploy`;
    - `auto_deploy`, run only by the signed webhook's service principal, for apps whose owner opted in;
  - `/settings/hosting` (domains, GitHub, apps, secrets, activity) + a "Hosting" entry in the cog menu;
  - shared `src/lib/server/ee/` (control client, `requireHuman`), so modules stay import-free of each other.

**Decisions / deviations (on record; owner can veto)**
- §8 recommendations implemented as defaults: hosting mutations are **human-only** (D11); Ubuntu 24.04 / Debian 13 only (`ee` refuses others); pre-DNS console host = `<ip>.sslip.io`.
- **Postgres listens on 127.0.0.1 (scram), not a unix socket only.** Client libraries can't agree on a socket+credentials URL (postgres.js ignores `?host=`). CONNECT is revoked from PUBLIC on every database.
- **Apps can reach loopback** (Caddy must reach their ports); binding is confined with `SocketBindAllow=tcp:<port>` instead of D5's `IPAddressDeny=localhost`.
- **Single owner by construction**: the first signup becomes admin. On an ee-managed server (`EE_WORKLOAD` set) signup closes after that (`src/lib/server/auth/owner-policy.ts`).
- `substrate` and `github` are self-seeded **system modules** (like `kernel`).
- **Under ee, `EE_VCS_AUTOCOMMIT=0`** for eigenEnterprise: the release has no `.git`. Server changes are committed by ee in the company repo; kernel_events is the audit trail.
- The release ships full `node_modules` (as the Dockerfile does): migration scripts import dev deps.

**Not yet verified (needs the owner)**: a real VPS with real DNS + Let's Encrypt; the real GitHub App flow (manifest → install → webhook); the founding journey with a real LLM provider. Hosting the release for `curl | sh` (the repo is private) is undecided.

**Owner decision (same day)**: not deploying to a remote VPS yet. "It has to run on this machine": an Ubuntu server emulated in Docker on the Mac. Shipped `scripts/local-server.sh` (up / status / logs / shell / stop / start / reset / ca). It runs the real installer into a systemd Ubuntu 24.04 container (native arm64; amd64 emulation breaks systemd's sandboxing on Apple Silicon). Console at https://os.ee.localhost, ports 80/443 → the box's Caddy, local CA. Installed clean with no owner, so the owner signs up first. A real VPS later uses the same installer with `--console-host <ip>.sslip.io` (owner's choice for the first domain).

**Local limits**: GitHub webhooks can't reach a laptop, so on this machine auto-deploy on push won't fire; "Deploy latest" (outbound fetch) works. Certificates come from the box's local CA (trust it via `local-server.sh ca`).

**Next**: owner signs up on the local server → onboarding → connects GitHub in Settings → Hosting → deploys the CEO's app; then the same on a real VPS.

## 2026-10-19 — PLANNED: phase-substrate — `ee`, the company's init system (architecture decision, no code)

**Owner directives (same session):**
- "If we build this out, I want it to work for everyone, and I want the 'your company is up in 10 minutes' claim to also work with the website the way it is."
- "Can't it be something I curl and install onto the server? Like a Linux package that gets started up with systemd?"
- "What if we don't use Docker?"

Two earlier same-day drafts were superseded: `phase-hosting.md` (a per-app hosting module; deleted) and a Docker-based version of `phase-substrate.md`.

**Finding**: the OS metaphor (company-os §1) has no init and no loader. Five plans depend on "a revision becomes a healthy, routed, supervised process, or nothing changes": wedge install/preview/domain, `repo.merge` (there is no `.git` in the production image, so nothing ever redeploys), module services (Owlery), the software-factory post-merge smoke, and user apps. Design it once.

**Decision log (architecture impact, proposed D1–D17 in phase-substrate §7, D16 owner-decided; owner can veto the rest)**
- `ee` = one curl-installed binary (daemon + CLI) under `ee.service`. systemd is the only supervisor; every workload is a generated, hardened unit; `ee` is not in the data path (`ee` down ≠ sites down).
- **Native only: no Docker daemon and no container runtime.** Deviates from company-os §4.2 ("Docker + Compose"); amend on approval.
- Desired state = the company repo; `ee` is its only writer; every mutating verb is validate → commit → reconcile. Every deploy, rollback and upgrade is a commit.
- **The catalog is the only environment** (phase-substrate §3.3):
  - runtimes: `static` + `node` now; `python` / `binary` / `jvm` later;
  - shared services, one of each: Postgres with each app its own database and login, a Postgres-backed queue + events in the kernel (replacing company-os's Redis/BullMQ), email, files, secrets, edge, schedules;
  - capabilities: `chromium`, `ffmpeg`, `tesseract`, … later.

  Apps declare their needs in `ee.json` (declared, never detected) and reach kernel services as `service` principals through the registry path.
- **D16, owner-decided: a gap is an eigen change.** No app may spin up its own environment: no containers, no app-run datastores (embedded SQLite included), no vendored system programs. A missing entry fails the deploy with `catalog_gap` and lands on the Extension Roadmap; closing it is a catalog release that every company gets. If an app *could* bring its own environment, that's a substrate bug.
- eigenEnterprise and Postgres are packages; `ee upgrade` is a health-gated blue-green deploy. First-party modules stay compiled in (phase-0 holds); all others are out-of-process workloads whose tools the registry proxies. This dissolves the fork-vs-image question: core is never modified on a server, and core improvements go upstream.
- The website stays as it is; the edge splits the public host (public surface only) from the console host. No container and no build on the 10-minute path.

**Owner decisions open (§8):** human-only approvals for system tier / first deploys / auto-deploy (reverses `a8b11c0` for this area); Ubuntu 24.04 + Debian 13 only; the pre-DNS hostname; the expand/contract migration guardrail.

**Found while planning**: `docker-compose.yaml` publishes db/app/studio on all interfaces (Docker bypasses UFW) and defaults the Postgres password to `eigen`. Under D9 compose becomes dev-only.

**Accepted trade-off (on record):** software that brings its own database engine (WordPress + MySQL, Plausible + ClickHouse) doesn't run on eigen until eigen provides that service for everyone.

**Next**: owner answers §8 → S0 (the shared spec, the app contract + catalog manifest, the hardened unit template, the vendored-program decision). Other plans are amended only after approval (§13).

## 2026-10-15 (3) — the eigen chrome is DEAD: one cog, every route

**Owner directive (verbatim)**: "/settings … the menu on the top right changes and the header
changes also. It shows the header of eigenmesh, which is a completely separate project, and
should be deleted in all routes… Eigen mesh as a module can stay, but the design for all
routes eigenenterprise has to offer are not the right ones, and I want you to delete them."
— This is the "when" the de-branding round (2026-09-22) was waiting for: the seed-derived
shell goes, the module functionality stays.

**Deleted completely**
- `app-header.svelte` (+ spec) — the eigen wordmark header with its account menu, admin/eval/
  feedback links, blur gradient stack — rendered by the root layout on every non-nucleus,
  non-auth route.
- The root layout's mobile **bottom nav** (Memory/Capture/Chat black-pill nav + gradient
  masks) and its `bottomNavItems`/`isNavItemActive` machinery, `pb-28` chrome padding.
- `eigen-wordmark.svelte` (+ spec) and **`logo-whole.svg`** (eigen's logo asset) — gone from
  the repo. The auth pages (login/signup/forgot/reset) and `+error.svelte` now carry a
  typographic "Eigen Enterprise" wordmark instead of the logo image.
- `current-user-view-select.svelte` — lived only in the deleted header (the author-view STORE
  stays; memory surfaces still consume it).

**What replaces the chrome**: one settings cog, top right, on every app route — the SAME
`home-settings-menu` (Company Settings / Extensions / API Keys / AI provider / sound + voice /
Restart onboarding / Sign out) the homepage already had, now rendered by the root layout for
non-nucleus, non-auth, non-public routes. No header, no nav, no logo anywhere; the nucleus
group and `/s/[slug]` stay chrome-free. Verified visually: `/settings`, the open menu, and `/`
carry exactly one cog and zero eigen furniture.

**Broke / fixed along the way**
- `release-helpers.ts` toured the dead chrome (Account menu links, the stale Workspace/
  Capture/Ask AI bottom nav) — rewritten against the cog menu, sign-out through the menu's
  Sign out button.
- **playwright `workers: 1`, deliberate**: suites share singletons — `kernel_journeys` admits
  ONE active row per kind company-wide, the mock gateway is one process with a global call
  counter. Concurrent workers fight over both (the documented flake class: the stale-v1 test
  failed twice in parallel multi-file runs, never serially). Serial is slower; deterministic.
- extension-roadmap's cog walk needed the boot wizard's retry-until-open discipline (SSR
  clicks before hydration attach handlers).

**Not deleted (deliberate, flagged)**: page CONTENT styling that references the old palette
(`--color-eigen-green` in memory surfaces, timeline views, author-layer chrome) — that is the
memory/timeline feature content wearing an old accent, not the chrome; a content-design pass
is owner-gated follow-up work. The favicon is still eigen-derived artwork (same class as the
logo was). Unused paraglide `nav_*` message keys remain in the catalogs (harmless).

**Gates: unit 4240 passed / 14 skipped; components 41 passed; svelte-check 0 errors (29
baseline warnings); eslint clean on touched files; serial controlled-env e2e 8/8
(extension-roadmap 2 + onboarding-welcome 3 + journey-founding 3).**

**Decisions (log)**
- The settings cog is THE chrome: the owner's menu design (company settings, sign out,
  extensions in a top-right menu) applies to every route; no second navigation surface exists.
- Chrome deletion ≠ content redesign: memory/graph/capture/timeline internals keep their
  current look until the owner orders the pass.

## 2026-10-15 (2) — SHIPPED: the Extension Roadmap — the company's build log, queue, and plan, visible to humans AND the agent

**Owner directive (verbatim intent)**: "I need a way to see what you did, what you changed,
what you fixed, what's on the roadmap… a kind of queue… it should live in the settings under
extensions… name the setting extension roadmap… a visual way to see what was done and what's
going to be implemented… down the line I want the agent to be able to build itself, so the
agent should have access to this build log."

**Shipped** (`f50762f` merged to main, wt/extension-roadmap; subagent-implemented, orchestrator
reviewed + integrated)
- **Kernel module `roadmap`** — `roadmap.list_items` (read) / `roadmap.add_item` /
  `roadmap.update_item` (mutate, no approval gate — internal company data), zod-validated,
  registry-audited, roles admin+agent. The agent connection is structural, not a shim:
  the module is in the orchestrator persona's module list, and with `roadmap` active its
  tools ride the existing tool-surface filter (scope 'all') — the agent can read and maintain
  the roadmap in chat TODAY, and the software-factory loop (phase-software-factory.md) gets
  its queue surface for free.
- **Migration `0084_extension_roadmap.sql`** (+ journal idx 84, + `roadmap.schema.ts`):
  `extension_roadmap_items` (status shipped/in_progress/planned, kind feature/fix/chore,
  position, `shipped_at` stamped by the store on entering 'shipped' and cleared on leaving)
  + 15 seed rows: the shipped build log (kernel, memory, brand pipeline, boot-sequence
  onboarding, founding journey, journey hardening, gateway voice, agent hands), the queue
  (live journey verification), and the plan (one-command deploy, software factory M0,
  conversation-driven website editing, company templates, voice provider wiring, build log
  from kernel events).
- **`/settings/extensions` — "Extension Roadmap"**: read-only board (Shipped with dates /
  In the queue / Planned), monochrome, honest empty sections, deliberately NO add/edit UI —
  content is maintained through the kernel tools (agent + CLI), the page only mirrors.
- **Top-right settings menu restructured**: Company Settings / Extensions / API Keys /
  AI provider ‖ sound + voice toggles ‖ Restart onboarding + **Sign out** (new). All
  e2e-pinned testids preserved. `/settings` gained an Extensions row.
- **e2e `extension-roadmap.e2e.ts` (2/2)**: the cog names Extensions; the board renders the
  seeds in their sections; deep-link works.

**Gates: full unit 4240 passed / 14 skipped (568 files; +24 over baseline); svelte-check 0
errors (29 baseline warnings); eslint clean on all touched files; controlled-env e2e:
onboarding-welcome 3/3 + journey-founding 3/3 + extension-roadmap 2/2 (both file orders).**
Migration applied to the dev DB; `roadmap` module activated there.

**Broke / flags**
- **`npm run ee` is BROKEN on main (pre-existing, NOT this round)**: `tsx src/cli/index.ts`
  dies on `ERR_MODULE_NOT_FOUND: $env` — the CLI's import chain reaches
  `src/lib/server/env/private-env.ts`, which imports the SvelteKit virtual
  `$env/dynamic/private`, unresolvable under plain tsx. Needs a decision (vite-node runner vs
  an env seam private-env can use without the virtual import). Module activation in the dev
  DB used the documented deployer SQL path in the meantime.
- The home-settings-menu spec previously ran in NO gate at all (excluded from the node
  config, absent from the browser include list) — enrolled in `vitest.browser.config.ts`;
  it now actually pins the menu.
- The journey-founding stale-v1 test showed one transient failure across five green runs —
  same class as the documented SSR-hydration click race; both file orders green otherwise.

**Decisions (log)**
- Roadmap UI is read-only v0; the AGENT (and `ee`/registry consumers) maintain content —
  the owner's "agent has access to the build log" is the module boundary, not a UI form.
- Seeds live in the migration (visible, reviewable, tool-editable afterwards), not a hidden
  bootstrap seed.

**Next**: owner opens the cog → Extensions and sees the board; the software-factory M0 open
questions (ticket source, first proof ticket, merge policy) are now THE next owner decisions —
the roadmap surface it would feed is live.

## 2026-10-15 — the 10-14 fixes VERIFIED LIVE; the journey e2e exists; the voice e2e re-pinned to the gateway

**How the owner report was reproduced**: the 2026-09-10 stale row (pre-versioning, mid-interview)
was ACTIVE in the dev DB when this session started — the exact reported state.

**Verified live, three ways**
- **The owner's own dev DB verified the stale-abandon first**: by the time this session looked,
  the 2026-09-10 row had already abandoned itself (`status='abandoned'`, `journey.abandoned`
  reason `spec_version` on the audit log) after the owner said "hi", and a fresh empty v2
  journey sat in its place (opened by the boot handoff). The fix fired in real use.
- **New e2e `src/routes/e2e/journey-founding.e2e.ts` (3/3, twice, ~24s)** against a real
  browser + real server + a DISPOSABLE database (`eigen_journey_verify` on the dev cluster,
  full bootstrap: migrate → ensure-extensions → ensure-app-role → apply-rls → activation
  seeds): (1) a v1-shaped active row abandons itself on "hi" — no duplicate-slug, no interview
  question, plain orchestrator answers, `journey.abandoned` reason `spec_version` audited;
  (2) a retried turn with pages already on disk LEDGERS them through the `alreadyApplied`
  probes (4 creates + the already-public home publish recorded `executed` WITHOUT re-running),
  the about publish actually runs and lands `approval_pending` (gate halts its step; the tone
  step's brand-doc create still executes — per-step halt, asserted); journey stays active.
  (3) `/api/tts` contract: 401 anon, 400 empty/oversized, and a speech-less gateway surfaces
  its provider error as a loud 500 (mock 404 verbatim in the error body).
- **onboarding-welcome e2e 3/3** in the controlled env — after re-pinning the voice contract
  (see below).

**Broke / caught by verifying**
- **The boot-sequence e2e still pinned the ROBOT voice** — the 10-14 TTS switch (browser
  speechSynthesis → gateway) was never re-run against it. Re-pinned to the new truth:
  `/api/tts` intercept captures the greeting text the client sends to the gateway, and the
  speechSynthesis recorder must stay EMPTY forever. Robot voice is now e2e-pinned-dead.
- **INCIDENT (fixed, on the record)**: the first verification runs' spec-side SQL went to the
  WRONG database — playwright.config.ts loads .env with `override: true`, so a generic
  `DATABASE_URL` env is silently repointed at the .env database while the server under test
  used another. Consequence: the owner's fresh v2 journey row got a fabricated state written
  over it and two stray pages (`about`/`contact`, body `Already here.`) landed in the dev DB.
  REMEDIATED to the exact pre-incident state (journey state restored to the
  `openWebsiteFoundingJourney` initial shape with the correct `onboarding:<userId>` sessionId;
  stray pages deleted; owner's `home`/`brand-tone-of-voice` untouched). GUARD: the new e2e
  takes `E2E_JOURNEY_DATABASE_URL` (name deliberately outside .env's reach), throws if it
  equals `DATABASE_URL`, skips loudly when unset, and resets journey/page rows itself.
- **Kernel VCS auto-commit fired mid-verification**: the create_page artifact's
  `git commit -am` landed the WIP as `tool website.create_page by orchestrator` — amended
  into this commit with the proper message (unpushed; same pattern as the pre-existing
  `cafbe2e` kernel commit).
- One pre-existing flake re-observed (not this change): onboarding-welcome's skip test clicked
  before hydration once (documented SSR-click race) — passed on rerun.

**Live-provider voice finding**: OpenRouter's API answers `/audio/speech` with 401
("Missing Authentication header") for the configured service identity — the public OpenRouter
API does not serve TTS for it. Live audio needs a speech-capable OpenAI-compatible gateway
(`LLM_MODEL_TTS`/`LLM_TTS_VOICE` or a BYOK provider with the route); until then the assistant
correctly stays silent (verified).

**Gates: unit 4216 passed / 14 skipped (566 files); svelte-check 0 errors (29 baseline
warnings); eslint clean on touched files; journey-founding 3/3 ×2; onboarding-welcome 3/3.**

**Decisions (log)**
- The journey e2e runs against a disposable DB by design (kernel_journeys admits ONE active
  row per kind company-wide; the spec resets rows — shared-DB runs are what the guard
  refuses).
- Fixture expectations follow observed product semantics, not the old docstring: the artifact
  gate halts its STEP; later steps still process (brand-doc create executed after the about
  publish went `approval_pending`). Docstring vs behavior divergence flagged for a follow-up
  either-way pin.

**Next**: the Extension Roadmap (settings → Extensions; build log + queue + planned; kernel
module so the agent reads it through its tool surface) — owner-directed this session.

## 2026-10-14 (2) — journey spec versioning: stale interviews can no longer speak through chat; orchestrator posture

**Owner report (verbatim)**: "The Eigenenterprise chat asks me things that seem like they are
part of one of the modules… the general chat should take more like an orchestrator role. It
shouldn't ask things like 'Now, on to the next step.' It should say: here's what we can do,
those are the modules… route the user there."

**Root cause**: the stale 2026-09-10 `website_founding` row (pre-phase-2e spec shape,
`positioning` never captured → never completable) was still ACTIVE — every chat turn had the
journey context block prepended, instructing the agent to ask the next step's question. The
chat never decided to interview; the journey driver did.

**Shipped**
- **JourneySpec.specVersion (kernel)**: `playbook.ts` specs carry a version; stored state
  stamps it at creation; `isStaleJourney()` flags rows whose version drifted (pre-versioning
  rows count as stale). `JourneyAwareAgentRuntime` abandons stale rows on first touch — status
  'abandoned', `journey.abandoned` event (reason 'spec_version', first emitter of the modeled
  event) — and answers as the PLAIN orchestrator: no journey context, no artifact runs.
  WEBSITE_FOUNDING_JOURNEY is specVersion 2; founding onboarding stamps it on create and
  re-stamps reused rows on resubmission.
- **Orchestrator posture (persona)**: "you route, you do not interview" — mission control, not
  a questionnaire; name the modules (memory, website, brand, email, repo, chat-gateway, recap)
  and what they do; hand off to the module's surface or tools instead of running its intake in
  chat; answer module-less requests directly.

**Gates: unit 4216 passed / 14 skipped; svelte-check 0 errors; eslint clean on touched files.**

**Decisions (log)**
- Version drift = abandon, never migrate: a superseded interview's answers are founder data,
  but driving it forward under a spec it never consented to is worse; a fresh founding
  submission (wizard restart) starts clean under the current version.
- The persona change is prompt-text only — the deterministic guarantees (journeys opened only
  by onboarding, stale rows abandoned in code) stay structural, per "code owns the agenda".

**Next**: owner reloads and says "hi" — the stale row abandons itself, the chat answers as the
orchestrator. Restart onboarding from the settings cog to redo the founding interview under v2.

## 2026-10-14 — FIX: duplicate-slug error on every journey turn; the assistant's voice moves to gateway TTS (qwen)

**Owner report (verbatim)**: "Error: duplicate website slug: brand-tone-of-voice — when i type
hi. this is not correct. also, when i start or restart the onboarding it uses a mechanical robot
sounding voice. please use qwen asr"

**Shipped**
- **Journey artifacts are idempotent (already-applied probes).** `JourneyArtifact` gains an
  optional `alreadyApplied` probe (pure read through the registry — never error sniffing);
  `executeStepArtifacts` records a probed artifact 'executed' WITHOUT re-running it. The
  founding spec probes `website.list_pages`: a create whose slug exists and a publish whose page
  already sits at the target visibility are ledger-recorded, not re-run. Root cause of the
  report: the legacy `website_founding` row (2026-09-10, pre-phase-2e spec shape) had the
  `brand-tone-of-voice` page in the DB but no 'executed' ledger entry under the CURRENT spec —
  so EVERY chat turn (e.g. "hi") re-ran `website.create_page` and failed loud with duplicate
  slug. Superseded pins rewritten deliberately: founding re-submission over existing pages is
  now idempotent completion (no throw), and chat retries succeed while publishes stay gated.
- **The assistant's voice = gateway TTS.** `llmCreateSpeech` in the LLM gateway
  (`POST {baseUrl}/audio/speech`, OpenAI-compatible, 3-attempt retry, activity-logged, STT
  billing config reused) + `src/lib/server/llm/tts-client.ts` (default
  `qwen/qwen3-tts-flash-2026-02-10`, voice `alloy`; `LLM_MODEL_TTS`/`LLM_TTS_VOICE` overrides,
  documented in .env.example) + `POST /api/tts` (auth 401, empty/>4000-char 400, returns
  audio/mpeg bytes, provider error mapped to 500). `src/lib/speech/tts.ts` no longer touches
  browser speechSynthesis AT ALL: it fetches `/api/tts`, plays the blob, cancels via
  AbortController; a failing gateway means SILENCE (console-warned), never a robot fallback.

**Note on the request wording**: the robot voice was browser speechSynthesis OUTPUT (TTS), not
ASR — ASR (input) was already qwen (`qwen3-asr-flash`, `stt-client.ts`). Implemented as gateway
TTS with the qwen default, mirroring the STT seam.

**Gates: unit 4214 passed / 14 skipped (566 files); svelte-check 0 errors (29 baseline
warnings); eslint clean on touched files.**

**Decisions (log)**
- Idempotency is a SPEC-declared probe, not a catch of duplicate errors — error-string sniffing
  is forbidden (no string heuristics); the probe is a deterministic registry read.
- Voice-off semantics unchanged (`ee-voice` toggle); "gateway unavailable" now joins
  "browser unsupported" as the honest silent state.

**Next**: owner verifies live — restart onboarding or type "hi": no duplicate-slug error, and
the boot-sequence voice comes from the gateway (requires an OpenRouter-compatible provider that
serves `/audio/speech`; the provider's exact error surfaces in the server log otherwise).

## 2026-09-22 — Eigen Enterprise de-branded from ../eigen (eigenmesh); settings rebuilt minimal

**Owner directive (verbatim)**: "immediately remove all ui that was taken from ../eigen from this
repo. eigen-enterprise is a completely separate project. reusing eigenmesh (the name of the
../eigen) project was outright wrong! fix your mistake" — scoped via questionnaire: settings
page rebuilt minimal + repo-wide naming scrub; other seed-derived pages stay for now (APIs
always stay).

**Shipped**
- **`/settings` rebuilt minimal**: only Account (email + password + sign out), AI provider
  (live status + link to /settings/llm), API keys (link to /api-keys). The eigen feature tabs
  (appearance/theme, speech/haptics, notifications/push, memory tools incl. export + delete-all,
  danger zone, graph rearrange) are gone from the page — their SERVER APIs are untouched.
  Page server trimmed to `load {user, providerReady}` + `changeEmail`/`changePassword`; the
  eigen `resetOnboarding`/language/locale actions removed (spec pins exact action keys).
- **Settings sub-routes** `/settings/agents` (webhooks) + `/settings/scheduled-tasks` (heartbeat):
  UI replaced with minimal placeholders linking back; their page-server loads + APIs untouched.
- **Repo-wide 'Eigen Mesh'/eigenmesh scrub (0 grep hits across src/, messages/, static/,
  .env.example)**: layout title, wordmark alts, chat/capture/feedback copy, i18n placeholders
  (en+de), webhook + push test payloads, storage-key prefix `eigenmesh:` → `eigenenterprise:`,
  schema comments, .env.example examples, LLM prompt examples (neutral examples, same shape).
  31 spec files' fixtures swapped symmetrically ('Website Relaunch'/'Archive Scan' as neutral
  labels — one ordering assertion needed a label that preserves the original sort semantics).
- **Behavioral de-branding (decisions)**: feedback inbox no longer `feedback@eigenmesh.xyz` —
  now env-overridable (`FEEDBACK_INBOX_EMAIL`) with placeholder default
  `feedback@eigenenterprise.example` (owner must set a real address for feedback delivery);
  subject `[Eigen Enterprise]`. Legal links no longer default to eigenmesh.xyz —
  `DEFAULT_WEBSITE_ORIGIN` is a placeholder (`eigenenterprise.example`), real legal pages need
  `PUBLIC_WEBSITE_ORIGIN`.

**Gates: unit 561 files / 4184 green; svelte-check 0 errors; components 34 green; e2e
onboarding-welcome 4/4, onboarding-provider 6/6 (incl. rewritten 'wizard never comes back'),
auth 9/10 (owlery placeholder env, pre-existing); contract grep 0.**

**Broke / flags**
- **Auditor rework round (addressed)**: first scrub missed live residuals outside src/ —
  `docker-compose.yaml` Traefik rule routed Drizzle Studio at `studio.eigenmesh.xyz` (now
  `studio.your-domain.example` placeholder — owner sets the real domain), plus identity in
  company-os memory module/README, evals graph-scale corpus + seed-guard, modules/email spec
  fixtures. All scrubbed; git grep over tracked files (excl. plan/docs/.pi history) = 0.
- **Stale generated artifacts regenerated**: `src/paraglide` compiled messages and the `build/`
  output predated the scrub and still served "Eigen Mesh" strings — `npm run build` regenerates
  both; artifact grep now 0 (paraglide + build).
- The e2e 'wizard never comes back' test drove the removed eigen resetOnboarding form —
  rewritten to pin the new truth (wizard only returns via the settings cog restart).
- Storage-key rename means previously-dismissed first-capture nudges re-show once (cosmetic).
- Logo ASSETS are still eigen's (`logo-whole.svg`); alt text says Eigen Enterprise. New logo
  artwork is a design task, not a naming task — flagged.
- Feedback delivery + legal links + studio domain need owner-supplied domains (see decisions) —
  placeholders are loud, not fake-working.
- **Scope boundary (deliberate)**: `plan/`, `docs/`, `.pi` skill docs retain historical
  eigenmesh mentions — they are internal records, not live code/UI/config; `.env` untouched
  (data-safety rule, untracked owner data).

**Next**: owner decision on the real feedback inbox + website origin; new logo assets; the
remaining seed-derived pages (memory, graph, capture, chat page, brand studio) await the same
treatment when the owner says when.

## 2026-09-22 — Onboarding owns the founding interview; homepage settings cog

**Owner report (verbatim)**: chat asked "which three words should describe your company's tone of
voice?" in response to "what api are you using?" — "this is wrong and should be part of the
onboarding. and we need a settings cogscrew icon on the homepage where we have the option to set
api keys, change settings and restart onboarding etc"

**Shipped**
- **Chat can no longer ask onboarding questions.** The orchestrator persona's proactive journey
  seed ("ask this question, word for word" when a request looks founding-shaped) is gone — that
  LLM judgment is what leaked the tone-of-voice question into ordinary chat. Journeys are now
  opened ONLY by onboarding; `JourneyAwareAgentRuntime` is a pure passthrough with no active
  journey (regression-pinned in brain.spec / brain.journey.spec / agent-journey-contract.spec).
  `JourneySpec.openingQuestion` removed from the kernel primitive (dead protocol marker).
- **Founding interview moved into the welcome wizard** (new step 4 of 5, "Tell me about your
  company."): tone (3 words) / company name / one-sentence positioning. Blank = skip, nothing
  recorded. `POST /api/onboarding/founding` records the answers as a fully-captured
  website-founding journey and executes its artifacts through the kernel registry
  (`executeStepArtifacts` — extracted from the driver, shared semantics): creates brand doc +
  home/about/contact skeletons; publishes hit the owner-approval gate → 'approval_pending',
  journey stays active and retries on later chat turns (unchanged driver behavior). Re-submit
  overwrites answers and retries gated publishes; a completed founding → 409 ("already exists,
  ask the assistant") via a deterministic list_pages pre-check (no error-string sniffing).
- **Homepage settings cog** (`home-settings-menu.svelte`, always rendered in every homepage
  state — chat, wizard, provider gate): API Keys → /api-keys, AI provider → /settings/llm,
  Settings → /settings, and **Restart onboarding** → new `POST /api/onboarding/welcome/reset`
  (clears `welcomeCompletedAt`) + invalidateAll → the wizard takes over the homepage again.

**Gates: unit 561 files / 4180 tests green; svelte-check 0 errors; components 34 green
(incl. 11 wizard + 4 menu); e2e onboarding-welcome 4/4 (new cog-restart journey),
onboarding-provider 6/6 (clean port), auth 9/10.**

**Broke / flags**
- **Pre-existing e2e flake (not this change):** `scripts/mock-gateway.mjs` sometimes survives
  playwright's cleanup; the next run's `reuseExistingServer: true` reuses the stale process and
  server-side fetches 502 (copilot/start). Reproduced F/P/F/P; with a clean :5199 between runs:
  3/3 green. Fix candidate: `reuseExistingServer: false` for the gateway webServer (or SIGTERM
  handling in the script).
- auth.e2e reset-email test fails in this dev env: `.env` has `OWLERY_BASE_URL=https://YOUR_HOST`
  (placeholder, unreachable) — environmental, untouched here.
- Founding re-submission after pages exist cannot rewrite page CONTENT (create_page fails loud on
  duplicate slugs by design) — content edits go through the chat (`website.update_page`). The
  wizard's honest copy: pages are drafted, publishing waits for approval.

**Decisions**
- Onboarding captures the interview as a FORM (one step, three fields), not a chat conversation —
  the wizard is a form surface; conversational one-at-a-time belongs to chat, which must never
  ask these questions again.
- Journeys opened by onboarding stay visible to the chat driver: pending publishes retry on chat
  turns and surface the approval card — no second execution path.
- AppBoot now exposes `journeys` (composition root owns wiring; endpoints never build stores).

**Next**: conversation-driven edits for the founded pages (rename/tone updates via chat using
website.update_page), and the mock-gateway e2e cleanup fix above.

## 2026-09-22 — "YOU DO IT YOURSELF" — the ready-proof executed live, end to end, by the agent

**Owner directive (verbatim)**: "there is no npm run co -- doctor. you do it yourself." —
I had built the verification tooling and then handed the running of it back to the owner.
Wrong direction. This milestone: make it work from where the owner actually is (repo root)
and run every step myself.

**Shipped**
- **`npm run co -- doctor` now exists at the repo root** (root package.json script
  delegates into company-os). Doctor upgraded: LLM check queries the founder's DATABASE
  (the terminal path now resolves stored credentials first — no env duplication), not env.
- **Terminal chat is a first-class founder path**: `co chat` resolves credentials exactly
  like the browser (stored DB config first, env second), loads .env read-only (the CLI
  never did — `npm run chat` was a dead path), and turns run through a strict promise
  tail (piped input arrives faster than turns complete; close waits for the last turn).
- **Live execution, by me**: brought the owner's stored provider URL (localhost:5155 — a
  dead leftover) alive with the scripted gateway, resumed the ACTUAL leftover session in
  the dev database ("You were setting up Hafenlicht — where were we?"), answered the
  remaining 7 questions through the real CLI → render → reveal → ownership pointer →
  **verified the artifact**: v0.1 committed (4 files, provenance), `/site` 200 on the
  production build, real-browser screenshot inspected — monogram, German typographic
  handmade site, every sentence traceable to the answers I gave.
- **4 more issues caught by actually running it**:
  1. `?raw` imports are a Vite convention — plain-node (the CLI) rejects them. Fix:
     manifest + theme are typed runtime constants; module.json/theme.css stay as the
     human-editable artifacts, pinned to the constants by a sync test (which caught a
     real drift on its first run).
  2. The CLI never loaded .env — fixed with a read-only shared loader (chat, doctor,
     harness all use one implementation; real env always wins; the .env FILE is never
     written — data-safety rule respected).
  3. The CLI's exit raced piped turns ("Saved." printed mid-render) — promise tail.
  4. The harness now refuses a busy port LOUDLY: a stale server answering on 5178 made
     every smoke assertion lie (it interrogated the WRONG server — the dev one). Port
     pre-check names the culprit instead of asserting against a stranger.

**Gates: 113 unit, tsc, svelte-check, production build — green; SMOKE PASS; E2E 4/4 PASS;
plus one LIVE terminal journey against the owner's real dev database and stored provider
URL, artifact verified in a real browser.**

**Decisions (log)**
- Data-safety rule held: `.env` untouched. My live run used inline env; the ONE line the
  owner may want to add themselves (shown, not applied):
  `COMPANY_OS_SITES_DIR=/absolute/path` in `company-os/.env`.
- The owner's stored provider config points at a dead mock (localhost:5155) — I brought
  THAT alive rather than overwriting founder data. Consequence, stated honestly: a
  real-MODEL conversation still needs their real key via the guided setup (M8 eval).
- Test residue (one open session, one memory row) was LEFT in place and used: resuming a
  real half-interview is a stronger test than a fresh one, and it's the wedge's actual
  promise ("nothing is lost, ever").

**Next**: M4 — the iteration loop (conversation-driven edits, ~3-iteration cap, park-it
offer). When the owner drops a real key into the guided setup, the same one-command
verification exercises the real model.

---
## 2026-09-22 — E2E HARNESS + `co` CLI SHIPPED — "ready" now means proven in a real browser

**Owner directive (verbatim)**: "what happened a lot of times now is that you are telling me
that it's ready and that I then open the dev server and look at the page and nothing works."
— "I want you to be able to test the work you did and evaluate the work you did." Plan:
`plan/company-os-e2e.md`.

**Shipped**
- **`npm run co <command>`** — one CLI to interact with and verify the tool:
  `doctor` (checks every dependency, prints the exact fix — correctly reports this
  machine's missing SITES_DIR/LLM env), `chat` (founder conversation in the terminal,
  now wired with the website module + prints the ownership pointer after the render),
  `smoke` (headless E2E), `e2e` (browser journeys).
- **E2E stack harness** (`company-os/e2e/harness.ts`): the REAL product — production
  build (adapter-node), real Postgres (disposable `company_os_e2e` database, recreated
  per run), real git (temp sites dir), real HTTP — against a wire-compatible SCRIPTED
  LLM gateway (`e2e/mock-llm.ts`, OpenAI SSE with split tool-call chunks; a scripted
  401 mode for the wrong-key journey; a model call that outlives the script fails loud
  with the request summary).
- **Smoke journey** (`e2e/smoke.ts`): drives exactly what the UI drives — setup gate →
  guided provider setup → the 8-turn interview (one answer per turn, agenda key
  asserted each turn) → render in the final turn → reveal → `/site` serves the
  committed artifact → the v0.1 commit with `content.json` provenance and a clean tree.
  13 scripted model calls, seconds-fast, deterministic.
- **4 browser journeys** (`e2e/journey.spec.ts`, Playwright in company-os, headed by
  default / `E2E_HEADLESS=1`): **J1** the wedge journey (setup → interview typed into
  the real chatbox → reveal → `/site` headline/lang/monogram → git v0.1 + provenance);
  **J2a** wrong key → the provider's exact 401 surfaces, nothing saved;
  **J2b** audit rejection → nothing published, founder told honestly;
  **J3** reload mid-interview → "You were setting up … — where were we?" → continue →
  render. All 4 green in ~8s.

**Gates: 111 unit, tsc, svelte-check, production build — all green; SMOKE PASS; E2E 4/4 PASS.**

**REAL BUGS THE HARNESS CAUGHT ON ITS FIRST RUNS (the whole point):**
1. **`render_website` was broken in the production build** — `import.meta.dirname` dies
   in the bundled server (`build/server/chunks/chunks/theme.css` ENOENT). Dev worked,
   prod didn't — the exact class the owner complained about. Fix: manifest + theme
   ship inside the bundle via `?raw` imports; no runtime fs reads.
2. **The drift guard punished the render turn** — turn-start agenda demanded the
   site.language question while the model correctly saved it AND rendered in the same
   turn; the correction loop then burned a second attempt and failed loud. Fix:
   satisfaction is judged against LIVE state recomputed from memory.
3. **Company identity mismatch** — the render record stored the founder's raw sentence
   while the directory keyed off the audited draft name; `/site` 404'd on a healthy
   render. Fix: directory, record and rendered site all use the audited name.
4. **Product gap**: the UI dropped `companyName` from the resume bootstrap — the
   "You were setting up …" promise (P1, "nothing is lost, ever") was never rendered.
   Fixed; J3 asserts it.
5. Infra lesson: `spawnSync` in the e2e wrapper froze the event loop the mock gateway
   lives in — every journey hung at loadScript. Async spawn; documented in code.

**Decisions (log)**
- Only the LLM is fake; everything else is production. Real-LLM runs are M8's eval
  (owner key, human-judged), not an automated gate.
- Test ports/db are fixtures with defaults (5177/5178, `company_os_e2e`); PRODUCT envs
  keep failing loud — the server under test gets NO `COMPANY_OS_LLM_*` so the guided
  setup path is what's actually exercised.
- The mock reprograms per journey via `POST /__script`; DB reset is a direct TRUNCATE
  from the test side — no test routes in product code.
- **Binding definition of done** (recorded in company-os/README.md): no company-os
  change ships without `co smoke` green, plus `co e2e` when the UI flow changed;
  results quoted in progress.md.

**Next**: owner runs `npm run co -- doctor` and adds the two missing env lines it
prints; then a live first conversation (their key) — that lands in M8 territory. Then
**M4** (iteration loop) per `plan/phase-wedge.md`.

---
## 2026-09-22 — company-os M3 SHIPPED — the website module + first render (P2/P3, the reveal) (`b29266b`)

The interview finally ends somewhere. `ready_to_render` used to dead-end ("the website
build comes next" — nothing built it); now the wedge's actual product moment works:
describe your company → the site is drafted, audited, rendered and committed → revealed at
`/site`.

**Shipped**
- **`modules/website/`** — the first module, weekend-shippable bar: `module.json` is a
  load-bearing contract (code validates section types/schema/tools against it, not
  decoration); `copy.ts` drafts site copy from the founder's answers ONLY (every section
  must cite its source answer keys — unanswered keys are rejected) and then runs the
  **W5 hard filter**: a second LLM pass judges MEANING (no string heuristics) and rejects
  sentences stating prices/legal claims/certifications/numbers the founder never gave —
  a rejected audit commits NOTHING; `template.ts` is a pure content→HTML renderer in the
  typographic "handmade" register (system serif stack, warm paper, hairline rules,
  monogram fallback from the company name, language-aware, everything HTML-escaped,
  byte-deterministic so commits don't churn); `theme.css` is the founder-editable token
  surface.
- **`site-store.ts`** — the generated site is a git repo from the FIRST render (W4:
  "even version 0.1 is committed"): `git init` on first render, one commit per render
  (`render: v0.1 …`, versions bump 0.1→0.2→…), commit identity provided by the store so
  the artifact never depends on host git config. `COMPANY_OS_SITES_DIR` required, fails
  loud at call time (W3 convention — same as LLM config).
- **The process ends somewhere**: `plan.ts` gains the `rendered` phase, derived from a
  `render` entry in company memory (never persisted as state — resume stays exact).
  `ready_to_render` now demands the `render_website` tool call: a turn ending without it
  gets ONE bounded correction, then loud drift failure (same discipline as the question
  agenda). Questions are structurally impossible post-interview (both post-interview
  phases refuse at the tool door). Without `COMPANY_OS_SITES_DIR` wired, the render turn
  fails loud BEFORE the model is invoked — misconfiguration can't burn tokens.
- **`/site`** — the reveal surface serves exactly the committed `index.html` (the founder
  sees the artifact, not a re-render). Honest 404 ("never been rendered") vs loud 500.
- **`/api/turn` streams live** — events now go out as they happen (new `onEvent` seam on
  `runTurn`/`openSession`), so the render's progress lines arrive during the build, not
  after it. The CLI keeps its existing buffered path.

**Gates: 111 vitest passed (17 files; PG suites skip without test DB as before), tsc
clean, svelte-check 0 errors, production build green. Rendered output visually inspected
(Fotostudio smoke: monogram, de lang, sections, mailto CTA, minimal footer).**

**Decisions (log)**
- The site repo IS the website: `index.html` is self-contained (tokens inlined from
  `theme.css`, also committed alongside `content.json` with per-section provenance).
  Deploy later = serve the repo; no renderer needed at the edge.
- The CTA action (`mailto`/url/tel) is only emitted when the founder literally gave the
  address/number — the audit pass verifies; otherwise the CTA renders text-only. An
  invented email would be fabrication.
- `content.json` ships in the site repo: provenance (section → answer keys) travels with
  the copy. "100% traceable" is inspectable, not asserted.
- vitest/tsconfig now include `modules/**` (child tsconfig `include` overrides the
  generated kit list — mirrored the needed entries; svelte-check verifies).

**Broke / lessons**: FakeClient must be shared between the conversation loop and the
website tool deps — the draft/audit calls consume scripted turns from the SAME client, so
the tool deps get the conversation's client, not a fresh one. Seeding memory after
`openSession` is the correct resume semantic in specs (memory is the substrate); seeding
before open changes which turn consumes which scripted response.

**Known limitation (deliberate, M4's scope)**: after the reveal the agent is honest about
what it cannot do — "editing by conversation comes next; the site is saved and every
version is committed." No edit tools exist yet.

**Next (owner)**: add `COMPANY_OS_SITES_DIR=/absolute/path` to `company-os/.env` (I don't
touch .env — the app fails loud with this exact line until it's set), then run a live
first conversation: interview → watch the render lines → open `/site`. Then **M4**
(iteration loop: conversation-driven edits as tools, ~3-iteration cap, "park it" offer)
per `plan/phase-wedge.md`.

---
## 2026-09-22 — Phase-1e SHIPPED — welcome setup wizard: the whole system, not just the provider

**Owner directive (verbatim)**: "I WANT A SETUP WIZARD THAT GUIDES THROUGH THE SETUP! THE USER
DOES NOT KNOW WHAT THIS IS, WHAT THE SYSTEM CAN DO AND WHAT THEY WANT." Root cause: the only
first-run surface was the provider wizard (phase-1d/2a), gated on `providerReady` — a user
whose provider works (platform credits / env BYOK) logged in to a bare "What do you need?"
chatbox with zero explanation of the product.

**Shipped**
- **Welcome setup wizard on `/`** (`src/lib/components/welcome-wizard.svelte`, nucleus design
  language): ① What this is (plain words: one private AI for your company, on your server,
  remembers, acts only with approval) → ② What it can do (six capability cards: Nucleus chat,
  Capture, Memory, Knowledge graph, Brand studio, API keys) → ③ Connect the AI (reuses
  `<ProviderOnboarding>` inline when no provider works — still a hard gate, no skip;
  "Connected" card when ready) → ④ "What do you want to do first?" (Start with the chat /
  Capture / Memory / Brand / Graph — destination buttons complete the tour then navigate).
  Skippable at every step except ③-unconnected.
- **Gate**: `(nucleus)/+page.server.ts` returns `showWelcome = !harness &&
  user_preference.welcome_completed_at IS NULL`. Page precedence: welcome wizard → provider
  wizard (returning user, vanished provider) → chat.
- **Persistence**: migration `0082_welcome_onboarding.sql` (+journal, +brain.schema.ts) adds
  `user_preference.welcome_completed_at`; `POST /api/onboarding/welcome` (auth 401, idempotent
  upsert via `completeWelcomeOnboarding`, fails loud).
- **Fixed pre-existing e2e breakage**: onboarding specs hardcoded mock-gateway port 5191 while
  playwright.config starts it on `MOCK_GATEWAY_PORT ?? 5199` — the real 1-token `test-provider`
  dry-run failed on main. Specs now derive the port from env like the config does.

**Gates: 4166/4166 vitest unit (558 files), 30/30 component, e2e onboarding-provider 6/6 +
onboarding-welcome 3/3 (new suite: first-screen walk → chat; skip persists across
sign-out/sign-in, provider gate still holds; destination cards navigate), svelte-check 0
errors, lint clean on touched files, production build green. Migration applied to dev DB.**

**Decisions (log)**
- New `welcome_completed_at` on `user_preference` instead of reusing `user.onboarding_completed`
  (that flag means "provider onboarding done", is only set by saveProviderConfig, and platform-
  credit users never hit it). A fresh flag also makes the tour appear for existing accounts —
  exactly what the owner asked to see.
- The tour is skippable; the provider step inside it is not (phase-1d "no provider, no product"
  stands where it belongs). Skipping with no provider lands on the provider gate — verified e2e.
- The provider wizard is embedded, not duplicated: one credential flow to maintain.

**Broke / lessons**: SSR buttons click before Svelte hydration attaches handlers — e2e must
retry-until-advanced (new `continueToStep`, same discipline as `fillCaptureComposer`). An API
completion of a UI gate must reload the open page — `page.request.post` does not refresh
already-rendered load data.

**Known stale (pre-existing, not this phase)**: `release.e2e.ts` / `projects-assign-task.e2e.ts`
still expect the removed `/capture` onboarding overlay on `/` — they predate phase-1d and need
a rewrite for the current surface.

**Next**: owner reloads `/` and walks the wizard (their account has `welcome_completed_at`
NULL — it shows). Then the settings fold-in pass (catalog providers manageable only via
onboarding) or phase-3 per roadmap.

---
## 2026-09-21 — M2c — THE FOUNDER SURFACE: guided UI + provider setup in the browser (`edcb59f`)

**Owner directive (verbatim)**: "no, i wont touch the env. this is not good. its fine for devs, but does not work for normal people. i want to get guided through this in a ui as a user." The chat surface (was M6) and provider onboarding moved to NOW — the first conversation is the product.

**Shipped**
- **company-os is now a SvelteKit app** (architecture doc's shell): engine under `src/lib/server/`, adapter-node, `npm run dev` → browser.
- **Guided provider setup**: first open without a configured key → setup screen (presets: OpenRouter / OpenAI / custom OpenAI-compatible). The key is verified with a REAL request — failures surface the provider's exact error (verified live: OpenRouter 401 came back verbatim) — then stored in **the founder's own database** (migration `0002_provider_config`, single row). `resolveLlmConfig`: DB → env (dev) → null = setup screen. A missing key is a surface, never a silent fallback.
- **Chat UI**: arrival + interrogation as bubbles; streamed answers; named progress lines ("→ save_answer / ✓ saved"); questions emphasized; choices numbered; resume on reload. The process state stays server-side — the client renders events honestly.
- Routes: `POST /api/session` (setup gate → arrival/resume), `POST /api/provider` (verify+save), `POST /api/turn` (SSE loop events).

**Verified end-to-end** with a local mock LLM (OpenAI-compatible SSE): setup gate → key stored → arrival renders → founder answer → `save_answer` persisted to memory → next question delivered — all through the real HTTP surface. **Gates: 71/71 vitest (incl. PG), svelte-check 0 errors, production build green.**

**Decisions**
- Key in DB plaintext (single-tenant, their server, their DB) — KMS-style encryption deliberately deferred; revisit at deploy hardening.
- `npm run dev` reads `company-os/.env` (gitignored, local-only DB URL — created openly, no secrets); `.env.example` documents the one runtime var.
- The CLI (`npm run chat`) stays as the dev/headless path.

**Broke / lessons**: routes can't have arbitrary exports (SvelteKit); `process.env` isn't populated from `.env` in dev — routes use `$env/dynamic/private`; the provider-setup route needs stores BEFORE a config exists (`coreStores` split from `buildRuntime`); `build/` output committed twice now — gitignore discipline for generated dirs, same class as `.svelte-kit`.

**Next**: M3 — the website module: `module.json`, template + tokens, generate-from-answers-only, git repo per site, commit per render, preview in the UI (P2/P3 — the reveal moment).

---

## 2026-09-21 — M2b — THE PROCESS DRIVES: code-owned agenda after the first live run failed (`5243dfd`)

**Owner feedback (verbatim, on record)**: after a live conversation the founder had to push — generic greeting, the model skipped to Q4 (tone) on its own, then offered to *invent a company name*, and the founder was left asking "and now?". **Directive: "i can't push the ai to do the thinking for me, it has to proactively guide me through a process."** Root cause: M2 made the LLM own the process (a rules document), which is exactly backwards.

**Shipped**
- **Code owns the agenda** (`src/conversation/plan.ts`): the QUESTION_PLAN is a sequence; `processState(memory)` computes phase + the single next required key; injected into every turn as a PROCESS STATE system message (recomputed from memory every turn — never persisted, so resume is always exact).
- **Drift enforcement**: a turn ending without the required question gets ONE bounded correction, then the engine fails loud (`refusing to drift`) — silent agenda loss is impossible.
- **Agenda-key enforcement, live**: `ask_question` now requires the agenda's key, validated against `processState` recomputed from memory at enforcement time (so a mid-turn save moves the agenda correctly: answer Q1 → Q2 becomes deliverable within the same turn). Off-agenda questions, skipping ahead, stalling, and post-completion questions all fail at the tool door.
- **`mark_not_needed`**: the conditional site.language slot resolves by agent decision with a reason (LLM decides meaning, code persists — guardrail-compliant).
- **Chat CLI** (`src/cli/chat.ts`, `npm run chat`): the first conversation in the terminal — real substrate probes, streaming with named progress lines, resume on start. Render logic pure + tested (`render.ts`).

**Broke / lessons**
- `openSession` double-fed the persisted prefix into the loop (tests passed via slicing luck) — runTurnLoop now reads the persisted session, no additions param.
- FakeClient recorded params **by reference** — the loop's working-copy mutations leaked into recorded calls; snapshot at call time.
- Node strip-types rejects constructor parameter properties — explicit field declarations (llm/memory/session).
- The .env LLM_* values are EMPTY strings in this environment (the OpenRouter key lives in the app's BYOK DB) — the live CLI smoke needs `COMPANY_OS_LLM_*` env from the owner; everything else is test-covered.
- The external lint watcher reformats mid-session; verify-on-disk is now standard practice (caught twice this milestone).

**Decisions**: agenda = single source of truth (memory) evaluated live at enforcement, not frozen per turn; corrections persist across attempts in the loop input so the transcript stays API-valid; `requireQuestion=false` only for a broken-substrate arrival (the honest failure IS the turn).

**Next**: M3 — website module: `module.json`, template + tokens, generate-from-answers-only, git repo per site, commit per render, preview (P2/P3).

---

## 2026-09-21 — M2 SHIPPED — first conversation P0/P1: arrival check + interrogation engine (company-os)

**Shipped**
- **P0 arrival**: `src/substrate.ts` — injectable probe runner + real probes (postgres reachable, migrations applied, git available). Report is code-generated and authoritative; a failing probe lands in the transcript with its fix command. The LLM may only phrase it, never fake it.
- **P1 interrogation**: `src/conversation/first-conversation.ts` — the policy prompt (7 questions in order, one-per-turn, never-invent, choices-over-blanks, skip rules, undecisive-founder rule, founder's language = site's language) + fixed answer vocabulary (`company.name/audience/cta/tone/differentiator/assets`, `site.domain`, `site.language`).
- **Structural enforcement** (code, not prompt advice): `ask_question`/`offer_choices` are **halting tools** — the loop ends the turn when they execute; a second tool call in the same round gets a NOT EXECUTED observation (transcript stays API-valid, model learns the rule). `save_answer`/`skip_question` validate the key vocabulary and non-empty values at the door (the never-invent gate) and enforce the question budget on distinct keys.
- **Turn runner**: `src/conversation/turn.ts` — `openSession` (P0) and `runTurn` (persist founder message → loop → persist generated messages; a crash loses nothing said).

**Gates: 55/55 vitest green (incl. PG-backed), tsc --noEmit clean.**

**Decisions**
- Question budget = 8 distinct keys (7 questions + conditional site.language per Q2.5); M8 eval still measures ≤7 asked. Re-answering an existing key is never budget-limited.
- All tool `execute`s are async (uniform await path through the registry — a sync throw escapes `expect().rejects` and any caller's try/catch asymmetry).
- Halting-tool results keep the transcript OpenAI-valid (every tool_call gets a tool result, executed or NOT EXECUTED).

**Broke / lessons**
- The external lint watcher reformats files mid-session (interfaces → type aliases, naming-case renames); verify-on-disk after every edit now — two of this milestone's test failures were spec-vs-disk drift, one was a genuine sync/async throw bug caught by that verification.

**Next**: M3 — website module: dead-simple `module.json`, template with tokens, generation from answers only, git commit per render, preview + silent reveal (P2/P3).

---

## 2026-09-21 — M1 SHIPPED — session + memory persistence with resume (company-os)

**Shipped**: `agent_sessions`/`agent_messages` (every message persisted, seq-ordered, tool_calls as jsonb) + append-only `company_memory` (latest-wins reads — "nothing is lost, ever") via migration `company-os/migrations/0001_init.sql`; dead-simple own migration runner (`src/migrate.ts`, filename order, `schema_migrations` tracking, transactional, loud); `PgSessionStore`/`PgMemoryStore` + explicit in-memory test doubles (DI, never silent fallbacks); `resumeContext()` — "You were setting up <company> — where were we?" data assembly (phrasing belongs to M2's conversation policy).

**Gates: 38/38 vitest green (7 Postgres-backed against a dedicated `company_os_test` DB on the dev cluster), tsc --noEmit clean.** PG suites skip loudly without `COMPANY_OS_TEST_DATABASE_URL`.

**Broke / lessons**
- **postgres.js delivers jsonb as a raw string on this setup** — `rowToMessage` now accepts parsed-or-string and parses defensively.
- **The dev cluster preloads Apache AGE** (`shared_preload_libraries=age`), whose hook breaks `DROP TABLE` in any DB without `ag_catalog` (CREATE/TRUNCATE unaffected). Test DB recreated from `template0`; tests reset via TRUNCATE/DELETE, never DROP. Documented in `company-os/README.md`.
- In-memory session double needed a monotonic touch counter — ISO timestamps tie within a millisecond and `latestOpen` ordering went flaky.

**Decisions**: sessions/messages/memory shaped exactly for the P0–P5 flow (append-only, resume-first); jsonb defensive parsing over driver config archaeology; `postgres@^3.4.9` pinned to match the ecosystem.

**Next**: M2 — first-conversation P0/P1: arrival health check (real substrate probe, honest failures) + the 7-question interrogation policy (≤7, one per turn, choices-over-blanks, skip rules, answers → memory).

---

## 2026-09-21 — STRATEGIC PIVOT: the wedge. Owner verdict + wedge docs captured + phase-wedge opened (M0 shipped)

**Owner verdict on the existing build**: "very opinionated, bloated and not what i wanted." The kernel/brand direction built elaborate machinery while the actual product — describe your company → running on your own VPS in 10 minutes — doesn't exist. All new work executes the wedge docs instead.

**Captured verbatim into plan/**: `the-wedge.md` (strategy), `first-conversation.md` (the P0–P5 day-one flow), `claim.md` ("Own your company. Don't rent it."), `ideas.md` (WebMCP entry), `company-os-architecture.md` (v0.1 target architecture).

**Opened `plan/phase-wedge.md`** — the thin-slice execution plan: agent harness (minimal tool registry), website module (conversation-generated, git-stored, SvelteKit-rendered), one-command deploy, memory + owlery wired. Decisions of record W1–W8 (fresh minimal build at `company-os/` with zero imports from the existing app; Postgres only, no Redis/BullMQ; minimal fail-loud LLM client; website = git repo of content+theme; never-invent enforced structurally; SSE streaming; single owner token; memory = plain table until size demands more).

**Parked (not deleted)**: phase-2b/2c/2d/3 and everything built under them (kernel machinery, brand pipeline, visual editor, 81-migration schema, 4k-test suite). The existing app stays green and untouched; `company-os/` extracts to its own repo when it warrants one.

**M0 SHIPPED — harness core** (`company-os/`): streaming LLM client (OpenAI-compatible, env-required fail-loud `COMPANY_OS_LLM_*`), JSON-schema tool registry with loud parse errors, reasoning loop (reason → tool → observe, loud max-steps failure), all DI-seamed for tests without network/env. Vitest suite green. Commits: see git log on `company-os/` paths.

**Decision log**: this entry IS the architecture-impact decision record for the pivot; details in phase-wedge.md §2. AGENTS.md repo-map update deferred until the slice proves out (owner's call).

**Next**: M1 session+memory persistence (Postgres + resume), then M2 first-conversation P0/P1.

---

## 2026-09-10 — FIX: /brand 403 (owner had no admin role) + activation notice BEFORE the wizard/judge start (`f261d98`, direct orchestrator fix)

**Owner hit on first use**: `/brand` → 403. Two stacked causes: (1) the owner's Better Auth row had role `'user'` — `requireAdmin` hard-failed; fixed as **dev-DB data** (`update "user" set role='admin'`, the `create-admin.mjs` equivalent — no code change). (2) `kernel_module_activations` had no `brand` row — even as admin, every `brand.*` tool would throw `module_inactive`.
- **Owner directive**: don't fail — inform. `/brand` and `/brand/extract` now probe `brandModuleState()` on load and render **`ActivationNotice`** ("The branding module is inactive — activating it enables … approval-gated: confirm here, then approve `kernel.module_activate` in the orchestrator chat") instead of the wizard.
- **`POST /api/brand/activate`** (admin-only) → `kernel.module_activate {module_id:'brand'}` through the registry: first call → `approval_required` → UI shows "approve in the orchestrator chat"; retry after the conversational yes → activated → `invalidateAll()` loads the real surface. Self-seeded kernel module makes this reachable while `brand` is inactive (no bootstrap deadlock).
- **Gates: brand+routes+lib 36 files / 502 tests green; check 0 errors; lint clean (import sort auto-fixed).**
- **Follow-up on record**: first-signup admin policy (single-tenant: first human should presumably be owner/admin by construction instead of needing `create-admin.mjs`) — owner's call, not silently decided.

---

## 2026-09-09 — Phase-2d M6+M7 SHIPPED — PHASE COMPLETE: visual editor + tree navigation (`8f3755e`/`51e6c77` on wt/brand-visual, ff-merged; delegated subagents, orchestrator verified 493 brand-suite tests + merged; worktree pruned)

**Shipped** (migration **0081** applied)
- **M6 editor** (`/brand/editor/[setId]`): full specimen canvas (nav/hero/cards/form/pricing/footer, flexbox, cssVars-driven, light/dark) + token panel — seed controls (color picker + oklch numerics, curves, shape, elevation, motion, grain) re-expand deterministically via `reseed.ts applySeedEdit` with **owner pins surviving every re-expansion** (V3: pins beat re-expansion; `pins jsonb`, migration 0081; clear-pin re-flows from expansion, seedless drafts throw loud); click-element → driving-token highlight via the static `drivers.ts` registry; writes through draft-only `brand.visual_set_update` (human-only).
- **M7 tree navigation** (last priority, V7): precomputed k-NN descent per card ("Similar →" pivot drawer), clickable breadcrumb trail, cluster **tunnel links** from build-time `clusterAdjacency` (centroid-ranked, ≤3, in index.json); `fromNumericVector` inverse added to vector.ts so centroid distances decode back to styles; `brand.corpus_similar` read tool + `/api/brand/corpus/similar`. Pure lookups — zero runtime compute/LLM.
- **Gates: full unit 4149 passed / 5 skipped; brand suite 34 files / 493 tests green in worktree AND re-verified in main tree post-merge; check 0 errors; lint clean in touched files.**

**Decisions**
- Culori ambient d.ts extended per its own header rule (`formatHex`) — culori ships no types.
- Pin keys: bare var names for light, `dark:` prefix for dark; every direct cssVars/dark patch write pins in the same tool call.
- Adjacency symmetry asserted exactly while clusters ≤ k+1 (true today: 3 clusters); asymmetry beyond that is documented by-design.
- Phase-2d M1–M7 all merged; **worktree `../ee-brand-visual` + branch `wt/brand-visual` pruned** (recreate with `git worktree add ../ee-brand-visual -b wt/brand-visual` if follow-ups demand a stream).

**The complete owner loop (all surfaces nucleus/admin):** `/brand/extract` — paste URL → 3 candidate extractions/round → judge closest → accept → corpus item → `node modules/brand/corpus/ingest-tier1.mjs` + `npx vitest run modules/brand/corpus/build.spec.ts` to reindex → `/brand` — pick ≥3 style cards (k-NN pivots + tunnels optional) → top-3 matches → working draft → `/brand/editor/<setId>` — tune seeds/resolved values with pins → `brand.visual_set_activate` → approve in chatbox → **brand applies to the whole app**, hero + shader included. `BRAND_EXTRACT_MODEL` env required for extraction (loud if unset).

**What's next (owner's call)**: extraction-driven corpus growth in the wild (clusters will multiply past 3 — tunnels get interesting); LLM cluster naming (logged follow-up, replaces deterministic "<centroid member> family" names); phase-2c M3–M5 voice pipeline (unchanged, orthogonal); optional editor UX pass (drawer width/breadcrumb depth).

---

## 2026-09-09 — Phase-2d M4+M5 SHIPPED: selection wizard + approval-gated go-live with global token application (`999b8a6`/`e894ffd`→`4e9c519`/`439a556` on wt/brand-visual, ff-merged; delegated subagents, orchestrator verified + merged)

**Shipped** (migration **0080** applied to dev DB)
- **M4 selection wizard**: `/brand` (nucleus) — corpus as cluster-grouped card grid (`StyleCard` scoped per item), picks accumulate (≥3 unlocks matches), `selection/match.ts` = weighted centroid of picked vectors → top-3 nearest (pure math, zero LLM, V7), "Use this design" → **working draft** in `brand_visual_sets` (draft/active/retired, one-active partial unique index, `source_item_id` by uuid — no FK, corpus is in-repo per V2). Tools: `brand.corpus_list/get`, `brand.selection_matches`, `brand.visual_set_create/get/list`.
- **M5 publish/apply**: `brand.visual_set_activate` **approval-gated** (APPROVAL_REQUIRED_TOOLS; halts as pending approval, second call after approval releases — set_activate pattern); activation guards = 16 required visual roles (loud gap list) + draft-only + **retire-previous** (order dictated by 0080's partial unique index). Consumption: root `+layout.server.ts` reads active set → `+layout.svelte` emits **unlayered** `:root`/`.dark` override (beats `@layer base` regardless of injection order) → **applies to the whole app**; `/s/[slug]` hero (h1 color, WaterFlow tints) is now token-driven. `style-format/tint.ts grayscaleTint`: chromatic brands project onto the L axis (c→0) so the shader's monochrome invariant stays intact while tints stay brand-derived.
- **Hotfix `439a556`**: `corpus/mapping.mjs` → typed `mapping.ts` — the rebrand stream's `modules/**` svelte-check include pulled the plain-JS module into the check program (42 implicit-any errors); `ingest-tier1.mjs` now imports the TS module directly (node ≥22.18 native type stripping, fail-loud guard). check back to 0 errors.
- **Integration**: orchestrated commit `fe9819a` landed the rebrand stream's then-uncommitted water-flow hero work on main (byte-identical to the branch's vendored copies — zero loss); rebase conflict in `s/[slug]/+page.svelte` resolved in favor of the M5 token-driven supersession (verified strict superset of the hardcoded version).
- **Gates: worktree 35 files / 433 tests green (brand+routes+s/[slug]); full suite 4061 passed in M5 verification; check 0 errors; main tree re-verified 433/433 post-merge after `npm install` synced node_modules with the merged package.json.**

**Broke / lessons**
- **Main-tree node_modules lagged the merged package.json** (culori/daisyui) → 12 spec files failed at collection in the main tree while green in the worktree. Rule: after every stream merge, `npm install` in the main tree before trusting gate runs.
- M5's check ran pre-rebase; the rebase delivered the svelte.config include that exposed `mapping.mjs` — post-rebase gates are now run by the orchestrator on EVERY merged milestone (both incidents caught exactly there).

**Decisions**
- Unlayered override block beats `@layer base` by cascade construction, not injection order — documented at the injection site.
- `brand.selection_matches` is pure-read (no human-only guard); `visual_set_create` backfills seeds from the source corpus item (V3 resolved-tokens-alongside-seeds).
- Reverting a live brand = activating another draft (retirement is only ever a side effect of new go-live).

**Next — M6 editor (wt/brand-visual)**: specimen canvas + token panel (seed controls where seeds exist, resolved always, light/dark) + click-element→token-highlight, writing the draft via `brand.visual_set_update`. M7 (tree navigation) after.

---

## 2026-09-09 — Phase-2d M3 SHIPPED: corpus assembly — 83 formalized styles + deterministic similarity index (`beee859` on wt/brand-visual, ff-merged; delegated subagent, orchestrator verified 144 new tests + merged)

**Shipped** (109 files, +13,965 lines)
- **Similarity math** (`style-format/vector.ts` + `fonts.ts`): 48-dim style vectors from cssVars (10 core colors → OKLCH, radius/density, font categorical matrix, dark delta), weighted `styleDistance` (color ≈.45 / shape-density ≈.25 / type ≈.2 / effects ≈.1), symmetric, deterministic.
- **Tier-1 ingest** (`corpus/ingest-tier1.mjs` + pure `mapping.mjs`): 35 daisyUI v5 themes + 36 tweakcn presets → shadcn-role corpus items (mapping table in report/commit; OFL font substitutes pinned; seeds derived best-effort, cssVars remain vector source of truth). Owner-run, loud, skippable per source.
- **12 hand-authored archetype seed files** (brutalist → blueprint-constructivist), expanded through `expandSeeds()` at build time.
- **Build-through-vitest** (`corpus/build.spec.ts`): validates every item, computes vectors + k-NN(8) + agglomerative clusters (threshold 0.35, min 3) → `corpus/index.json`; deterministic, byte-stable on no-op rebuilds. **83 items, 3 clusters** (11/56/16 — light/dark divide dominates at v0 threshold).
- **Gates: 3979 unit passed / 0 failed (544 files); check 0 errors; lint clean in modules/brand.**

**Decisions**
- Item ids = pinned-namespace uuid v5 (schema demands UUIDs); slug survives as filename.
- Color normalization reference constant (0.1) added — without it the cluster threshold can never separate light-theme families.
- Cluster naming v0 = deterministic "<most-central member> family"; LLM naming logged as follow-up (keeps the build fully offline).
- Build runs through vitest (plain node can't import the pure TS modules; vite-node is broken for CLI in this repo) — one implementation, zero toolchain hacks.
- Only 3 clusters at v0 threshold: expected for a daisyUI/tweakcn-weighted corpus; threshold + corpus growth (M2 extraction loop!) are the levers.

**Next — M4 selection wizard** (`wt/brand-visual`): `brand_visual_sets` migration (draft/active/retired, one active), `brand.corpus_list/get` + centroid-matches tools, cluster-grid wizard UI → working draft.

---

## 2026-09-09 — Phase-2d M1+M2 SHIPPED: canonical style format + design-system extraction with owner judge loop (`ea6bc2a`/`3eab46c`/`9228dc6` on wt/brand-visual, rebased onto main after governance+BYOK commits, ff-merged `9228dc6`; implementation delegated to subagents in `../ee-brand-visual`, orchestrator reviewed + verified gates + merged)

**Shipped** (46 files, +4050 lines; migration **0079** applied to dev DB)
- **Canonical style format** (`modules/brand/style-format/`): zod seed schema (~18 params per plan V3) + pure `expandSeeds()` — OKLCH 12-step ramps (culori, Radix step semantics → shadcn roles), invert-tone dark scheme, Utopia clamp() fluid type/space scales, shape/radius tables, elevation shadow recipes, motion token pairs, feTurbulence grain — plus deterministic CSS emitter and the corpus-item type. Golden snapshot tests pin `expand(seed) === tokens.json`.
- **Extraction pipeline** (`modules/brand/extract/`): SSRF-guarded Playwright capture (computed-style facts + screenshot), facts digest, **3-candidate propose** (Color-led/Type-led/Structure-led lenses, temps 0.4/0.7/1.0) through the gateway, store (sessions/rounds/verdicts + `brand_corpus_staging`), export script → `modules/brand/corpus/<id>.json`.
- **5 kernel tools** (`brand.extract_start/propose/judge/accept/session_get` — human-only guards per 2c D5, no new approval gates since staging ≠ publish) + owner API routes (`requireAdmin` idiom → registry.execute) + nucleus judge UI `/brand/extract` (specimen cards vs live screenshot, closest/retry/accept).
- **Gates: brand+routes 271 passed; post-rebase brand+routes+llm 512 passed; full unit 3917 passed / 14 skipped; check 0 errors (warnings = pre-existing baseline); lint 0 findings in touched files.**

**Decisions**
- **Deviation from plan V3, on record**: CSS emission is an **in-repo deterministic emitter**, not Style Dictionary v4 — our token surface is fixed and snapshot-tested; SD adds indirection with no multi-platform consumer today. Revisit if iOS/Android targets appear.
- **`llmChatCompletion` gained an additive optional `modelOverride`** (wins over routing, never defaults) — enables the dedicated extraction model identity per D2: **`BRAND_EXTRACT_MODEL` env, unset fails loud at call time**.
- Judge loop = convergence-by-selection (owner picks closest of 3; verdicts stored as judged pairs for future fine-tuning feedback), exactly the owner's "3 variants → I judge → next round" shape.
- Parallel-session commits (governance, BYOK) landed mid-stream; rebase was clean, 512 post-rebase tests verified before merge.

**Next — M3 corpus assembly in `wt/brand-visual` (worktree kept)**: Tier-1 ingest (daisyUI/tweakcn/shadcn themes → corpus items, human-validated) + hand-authored archetypes; deterministic vector/k-NN/cluster build script (OKLCH ΔE weighted vectors, build-time LLM cluster naming) → `modules/brand/corpus/index.json`.

---

## 2026-09-09 — FIX: chat LLM calls now resolve the human's provider config (`2408c92`)

**Owner hit on dogfood**: chatbox failed loud with "Platform EUrouter not configured: set LLM_BASE_URL" despite configured OpenRouter BYOK. Root cause: the harness engine attributed LLM calls to `ctx.agent.id` ('orchestrator' principal) — llmChatCompletion found no provider row for that id and fell back to platform env. Identity mismatch between harness principal ids and llm-client user ids, introduced by the chatbox→harness wiring.
- **`llmUserId` threads surface → dispatch → ctx → engine**: `DispatchOptions { llmUserId }` on AgentRuntime.dispatch; `EngineContext.llmUserId`; builtin-json precedence `ctx.llmUserId ?? engine config ?? agent.id` (both call sites incl. streaming); `AgentChatDispatch` carries the authenticated `user.id`; route closure passes it; Telegram `respond` passes the allowlisted `session.principalId` (human principal id = auth user id). BYOK config now resolves for exactly the human in the conversation, web and Telegram alike.
- Regression coverage: runtime threading test, engine precedence test, route dispatch-options assertion. Gates: 610 kernel+modules+routes passed, check 0 errors.

## 2026-09-09 — Governance follow-up: the conversational yes is the gate (`a8b11c0`)

**Owner directive**: "ee module activate repo — this has to be called by the agent." No manual CLI prerequisites; the loop lives in the conversation.
- `kernel.approvals_list` + `kernel.approvals_decide`: owner-only → **owner/admin/agent** — the agent surfaces pending approvals in chat and executes the owner's conversational yes (trust-the-transcript, as recorded in phase-3 risks; `decidedBy` audited). The chatbox approval card now completes in-conversation.
- `kernel.module_activate`/`deactivate` added to APPROVAL_REQUIRED_TOOLS — the agent can call them (it holds admin), the gate halts until the owner's yes. "Activate the repo module" is now a chat sentence, not a CLI step.
- CLI specs that used owner-only `approvals_list` as their denial vehicle re-pointed at an owner-only fixture tool (intent preserved: flag-over-env resolution + permission_denied exit-code mapping). Gates: 642 passed / 4 skipped, check 0 errors; the parallel session's uncommitted brand files were accidentally swept into a commit and restored to uncommitted state (`ea62db6` redone as `a8b11c0`).

## 2026-09-09 — Phase-2d DESIGNED: visual branding (taste elicitation → extraction → selection → apply → editor)

**Shipped** (plan only — design grilling session, zero code)
- **`plan/phase-2d-visual-branding.md`** — approved design with decisions of record V1–V10 and milestones M1–M7. **Supersedes phase-2c D1: the visual pipeline is now v0 scope.** Phase-2c M3–M5 (voice pipeline) unchanged and orthogonal.
- The crux (owner: "how do we translate tokens to design and vice versa") resolved by research: **W3C DTCG container + a seed block (~18 params) + 8 pinned deterministic expansion rules** (OKLCH/Radix ramps, M3 dark scheme, Utopia fluid scales, shape/motion/shadow/grain recipes) → `expand()` → Style Dictionary v4 → the CSS vars `layout.css` already consumes. Snapshot-tested determinism; no existing format had this — the seed schema is the only novel piece.
- Architecture facts pinned: corpus = in-repo static JSON in `modules/brand/` (Tier-1 ingest: ~100–150 already-tokenized MIT styles from daisyUI/tweakcn/shadcn + extraction-driven growth); similarity = deterministic weighted token-vector distance + build-time k-NN/clusters (Every Noise pattern); selection = cluster grid → picks → weighted-centroid taste → top-3 shortlist; **zero runtime LLM**.

**Decisions (owner, grilled)**
- **Extraction pipeline = first priority**: URL → 3 candidate extractions per round → owner judges closest → iterate until accepted → corpus item; judged pairs stored for future fine-tuning. "RL with me as judge" implemented as convergence-by-selection, no gradient updates v0.
- **No Penpot, no second DB, ever** — DB is SoT (new `brand_visual_sets`, draft/active/retired), native flexbox editor on a specimen canvas instead; Penpot conventions may be harvested later at most.
- Runtime taste-interpretation scrapped ("no llm as judge … wrong direction"): selection is pure math; LLM only in extraction loop + one-time build-time cluster naming.
- Tree navigation (k-NN descent/tunnels) = **last priority**; one selected design applies **globally to all user-facing surfaces** (global `:root` override; app's own style remains until explicit activation); water-flow shader keeps grayscale until a brand is active, then tints from the active set.

**Next** — M1 canonical format (`expand()` + snapshot tests + Style Dictionary emitter) in workstream `wt/brand-visual`; M2 extraction pipeline + judge loop right behind it.

---

## 2026-09-09 — Phase-3 M2: repo hands — the one agent can now improve its own repo

**Shipped** (`004d1e9` on wt/one-agent-hands, ff-merged; subagent-implemented in worktree, orchestrator reviewed)
- **`modules/repo`** (new, activation-gated): the agent's repo hands as 5 registry tools — `repo.worktree_create` (external; `../ee-agent-<id>` + `wt/agent-<id>`, idempotent per principal, stale-worktree fails loud), `repo.run` (external; token-structured allowlist — metachars rejected outright, per-entry arg validation, `--amend` structurally impossible; 10-min timeout; non-zero exit = result, not exception; output truncated with explicit marker), `repo.read_file`/`repo.write_file` (mutate/read; path-resolved inside worktree, `..` escapes rejected, secret paths blocked BOTH ways — reading `.env*`/`*.key`/`*.pem` is exfiltration), `repo.merge` (mutate + in APPROVAL_REQUIRED_TOOLS; server-side verify gate = vitest kernel-scoped + check, both green or refused; commit-if-dirty → `merge --no-edit` → cleanup; conflicts fail loud: STOP and ask the owner).
- **Discipline as prompt**: `modules/orchestrator/discipline.ts` — 6 sections distilled from `.pi/skills` (plan-first, understand-first, no-fallbacks, no-mid-air-rethinks, loop-detection, commit-conventions) + REPO_HANDS protocol (plan in chat → worktree → edit/run → progress.md → merge behind owner approval). Appended to the orchestrator persona (2-line brain.ts change).
- **No new tables** (M2 decision): git history + kernel_events are the run log. Events: `repo.worktree_created/command_run/file_written/merged/verify_failed` (metadata-only).
- **Gates: modules/repo+orchestrator 106 passed (incl. real temp-git-repo integration spec); kernel+modules+cli 628 passed / 4 skipped; check 0 errors / 24 warnings; boundaries guard green; hostile-input battery pinned (shell injection, amend, traversal, secret paths).**

**Decisions**
- Allowlist over free shell: the agent is owner-entrusted, but a hallucinated command shouldn't be `rm -rf`; capability gaps closed by structured tools (`write_file` gives mkdir-p; merge does its own `git add -A` internally) instead of flag-widening the allowlist.
- Duplicate `REPO_VERIFY_TARGETS` instead of importing from frozen dev-agent (boundary guard).
- Idempotent worktree keyed by principal id, tracked in engine memory; no DB persistence (git is the log).

**Next — M3 (dogfood + cleanup)**: live proof in the chatbox — "improve X" → plan → worktree → green → owner yes → merged → progress.md updated, all in one conversation. Then delete frozen code (pi-engine, dev-agent module, orchestrator brain/loop remnants, builtin-json engine indirection, legacy agent-loop path) and re-point anything still consuming them.

---
## 2026-09-09 — Phase-3 M1: durable session log — conversations survive restarts

**Shipped** (`3f33645` on wt/one-agent-loop, merged `7dbab8b`; implementation delegated to a subagent in the worktree, orchestrator reviewed + integrated)
- **`kernel_agent_session_events`** (migration **0078** + journal idx 78): append-only conversation log (bigserial id = global order, session_id/agent_id, kind CHECK user|assistant, payload jsonb `{text}`), index (session_id, id). Applied to dev DB; content-hash tracking meant the rename to 0078 needed no DB surgery.
- **`kernel/session-log.ts`** — kernel port (`AgentSessionLog` append/list, InMemory for tests; zero `$lib/server` imports); `DbAgentSessionLog` in `db-stores.ts` (DbHandle-injected, newest-DESC reversed to chronological).
- **builtin-json dememorized**: in-memory session Map + `remember()` DELETED; history derived from `list(sessionId, 40)` per run; each final turn appends user + assistant events; construction fails loud without a log; payload text validated loud. Protocol/streaming/approval UX untouched.
- **Wiring**: `WiredKernel.sessionLog` (required); `BootstrapKernelOptions.sessionLog` defaults `DbAgentSessionLog(db)`; orchestrator bootstrap forwards `kernel.sessionLog` into the engine. boot.ts unchanged.
- **Restart-resume proven**: fresh engine instance B on a shared log continues A's conversation (spec); DB integration spec proves the same across fresh store instances.
- **Gates: kernel+db+orchestrator 305 passed / 5 skipped (DB specs run green against dev DB); cli+mcp+modules 387 passed / 1 skipped; check 0 errors / 24 warnings (baseline).**

**Broke / integration**
- **Mid-air 0077 collision** with the parallel journeys stream (both took idx 77; both touched modules/index.ts, bootstrap.ts, brain.ts, journal). Resolution: journeys keeps 77, session events renumbered **0078**; imports unioned in brain.ts; auto-merge of the JourneyAwareRuntime + sessionLog wiring verified by hand. Journal-pin spec in playbook.spec now looks up by tag instead of "last entry" (pin survives future migrations — intent preserved, not weakened).
- Dev DB: `0077_journeys` committed by the other session but NOT yet applied — next `npm run db:migrate` applies it (hash-based tracking; my 0078 content already applied under its old name, hash unchanged → skipped).

**Decisions**
- SessionLog is kernel-owned port + DB store beside the other kernel stores (same pattern as approvals/events); engine requires it — no in-memory fallback, debt deleted not shadowed.
- Only final turns are logged (user + assistant); tool calls stay in kernel_events/stream — conversation log stays model-history-shaped.

**Next — M2 (repo hands)**: `repo.*` registry tools (worktree_create / run-scoped / merge approval-gated with server-side verify) + `.pi/skills` discipline as persona prompt sections; then the in-conversation self-improvement proof.

---
## 2026-09-08 — Seamless-tool wave 1+2: harness chat, approvals in the surface, recap, THE JOURNEY

**Shipped** (52b110c → 9d6b8e8, five commits; parallel brand work in the tree was left untouched)
- **Redirects dead**: post-auth lands on `/` (social default, e2e auth-landing assertions incl. auth.e2e + projects-assign-task; capture-as-feature tests kept). Chatbox got `data-testid="nucleus-chatbox"`.
- **`/api/chat` now dispatches through the kernel AgentRuntime** — the chatbox speaks through the harness proper. New surface events: `tool.preview` (metadata-only, ≤120 chars) + `approval.required`; nucleus renders "→ using …" lines and an approval card. Streaming via optional `EngineContext.stream` (graceful single-delta fallback — llmClient has no streaming seam yet).
- **`modules/recap`**: deterministic 24h kernel_events digest → owner Telegram chats (sessions × allowlist intersection, chunked, fail-loud) + `recap.completed` event; `recap.run_now` tool; activation-gated; wired in boot.ts with 5-min tick (HMR-safe, opt-out via bootApp options).
- **Journey engine** (`kernel/playbook.ts` + `kernel_journeys` idx **77** — parallel session took 75/76): `website_founding` journey ships REAL — tone-of-voice question (marker protocol, zero semantic parsing) → brand doc artifact → home/about/contact skeleton pages → `website.publish_page` ×3 **behind the approval gate** (added to APPROVAL_REQUIRED_TOOLS) → completed + event. `JourneyAwareAgentRuntime` subclass = both chatbox and Telegram get journeys; deterministic start seam via verbatim persona question.
- **Main: 1268/1268 tests, check 0 errors; eigen_test migrated through 0077.**

**Notes / debt**
- Chat history for the model is engine in-memory per session (DB rows = durable transcript/UI only) — persisted session memory is the next harness debt.
- `journey.abandoned` modeled, no timeout/cancel path yet. One active journey per kind (DB-enforced).
- Parallel session active in-tree (modules/brand water-flow shader, migrations 75/76, phase-3-one-agent.md draft) — commits were scoped strictly to agent reports; their files remain uncommitted by me.

---
## 2026-09-09 — DECISION: One Agent — dsh concepts implemented IN-REPO (no dsh install; kernel stays as the tool door)

**Decision (owner, decisive)**: "We need one agent that does all." — "We don't install dsh. We take the concepts of dsh and implement them in our repo." One in-repo agent loop (evolved builtin-json protocol) with a durable append-only Postgres session log (model-visible = logged; restart = resume; in-memory Maps debt dies), speaking through the nucleus chatbox via `/api/chat`. Company tools AND repo hands (worktree → scoped run → verify → approval-gated merge) are registry tools through the kernel door. `.pi/skills` discipline ports into the one agent's system-prompt sections. Approvals surface in-band: pending → agent asks in chat → owner yes → retried → audited in kernel_events + git.

- **Concept map** (dsh → in-repo, exists vs build) pinned in `plan/phase-3-one-agent.md`.
- **Frozen** (deleted deliberately in M3): AgentRuntime engine indirection, pi-engine, dev-agent module, orchestrator brain/loop, legacy `/api/chat` agent-loop path, Telegram gateway (dormant).
- **Unchanged**: kernel proper (registry/principals/approvals/events/vcs/modules + DB), website/auth/memory/brand app, phase-2c branding M3–M5, `ee` CLI as the human/external door.
- **Accepted risks on record**: in-repo loop is hand-maintained (one protocol file + a log — full ownership, zero external churn); owner principal in agent hands (conversational governance + git rollback; merge is the approval-gated control point); trust-the-transcript approvals.
- **Milestones**: M1 loop + durable session log + `/api/chat` → one loop → M2 repo hands (`repo.*` tools) + skills-as-prompt-sections + in-conversation self-improvement proof → M3 dogfood (agent improves its own discipline) + deliberate cleanup of frozen code.

## 2026-09-09 — Brand water-flow shader: monochrome fluid as a brand module asset

**Shipped** (uncommitted working tree)
- **`modules/brand/water-flow.svelte`** — the brand's signature visual: a monochrome flowing-water surface rendered by a WebGL1 fragment shader, built to be as lightweight as possible. One fullscreen triangle, one program, zero textures, zero per-frame allocations; motion = three domain-warped fbm evaluations/pixel (classic water warp). Cost controls: DPR capped at 2 × quality 0.75 with a hard 1.5M-pixel budget (flat fragment cost on 4K), `powerPreference: 'low-power'`, rAF loop paused via IntersectionObserver when offscreen, `prefers-reduced-motion` renders a single static frame (live media-query switch), dt clamped so background-tab resume never jumps the flow, full teardown incl. `WEBGL_lose_context`.
- **`modules/brand/water-flow-shader.ts`** — pure logic split out of the canvas lifecycle: GLSL sources + `parseMonochromeTint`/`resolveWaterFlowColors`. Tints are hex-only and **monochrome-enforced at parse** (non-grayscale input throws naming the brand rule — the water-flow asset is grayscale by invariant, not by styling).
- **Failure policy (decorative asset)**: every failure mode (no WebGL, invalid/non-monochrome tint) degrades to a VISIBLE static tint (gradient from the same props + `data-water-flow="static"`) with a loud `console.error` — never a crash of the host page, never a silent degradation. Shader compile/link failures still throw loud (code bug, not environment).
- **Landing surface**: `/s/[slug]` website pages now open with a hero band (dark `#060606` → silver `#b9b9b9`, default props) — the water flow fills the band, page title overlays bottom-left over a legibility scrim.
- **Tests first**: `water-flow-shader.spec.ts` (12 node tests: tint parsing incl. monochrome rejection, shader-source invariants — WebGL1/no `#version`, mediump, texture-free, uniform coverage) + `water-flow.svelte.spec.ts` (4 browser tests: decorative canvas + class/aria passthrough, static fallback on missing WebGL, static fallback on non-monochrome tint, enrolled in `vitest.browser.config.ts`). GLSL compile+link verified against a real GL context (playwright chromium + SwiftShader) since headless CI has no GPU.
- **tsconfig scope fix (long-standing flag resolved)**: `svelte.config.js kit.typescript.config` now adds `../modules/**/*.ts` + `../modules/**/*.svelte` to the generated tsconfig include — modules UI assets are first-class citizens for `svelte-check` and eslint's projectService (the 2026-09-08 "modules/** outside svelte-kit tsconfig include — consider tsconfig addition later" flag is closed).
- **Gates: unit 3506 passed (509 files), components 17 passed, check 0 errors (24 warnings = main's), lint: 0 errors in touched files (kernel's pre-existing errors untouched).**

**Decisions**
- The shader lives IN `modules/brand/` (user directive: "part of the branding module") — it is a brand visual asset, not a generic component; `src/lib/components` stays for shared UI. Routes may import module assets (boundaries guard only polices module→module imports; a presentational .svelte has no server deps).
- Monochrome tints enforced in code (`parseMonochromeTint` rejects non-grayscale hex) — brand invariants belong in the brand module, fail loud.
- Continuous fluid over discrete cells: user picked the smooth interpretation of the Y-reference; the tiled look remains achievable via future props if wanted.
- Degradation policy for decorative surfaces: visible static tint + loud log (consistent with the fail-loud spirit — the failure is observable — while not taking down a public landing page over a missing GPU feature).

**Tracked**
- **`ee` CLI broken on vite 8 (regression, needs a fix stream)**: `tsx src/cli/index.ts` fails (`Cannot find package '$env'` — tsx doesn't apply SvelteKit's tsconfig paths) and the vite-node fallback dies in SvelteKit's browser-import guard (`An impossible situation occurred`, node_modules/@sveltejs/kit/src/exports/vite/index.js:670 — vite-node's module graph isn't walkable for the server-only pyramid check). Documented dev-bootstrap via SQL was used instead this session (owner principal `…aa`, website module activation, `home` page seed); the CLI path must be restored before agent-native hands depend on it.
- Headless CI has no WebGL → the animated branch is only exercised by real GL (SwiftShader verification script, not enrolled); browser spec asserts structure + fallback branches.
- Hero is wired only on `/s/[slug]`; reusing it on the nucleus `/` or future marketing routes is a one-line component import (brand module is the owner).
- Shader tuning (speed/scale/quality defaults, tint tokens from `brandVisualTokens` once M3 publish lands) is open — defaults chosen to match the reference art.

---
## 2026-09-08 — Phase-2c: explicit model selection — no implicit defaults

**Shipped** (`21ad301` feature, wt/model-selection, rebased onto brand-kernel main, ff-merged)
- **User directive**: never default to gpt-4o-mini (or anything). Model choice is now a dedicated wizard step for EVERY flow, driven by the models.dev catalog via `GET /api/onboarding/catalog/models?provider=…` (works for anthropic/openai-codex whose API shape excludes them from the API-key grid).
- **Pinned defaults removed everywhere**: OpenRouter sign-in no longer pins openai/gpt-4o-mini; Anthropic no longer pins claude-sonnet-4-5; Codex no longer pins gpt-5.1-codex. Connect/poll endpoints REQUIRE the chosen chat model; onboarding completes only after selection. API-key form model inputs start EMPTY with catalog datalist suggestions.
- **Embedding fields render only when the catalog says the provider supports embeddings**; otherwise an honest note (memory features need one later). `getCatalogModelLists(providerId)` returns model lists for ANY catalog id (raw entries cached unfiltered).
- **E2E hardening**: root layout sets `body[data-eigen-hydrated]` on mount (SSR hydration replay was wiping values filled pre-hydration); `fillPersisted` verifies the value SURVIVES a settle window and re-fills; flow-id → catalog-id mapping fixed (github_copilot → github-copilot); mock-gateway fixture extended (anthropic/openai-codex/openrouter/github-copilot entries) and its chat replies are now agent-protocol JSON (tool-first, alternating list_projects/answer per the journey contract).
- **Gates: unit 3473 passed, components 13 passed, e2e 6 passed on BOTH deployment shapes, check 0 errors, lint = main's 7 pre-existing.**

**Decisions**
- Model lists come from the live catalog even for API-shape-excluded providers (Claude/Codex sign-ins need model pickers too) — the catalog is the single source of model truth.
- No model default anywhere in onboarding; Continue is disabled until a chat model is picked. Server-side, connect/poll reject empty modelChat (400).
- OpenRouter sign-in carries the chosen models through the PKCE cookie (authorize body → callback save) since its completion is a redirect, not a wizard step.

**Tracked**
- Model pickers list the full catalog for the provider; a "recommended" subset per subscription tier would be a UX refinement.
- Settings → LLM still edits models for the two first-class providers only; fold catalog-wide editing into the legacy-deletion pass.

---
## 2026-09-08 — Phase-2c M1+M2 shipped: brand kernel schema + guideline curation module

**Shipped** (`d71dc6b` plan + `a03fb89` feature, wt/branding, ff-merged)
- **Migration 0076** (`drizzle/0076_branding_tables.sql` + journal idx 76, applied to dev DB + functionally smoked): 10 `brand_*` tables — guideline sets (immutable versions, draft|active|retired, **one-active-per-locale partial unique index** so D3 is DB-enforced), voice examples, lexicon, visual tokens, glossary, criteria, assets, validations, judge metrics, calibration cases. CHECK constraints on every enum-ish column.
- `src/lib/server/db/brand.schema.ts` — drizzle schema (consumed only by modules/brand).
- **`modules/brand`** — store (interface + InMemory + Db + lazy `defaultBrandStore()`; lifecycle guards live IN the store), manifest, **10 kernel tools**: `brand.set_create/update/activate/get/list`, `example_add`, `lexicon_add`, `criterion_add`, `token_add`, `glossary_add`.
- **Guards**: activation requires CARE-complete context + ≥2 exemplars incl. ≥1 good and ≥1 bad (G2); single tone words rejected at zod level; curation writes draft-only; active/retired immutable (G23); `getActiveSet(locale)` fails loud — no implicit "latest".
- **G8/D5 enforcement**: mutation descriptors are admin-role AND handlers reject non-human principals (an agent holding the admin role still gets `permission_denied`); `brand.set_activate` is additionally approval-gated (APPROVAL_REQUIRED_TOOLS).
- Wired in `modules/index.ts`; `index.spec.ts` exact-manifest assertions grown by design.
- **Gates: modules+kernel 411 passed / 1 skipped; db 23 passed / 2 skipped; check 0 errors (24 warnings = main's); lint 7 errors = main's pre-existing baseline, 0 in modules/brand.** Migration smoke: second active set per locale correctly violates the unique index.

**Decisions**
- D1–D5 recorded in `plan/phase-2c-branding-module.md` (visual pipeline out of scope v0; dedicated judge identity + explicit `BRAND_JUDGE_MODEL` unset-loud; per-locale sets; layered disclosure; human-only mutations + activation approval gate).

**Next**
- M3 stream: `brand.content_generate` (N≥3 variants via gateway, judge-rank), deterministic→judge validation pipeline, `brand.content_publish` approval-gated with risk tiers.
- M4 stream (separate — touches `src/lib/server/llm/**`): `brand-context` gateway middleware (G4) — CARE block injection + `guideline_set_id` on call records; generation without an active set fails loud.
- M5: calibration + regression + acceptance sweep (§7 checklist).

## 2026-09-08 — Phase-2c approved: brand kernel implementation starts

**Shipped**
- `plan/phase-2c-branding-module.md` — approved phase plan. `plan/branding-module-rules.md` flips PROPOSED → APPROVED.
- **§8 open questions resolved as decisions D1–D5** (vetoable, recorded in the phase plan): D1 visual-asset pipeline out of scope v0 (owlery bootstraps tokens later); D2 dedicated judge identity + explicit `BRAND_JUDGE_MODEL` (unset = loud failure, never a silent generator-model fallback); D3 per-locale guideline sets, one active per locale, explicit-locale resolution (no implicit "latest"); D4 disclosure = site-level statement + per-asset provenance flag; D5 guideline mutations human-admin-only (handler kind check), `brand.set_activate` additionally approval-gated, agent-proposal flow tracked as follow-up.
- Module id `brand`, tool namespace `brand.*`; milestones M1 schema+migration 0076 → M2 store+manifest+guideline tools → M3 generation/validation/publish → M4 gateway brand-context middleware → M5 calibration/regression/acceptance sweep.

**Next:** M1+M2 on `wt/branding` worktree.

## 2026-09-08 — Phase-2b: subscription sign-ins — Claude Pro/Max + ChatGPT via API-shape adapters

**Shipped** (`7fe61c5` plan + `feb8cc1` feature, wt/subscription-signins, ff-merged)
- **Anthropic (Claude Pro/Max) sign-in**: PKCE authorize (state=verifier) opened in a new tab; user pastes the code/redirect URL back (pi's manual_code pattern — no redirect-allowlist dependency); exchange + refresh at platform.claude.com. OAuth requests authenticate via Bearer with Claude Code identity headers (`user-agent: claude-cli/x`, `x-app: cli`), betas `claude-code-20250219,oauth-2025-04-20`, and the required Claude Code system preamble (pi: buildParams).
- **OpenAI (ChatGPT Plus/Pro) sign-in**: device-code flow (`auth.openai.com/api/accounts/deviceauth/*`, verification page `/codex/device`) — same wizard UX as Copilot. Access token is a JWT; `chatgpt_account_id` claim extracted for the required `chatgpt-account-id` header.
- **API-shape adapters** (`llm/api-shapes.ts`): Anthropic messages (non-streaming, `/v1/messages`) and Codex responses (SSE `/codex/responses` accumulation) normalize to OpenAI shape — llm-client's retry loop, cost logging, and PostHog run unchanged. Dispatch gated by `usesApiShape(provider)`; OpenAI-compat path untouched. Embeddings on subscription providers fail loud naming the fix.
- **llm-client**: resolve-on-expiry generalized — github_copilot, anthropic, and openai_codex rotate and persist tokens on expiry; OpenRouter OAuth keys pass through (never expire).
- **Wizard v3**: subscription step now offers Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, and OpenRouter sign-in — paste-code card and device-code card join the API-key catalog form.
- **E2E**: mock-gateway gained Anthropic token/messages + Codex device/SSE stubs; the Claude test captures the loopback callback REQUEST (Chrome replaces the failed navigation's URL) and pastes the full URL; both flows run a real chat turn through the adapters.
- **Gates: unit 3470 passed, components 12 passed, e2e 6 passed on BOTH deployment shapes, check 0 errors, lint = main's 7 pre-existing.**

**Decisions**
- Anthropic uses manual-code paste (pi's headless pattern) instead of a registered redirect URI — works remotely and self-hosted without any client registration.
- Codex uses the device-code login (not the localhost:1455 browser flow) — same rationale; SSE accumulated server-side (Codex rejects store:true and pi always streams).
- OAuth refresh generalized: anthropic/openai_codex/github_copilot rotate-and-persist on expiry inside loadLlmProviderConfig.

**Tracked**
- OpenRouter sign-in + catalog model defaults are pinned conservatively (gpt-4o-mini / text-embedding-3-small / claude-sonnet-4-5 / gpt-5.1-codex); model PICKERS for subscription providers (catalog or /models endpoints) are the next UX refinement.
- answer_question/retrieve chaining in the agent journey means a first-turn plain answer is rejected (tool-first contract) — subscription e2e asserts the turn completes, not the reply content (journey tests already cover reply semantics with real providers).

---
## 2026-09-08 — Phase-2a: provider onboarding — method → provider (pi-inspired, catalog-driven)

**Shipped** (`01eab7a` plan + `b338c48` feature, wt/provider-catalog-onboarding, ff-merged)
- **Research**: pi's `packages/ai` auth architecture — type-tagged credentials (`api_key | oauth`), `OAuthAuth.isSubscription`, normalized events (`auth_url`, `device_code`). Ported the two web-native flows and adopted **models.dev** (the open model catalog pi generates from) as the provider catalog.
- **Wizard v2 — two questions**: ① "Use a subscription I have" vs "Use an API key" ② provider selection — subscription lists **GitHub Copilot** (device flow) + **Sign in with OpenRouter** (PKCE → permanent key); API-key lists the models.dev catalog (OpenAI-compatible only, chat/embedding model counts, search) with EUrouter pinned first-class.
- **GitHub Copilot subscription, full e2e**: device code shown in the wizard → server polls → GitHub token exchanged for a short-lived Copilot token (proxy-ep → api base derivation, model list) → stored tenant-encrypted (`auth_type/oauth_*` columns, **migration 0075**). Chat-only by design: embeddings absence fails loud naming the fix.
- **OpenRouter sign-in**: `authorize` sets an httpOnly PKCE verifier cookie, OpenRouter redirects back with `?code=`, exchanged for a permanent key, saved + onboarding completed + redirected to `/`.
- **llm-client generalized**: provider ids are free-form text (new providers never need migrations); all non-EUrouter providers route by direct model; OAuth rows resolve + refresh transparently (rotated access persisted under the store lock semantics of `loadLlmProviderConfig`).
- **Gates: unit 3456 passed, components 10 passed, e2e 4 passed on BOTH deployment shapes (incl. the full Copilot device flow headlessly via mock-gateway stubs), check 0 errors, lint = main's 7 pre-existing.** Migration 0075 applied to the dev DB.

**Decisions**
- v1 subscription providers = Copilot (device flow — fully web-native, no client-secret) + OpenRouter sign-in (PKCE with caller-controlled callback). **Claude Pro/Max and ChatGPT subscriptions are the deliberate next step**: they need a redirect-allowlist strategy + Anthropic/Codex API-shape adapters — pi's `anthropic.ts`/`openai-codex.ts` are the reference implementations.
- models.dev is a live dependency with loud failure + retry (never a silent fallback); `MODELS_DEV_CATALOG_URL` / `OAUTH_GITHUB_*` env overrides exist for e2e determinism.
- Wizard strictness by catalog: embedding-capable providers require an embedding model (memory depends on it); chat-only providers (Copilot) warn and defer.

**Tracked**
- Claude/ChatGPT subscription OAuth + Anthropic/Codex API-shape adapter (next pass).
- Settings → LLM remains the legacy two-provider surface; catalog providers currently manageable only via onboarding (reconnect flow = revisit onboarding) — fold into the legacy-deletion pass.

---
## 2026-09-08 — Phase-1d: first-run onboarding IS the first screen (nucleus, ground-up)

**Shipped** (`a1fb017` plan + `8972baa` feature, wt/nucleus-first-run-onboarding, ff-merged)
- **The wizard IS the page**: open `/` without a working provider → `ProviderOnboarding` (nucleus design: white, black borders, sharp, tracked uppercase wordmark) replaces the chatbox entirely. Provider tiles (OpenRouter / EUrouter) → adaptive credential fields → **Connect runs a real 1-token gateway call** (`testLlmProviderConnection`, config-driven routing — env cannot silently complete wizard creds) **before saving** (`saveProviderConfig` + `onboardingCompleted=true`). No skip: no provider, no product. Operator-hint branch for BYOK-disabled deployments.
- **Landing flip /capture → /** — signup (load, callbackURL ×2, post-success), login (×4), settings resetOnboarding. Onboarding is literally the first thing on opening the page; e2e helpers follow (`waitForURL '/'`).
- **Nucleus gate**: load returns `needsOnboarding = !harness && !providerReady` — returning users whose provider vanished see the wizard again; harness accounts never do.
- **Legacy surface reverted to pre-1c**: capture overlay back to its 3-step EigenMesh shape (deletion stays a deliberate later call); capture page lost the 1c provider-step additions.
- **`scripts/mock-gateway.mjs`** — OpenRouter-compatible mock gateway as a second playwright webServer: the wizard's real test-call is proven e2e against a reachable gateway (dummy-URL runs correctly fail the test — feature working as designed).
- **Gates: unit 3442 passed, components 8 passed, e2e 3 passed on BOTH deployment shapes (platform env emptied + present), check 0 errors, lint = main's 7 pre-existing.**

**Decisions**
- Ground-up per user directive: EigenMesh onboarding copy/design is not carried over; the wizard is EE-native and gates the chatbox. First-run has no skip — fail loud at the front door.
- Connection proof is a real gateway request (1 token, activity-logged), not a key-format check.
- Wizard requires complete working credentials (EUrouter: both rule UUIDs; OpenRouter: both models) — stricter than the permissive Settings form, by design.

**Tracked**
- `release-helpers.completeOnboardingOverlay` still walks the removed install step (pre-existing; production-user e2e helpers need a rewrite for the wizard-first flow).
- Old eigenmesh copy remains in the legacy capture overlay + `/settings` pages until the deliberate legacy-deletion pass.

---
## 2026-09-08 — Phase-1c: onboarding provider setup — LLM config is user-facing, not an env dead end

**Shipped** (`92f96dd` plan + `215c303` feature, wt/onboarding-provider-setup, ff-merged)
- **Typed `LlmNotConfiguredError`** (`src/lib/server/llm/errors.ts` + `isLlmNotConfiguredError` cause-chain walk) thrown by platform-llm, llm-client loaders, llm-config-guard, preferences. Chat error terminal payload threads `code: 'llm_not_configured'` on the wire; `ChatStreamError` carries it. Zero string matching.
- **Onboarding step "Connect your AI provider"** in `capture-onboarding-overlay.svelte` (id-based step flow frozen at mount): EUrouter (base URL + key + rule UUIDs) / OpenRouter (base URL + key + model names). Skippable; operator-hint branch when `BILLING_BYOK_UI_ENABLED=false`. Only shown when `isUserProviderReady` is false (mirrors `loadLlmConfig` fidelity: billingMode-aware, non-throwing env check).
- **`saveProviderConfig` service** — one persistence path for Settings → LLM and the onboarding action (validate, tenant-encrypt, upsert `llm_provider_config`, active provider, `billingMode → byok`). Settings action slimmed to form-parse + BYOK-UI gate.
- **Failed chat turns get a door**: nucleus renders "Set up your AI provider →" under the failed bubble when `code === 'llm_not_configured'`.
- **E2E** (`onboarding-provider.e2e.ts`, 3 tests, green on BOTH deployment shapes — provider env present and emptied): step shown+save via onboarding form, step hidden once BYOK creds exist (via settings form, deterministic on any deployment), skippable.
- **`E2E_PORT` playwright override** — a worktree checkout can e2e its own build instead of silently reusing another checkout's dev server on 5173 (reuseExistingServer trap; cost ~an hour to diagnose — the bug ran main's suite against a stale server and "passed" 14 unrelated tests).
- **Gates: unit 3424 passed, components 8 passed, e2e 3 passed, check 0 errors, lint errors = main's 7 (all pre-existing kernel).**

**Decisions**
- Chat failure deep-links to `/settings/llm` (one form, no duplication) — orchestrator call, user approved plan without picking.
- Onboarding provider setup = per-user BYOK (existing semantics); platform service-account env stays the operator path — coincident in single-tenant self-host.
- Provider step visibility is load-derived (`providerReady`), never an execution gate: the gateway still fails loud; the UI only adds a door.
- Component spec for the overlay enrolled in the browser gate with `$app/*` stub modules (`src/lib/vitest-stubs/`) + alias in `vitest.browser.config.ts` (vi.mock can't intercept virtual modules that fail import-analysis).

**Broke / found**
- `capture-onboarding-overlay.svelte.spec.ts` was stale since the billing strip (`ebf9295`) — expected an install/wallet step the component no longer had; rewritten and enrolled in the browser gate.
- Pre-existing, NOT fixed here (different workstreams): `release-helpers.completeOnboardingOverlay` still expects the removed install step (breaks production-user e2e helpers); `auth.e2e` `text=Capture` strict-mode failure; capture/pricing e2e need LLM env; `tests/qa-*` call the stripped billing API; `release.e2e` PayPal preflight. Kernel lint errors (7) pre-exist on main.
- Worktree checkouts need `.env` copied manually (untracked) or module-init env guards throw; hermetic specs are unaffected.

**Next:** nucleus `/` surface — route auth redirect flip to `/`, identity-in-chatbox; then Phase 2 owlery internalization.

---
## 2026-09-08 — THE NUCLEUS: one white screen, one chatbox

**Shipped** (`9829262` nucleus + `693a5a6` hermetic-env fix + auth dev-links `ea8f5e4`)
- **`/` is now the nucleus**: white screen, one chatbox (text + Qwen ASR mic via existing `/api/capture/transcribe`), streaming replies via `/api/chat`. No nav, no module concepts, no eigenmesh landing (deleted). `(nucleus)` route group pins light palette; console routes still exist as unlinked internal tooling (deletion policy: later, deliberate).
- **Journey seed** in the orchestrator persona: founding requests open the brand journey — tone of voice first, one question at a time. Wired through `AGENT_SYSTEM_PROMPT` (critical fix: `/api/chat` runs the legacy agent-loop, which never saw the persona).
- **Auth links print to terminal in dev** (`ea8f5e4`) — no local mail server needed.
- **Env truths reconciled**: user `.env` had a duplicate placeholder OWLERY block; Vite dotenv (last-wins) saw it as configured, CLI loader (first-wins) as unconfigured — the login lockout + 2 flaky specs traced to this. `.env` cleaned; specs now mock `$env/dynamic/private` hermetically (`693a5a6`).
- **Main: 1112 tests green, check at 0 errors.**

**Decisions**
- The surface hides the console; nothing is deleted without a decision. Brand-token re-skin happens via the brand kernel phase — visual identity stays green for now.
- ASR transcript fills the input (user reviews before send), not auto-send.

**Tracked (honest list)**
- `/api/chat` still runs the legacy agent-loop, not the kernel AgentRuntime — unify so the chatbox speaks through the harness proper.
- Post-auth redirect still lands on `/capture` (e2e helpers cascade) — flip login/signup → `/` in a dedicated stream.
- Identity-in-chatbox (no boring /login page) — journey design later.

---
## 2026-09-08 — Dev instance live on :5433; test DB rebuilt from scratch (1206/1206)

**Shipped**
- Compose: containers renamed `eigen-enterprise-*`; EE db on **host 5433** (legacy eigen stack keeps 5432) — `.env.example` updated.
- Fresh-boot infra fix inherited from eigen: `01-extensions.sh` sets `search_path` before `::agtype` index casts (first boot on a clean volume previously failed all four graph indexes).
- `eigen-enterprise-db` running + healthy; `eigen_test` created with the FULL init chain (vector+age+graph+labels+indexes, `eigen_app` role + grants, pg_cron/pg_net), 75 migrations applied, **RLS applied (`db:rls`) — the missing piece behind the "pre-existing" integration failures: RLS policies are not part of migrations**.
- Verification: **1206/1206** (kernel/modules/cli/mcp/db/activity/routes) on the new instance, including the tenant-secrets RLS integration specs.

**Decisions**
- Test DBs must bootstrap with `db:migrate` + `db:rls` (migrations alone ≠ RLS). Follow-up candidate: `db:test-up` script automating create+init+migrate+rls.
- Old eigen-db (5432) untouched; its eigen_test is obsolete.

**Smoke test fully unblocked:** `.env` → `DATABASE_URL=...localhost:5433/eigen`; `db:up` → `db:migrate` → `db:rls` → `dev`; activations + allowlist SQL per bootstrap.ts docs.

**Next:** Phase 2 — owlery internalization (EmailProvider port), then sales (Phase 3).

---

## 2026-09-08 — Startup wired + company feed live (smoke-test ready)

**Shipped** (wt/startup `4951da0`, wt/activity `2fafd7d`, MCP-spec fix `4b6ef81`)
- **`src/lib/server/boot.ts`** — the composition root: `bootApp()` memoized single-flight (failed boots do NOT cache — retry recomposes fresh); kernel → bootstrapOrchestrator(kernel, wireGateway, { engines: [['pi', piEngine]] }) → bootstrapChatGateway stage; env injectable. `src/hooks.server.ts` triggers it additive + loud-fail.
- **Company feed** — `/activity` now renders `kernel_events` (agent.*, tool.executed, gateway.telegram.*, dev-agent.*) via `listKernelEvents` read-model + `toFeedItem` whitelist (metadata only; content fields proven excluded by tests). Full emitted-type inventory grepped + pinned.
- **Stale HTTP-MCP spec fixed** — broadened verification scope to `src/routes` exposed a seed-era spec asserting the pre-kernel contract (unprefixed tool name, no activation). Now: fixture kernel (memory activated, real descriptors, mocked impls), namespaced `memory.retrieve_thoughts`. 655/655 in src/routes.
- **Main state: kernel+modules+cli 446, mcp 56, routes 655, boot/activity included — check at 5-error baseline.**

**Flags**
- 6 pre-existing eigen_test integration failures (tenant-secrets, ontology-db, retrieval, thought-lifecycle) — test-DB schema drift; `npm run db:migrate` against eigen_test before smoke test.
- Feed open items: `textLength` whitelist field, `website.contact.captured` inclusion, load-more cursor — later touches.

**SMOKE TEST (user runs)**
1. `npm run db:up && npm run db:migrate`
2. `.env`: TELEGRAM_BOT_TOKEN, LLM gateway creds
3. SQL: activate `chat-gateway` + `memory` (+`email`); allowlist Telegram user → principal; seed `orchestrator` principal row
4. `npm run dev` → message the bot → orchestrator responds via builtin-json engine; /activity shows the events
5. hermes: point MCP at `/api/mcp` (session user) or Bearer key (agent principal)

**Next:** Phase 2 — owlery engine internalization (EmailProvider port first), then sales (Phase 3).

---

---

## 2026-09-08 — THE HARNESS IS IN (AgentRuntime + LoopEngine + PiEngine)

**Shipped** (`034c1f1` harness + `a6996af` pi-engine + orchestrator integration, merged to `main`)
- **Kernel primitives**: `kernel/agent.ts` (AgentConfig/AgentTypeSpec), `kernel/engine.ts` (EngineContext + LoopEngine — the harness hands engines tools/approvals/events/spend; engines own model/prompts/strategy), `kernel/agent-runtime.ts` (dispatch pipeline: unknown_agent → agent_disabled → unknown_engine → budget → dispatched → run → replied; payloads metadata-only), `kernel/tool-surface.ts` (shared fail-closed filter: activation ∩ scope ∩ roles), `kernel/agent-admin.ts` (`agent.list/enable/disable`, owner-gated), `kernel/pi-engine.ts` (headless pi as a hosted engine; canonical PI_GUARDRAILS; spawn seam injected).
- **Demotions done**: orchestrator brain → thin adapter over AgentRuntime; orchestrator = seeded AgentConfig (`builtin-json` engine, `EE_HARNESS_SPEND_CAP_USD`, malformed = boot fails loud); dev-agent runner delegates spawning to PiEngine.
- **Manifest extension (additive)**: `agents?: AgentTypeSpec[]`, `verification?: VerificationPolicySpec[]` — third parties can ship agents, not just tools.
- **Integration (orchestrator, on main)**: resolved harness × gateway-extraction conflicts (brain.ts adapter keeps `$lib/kernel/gateway` port; bootstrap keeps composition-root shape `bootstrapOrchestrator(kernel, wireGateway, options)` + runtime seeding; bootstrap.spec reconciled to three-arg convention); unified pi-engine's structural EngineContext mirror into the canonical type; added `options.engines` injection seam so the composition root hosts `pi` without module-to-module imports (boundary guard stays green). New test proves engine injection via dispatch.
- **Main: 446 (kernel+modules+cli) + 56 (mcp) = 502 tests green; `npm run check` at 5-error baseline.**

**Decisions**
- Adding an agent = one AgentConfig + zero new code; it inherits permissions/approvals/events/spend/verification. The orchestrator holds no code privilege — deleting/replacing it touches no kernel code.
- Spend cap: single cap on the harness agent itself (`EE_HARNESS_SPEND_CAP_USD`); no granular per-agent limits (user decision).
- Sessions in engines: in-memory Maps (documented debt); gateway-cost accumulation wiring = follow-up (spend currently via `recordSpend`).
- Merge-conflict lesson recorded: parallel sessions on `main` + long-lived worktrees = textual conflicts on shared files; integration unification is orchestrator work.

**Next**
- Startup call site that composes kernel → orchestrator → gateway (pending since gateway extraction) — then the live Telegram smoke test.
- Apply `agent.*` events on the wire (activity feed UI); persisted sessions; gateway-cost spend accumulation into the runtime.
- Then per roadmap: owlery internalization (Phase 2), sales (Phase 3), brand kernel.

---

## 2026-09-08 — Gateway contract moved into the kernel (declared edges now zero)

**Shipped** (`56d8c80`, merged to `main`)
- New `src/lib/kernel/gateway.ts`: the chat-gateway port lives in the kernel now. It holds `TelegramSessionRef`, `Brain`, `AllowlistEntry`, `AllowlistStore`, `GatewaySession`, `SessionStore`, plus the `CHAT_GATEWAY_MODULE_ID` and `CHAT_GATEWAY_ALLOWLIST_TOOLS` constants. chat-gateway imports them from the kernel; every local copy is gone, no re-export shims inside modules.
- New `src/lib/kernel/wiring.ts`: `WiredKernel` and `registerModuleTools()` moved here from modules/index.ts. The composition root still assembles the kernel, but the wiring types belong to the kernel.
- `modules/index.ts` gained the gateway boot stage: `bootstrapChatGateway(kernel, brain, { env, db? })` returns the boot object, or null when the module is inactive. The fail-loud token rule is unchanged: an active gateway without `TELEGRAM_BOT_TOKEN` still aborts startup. `bootstrapOrchestrator(kernel, wireGateway, options?)` now takes the kernel as a parameter and hands the brain to the injected gateway stage. It has no caller yet (startup wiring is still pending the user's live smoke test), so the signature change breaks nothing.
- `DECLARED_WIRING_EDGES` is an empty Map, pinned by test. The repo scan passes with zero exceptions: no module imports another module or the composition root.
- Verification: 327 passed / 1 skipped (kernel + modules), `npm run check` at the 5-error baseline, lint clean on touched files.

**Decisions**
- The kernel owns the port (the `Brain` type the gateway consumes), while phase 1b decides who implements it (BuiltinJsonLoop). The two streams stack cleanly.
- modules/index.ts re-exports `WiredKernel`/`registerModuleTools` because src/cli, mcp/server, and admin-bootstrap import them from there and sat outside this stream's scope. Re-pointing those imports is a small chore, not urgent.

**Next:** phase 1b harness streams (wt/harness, wt/pi-engine); startup call site that composes kernel → orchestrator → gateway; then the HTTP tool route.

---

## 2026-09-08 — wt/harness: AgentRuntime + LoopEngine kernel primitive (orchestrator demoted to config)

**Shipped** (branch `wt/harness`, phase-1b)
- `kernel/agent.ts` — AgentConfig (id === principal id), AgentTypeSpec, VerificationPolicySpec, AgentSessionRef, LoopEngineId.
- `kernel/engine.ts` — `EngineContext` { agent, principal, executeTool, listTools, emit, spendUsd } + `LoopEngine` (type alias for lint; structural). Tool list is precomputed per dispatch → `listTools()` sync.
- `kernel/tool-surface.ts` — THE shared filter (activation ∩ role intersection ∩ agent module scope, fail closed); runtime + orchestrator both resolve surfaces through it. MCP listing untouched (activation-only subset).
- `kernel/agent-runtime.ts` — dispatch pipeline: unknown_agent → agent_disabled → unknown_engine → budget check (emit `agent.budget_exceeded` + throw before any run) → emit `agent.dispatched` → engine.run → emit `agent.replied` {replyLength} (payloads metadata-only, never content). `stop()` = disable + `agent.stopped` (v0; in-flight cancellation is engine-dependent, documented). `recordSpend()` + injected `spendFn` + injected `rolesFor` (AgentConfig carries no roles; default `['agent']`).
- `kernel/engines/builtin-json.ts` — brain loop extracted verbatim (think-strip, fence-strip, brace-balance, parse-retry ×3 default, approval_pending UX, history cap 40, 8 iterations, 12k tool-result chars). Kernel-local `EngineChatMessage`/`LlmCompleteFn` (no kernel→server import); `llmUserId` defaults to `ctx.agent.id`.
- `modules/orchestrator/brain.ts` — thin adapter (identity data + `respond` → `runtime.dispatch`, `offeredTools` → `runtime.listAgentTools`); `bootstrap.ts` seeds the runtime (`orchestrator` config, `builtin-json` engine, `EE_HARNESS_SPEND_CAP_USD` → spendCapUsd, malformed = boot fails loud) — **flagged modules/** edit.
- `kernel/agent-admin.ts` (new) — module `agent`: `agent.list` (read, admin+agent), `agent.enable`/`agent.disable` (mutate, owner-only), self-seeded active from orchestrator bootstrap.
- Manifest extension (additive): `ModuleManifest.agents?: AgentTypeSpec[]`, `.verification?: VerificationPolicySpec[]` + zod schema; v0 declarative only, nothing enforces.
- `kernel/errors.ts` — 6 new loud codes: unknown_agent(404), agent_disabled(409), duplicate_agent(409), unknown_engine(500), duplicate_engine(409), budget_exceeded(402).

**Verification:** kernel+modules+cli 424 passed / 1 skipped (baseline 383; brain.spec 14 tests moved to `engines/builtin-json.spec.ts`, ~27 net new); mcp+modules w/ test DB 252 green; check = exactly 5 baseline errors; lint: 0 errors in harness files (7 pre-existing elsewhere).

**Decisions / flags**
- Spend wiring: gateway-cost.ts exposes parsers only — no per-principal accumulation query exists in `llm/` → default is a per-runtime in-memory accumulator via `recordSpend(agentId, usd)`; gateway-cost wiring documented follow-up (llm/** untouched).
- Sessions in engines are in-memory Maps (documented debt, same as Phase-0 brain).
- brain.spec deleted (moved) — OrchestratorBrainError → `LoopProtocolError` (LoopProtocolError is the engine's class now).

**Next:** apply events on the wire (activity feed), PiEngine (`wt/pi-engine`, no modules/index edits), persisted sessions + gateway-cost accumulation.


---

## 2026-09-08 — Kernel open-API round 2 merged (manifest schema, problem+json, boundary guard, event provenance)

**Shipped** (4 worktree streams → `main` @ `d3451ec`)
- **wt/manifest-schema** (`fa3674d`): `kernel/manifest-schema.ts` — published Zod→JSON Schema contract for `ModuleManifest`, fail-loud in `ModuleRegistry.register()`. **Fix-forward** (`d3451ec`): `tools: []` is valid (toolless modules legitimate — caught by `admin-bootstrap`/`brain` fixtures exercising `registerModuleTools`; schema was over-constrained, fixtures were right).
- **wt/problem-json** (`d12dc11`): `KernelError.toProblemJson()` — RFC 9457 (urn:eigenenterprise:problem:<code>, exhaustive title map = type error on missing entry, status map + 500 fallback); OpenAPI `components.schemas.problem` + problem+json on 400/401/403.
- **wt/event-source** (`6a3dd57`): `KernelEvent.source` + persistence (drizzle `0074_kernel_event_source` + journal idx 74 — **migration not yet applied**), `moduleSource()`/`KERNEL_EVENT_SOURCE` urns, `toCloudEvent` resolution `event.source ?? source` (throw if neither), all 7 emit sites wired (registry audit per-module, dev-agent ×4, website ×1, chat-gateway ×2).
- **wt/boundaries** (`45e5306` + `33b33d5`): `kernel/boundaries.ts` import-specifier detector (resolves relative specifiers, catches dynamic + export-from + bare forms) + repo-scan test. **The guard earned its keep on day one: 11 real `orchestrator→chat-gateway/index` edges found** (orchestrator = boot stage wiring the gateway surface) — codified as `DECLARED_WIRING_EDGES` pinned by test, not silently ignored.
- Verification on main: 370 passed / 1 skipped, only `mcp/registry.spec.ts` fails (`DATABASE_URL` — user-started DB, known); check = 5 baseline errors; lint clean.

**Broke / flags**
- Manifest validation broke 2 fixture files with fake `tools: []` manifests → root cause was the schema rule, not the fixtures; fixed schema, reverted fixture edits.
- Orchestrator still structurally coupled to chat-gateway internals (types, stores) — declared, tracked.

**Decisions**
- Toolless manifests are valid; tool-name pattern allows snake_case (all 20+ real tools use it) — published contract documents reality.
- Cross-module wiring edges are *declared policy* with reasons, zero by default; contract extraction (gateway types → kernel) is the follow-up that shrinks the set.
- problem+json 404/409 surfacing deferred until the HTTP tool route exists.

**Next:** extract chat-gateway contract to kernel (kill declared edges); apply migration 0074 (`npm run db:migrate`, user-started DB); HTTP tool route mounting registry with bearer → principal mapping.

---

## 2026-09-08 — Kernel open-API standards round merged (output schemas + CloudEvents)

**Shipped** (`49ae71c` + `1585d9b`, merged to `main` @ `575ea06`)
- `plan/kernel-open-api.md` — approved standard stack: JSON Schema 2020-12 contracts (one Zod source → MCP + OpenAPI), registry-`execute()`-only inter-module calls (zero side doors), CloudEvents 1.0 event envelope, OpenAPI 3.1 edge; A2A watched, not adopted. Rejected: gRPC, direct imports, bespoke wire protocol.
- **wt/output-schema** (`49ae71c`): `ToolDescriptor.outputSchema?: ZodType`; `execute()` validates handler results pre-audit (`invalid_output`, audited `ok:false`, vcs commit skipped); MCP `tools/list` + OpenAPI 200 responses advertise compiled output schema (`io: 'output'`); parity test covers output round-trip. `errors.ts`: `invalid_output` added (coexists with `run_in_progress` from the dev-agent stream).
- **wt/cloud-events** (`1585d9b`): `kernel/cloudevents.ts` — CloudEvents 1.0 `CloudEvent` type, `toCloudEvent(event, source)` mapper (source explicit per call site — no implicit defaults), `eventType()` reverse-DNS convention `com.eigenenterprise.<module>.<name>`. Envelope derived at boundaries — **no kernel_events migration** (open-api plan rule 4).
- Verification on main: 325 passed / 1 skipped (kernel + mcp + modules); only failure = `mcp/registry.spec.ts` `DATABASE_URL` missing (known — user starts dev DB). `npm run check` = 5 documented baseline errors; lint clean.

**Broke / flags**
- `main` advanced mid-stream (`40a3654` dev-agent/website/cli) — both branches merged main first, then landed; `errors.ts` union auto-merged (both new codes coexist). Worktree `node_modules` symlinked from main checkout this round — fast, worked clean.

**Decisions**
- Output validation lives inside the handler `try` (reuses existing audit-`ok:false`-rethrow path; no duplicated audit logic).
- CloudEvents adapter only this round — wiring explicit `source` into all emit sites is a follow-up on main.

**Next (from `plan/kernel-open-api.md` §Later):** manifest JSON Schema at registration, problem+json error shape, cross-module import guard, emit-site `source` wiring.

---

## 2026-09-07 — dev-agent shipped: the repo can now improve itself (gated)

**Shipped**
- **Security chore** (`8f55e76`): redacted hardcoded production Bearer token inherited from eigen in `.pi/extensions/eigen-mcp.ts` → env-based (`EE_MCP_URL`/`EE_MCP_TOKEN`, no fallback). Token remains in seed git history — repo never pushed; rewrite optional.
- **wt/devagent** (`c513370`): `modules/dev-agent` — pi-driven self-improvement. Tools: `dispatch` (external, owner+agent), `status`, `logs` (read), `merge` (mutate, **owner-only**), `abort`. Lifecycle: dispatched → running (pi headless `pi -p --mode json` in sandbox worktree `../ee-da-<id>`, single-flight) → verification gate (vitest + check in worktree) → green|red → merged|aborted. Runs persisted (`kernel_devagent_runs`, idx 73). All seams injected (PiRunner/CommandRunner) — zero real pi/git in tests. `.pi/skills/dev-agent-protocol/` documents the contract. Kernel: `run_in_progress` added to error union (orchestrator).
- **Main: 378/378 tests, `npm run check` at baseline.**

**Decisions**
- `dev-agent.dispatch` NOT approval-gated: the owner-gated merge is the control point; dispatch is audited, single-flight, 15-min capped. Policy can add it later.
- pi binary: `PI_BIN` override, default `'pi'` on PATH (binary-name default, not an env fallback).
- pi output persists truncated (4000) in `result_summary`; never logged at info.
- Local test DB: `postgres://eigen:eigen@localhost:5432/eigen_test` (created + migrated 0000→0073 during this stream); bootstrap script still owed.

**The recursive loop (how to use)**
1. `ee tool run dev-agent.dispatch --input '{"task":"…"}' --principal <owner-id>` (or via Telegram/orchestrator delegation, or MCP from hermes)
2. pi works in a sandbox worktree; kernel verifies tests+types
3. `ee approvals`-style review → `ee tool run dev-agent.merge --input '{"run_id":"…"}' --principal <owner-id>`
4. Merged changes become the new baseline — including changes to the agent itself.

**Next**
- First real dogfood: dispatch a small improvement task end-to-end (needs dev DB running + pi configured).
- Phase 2: owlery engine internalization; Phase 3: sales; brand kernel (plan/phase-1-baseline.md follow-ups).

---

## 2026-09-07 — CLI + Website merged (Phase 1 baseline)

**Shipped**
- **wt/cli** (`aeaf04b`): `src/cli/` — `ee` CLI as **thin dispatcher over kernel registry tools** (no special powers, no MCP hop). Commands: `status`, `tool list/run`, `module list/activate/deactivate`, `approvals list/decide`, `openapi`. New kernel admin tools (`kernel.module_*`, `kernel.approvals_*`) registered via new `admin-bootstrap.ts` ('kernel' module self-active by design). Principal: `--principal`/`EE_CLI_PRINCIPAL_ID`, fail loud. Exit codes: 0/1/3 (approval_required). Runner: tsx (already in devDeps), `npm run ee`.
- **wt/website** (`d15db04`): `modules/website` — content objects (`website_content`: slug/kind page|doc/visibility), tools `create/update/publish/get/list_page`, public rendering at `/s/[slug]` (private→404), contact capture `POST /api/website/contact` → `website_contact` + `kernel_events('website.contact.captured')` (ids only, no content). Markdown via marked+DOMPurify (chat's citation-rewriting deliberately not reused). Tables idx 72. `modules/index.ts` additive registration.
- **Main: 335/335 tests green, `npm run check` at baseline.**

**Decisions**
- CLI decision REVERSED (user): agents need an in-process execution surface; MCP stays external-facing (hermes/opencode), CLI is the company-agent's native hands. Recorded in `plan/phase-1-baseline.md`.
- Baseline company = website + agent (orchestrator), extensible via module contract.
- 'kernel' admin module self-active: can't gate on the store it administers.
- `/s/[slug]` fully anonymous = correct (it's the public web).

**Flags / debt**
- No `bin` entry yet (script suffices; add when packaging). No seeded-DB `ee status` smoke script yet.
- No rate limit on contact endpoint; no contact-listing surface (sales phase); `website.contact.captured` has no consumer yet.
- `modules/index.spec.ts` exact-manifest assertions grow with each module (by design).

**Next**
- Agent self-improvement loop: `pi` agent on this repo (user request) — messages → code changes → kernel-verified (tests/check) → git-committed. Design first: agent principals can already execute every tool; the missing piece is *code execution + repo access* governance (which tools mutate the repo, review gates).
- Then: owlery internalization (Phase 2), sales (Phase 3), brand kernel.

---

## 2026-09-07 — **PHASE 0 CODE-COMPLETE** (orchestrator merged)

**Shipped** (`ab7e84f`, merged to main)
- `modules/orchestrator/`: **brain** (orchestrator persona = agent principal `orchestrator`/roles admin+agent; mirrors agent-loop's JSON tool protocol but executes via `kernelRegistry.execute`; tool surface = registry ∩ activated modules ∩ role-intersection — fail closed; all LLM via `llmChatCompletion` gateway), **loop** (sequential 25s long-poll, 1s→30s backoff, abortable; job-queue deliberately not used — blocking poll ≠ cron), **allowlist admin tools** (`chat-gateway.allowlist_add/remove/list`, owner-only), **bootstrap** (fails loud only when chat-gateway activated but token missing; SQL upsert documented for activations + orchestrator principal row).
- Approval-pending UX: `approval_required` → structured `{"status":"approval_pending"}` tool result instructing the model to tell the user it's pending — the model cannot claim execution.
- **Main state: 212/212 tests green (24 files), `npm run check` = 5 documented baseline errors, lint = baseline.**

**Decisions (orchestrator)**
- App must boot `bootstrapOrchestrator()` at startup (first-call-wins singleton ordering).
- Parse-failure after retries: fail loud → Telegram redelivery (at-least-once). No apology-degradation.
- Orchestrator memory ownership: principal row seeded at bootstrap; ownership refinement deferred to memory-scoping work (Phase 4).

**Phase 0 exit criteria — status**
| Criterion | Status |
|---|---|
| One registry → MCP + OpenAPI | ✅ parity-tested |
| Principals incl. agents, permissions, approvals | ✅ tested |
| Append-only events, activation gating, git auto-commit | ✅ tested |
| Modules: memory, email, chat-gateway manifested | ✅ |
| Orchestrator answers via Telegram | ✅ code-complete — **live smoke test pending user** (needs: `npm run db:up` + `db:migrate`, `TELEGRAM_BOT_TOKEN`, activate `chat-gateway` + `memory`/`email`, allowlist owner's Telegram ID) |

**Known debt (tracked)**
- Web push inert (SW deleted with PWA strip) — Telegram is the channel for now
- `billingMode` column + wallet tables still in DB schema; eigen-green theme; "Eigen Mesh" i18n strings; PWA deps in package.json
- `modules/**` outside svelte-kit tsconfig include; kernel lint chores (interface→type, caught-error rule)

**Next: Phase 1 — Website module** (content objects, brand kernel, public rendering, contact capture) per `plan/phase-0-kernel.md` §Later phases.

---

## 2026-09-07 — Round 2 merged: wire + chat-gateway

**Shipped**
- **wt/wire** (`1c46348`): DB-backed kernel stores (`kernel/db-stores.ts` → kernel_principals/events/module_activations/approvals), module activation gating in `registry.execute` (fail closed when ActivationStore injected), `modules/memory` (7 tools wrapping existing MCP memory impls) + `modules/email` (send_mail=external, add_contact=mutate, list_contacts=read via thin owlery runners), MCP server (`tools/list`+`call`) now renders from the kernel registry, OpenAPI 3.1 generator (`kernel/openapi.ts`), parity test (MCP ↔ OpenAPI ↔ registry).
- **wt/gateway** (`fb9de70`): `modules/chat-gateway` — Telegram long-polling client (DI'd fetch), allowlist→principal resolution (fail closed, denied events carry no content), session upsert, paragraph-aware chunking (4k), `chatGatewayEnv` fails loud without `TELEGRAM_BOT_TOKEN`; tables `kernel_gateway_allowlist`/`kernel_gateway_sessions` (migration idx 71). Brain interface injected — orchestrator loop comes next.
- **Orchestrator on main**: widened approval gate to all non-read tools (`registry.ts`; vcs commit stays mutate-only). `email.send_mail` now halts as `approval_required` — wire's placeholder test updated to assert the decided semantics. Repaired NUL-corrupted `chat-gateway/stores.ts` (subagent write artifact; content intact, git had classified it binary).
- Verification: **178/178** tests green (kernel 58, mcp+modules 120); `npm run check` = 5 documented baseline errors only.

**Broke / flags**
- Root `vitest.config.ts` now includes `modules/**`; colocated `modules/chat-gateway/vitest.config.ts` kept as scoped runner (redundant but harmless).
- `modules/**` sits outside svelte-kit tsconfig include — typechecked transitively; consider tsconfig addition later.
- Pre-existing lint errors in `src/lib/kernel` files (interface→type, caught-error rule) — chore pending.
- DB-dependent suites need `DATABASE_URL` (dev DB not started this session — user starts it).

**Decisions**
- Approval gate: `auditClass !== 'read'` (external actions leave the company — approvals apply). VCS commit: `mutate` only (repo-state changes only).
- MCP principal mapping (Phase-0 parity): session user → human/admin; Bearer key → agent/admin+agent. Real PrincipalStore wiring into auth = next stream.
- Poll-loop ownership + offset persistence + allowlist bootstrap UX + orchestrator persona wiring = next workstream.

**Next**
- `wt/orchestrator`: seed orchestrator persona (agent principal), `Brain.respond` → kernel registry tools via existing agent-loop + LLM gateway; poll loop on job-queue tick; allowlist bootstrap tool; PrincipalStore→auth wiring.

---

## 2026-09-07 — Branding guideline module ruleset (plan only, no code)

**Shipped**
- `plan/branding-module-rules.md` — 25 normative rules (G1–G25) for the future brand-kernel module, derived from NN/g's "Using AI for UX Work" study guide + 32 linked articles (full-text analysis via 4 parallel research subagents; podcasts/videos excluded). Includes kernel-architecture mapping, data-model sketch, validation pipeline, anti-pattern catalog, acceptance criteria, open questions.

**Decisions**
- Voice stored exemplar-first (good/bad pairs as primary representation; single tone adjectives rejected at schema level) — evidence: tone adjectives alone exaggerate.
- Validation = deterministic rule engine (pass/fail in code) + calibrated LLM judge (F1 ≥ 0.8 vs. human annotations before autonomous blocking); layers never blended — Baymard principle.
- Risk-tiered publish gates: heritage/standard content requires human approval; only low-stakes internal drafts may auto-pass. AI drafts, never publishes.
- Guideline sets are versioned; outputs pin the version validated against — no implicit "latest" resolution (no-fallbacks guardrail).
- Synthetic audience feedback is hypothesis-grade: labeled, never satisfies a publish gate.
- Module precedes implementation — feeds phase-0 "Later phases 1: brand kernel".

**Next**
- Grill the open questions in §8 (visual pipeline, judge-model isolation, locales, disclosure UX) before any implementation planning.

---

## 2026-09-07 — Kernel skeleton + product strip merged to main

**Shipped**
- **Strip** (`ebf9295`, merged): removed billing/wallet/PayPal (−10.6k lines, 143 files), PWA/service-worker, product branding (DESIGN.md, assets.af, eigenmesh csv). Relocations: `billing/context.ts`→`db/tenant-context.ts`, `billing/platform-llm.ts`→`llm/`, `billing/preferences.ts`→`llm/`, `byok-ui.ts`→`settings/`. Kept: `llm/gateway-cost`, owlery client, messages/, evals/, docs/.
- **Kernel skeleton** (`fcddc48`, merged): `src/lib/kernel/` — registry (single execute path: permission→approval→zod-validate→handler→audit→vcs-commit), principals, events (append-only contract), modules (fail-closed activation), vcs (GitCommitter, `EE_VCS_AUTOCOMMIT=0` opt-out), approvals (latest-decision-wins gate). Tables: `kernel_principals`, `kernel_events`, `kernel_module_activations`, `kernel_approvals` + drizzle journal idx 70.
- Integration on main verified: kernel tests 30/30 green; `npm run check` 5 errors = documented eigen baseline (vapid ×3, posthog public env ×2); full vitest needs dev DB running (user starts it).

**Broke / flags**
- Service-worker was ALSO the web-push + capture-queue worker — web push is inert until it gets a new home. Accepted for v0 (Telegram is the push channel).
- `billingMode` DB column + wallet tables still in schema (migrations out of strip scope). Cosmetic leftovers: eigen-green theme, "Eigen Mesh" i18n strings, PWA deps in package.json.

**Decisions**
- Approval gate design: registry consults `ApprovalStore.latestFor(tool, principal)` — approved→proceed, pending→`approval_required` (no dup requests), none→create request + throw. Denied → new request.
- Registry collaborators are constructor-injected (EventSink/ApprovalPolicy/ApprovalStore/VcsCommitter); DB-backed stores land next.
- Worktree flow proved: `wt/strip` (mutating) and `wt/kernel` (additive) ran in parallel, merged clean.

**Next workstreams**
- `wt/wire`: DB-backed kernel stores + module manifests (memory, email) + MCP server rendered from kernel registry + OpenAPI generator + parity test
- `wt/gateway`: `modules/chat-gateway/` — Telegram long-polling, session mapping, allowlist (→ principals), chunking; migration idx 71

---

## 2026-09-07 — Phase 0 kickoff

**Shipped**
- `plan/phase-0-kernel.md` — approved architecture (grilled across 5 rounds)
- Repo seeded from eigen (`c4642f1` — tree unmodified: rsync w/o `.git`, `node_modules`, artifacts, `.env`)
- `AGENTS.md` — orchestrator model + guardrails written

**In progress**
- Strip: `billing/` (keep `llm/gateway-cost`), eigenmesh branding, PWA/service-worker, product deploy specifics
- Kernel skeleton: registry, principals, events, modules, vcs

**Workstreams** (worktrees off `main`)
- `wt/strip` — product-strip + import fixes
- `wt/kernel` — `src/lib/kernel/` + `modules/` skeleton (new files only; merges clean)

**Decisions**
- Orchestrator model adopted (AGENTS.md): subagents + worktrees, progress in `plan/`
- CLI dropped from Phase 0; OpenAPI generation stays
- Telegram gateway = company general assistant ("the orchestrator"), allowlist auth
- Strip table (billing out, PWA out, memory/MCP/job-queue/owlery-client in) — see phase-0 plan

**Next**
- Strip merged → tests green → kernel skeleton → pilot modules → orchestrator via Telegram

---

## 2026-09-07 — Phase-2e: onboarding redesigned as the boot sequence

**Shipped**
- Owner verdict on the phase-1e wizard: dead surfaces, jargon, module tourism — scrapped.
  New rule is permanent: `.pi/skills/tangible-purpose-ui/SKILL.md` (never show anything
  without real, tangible purpose; modules invisible at first run; agent chat is the only UI).
- Boot sequence (`welcome-wizard.svelte` rewrite): orb bloom + breathe (pure CSS, monochrome,
  `prefers-reduced-motion` respected) → "Hello." → name ask (only when unknown) → identity
  lines in outcome language → mind act (only when no provider; embedded provider wizard,
  real choices) → handoff into the chat. No step counter, no capability list, no
  "Your AI is connected" screen, no founding-interview step, no module destination buttons.
  "Skip for now" = muted corner link, same never-nag semantics.
- Sound: `src/lib/sound/boot-sound.ts` — Web Audio synth (no assets/deps), ON by default
  (owner decision), gesture-unlocked AudioContext, `ee-sound` localStorage flag, mute toggle
  in the home settings menu.
- Seeded first agent turn on handoff (deterministic, no LLM): "Hello{name}. Your company's OS
  is getting set up — that happens by talking. So: what's your company called, and what does
  it do?" — honest: the setup IS the first conversation (first-conversation.md P0/P1).
- Full width: nucleus page container `max-w-2xl` removed (`w-full`, padded) — fixes both the
  narrow-strip complaint and the vertical skew (wizard was min-h-dvh inside the headered
  container; now flex-1 centered in remaining space). Provider wizard got an `embedded` prop
  to drop its own min-h-dvh/label inside the mind act.
- Server: migration `0083_user_display_name.sql` (+journal idx 83) — `user_preference.display_name`;
  `setWelcomeDisplayName()`; new `POST /api/onboarding/name` (401/400 fail-loud).
  Founding endpoint kept (owner option A) for the future branding surface; its UI step removed.
- Explicit-event contracts (no `$effect` control flow): provider wizard `onconnected`
  callback ("Enter the workspace →"), wizard `oncomplete({ name })` seeds the chat.

**Verification**
- `npm run check` 0 errors (29 warnings = documented baseline); lint 0 errors.
- Unit: 4194 passed (incl. new name API + page-load displayName tests).
- Components: 32 passed — welcome-wizard spec rewritten for the boot sequence (9 tests,
  provider wizard mocked via `provider-onboarding.stub.svelte`).
- E2E: full suite 25 passed, 2 pre-existing skips. `onboarding-welcome.e2e.ts` rewritten:
  happy path (name → mind via API → seeded chat), skip path (gate still holds,
  sign-out/in persistence), restart path (name survives, personalized greeting).
  Migration 0083 must be applied to any env before this ships (`npm run db:migrate`).

**Decisions**
- Sound default ON; tab mute + settings toggle are the levers (owner ruled).
- Full width = literal (`w-full` everywhere on nucleus); forms inside acts keep readable
  measures (max-w-md/lg) — typography, not container restriction.
- Name is identity, not tour state: `resetWelcomeOnboarding` keeps it.

---

## 2026-09-07 — Phase-2e follow-up: the voice, and the compile that actually compiles

**Owner feedback** (after driving the new boot + first conversation): wow moment landed. Two
gaps: (1) no text-to-speech when the assistant speaks; (2) the agent SAID "I will now compile
the brand narrative" and nothing ran — no process, no UI reflection.

**Root cause of (2):** removing the wizard's founding step (phase-2e) also removed the ONLY
opener of the website-founding journey — the chat was a plain orchestrator turn, so "compiling"
was an LLM promise with no execution behind it.

**Shipped**
- The handoff now OPENS the founding journey (empty) server-side:
  `openWebsiteFoundingJourney()` in founding.ts, called by POST /api/onboarding/welcome —
  onboarding still owns the start; the chat drives it. Idempotent (reuse active, reuse none
  after completion). Restart onboarding → new journey on next completion.
- Journey steps reordered to match the seeded question and natural founding order:
  company_name → positioning → tone. The brand-doc artifact moved to the tone step (final) —
  it needs all three answers; it fired early under the old order and would have written an
  empty tone.
- Discipline: new `NO EMPTY PROMISES` section — never announce future work; execute in the
  same reply with tool calls (the transcript shows each one) or say what's missing.
- The seeded first turn now asks exactly the journey's first question ("So, first: what's
  your company called?") — one question per reply, the journey drives the rest.
- The visible process the owner asked for: when the journey completes its captures, artifacts
  execute through the kernel registry mid-chat — tool preview lines ("→ using
  website.create_page · …"), status labels, the approval.required card for publishes, and the
  journey-completed kernel event. No new UI needed; the existing stream surfaces finally have
  something true to show.
- TTS (`src/lib/speech/tts.ts`): browser SpeechSynthesis, ON by default, `ee-voice` localStorage
  flag, markdown→speech normalization (code blocks/links/emphasis/bullets), cancel-on-new-turn.
  Speaks: boot acts (greeting, name ask, identity lines), the seeded greeting, every successful
  assistant reply. Voice toggle ("Voice on/off") in the home settings menu next to Sound.

**Verification**
- Unit 4203 passed (journey reorder: brain.journey.spec rewritten for the new step order and
  artifact firing order; founding + welcome route specs cover the empty-journey open).
- Components 32 passed; check 0 errors; lint 0 errors.
- E2E 25 passed — happy path now also asserts the greeting is SPOKEN (speechSynthesis stubbed
  with a recorder via addInitScript).

**Decision logged**
- Voice + sound default ON; independent toggles (settings menu). Tab mute stays the user's lever.
