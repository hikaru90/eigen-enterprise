# Phase: Platform — one deploy dashboard, fewer and clearer modules

Status: APPROVED (2026-10-20), with the owner's answers below. Owner direction: "think of website not as a static site but as the dashboard where we link GitHub repos, deploy databases, web apps and back-end services — like Coolify."

## Why

The module list grew from implementation history, not from what the owner sees:

| Today | What it really is |
|---|---|
| website | static pages served at `/s/<slug>` |
| substrate ("Hosting") | ee control: domains, apps, secrets on the server |
| github | GitHub App connection + repos it can deploy |
| repo | the agent's worktree sandbox on the instance repo |
| email + owlery | one is a send tool, the other the SES-backed sender |
| roadmap | the company's build log — a view, not a capability |

Four of these are one product (deploying things), two are one product (email), and one is not a module.

## The new cut

| Module | Owns | Built from |
|---|---|---|
| **Website** (owner's name for it; internally the platform module) | Projects → services. A service is a **web app**, **back-end service**, **database**, or **site**. The GitHub connection, repos, branches, deploys (blue-green through ee), domains, env/secrets, logs, health. | website + substrate + github |
| **Email** | SES setup, sender, sending, the send tool | owlery + email |
| **Brand** | unchanged | brand |
| **Memory** | unchanged | memory |
| **Agent** | the orchestrator; its sandbox (today's `repo`) is the agent's internal hands, not a module the owner manages | orchestrator + repo + dev-agent |
| (no longer a module) **Roadmap** | becomes a page under Platform/Overview fed by kernel events | roadmap |

The company website becomes **one service of kind "site"** in Platform, with real hosts instead of `/s`:
- locally: `https://<company-slug>.ee.localhost` (the ee public role, own host, root path `/`);
- on a server: the owner's domain, or `<ip>.sslip.io` before DNS.

Built-in site pages stay a content service (CMS-like) for now; later a site can also be a GitHub repo deployed like any app.

## Rules carried over (binding)

- D11 stays: only humans change the server. Agent actions on Platform that change the server (deploy, domain, secret, database) go through approvals per the approval mode; the owner's clicks in the dashboard are human actions.
- D16 stays: native runtimes only, from the catalog; a missing runtime is an eigen change, not a container.
- code ↔ harness ↔ user: dashboard actions that fail surface through the agent or a plain message, never raw errors.

## UI

- An app shell: left sidebar (Chat, Overview, Platform, Email, Brand, Memory, Settings), content on the right. Phone: bottom bar or drawer.
- Every active module has its own page: status, what it has produced, and its settings.
- Platform page: projects list → service cards (kind, status dot, URL, last deploy) → service detail (deploys, logs, env, domains). Coolify is the reference for the information density, not for its looks.
- Overview: a calm summary across modules — what's running, what needs you, the latest work — linking into each module page.

## Delivery (each step ships and is verified on the local box)

1. **Module merge, no behaviour change**: Platform = website + substrate + github; Email = owlery + email; repo + dev-agent fold under Agent; roadmap becomes a page. Tool names keep working through the kernel (renamed tools get an explicit alias table; no silent remaps). Migration for activations.
2. **App shell + per-module pages** (Email settings, Brand, Memory, Agent) and the Overview redesign.
3. **Platform dashboard v1**: projects, services (link a GitHub repo → web app / back-end service), deploys, logs, domains, env — over the existing ee control API and GitHub module.
4. **Site as a service**: the company site moves from `/s` to its own host.
5. **Data for services**: there is ONE Postgres (the company's). A service never gets its own database. It gets its own schema in the company database, plus its own login role limited to that schema, and its connection string is stored as a sealed secret. Tables live there.

## Owner decisions (2026-10-20)

1. The dashboard keeps the name **Website**: it becomes the deploy dashboard, not a static site.
2. **No new databases.** Everything uses the one Postgres eigenEnterprise runs on. A service that needs data gets tables in it (in its own schema, behind its own role).
3. **The agent may deploy apps and create a service's tables itself**, gated by the approval mode (ask / reasonable / allow all). Owner clicks in the dashboard are human actions (D11).
