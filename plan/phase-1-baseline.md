# Phase 1 Plan — Baseline: CLI + Website + Agent

Status: APPROVED (2026-09-07, supersedes the "no CLI" line in phase-0)
Next phase: execution

## Revision

The CLI dropped in Phase 0 is **restored with a sharper purpose**: it is the
execution surface for the company's agents (and owner ops) — in-process,
kernel-native, no MCP hop. Agents drive modules through it; MCP stays for
*external* agents (hermes, opencode); the web chat stays for humans.

## Baseline company = website + agent

- `modules/website` — content objects (pages/docs), public rendering, contact capture
- `modules/orchestrator` — the agent (exists; formally the "agent" of the baseline)
- Everything else activates on demand — extensibility is the module contract,
  not a feature list.

## CLI (`ee`)

- Lives in `src/cli/`, runs via the repo's TS runner, zero new deps if possible
- Architectural rule: **the CLI has no special powers** — it is a thin dispatcher
  over kernel registry tools. Admin operations become kernel tools themselves:
  - `kernel.module_list` / `kernel.module_activate` / `kernel.module_deactivate` (admin)
  - `kernel.approvals_list` / `kernel.approvals_decide` (owner)
- Commands (v1):
  - `ee status` — instance, activations, pending approvals
  - `ee tool list [--module <id>] [--json]`
  - `ee tool run <name> --input '<json>' --principal <id>` — full pipeline
    (permission → approval → audit → vcs-commit)
  - `ee module list|activate|deactivate`
  - `ee approvals list|decide <id> --approve|--deny`
  - `ee openapi` — print the generated spec
- Auth: `--principal <id>` or `EE_CLI_PRINCIPAL_ID` (no default, fail loud);
  roles resolved from `kernel_principals`

## Website module (minimal, honest)

- Tables: `website_content` (id, slug, kind: page|doc, title, body markdown,
  visibility: private|public, updated_at) — migration idx 72
- Tools: `website.create_page` (mutate), `website.update_page` (mutate),
  `website.get_page` (read), `website.list_pages` (read), `website.publish_page`
  (mutate, flips visibility → public)
- Public rendering: `/s/[slug]` route serves public pages only
- Contact capture: public `POST /api/website/contact` → `website_contact`
  table + `kernel_events('website.contact.captured')` — leads live here until
  the sales phase
- Registered in `modules/index.ts`; baseline activation = website + chat-gateway
  (+ orchestrator implicitly)

## Verification

- CLI: unit tests on arg dispatch → registry calls (fake registry); exec smoke
- Website: tool pipeline tests, public-render gate (private 404), contact capture
- All pre-existing suites stay green; `npm run check` at baseline

## Out of scope (later phases)

Brand kernel, visual builder, SEO/AEO, owlery engine internalization, sales
pipeline, hermes config docs.
