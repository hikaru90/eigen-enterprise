# Phase Substrate — `ee`, the company's init system

**Status:** Draft architecture decision. Waiting for the owner on §8 (four questions) before S0 starts.
**Source:** Owner conversation, 2026-10-19:
- *"If we build this out, I want it to work for everyone, and I want the 'your company is up in 10 minutes' claim to also work with the website the way it is."*
- *"Can't it be something I curl and install onto the server? Like a Linux package that gets started up with systemd when the server boots?"*
- *"What if we don't use Docker?"*

**Supersedes:** The same-day drafts `phase-hosting.md` (a per-app module, deleted) and the Docker-based first version of this file.
**Must stay congruent with:** `company-os-architecture.md`, `the-wedge.md`, `first-conversation.md`, `claim.md`, `phase-0-kernel.md`, `kernel-open-api.md`, `phase-3-one-agent.md`, `phase-software-factory.md`.

---

## 0. Verdict

**Yes.** Deploying the CEO's app is one case of an operation the company OS already depends on in four places and has never designed:

> **A revision becomes a healthy, routed, supervised process, or nothing changes.**

The answer is to add the layer the OS metaphor is missing: an **init system**. Concretely:
- **`ee` is one binary you `curl` onto a server.** systemd starts it at boot.
- **It runs everything natively as systemd services:** Postgres, eigenEnterprise, the website, module services and the company's apps.
- **No Docker, and no container escape hatch.** Eigen provides a fixed **catalog** of runtimes, services and capabilities, and apps run only on that catalog. If an app needs something the catalog lacks, adding it is eigen's job, and every company gets it.
- **Desired state is git** (the company repo), and every deploy is a commit.

The CEO's app needs no special code. It goes through the same path the company uses for itself: at install, on every upgrade and on every module install. That path runs on every install, so it is the best-tested path in the product.

## 1. The missing layer

`company-os-architecture.md` §1 maps the OS: kernel = agent harness, processes = modules, package manager = git, filesystem = Postgres. It has **no init and no loader**. Four existing plans quietly depend on that missing piece:

| Plan | What it needs | What exists today |
|---|---|---|
| The wedge / first conversation (P0, P3, P5) | EE, Postgres and the edge from one command; a preview host; a domain with TLS | `install.sh` writes a `.env`; the Caddyfile is a static template; compose builds EE and Postgres **from source** on the box |
| "Extend it with git" / phase-3 repo hands | A merged change actually runs | `repo.merge` ends in a repo. In production there is no repo (`.git` is in `.dockerignore`), and nothing redeploys |
| Module services (company-os §4.2, §7.4 step 7) | "Worker starts the module" | Not specified. Owlery, the first real service, has nowhere to run |
| Software factory (M4) | Post-merge smoke on the deployed instance | Listed as a gap |
| CEO's app | A repo the company wants running | — |

## 2. The shape

```
curl -fsSL https://get.eigenenterprise.dev | sh
  → /usr/local/bin/ee            one binary: daemon + CLI
  → /etc/systemd/system/ee.service

 boot ─► systemd ─► ee.service ─► reconcile company repo ─► generated systemd units:

   ee-caddy.service        edge, :80/:443, ACME TLS         ┐
   ee-postgres.service     Postgres 16 + extensions         │ tier: system
   ee-os@<rev>.service     eigenEnterprise (node runtime)   ┘
   ee-owlery@<rev>.service email (an out-of-process module)   tier: module
   ee-app-kindred@<rev>    the CEO's app (node runtime)       tier: app
   ee-app-x@<rev>          an app on another catalog runtime (e.g. python, later)
```

```
 you / the agent / GitHub webhook
            │  ee deploy · ee rollback · ee status · ee logs · ee upgrade
            ▼
 ee daemon ─validate─► commit to company repo ─► reconcile ─► systemd units + Caddy config
   │  (root, no LLM, no public port, control socket only)
   └─► CloudEvents (SSE on the control socket) ─► eigenEnterprise kernel events
```

**`ee` is not in the data path.** Caddy, Postgres and every app are systemd services in their own right. If `ee` crashes or is being upgraded, nothing goes offline; only deploys pause.

## 3. Core ideas

### 3.1 `ee`: one binary, one service, one door

- **Install** writes the binary and `ee.service`, enables it, and it bootstraps the box (§5). **`ee self-update`** swaps the binary and restarts the service, which never restarts the apps.
- **The CLI is the interface** for the owner over SSH, for the agent (AGENTS.md already defines the `ee` CLI as the agent's native hands), and for webhooks:
  `ee status · ee deploy <w> [--rev] · ee rollback <w> · ee logs <w> · ee secret set <w> NAME · ee domain attach <host> · ee upgrade`
- **Commands talk to the daemon** over `/run/ee/control.sock` (OpenAPI 3.1 + problem+json, per `kernel-open-api.md`). The verbs are typed; there is no "run this command" verb.

### 3.2 Desired state is git; `ee` is its only writer

```
/var/lib/ee/company/          ← the company repo (git). "Exit = take this."
├── workloads/
│   ├── postgres.json         tier: system
│   ├── os.json               tier: system   (eigenEnterprise)
│   ├── owlery.json           tier: module
│   └── kindred-app.json      tier: app
├── routes.json               the whole edge: hosts → workloads
└── sources/                  local git mirrors of every repo the box runs
```

- **Every mutating verb does three things:** validate against the schema → commit (the author is the calling principal: owner, agent or webhook) → reconcile. An invalid desired state never enters history. Every deploy, rollback, route change and upgrade is a commit, so the audit trail, diff, revert and exit are all git. This is phase-0's choice ("audit trail, rollback, and history are the same mechanism"), made literal.
- **Reconciling is level-triggered.** Desired state (`HEAD`) is compared with what is observed (systemd unit states, the loaded Caddy config, the release directories), on every commit, at boot and on a timer. A crash at any point converges on the next pass.
- **Runtime state** (deploy history, health, the active release) lives in `ee`'s journal. It is only observed, never authoritative.

### 3.3 The catalog: the only environment

An app never brings its own environment. **Eigen provides everything an app runs on**, and the catalog is the complete list. There is no container runtime, no app-run database, no escape hatch. If an app needs something the catalog doesn't have, that's a gap in eigen, and eigen closes it for every company (D16).

| Kind | v0 | Later (each one an eigen release) |
|---|---|---|
| **Runtimes:** how app code runs | `static` (Caddy serves the files), `node` | `python`, `binary` (one compiled Go/Rust executable), `jvm` |
| **Services:** shared, one of each per box | **Postgres** (one cluster; each app gets its own database and login), **queue + events** (Postgres-backed, in the kernel; the existing job queue already uses `FOR UPDATE SKIP LOCKED`), **email**, **files** (a persistent, backed-up directory per app), **secrets**, **domains/TLS**, **schedules** | Search, object-storage API, whatever the gap loop surfaces |
| **Capabilities:** system programs an app may call | — | `chromium` (PDFs, screenshots), `ffmpeg` (audio/video), `tesseract` (OCR), a JVM for the KoSIT e-invoice validator |

**How an app uses the catalog:**
- **The app repo declares what it needs** in a small `ee.json` that travels with it: runtime and version, build command, start command, health path, required `services`, required `capabilities`. It is **declared, never detected**: no framework sniffing, per the no-heuristics guardrail. A repo without the contract gets one proposed by the agent as a PR.
- **The company repo says where, which revision and with what:** routes, secrets, resources, `rev`, auto-deploy.
- **Where code comes from** is a second, independent axis. A **release** is a versioned, checksum-verified tarball: eigenEnterprise, Owlery, third-party modules. A **git** source is a local mirror at a commit: sites, the CEO's app.
- **Runtimes and capabilities are pinned.** `ee` installs exact versions (official builds, checksums verified) under `/opt/ee/runtimes/` and `/opt/ee/capabilities/`, along with the system libraries they need. Each release gets exactly what it declared, mounted read-only into its sandbox and exposed through an environment variable (e.g. `EE_CAP_CHROMIUM`).
- **Using the services:**
  - **Postgres:** the app connects directly with its own login, over a unix socket, so ORMs like Prisma and Drizzle work unchanged. Other apps' databases are unreachable.
  - **Queue, events and email:** these go through the kernel. Each app is a `service` principal (that principal kind already exists in `principals.ts`) with its own API key, and it calls the kernel's services API over a unix socket. Its use of shared services therefore takes the same permission → approval → audit → event path as every other action.
  - One SDK for Node; other runtimes speak the same OpenAPI.
- **Data lives only in eigen's services.** No app runs its own datastore, and that includes embedded ones such as SQLite files. Backups, exports and the agent therefore see all of the company's data.
- **A gap fails loudly.** If `ee.json` declares something the catalog doesn't have, the deploy fails with `catalog_gap` naming the missing entry, and the gap lands on the Extension Roadmap (the `roadmap` module) as planned eigen work.

**Worked examples:**

| App | Catalog entries it needs | Status |
|---|---|---|
| The CEO's Claude Code app (e.g. Next.js + Prisma), client portal, booking page | `node`, Postgres, maybe queue | Fits v0 |
| Telegram/Slack bot, webhook handler, follow-up emails | `node`, queue, email | Fits v0 |
| Umami analytics (existing open source: Node + Postgres) | `node`, Postgres | Fits v0 |
| PDF invoices, screenshots | + `chromium` | Gap → capability |
| Podcast/video clips · receipt OCR | + `ffmpeg` · + `tesseract` | Gap → capability |
| E-Rechnung validation (KoSIT validator, Java) | `jvm` | Gap → runtime |
| A Python analysis service · Listmonk/Forgejo (Go binary + Postgres) | `python` · `binary` | Gap → runtime |
| WordPress (PHP + MySQL), Plausible (+ ClickHouse), Elasticsearch | Their own database engines | **Doesn't run on eigen** unless eigen chooses to provide that service for everyone |

### 3.4 Releases, health gates, rollback

- **Each release is its own directory:** `/var/lib/ee/workloads/<name>/releases/<rev>/`, holding the build output plus its pinned runtime. Builds run as **transient sandboxed systemd units**: their own user, read-only system, write access only to the build directory, memory/CPU caps, a timeout, one at a time.
- **Blue-green for stateless workloads:** start `ee-<name>@<new-rev>` on a fresh unix socket, health-check it, load the Caddy config with the new upstream, drain and stop the old copy. Keep the last 3 releases.
- **A failing health check never replaces a healthy release.** The old copy stays live, and the failure becomes a loud event with logs.
- **Rollback starts the previous release directory**: no rebuild, under a minute, recorded as a commit.
- **Stateful singletons (Postgres)** are restarted in place, with downtime and a snapshot first. A Postgres major upgrade is a separate procedure run by the owner (Debian's `pg_upgradecluster` tooling helps here; this is one place where native beats containers).

### 3.5 The security boundary: the schema plus generated units

`ee` runs as root, like any init. Everything it starts is generated from a template with **mandatory hardening**, and the schema has no fields that could weaken it:
- Its own user (`DynamicUser=` + `StateDirectory=`); `ProtectSystem=strict`, `ProtectHome=`, `PrivateTmp=`, `PrivateDevices=`.
- `NoNewPrivileges=`, an empty `CapabilityBoundingSet=`, `SystemCallFilter=@system-service`.
- `MemoryMax=`, `CPUQuota=`.
- **No loopback access** (`IPAddressDeny=localhost`). Apps get exactly three unix sockets: the one Caddy proxies to, Postgres (as their own login), and the kernel services API (as their own `service` principal). Outbound internet stays open for APIs.
- **Only declared runtimes and capabilities are mounted.** Nothing else on the system is visible to the app.
- **Only Caddy binds 80/443.** No workload can bind a public port.
- **The control socket's group is granted only to `os`, by the install template.** No spec can grant it.

Result: a fully compromised agent can, at worst, deploy or stop company workloads (which is why approvals exist, D11). It cannot reach root, other apps' files, or Postgres as superuser. Without a Docker daemon, there is no root socket to steal.

### 3.6 eigenEnterprise is a package; nothing ever modifies core on a server

- **EE is a system-tier `node` workload** whose source is a versioned release (the built SvelteKit server, production dependencies and migrations). `ee upgrade` is a blue-green deploy of a new release, health-gated like any other. A broken upgrade leaves the old EE running.
- **Postgres and its extensions are packages:** pgvector and pg_cron from the official PostgreSQL apt repository. Apache AGE and pg_net come from there if they are packaged, and otherwise from `.deb` packages we build in CI (`Dockerfile.postgres` already compiles all four from source).
- **Modules resolve the phase-0 vs company-os §7 tension.**
  - *First-party modules* are compiled into the release and gated by activation, exactly as today (phase-0's "no runtime hot-loading" holds).
  - *Every other module* is **out of process**: a workload plus a manifest, built on the catalog like any app. The kernel registry proxies its tools over a unix socket, so permissions, approvals, audit and events still apply (zero side doors, per `kernel-open-api.md`). That makes company-os §7's "modules are git repos, installed at runtime" true without hot-loading.
- **So the core never needs to be forked on a server.** Company-specific things live in the company repo, in out-of-process modules and in EE's own data. When the agent wants to improve the core, that's a PR upstream, and every company gets it. Development continues in the source repo as today (phase-3 repo hands).

### 3.7 Secrets, the edge, the website

- **Secrets:** encrypted in `ee`'s store under a host key generated at install, referenced by name, injected only at service start. You can set values, but only names are ever read back. Install generates every system secret. The production path has no `.env` and no default passwords (`docker-compose.yaml` becomes dev-only). This answers company-os §11.3.
- **The edge:** native Caddy. `ee` renders the *complete* Caddy config from `routes.json` and loads it through Caddy's admin API, which listens on a unix socket only. Caddy validates the config before applying it; an invalid config is rejected and the old one stays. `ee domain attach` checks that DNS points at the box before a certificate is requested.
- **The website stays as it is** (content in Postgres, rendered by EE at `/s/[slug]`). `os` gets two hosts:
  - **The public host** (`<domain>`) reaches only EE's public surface: website pages, the contact endpoint and assets. This is enforced in `hooks.server.ts` and by a path allowlist in Caddy.
  - **The console host** (e.g. `os.<domain>`) serves everything else.
  - *Later, if needed:* render the site to a `static` workload, so it survives EE outages and its public attack surface is only files.

## 4. Congruence with existing plans

| Plan / decision | What it said | With the substrate |
|---|---|---|
| company-os §1 OS metaphor | No init row | **`ee` is init**, and systemd sits under it, as in a real OS |
| company-os §4.1–4.2, §12 | Ubuntu 22.04/24.04; "Docker + Compose, every service in its own container" | **Changed:** Ubuntu 24.04 LTS / Debian 13; native systemd services; no containers at all; the catalog is the only environment. *Owner's architecture doc; amend on approval (§13)* |
| company-os §5.1 "each module gets its own Postgres schema" | Isolation inside one Postgres | Same principle, applied to apps: one cluster, each app its own database and login |
| company-os §5.2, §8 Redis + BullMQ | A queue on Redis | **Changed:** the queue and events are Postgres-backed catalog services. Wedge W2 already dropped Redis, and the existing job queue already runs on Postgres |
| roadmap module (Extension Roadmap) | The company's build log and queue | Receives every `catalog_gap` as planned eigen work |
| company-os §4.3 Caddy routes | Static routes | `routes.json` is the whole edge; `ee` renders and loads it atomically |
| company-os §7 modules as git repos, runtime install; §7.4 step 7 | "Worker starts the module" | Out-of-process modules are workloads; the registry proxies their tools |
| company-os §11.3 vault; open Q9 backups, Q10 observability | Open | `ee`'s secret store; `ee` knows every state dir (backups); journald has every log |
| phase-0 "no runtime hot-loading, ever" | First-party modules compiled in | Holds: first-party modules ship in the release |
| phase-0 vcs "the instance is a git repo on the VPS" | No repo in the production image | The company repo is that repo; `ee` writes it |
| phase-3 repo hands | The agent improves its own repo | Unchanged in the source repo; on servers, core improvements become upstream PRs |
| software-factory M4 post-merge smoke | Gap | The health gate *is* the smoke; a failed-deploy event files the bug |
| kernel-open-api | Registry is the only door; CloudEvents; OpenAPI | Kernel module `substrate` wraps `ee` verbs as registry tools; `ee` emits CloudEvents; control API is OpenAPI 3.1 + problem+json |
| phase-wedge W2 / M5 | "docker compose: app + postgres + caddy" | `ee` + caddy + postgres + os, all native. **M5 becomes S2 + S3** |
| the-wedge "deploy is one command" | `curl \| sh` | Literally |
| claim "exit = take the whole repo" | — | Company repo + a Postgres dump + `ee export` |
| Guardrails | Fail loud, no heuristics, LLM via gateway | A missing secret or catalog entry fails loudly; declared contracts only; no escape hatch (no bypass paths); `ee` has no LLM |
| main app vs `company-os/` (unresolved) | — | **Doesn't block this.** Either codebase can be the `os` release |

## 5. The 10-minute claim, native

| t | Founder sees | `ee` does |
|---|---|---|
| 0:00 | `curl -fsSL https://get.eigenenterprise.dev \| sh` | Verifies and installs the binary; enables `ee.service` |
| ~0:30 | Progress lines, no spinners | apt: Postgres + extensions, Caddy; downloads the Node runtime and the EE release (checksums verified); generates secrets; seeds the company repo |
| ~2:30 | The URL | Reconciles postgres → os; TLS on the pre-DNS hostname (§8.3) |
| ~2:45 | P0 arrival: "Postgres ✓ · edge ✓ · TLS ✓", read from `ee status` | — |
| 2:45–8:45 | P1 interview, P2 render (the website as it is) | — |
| ~8:45 | P3 reveal at the preview host | A route commit; Caddy reloads in milliseconds |
| ~9:30 | P5 domain, or deferred | DNS check → route → certificate |

**No container and no build on the critical path.** Builds happen only when the company brings code.

## 6. Build vs adopt

| Option | Verdict |
|---|---|
| **Docker / Compose as the foundation** | No. A root daemon supervising beside systemd, an OS copy in every image, ports that bypass the firewall, a root socket to protect. Worse for this product: containers are exactly the escape hatch that lets an app bring its own environment. No container runtime at all (D3, D16). |
| Coolify / Dokku / CapRover / Dokploy | No. A second control plane that owns the edge and the desired state, and all of them are Docker-based |
| Kamal | No. It deploys from a dev machine, so the company can't deploy itself |
| k3s / Nomad | The right pattern (declarative reconcile), the wrong weight for one VPS |
| Nix / NixOS | Solves pinned runtimes and system dependencies natively and reproducibly, but asks every founder to adopt Nix. Possibly a future way to *build* catalog entries, never something apps use directly |
| **`ee` over systemd + native runtimes + Caddy + git** | **Chosen.** The supervisor, isolation, TLS and history are all adopted; we write only the translator from desired state into units |

## 7. Decisions of record (proposed; the owner can veto any)

- **D1** — `ee` is the host agent: one binary plus `ee.service`; daemon and CLI; the company's init. It is written in TypeScript and compiled to a single executable (company-os principle 8). The name collides with the existing registry CLI (`src/cli`); resolve that in S0.
- **D2** — systemd is the only supervisor. Every workload is a generated unit. `ee` is not in the data path.
- **D3** — Native only. No Docker daemon and no container runtime: the catalog (§3.3) is the only environment an app runs in.
- **D4** — Desired state = the company repo; `ee` is its only writer; every mutating verb does validate → commit → reconcile.
- **D5** — The security boundary is the schema plus mandatory unit hardening (§3.5), with no fields to weaken it. Apps get unix sockets only; loopback is denied.
- **D6** — Source (release | git) × a catalog runtime. The app repo declares its runtime, services and capabilities in `ee.json`; the company repo declares where and which revision. No detection.
- **D7** — eigenEnterprise and Postgres are packages. `ee upgrade` is a health-gated blue-green deploy of the system tier.
- **D8** — First-party modules are compiled into the release; all others are out-of-process workloads whose tools the registry proxies. Core is never modified on a server; core improvements go upstream.
- **D9** — `ee` holds secrets; install generates every system secret; no `.env` in production; compose is dev-only.
- **D10** — `ee` renders the whole Caddy config and loads it atomically. The public host reaches only EE's public surface; the console has its own host.
- **D11** — Approvals by tier: system-tier changes, the first deploy of any workload, and turning on auto-deploy (a standing approval) need a human (§8.1).
- **D12** — GitHub is an optional source-provider module. `ee` reads only local git mirrors. Developers can also `git push` straight to the box.
- **D13** — Single node; supported distributions per §8.2.
- **D14** — The spec and the app contract are one shared zod package (→ JSON Schema 2020-12) that both `ee` and EE import.
- **D15** — EE can safely run twice for a moment: background singletons (pg_cron jobs, job workers, Telegram long-poll, the single-active-journey rule) hold Postgres advisory locks, and migrations follow expand/contract.
- **D16 — A gap is an eigen change.** *(Owner-decided, 2026-10-19.)* The catalog is the only environment. No app may spin up its own environment, whether a container, an app-run datastore (embedded ones like SQLite files included), or a system program vendored outside the catalog. An app that needs something missing fails its deploy with `catalog_gap` naming the entry. The gap is filed on the Extension Roadmap, and closing it means adding a catalog entry in an eigen release, which every company then gets. If an app *could* bring its own environment, that would be a substrate bug to fix, never a feature.
- **D17** — Shared services, one of each per box: Postgres (one cluster; each app its own database and login), queue + events (Postgres-backed, in the kernel), email, files, secrets, edge, schedules. Apps reach kernel services as `service` principals with their own API key over a unix socket, through the registry's permission → approval → audit → event path.

## 8. Decisions that are actually yours

1. **Human-only approvals (D11).** This reverses trust-the-transcript (`a8b11c0`) for this one area. The agent reads text attackers can influence (build logs, repo files, issues, webhooks), and a prompt injection must not be able to approve a system-tier change. *Recommendation:* yes.
2. **Supported servers:** Ubuntu 24.04 LTS and Debian 13 only. Narrow support is what keeps native packaging manageable; it is the price of not having Docker. *Recommendation:* yes.
3. **How the founder reaches the box in minute 2, before DNS:**
   - an IP-encoded public wildcard DNS name (no account, and no dependency on us);
   - an eigenEnterprise-operated subdomain (smoother, but it depends on us, in tension with the claim);
   - or no TLS until the founder's domain is set.
   *Recommendation:* the IP-encoded name, with Let's Encrypt rate-limit behavior verified in S2.
4. **The expand/contract migration rule (D15)** becomes an AGENTS.md guardrail. *Recommendation:* yes; it is what makes EE upgrades reversible.

## 9. Hard problems (named, not hidden)

1. **We own packaging, and the catalog is a product we maintain forever.** That means the Postgres extension `.deb`s (per PG major and distro), every runtime and capability version, security updates for each, and the EE release pipeline. This is the real cost of not using Docker. D13 bounds it, and the gap loop decides what earns a place in the catalog.
2. **We give up running arbitrary existing software.** Anything that brings its own database engine (WordPress + MySQL, Plausible + ClickHouse, Elasticsearch) doesn't run until eigen offers that service for everyone, or ships the function as its own module. This is deliberate: it is the line between hosting software and being an operating system.
3. **Vendored programs are the hard edge of D16.** An app can carry a program inside its own release (npm's `ffmpeg-static` does exactly this). Datastores and listeners are blocked structurally (no ports, loopback denied, only eigen's sockets), but a vendored binary looks like the app's own native code. S0 decides between failing builds that contain undeclared executables (a deterministic file-type check, not a heuristic) and leaving it as policy.
4. **Kernel services couple apps to EE.** The queue, events and email go through the kernel, so an EE outage pauses them, while an app's own database keeps working. EE is system tier and blue-green deployed (D15), which is what makes this coupling acceptable.
5. **Native isolation is configuration, not a default.** Containers give each app a separate filesystem view for free; here the generated units must be right. CI enforces it: every generated unit must stay under a fixed `systemd-analyze security` exposure score, and escape tests check that an app can't read EE's files, connect to Postgres as superuser, reach loopback, or bind :80.
6. **Server updates move shared system libraries.** Pinned runtimes and capabilities cover themselves, but native npm add-ons (e.g. image libraries) link against system libraries. After OS upgrades, `ee` rebuilds affected releases, health-gated. Heavy system dependencies belong in the catalog as capabilities, where eigen pins and maintains them.
7. **`ee` is root and the root of trust.** It stays tiny, has no LLM, and is not in the data path. Chaos tests: `kill -9` and reboot mid-deploy must converge.
8. **Code rollback is not data rollback.** Expand/contract (D15), plus a snapshot before every system-tier deploy.
9. **Two EE copies at once** during blue-green: advisory-lock leadership for every singleton (D15).
10. **Builds compete with production** on a small VPS. One build at a time in capped transient units. Heavy apps can ship CI-built releases instead of building on the box.
11. **Supply chain.** Build-time install scripts run in sandboxed build units. Every release, runtime, capability and binary download is checksum- or signature-verified. Unknown sources need owner confirmation (the company-os §7.6 rule).
12. **Scope gravity.** This is PaaS-shaped. `ee`'s feature set is exactly what the company OS needs for itself; apps get it for free. It never gets a dashboard.
13. **Single-node availability ceiling.** Accepted (D13).

## 10. Milestones

Each milestone: tests first, gates green, one commit, a progress entry, and a proof that runs on a real VPS where it says so.

- **S0 — The contract.** The workload schema, the `ee.json` app contract with `runtime` / `services` / `capabilities`, and the catalog manifest (shared zod package); the `catalog_gap` error; the hardened unit template; the control API (OpenAPI); CloudEvents types; the CLI naming; the vendored-program decision (§9.3). *Proof:* the schema rejects every privilege vector and every environment an app could bring itself; generated units pass the security-score threshold.
- **S1 — `ee` core.** Single binary + `ee.service`; the company repo with one writer; reconcile; Caddy render and load; secrets; `static` + `node` workloads from local fixtures. *Proof:* `kill -9` `ee` mid-deploy and reboot mid-deploy both converge; with `ee` stopped, every site keeps serving.
- **S2 — The platform as packages.** Postgres + extension packages (CI-built `.deb`s where needed); the EE release pipeline (CI publishes checksummed releases); `ee upgrade` / `ee self-update`; the installer. *Proof:* fresh Ubuntu 24.04 VPS → console over HTTPS in ≤ 3 min, with nothing installed beyond `ee`, Caddy, Postgres and the Node runtime.
- **S3 — EE ↔ `ee`.** Kernel module `substrate` (registry tools wrapping `ee` verbs); the P0 arrival check from `ee status`; the public/console host split. *Proof:* **the wedge**: `curl | sh` → first conversation → website live at the founder's domain in ≤ 10 min (this is phase-wedge M5).
- **S4 — Git sources, builds, blue-green.** Sandboxed builds, the health gate, keep-3, rollback as a commit; D15 in EE. *Proof:* a broken app deploy never replaces a healthy one; `ee upgrade` to a deliberately broken EE release leaves the old EE serving, and the agent reports why.
- **S5 — Shared services for apps.** Each app gets its own Postgres database and login; a `service` principal + API key provisioned at first deploy; the kernel services socket (queue, events, email); a files directory included in backups; the Node SDK. *Proof:* a fixture app uses its database, enqueues a job another workload consumes, and sends an email, all audited as kernel events. It cannot reach another app's database or the services under another principal.
- **S6 — GitHub source provider + customer zero.** The GitHub App module: mirror fetches, webhook rev bumps, auto-deploy, the `ee.json` PR. *Proof:* **customer zero**: the CEO's app is deployed by conversation and redeploys on push, with zero app-specific code in `ee`. **If her app needs a catalog entry that doesn't exist yet, that entry is built first. The gap rule applies to customer zero too.**
- **S7 — Out-of-process modules.** Manifest + workload on the catalog, tools proxied by the registry; Owlery first. *Proof:* "add a contact form" → the Owlery workload runs → mail goes out (first-conversation P5).
- **S8 — The gap loop, end to end.** `catalog_gap` → Extension Roadmap item → a new catalog entry ships in a release. First entries are chosen by real gaps; the likely candidates are `chromium` (PDF invoices) and `python`. *Proof:* an app declaring `chromium` fails with `catalog_gap` before the entry exists, and after the eigen release it deploys with no change to the app.
- **Later:** off-box backups, preview workloads per PR (software factory), static website publish, `ee export`, more runtimes and capabilities as the gap loop demands.

## 11. Success criteria

| Metric | Target |
|---|---|
| `curl \| sh` → console over HTTPS | ≤ 3 min |
| `curl \| sh` → live personalized website | ≤ 10 min; no container, no build on the critical path |
| Sites offline while `ee` is stopped or upgrading | Zero |
| `ee` killed, or box rebooted, mid-deploy | Converges with no manual step |
| A failing deploy or upgrade replaces a healthy release | Never |
| Rollback | One sentence or one command, ≤ 1 min, recorded as a commit |
| Privilege reachable by the agent or an app | None (schema + escape tests) |
| Generated units above the security-score threshold | Zero (CI) |
| Deploys without a commit in the company repo | Zero |
| Secret values in git, logs, releases or tool output | Zero |
| App-specific code needed to run the CEO's app | Zero |
| Apps running on anything outside the catalog | Zero |
| A missing catalog entry | Deploy fails with `catalog_gap` naming it, and a roadmap item exists |

## 12. Non-goals

Docker or any container runtime; apps bringing their own environment or datastore; running arbitrary existing software that needs services outside the catalog; multi-node; Kubernetes; buildpacks or framework detection; a PaaS dashboard; autoscaling; hosting other companies' apps; support for distributions beyond §8.2.

## 13. If approved, amend

- `company-os-architecture.md`: add `ee` to §1; rewrite §4 (native systemd, no containers, the catalog); replace Redis/BullMQ in §5.2 and §8 with the Postgres-backed queue; update §12; point §7.4 step 7 and §11.3 here.
- `phase-wedge.md`: M5 → S2 + S3.
- `AGENTS.md`: the expand/contract guardrail, plus a repo-map entry for the `ee` package.

None of these are edited until the owner confirms.
