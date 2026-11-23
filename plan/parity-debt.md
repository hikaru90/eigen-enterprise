# Parity debt: UI-only actions that must become registry actions

<!-- Generated from src/lib/kernel/ui-parity.ts by src/lib/kernel/ui-parity.spec.ts. Do not edit by hand:
     change the map, then run `npx vitest run src/lib/kernel/ui-parity.spec.ts -u`. -->

Registry-first (plan/phase-company-brain.md §1, CB4): everything clickable is a kernel registry
action first, so the `ee` CLI, MCP and the agent get it too. Every mutating entry point of the app
(form actions, POST/PUT/PATCH/DELETE handlers) is mapped in `src/lib/kernel/ui-parity.ts`; the gate
fails on an unmapped one, and the debt below can only shrink (`DEBT_CEILING`). Each stage-3
milestone (CB8–CB13) clears its module’s section.

Mutating entry points: **340** — tool 215, human-only 46, transport 48, no effect 16, **debt 15**.

| Module | Debt |
|---|---|
| kernel | 9 |
| members | 4 |
| assistant | 1 |
| website | 1 |

## kernel (9)

- `/(nucleus)/m/memory/settings ?/settings` — My notification settings.
- `/(nucleus)/settings/backups ?/run` — Run a backup now.
- `/(nucleus)/settings/company ?/recropLogo` — Re-crop the company logo.
- `/(nucleus)/settings/company ?/removeLogo` — Remove the company logo.
- `/(nucleus)/settings/company ?/uploadLogo` — Upload the company logo (image bytes + crop).
- `/(nucleus)/settings/llm ?/saveModelConfig` — Chat and embedding model or rule; settings.update covers only the chat model and rule.
- `/(nucleus)/settings/llm/byok/[provider] ?/saveModelConfig` — Chat and embedding model or rule (same actions as Settings › AI).
- `/(nucleus)/settings/updates ?/update` — Install a new eigenEnterprise release.
- `/api/settings/notifications PUT` — My notification settings.

## members (4)

- `/(nucleus)/settings/members ?/remove` — Remove a member.
- `/api/onboarding/name POST` — Set what I am called.
- `/api/profile PUT` — Set my first and last name.
- `/api/profile/avatar POST` — Set my profile picture (image bytes, cropped).

## assistant (1)

- `/api/agent/runs/[id] PATCH` — Rename a conversation.

## website (1)

- `/api/onboarding/founding POST` — The founding interview (tone, name, positioning) as one act; its artifacts already run through website.* tools.
