# Phase: Website module — Apps as the one place (owner request, 2026-10-21)

Status: APPROVED by the owner in conversation (2026-10-21). Delivers `plan/phase-platform.md` step 4 (site as a service) and consolidates the website module's console UI around **apps**.

## 1. What the owner asked for (verbatim intent, structured)

1. **Pages/site are an app.** Even without a repo or GitHub, the owner can "add a static site under a domain". The company site shows up next to the apps.
2. **Apps is an overview.** Clicking Apps shows every app as a card in a two-column grid, each card saying **under which domain it runs**, with a **"+" card at the end** to add one.
3. **"Deploy a repo" is an option, not a section.** Adding an app offers: *Build it with chat* · *Connect a repo* · *Static site*.
4. **Settings → Hosting is wrong.** It renders in the dark theme (looks broken); domains are listed but only removable; it must not be the central place that decides which domain belongs to which app. It may *show* which domains are connected, nothing more. GitHub connect, Apps and App secrets do not belong there — they belong with the app.
5. **GitHub connection is misplaced.** Connecting a repo is a step of adding an app: pick the repo → public or private → a deploy key only when private. The GitHub page should not house the connected-repos list.
6. **Recent activity** belongs on the Website module page, not hidden in a hosting tab.
7. **Use shadcn-svelte** for these pages (already installed: `components.json`, `src/lib/components/ui/*`).

## 2. Findings that shape the cut (from recon, 2026-10-21)

- The dark Hosting page has one cause: `/settings/hosting` is outside the `(nucleus)` route group, so it never gets `marketing-light-theme` (`src/routes/(nucleus)/+layout.svelte:23`) and its hard-coded `border-black/15` / `bg-white` classes vanish under `.dark`. Everything under `/m/website/*` renders light. **Fix = move the page into the module.**
- Domains live only in ee's company repo (`routes.json`, `settings.json`). ee has add/remove and *move on add* (re-POST with another workload strips the old route), no rename. The public host is pinned to workload `os` (`ee/src/domains.ts:57`); `rootRewrite: '/s/home'` is fixed. **Exactly one company site exists**; a second "site" would be a repo-backed static app (ee already serves `runtime: 'static'` through Caddy `file_server`).
- `website.app_list` returns services + catalog only; hosts must be joined from `ee.status().routes`, last deploy from `/v1/deploys`. `website.app_get` already returns an app's domains (read-only).
- Secrets are two systems: `website.app_env_set` (per app, agent-gated) and `substrate.secret_set` (any workload, human-only, write-only). Both stay; the per-app page surfaces both.
- GitHub App callbacks are hard-wired to `/settings/hosting/github/{callback,installed}` (`src/routes/settings/hosting/manifest.ts`). **Those `+server.ts` routes stay where they are**; only the page moves.
- Pages are created by agent tools (`website.create_page`…); there is no pages editor UI. The site page lists pages and their publish state; writing stays in chat.
- Zero browser coverage exists for `/m/website/*` and `/settings/hosting`.

## 3. Target information architecture

| Route | Purpose | Theme |
|---|---|---|
| `/m/website` | Module page (generic) + **Recent activity** panel (website events: deploys, domains, pages, keys) | light |
| `/m/website/apps` | **Apps overview**: 2-column grid of app cards (name, kind badge, status, domains, repo@branch, last deploy) — the **company site is a card** (kind *Site*) — last card is **"+"** → Add dialog | light |
| `/m/website/apps/new` | **Connect a repo** flow: repo → public/private (deploy key only for private) → name/kind/domain/build settings (with "Let AI fill this out") → deploy with progress | light |
| `/m/website/apps/[name]` | App detail: deploy, **domains (add/change/remove, per app)**, build settings, environment variables + secrets, deploy history, logs, remove | light |
| `/m/website/site` | **The company site as a service**: public domain (set/change/remove), public URL, pages with publish state | light |
| `/m/website/hosting` | Server: managed state, console host, reconcile error, **domains table (read-only, each row links to the app/site that owns it)** | light |
| `/m/website/github` | **GitHub App connection only** (install status, advanced manifest connect, disconnect). No repo list, no repo forms | light |
| `/settings/hosting` | 307 → `/m/website/hosting` (the `github/callback` + `github/installed` endpoints under it stay) | — |

Add dialog (from the "+" card), three options:
- **Build it with chat** → `/?prefill=<text>` (the chat composer gets the draft; nothing is sent automatically).
- **Connect a repo** → `/m/website/apps/new`.
- **Static site** → `/m/website/site` (set the site's domain there; a repo-backed static site is "Connect a repo" with runtime `static`).

## 4. Decisions (architecture impact → progress.md decision log)

- **D-W1 — The company site is a service of kind `site`, synthesized, not stored.** Its card/page is built from `ee.status().settings.publicHost` + `website_content` counts. No new table; one site per company (schema fact). A second site = a repo-backed static app.
- **D-W2 — Domain assignment is per app.** New human-only tools `website.app_domain_set` / `website.app_domain_remove` (`modules/website/apps/domain-tools.ts`) own the host ↔ app mapping and keep `website_services.host` in sync; they refuse to touch a host owned by another workload. The site's public domain keeps using `substrate.domain_add {role:'public'}` / `substrate.domain_remove`. The Hosting page is read-only for domains.
- **D-W3 — Hosting moves into the module** (`/m/website/hosting`); `/settings/hosting` redirects. Callback endpoints keep their URLs (GitHub manifest is hard-wired to them).
- **D-W4 — Repo connection is a step of adding an app.** `/m/website/apps/new` owns inspect → (deploy key if private) → connect → deploy. The GitHub page keeps only the GitHub App connection. Server tools are unchanged (connect-tools, deploy-key tools; D11 gating untouched).
- **D-W5 — shadcn-svelte everywhere on these pages** (Card, Dialog, Button, Input, Select, Badge, Alert, RadioGroup, Tabs, Separator). No hand-rolled `border-black/15` dialect.
- **D-W6 — Secrets per app, write-only, two tools as today.** Env vars via `website.app_env_set` (agent-gated), secrets via `substrate.secret_set` scoped to the app's workload (human-only). No values are ever read back.
- Guardrails carried: no `$effect` for control flow; every substrate mutation `requireHuman` (D11); approval-gated agent tools unchanged (`APPROVAL_REQUIRED_TOOLS` pinned by `modules/manifests.spec.ts`); fail loud when ee is unreachable (`managed:false` states are explicit UI, not fallbacks).

## 5. Workstreams (disjoint file sets; one git worktree per branch)

### Batch 1 (4 agents in parallel)

**W1 — `wt/website-apps-overview`: Apps overview + Add dialog + site card**
- Owns: `src/routes/(nucleus)/m/website/apps/+page.svelte`, `+page.server.ts`, `page.server.spec.ts`; new `src/lib/components/app-card.svelte` (+ `.svelte.spec.ts`), `src/lib/components/add-app-dialog.svelte` (+ spec); `modules/website/apps/tools.ts` **only the `website.app_list` handler** (+ `apps/tools.spec.ts`): enrich each service with `domains[]` (from ee routes), `lastDeploy` (stage/status/endedAt from `/v1/deploys`), and add the `site` entry (`publicHost`, page counts, url); chat prefill: `src/routes/(nucleus)/+page.svelte` reads `?prefill=` once in `onMount` into the composer draft.
- Removes the inline "Deploy a repo" section and the `deploy` action from the overview (W3 re-homes it).

**W2 — `wt/website-app-detail`: App detail redesign + per-app domains + secrets**
- Owns: `src/routes/(nucleus)/m/website/apps/[name]/+page.svelte`, `+page.server.ts`, new `page.server.spec.ts`; new `modules/website/apps/domain-tools.ts` (+ spec) with `website.app_domain_set` and `website.app_domain_remove` (requireHuman, admin); registration in `modules/website/apps/manifest.ts` + `modules/website/manifest.ts` + `modules/manifests.spec.ts`. Does **not** edit `modules/website/apps/tools.ts`.
- Secrets section calls `substrate.secret_set` with `workload = app name` through `ownerRun`.

**W3 — `wt/website-app-new`: Connect-a-repo flow (`/m/website/apps/new`)**
- Owns: new `src/routes/(nucleus)/m/website/apps/new/+page.svelte`, `+page.server.ts`, `page.server.spec.ts`; new `src/lib/components/repo-connect-steps.svelte` (+ spec). Reuses `app-build-form.svelte`, `app-deploy-progress.svelte`, `apps/form.ts`, `startOwnerDeploy`, and the existing connect/deploy-key/inspect tools. Does not edit `github-connect.svelte` or the GitHub page (W6).
- Step 1 lists already-connected repos (with "disconnect" for ones no app uses) and takes a URL or a GitHub-App repo; step 2 derives public/private from `website.github_inspect_repo` and shows the deploy-key steps only for private; step 3 is name/kind/domain/build settings → deploy → progress → link to the app.

**W4 — `wt/website-hosting-site`: Hosting relocation + Site page**
- Owns: new `src/routes/(nucleus)/m/website/hosting/{+page.svelte,+page.server.ts,page.server.spec.ts}`, new `src/routes/(nucleus)/m/website/site/{+page.svelte,+page.server.ts,page.server.spec.ts}`; `src/routes/settings/hosting/+page.server.ts` becomes a redirect and `+page.svelte` is deleted (callback `+server.ts` files untouched); `src/lib/shell/module-settings.ts` (Public site → `/m/website/site`, Hosting → `/m/website/hosting`); `src/lib/components/home-settings-menu.svelte` (Hosting link).
- Site page: domain set/change/remove via `substrate.domain_add {role:'public', workload:'os'}` / `substrate.domain_remove`; pages list via `website.site_info` / store.

### Batch 2 (after batch 1 is merged)

**W5 — `wt/website-activity`: Recent activity on the module page** — new read tool `website.activity` (new file `modules/website/activity-tools.ts`: ee events + deploys + kernel events for `website.*`/`substrate.*`), `panel: 'website-activity'` slot in `module-settings.ts`, `src/lib/components/website-activity-panel.svelte`, module page wiring.

**W6 — `wt/website-github-slim`: GitHub page = App connection only** — `src/routes/(nucleus)/m/website/github/*`, `src/lib/components/github-connect.svelte` (+ spec): remove repo forms and the connected-repos list; keep install/advanced/disconnect; copy explaining repos are connected when adding an app.

**W7 — `wt/website-e2e`: Browser journey + polish** — Playwright journey for the overview grid, "+" dialog, `/apps/new` validation, hosting light theme, site page; consistency pass across the five pages (spacing, breadcrumbs, empty states, phone layout).

## 6. Acceptance (owner's words → checks)

- Apps shows a two-column grid of cards; each card shows its domain(s); the site is one of the cards; the last card is "+".
- "+" offers Build it with chat / Connect a repo / Static site; "Deploy a repo" no longer sits under the list.
- A private repo asks for a deploy key, a public one never does; connecting a repo only happens while adding an app.
- Domains are changed on the app (or site) page; Hosting only shows them and links to their owner; Hosting renders light like every module page.
- GitHub connect, Apps and App secrets are gone from Hosting; secrets live on the app page.
- Recent activity is on the Website module page.
- `npm test`, `npm run check`, `npm run lint` green on `main`; the new pages have server specs; the module cut is pinned in `modules/manifests.spec.ts`.

## 7. Out of scope (named follow-ups)

- Serving the company site at `/` of its public host instead of `/s/<slug>` (`rootRewrite` is fixed in ee) — phase-platform step 4b.
- Multiple company sites; a pages editor UI (pages stay chat/tool-driven).
- ee additions: `PATCH /v1/domains` (atomic rename), deploy-key list, secret delete, `resources` on apps, DNS pre-check — tracked in phase-substrate gaps.
- The rest of `/settings/*` keeps its current theme behaviour.

## 8. Owner correction — 2026-10-22

The owner rejected the fragmented Hosting / Site navigation and the deployment warning dominating the app overview. The approved correction is a Coolify-style apps-and-repositories overview with two Add choices (build with chat, connect GitHub), an explicit public/private repository flow with server-held read-only deploy keys, and one Website Settings entry for server connection, domain routing and automatic HTTPS. Per-app operational settings remain attached to each app.

- Include connected repositories even before their first deployment; match repository identity and branch, rather than hiding sources that lack service rows.
- Missing deployment capability must be stated accurately where a key or deploy is requested, and visible via server status/settings. Repo browsing and public connections remain useful. Errors must remain visible.
- Group existing Hosting and Site controls under Settings while preserving their URLs and mutation/approval contracts. Existing build, deployment history, logs, environment, secrets, mail access and removal actions remain available. No functionality is removed in this correction.
- HTTPS is managed by the existing ee/Caddy server. Explain DNS and renewal; do not invent certificate issuance/expiry data the control API does not expose.
- Workstreams: overview/repository inventory, connect/access workflow, website/app settings in separate worktrees; orchestrator owns integration, headed browser journey, runtime verification, and progress.
