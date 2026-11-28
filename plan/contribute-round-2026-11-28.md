# Make-a-wish round — 2026-11-28

Source: one.eigenenterprise.app (`eigen` MCP, `contribute.list`), read 2026-11-28 on main `8867ff45` (v0.5.47). Owner: "get the newest commit from main and then integrate the ee-one contributions from the mcp and integrate all of them. make sure to finish the work in 'in progress' … use subagents on low to implement in parallel."

## Owner decisions (2026-11-28, asked at the start)

1. **Handover is deleted** (wish f3fc516e). Ony's handover wishes are declined with a note: b92e6ba5, f71be370, 214b70d7, d3801d8a, 8587d182. Tables stay; the drop comes later as an `-- ee:contract` migration.
2. **All the big wishes are built this round**: co-workers on the web and seeing images, artifacts in Drive, encryption at rest, dashboard patterns.
3. **Memory documents migrate into Drive for real** (expand migration; Memory's Documents tab goes away).

## Workstreams (one low-effort subagent each, own worktree)

| Branch | Wishes | Migration |
|---|---|---|
| `wish-memory-frontpage` | f3fc516e (delete handover, "What the brain knows" becomes Memory's front page), 2f296da6 (edit a task's source thought) | — |
| `wish-memory-docs-drive` | f3fc516e (documents into Drive) | 0191 |
| `wish-notifications` | f3fc516e (questions on the dashboard + notification bell), 3c1481b9 | 0192 |
| `wish-dashboard-patterns` | 75a4e570 (eigenmesh-style "what's happening") | 0193 |
| `wish-coworker-web-vision` | 133f8e82 (web.fetch / web.search), a4a5a3ad (images; video declined) | 0194 |
| `wish-ai-models` | cd140a7a, 60bd7be2, d0a0c775, c37fcfe6, 377f4843 | 0195 |
| `wish-coworker-ui` | 7c6db153, acdb941e, 32162c64, 714726fe | 0196 |
| `wish-artifacts` | 7478dbe4, a4a5a3ad (free design) | 0197 |
| `wish-messages-calls` | b012b298, 397dfda6, 4fbf9991, f397009a, 2734a371 | 0198 |
| `wish-polish-a` | 0994bb7b + the presence e2e still open, 70a54b68, 628e00f8, f3b0b4f5 | — |
| `wish-polish-b` | 498da734, 98f18047, 55fdb281, fd96580a | 0199 |
| `traces-phone-home` | 3b18c845 (in progress): T0–T6 of `plan/traces-phone-home.md` | 0200–0202 |
| `memory-one-input-jev` | 11f05e24 part 2 (Jev routes the one input), 057cd4d5 (answers go into the brain) | 0203 |
| eigenEnterprise-cloud `volume-encryption` | e840c02c: V1–V3 of `phase-volume-encryption.md` (V0 needs a real host) | cloud repo |

Migration numbers are set in advance so the parallel branches merge without journal collisions; gaps from unused numbers are closed when the branches merge.
