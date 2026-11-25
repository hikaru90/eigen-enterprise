# Parity debt: UI-only actions that must become registry actions

<!-- Generated from src/lib/kernel/ui-parity.ts by src/lib/kernel/ui-parity.spec.ts. Do not edit by hand:
     change the map, then run `npx vitest run src/lib/kernel/ui-parity.spec.ts -u`. -->

Registry-first (plan/phase-company-brain.md §1, CB4): everything clickable is a kernel registry
action first, so the `ee` CLI, MCP and the agent get it too. Every mutating entry point of the app
(form actions, POST/PUT/PATCH/DELETE handlers) is mapped in `src/lib/kernel/ui-parity.ts`; the gate
fails on an unmapped one, and the debt below can only shrink (`DEBT_CEILING`). Each stage-3
milestone (CB8–CB13) clears its module’s section.

Mutating entry points: **400** — tool 286, human-only 48, transport 51, no effect 15, **debt 0**.

| Module | Debt |
|---|---|
