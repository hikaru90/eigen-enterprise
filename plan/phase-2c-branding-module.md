# Phase 2c — Brand kernel (branding module)

**Status:** APPROVED for implementation (user directive 2026-09-08; ruleset `plan/branding-module-rules.md` flips PROPOSED → APPROVED)
**Ruleset of record:** `plan/branding-module-rules.md` (G1–G25, normative MUST/MUST NOT)
**Module id:** `brand` (tool namespace `brand.*` — module id MUST equal tool-name prefix per kernel contract)

## §8 open-question resolutions (decisions of record — vetoable by owner)

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Visual-asset pipeline: in-module v0 vs owlery bootstraps? | **Out of scope v0.** `brand_visual_tokens` + `brand_glossary` ship as storage + curation tools; owlery's design-system AI bootstraps the store in a later phase. No generation pipeline in-module. | Matches ruleset §1 scope; no half-pipelines. |
| D2 | Judge model routing: same as generator or dedicated judge principal? | **Dedicated judge identity, explicit model setting.** Every judge call records `judge_id` + model on `brand_validations`/`brand_judge_metrics`. The judge model comes from module setting `BRAND_JUDGE_MODEL` (env) — **unset fails loud at judge-call time**; it never silently falls back to the generator model (no-fallbacks guardrail). Cost isolation later = point the setting at a cheaper model. | Calibratability (G12) requires attributable judge calls; silent same-model default would hide routing changes. |
| D3 | Multi-locale voice: per-locale exemplars or per-locale sets? | **Per-locale sets.** Every guideline set carries a REQUIRED explicit `locale` (BCP-47 syntax check only — semantics stay LLM/ontology). Activation is one-active-set-per-locale (partial unique index). Resolution always by explicit locale param — no implicit "latest" (G23). Kindred v0 uses exactly one locale. | Sets stay immutable units; multi-locale needs no migration. |
| D4 | Disclosure UX: per-asset flag or blanket statement + override? | **Both, layered:** site-level disclosure statement lives in the guideline-set `context` (rendered by the website module later); per-asset `disclosure` flag (`ai_assisted \| human_authored`) on `brand_assets.provenance` overrides. G18 synthetic labeling stays schema-level (`provenance: synthetic` never satisfies a publish gate). | Blanket default + escape hatch; G21 satisfied by provenance flag. |
| D5 | G8 enforcement shape v0 | Guideline **mutation tools** (`brand.set_*`, `*.add`): permission roles `['admin']` + handler rejects non-human principals (`kind !== 'human'` → `permission_denied`, loud). **`brand.set_activate` is additionally approval-gated** (APPROVAL_REQUIRED_TOOLS) — the strategic go-live moment. Agent-proposal-with-diff flow = tracked follow-up (v0 agents are excluded from mutations entirely, so approvals-on-every-edit would add friction without adding safety). | G8's strategic/tactical split without burying curation in approval clicks. |

## Milestones

- **M1 — Schema + migration 0076** (`drizzle/0076_branding_tables.sql` + journal idx 76 + `src/lib/server/db/brand.schema.ts`): tables per ruleset §4 — `brand_guideline_sets` (immutable versions, draft|active|retired), `brand_voice_examples`, `brand_lexicon`, `brand_visual_tokens`, `brand_glossary`, `brand_criteria`, `brand_assets`, `brand_validations`, `brand_judge_metrics`, `brand_calibration_cases` (implied by `judge_metrics.calibration_set_ref`). CHECK constraints for all enum-ish text columns.
- **M2 — Store + manifest + guideline tools** (`modules/brand/`): `store.ts` (interface + InMemory + Db + lazy default), `manifest.ts`, `tools.ts`. Tools v0: `brand.set_create`, `brand.set_update`, `brand.set_activate`, `brand.set_get`, `brand.set_list`, `brand.example_add`, `brand.lexicon_add`, `brand.criterion_add`, `brand.token_add`, `brand.glossary_add`. Activation guards (G2): draft-only; ≥2 exemplars incl. ≥1 good + ≥1 bad; tone attributes ≥2 words each (single tone word rejected at schema level); one active set per locale. Drafts mutable, active/retired immutable (fail loud).
- **M3 — Generation + validation + publish**: `brand.content_generate` (external, N≥3 variants, exemplar-led prompt via gateway, judge-rank with per-criterion rationale — G6/G7/G9), validation pipeline (deterministic pass → judge pass — G10/G11/G14/G15), `brand.content_publish` (external + approval-gated, heritage/standard risk tiers require the approval — G16), provenance rows (G20/D4).
- **M4 — Gateway brand-context middleware** (G4): `brand-context` middleware in `src/lib/server/llm/` — resolves the active set for an explicit locale, compiles CARE block, appends to system prompt, records `guideline_set_id` on the call record. Generation without an active set fails loud.
- **M5 — Calibration + regression + acceptance sweep** (G12/G13/G24): calibration sets, F1 measurement, sub-threshold → flag-only + loud warning; guideline/judge/model change re-runs the suite; §7 acceptance checklist green incl. the no-`||`-fallback lint/test sweep.

## Workstream layout

Single stream `wt/branding` (worktree `../ee-branding`) for M1+M2 (disjoint file set: `drizzle/`, `src/lib/server/db/brand.schema.ts`, `modules/brand/`, `modules/index.ts` + spec). M3/M4 split later: M4 touches `src/lib/server/llm/**` — separate stream to avoid collisions.

## Guardrails binding this phase

- No regex/keyword logic for brand semantics (G14) — deterministic layer = format/count/list-membership only.
- All LLM calls through the gateway (G9) — cost + principal + `guideline_set_id` attached.
- No `|| 'latest'`, no fallbacks on guideline resolution — stale references fail loud (G23).
- Every mutation → kernel audit event; mutates also vcs-committed by the registry.
