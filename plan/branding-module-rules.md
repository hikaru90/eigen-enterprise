# Branding Guideline Module — Design Rules

Status: APPROVED (2026-09-08 — implementation governed by plan/phase-2c-branding-module.md; §8 questions resolved there as D1–D5)
Date: 2026-09-07
Precedes: implementation (planned as the "brand kernel" from phase-0 §Later phases 1)
Source basis: NN/g study guide ["Using AI for UX Work"](https://www.nngroup.com/articles/ai-work-study-guide/) + 32 linked articles (full-text analyzed; YouTube podcasts/videos excluded). Article names cited inline per rule.

---

## 1. Purpose & scope

The branding guideline module is the **company's brand as executable context**: a formalized, deterministic, versioned store of voice, tone, visual identity, and lexicon that (a) is injected automatically into every LLM call that produces brand-bearing content, and (b) validates that content before it can leave the building.

In scope: brand guideline storage + versioning, generation-time context injection, content validation (deterministic + LLM-judge layers), risk-tiered review gates, provenance ledger.
Out of scope (v0): visual asset generation/pipeline, design-system file rendering (owlery design-system AI bootstraps the store later), multi-brand (one company per instance).

**Core thesis from the research:** AI output quality is a function of context quality × validation rigor × human-judgment placement. The module is the mechanism for all three — not a rules PDF, but a runtime participant in every generation call.

---

## 2. Architecture fit (how this maps to the kernel)

| Rule enforcement point | Kernel mechanism |
|---|---|
| Every brand-affecting action is a registry tool (`brand.*`) | `src/lib/kernel/registry.ts` — permission → approval gate → zod-validate → handler → audit event → vcs commit. No side doors: chat, cron, MCP all inherit gates. |
| Publish/sign-off is approval-classed | `auditClass: mutate` + approvals table — `brand.content.publish` cannot execute without human approval decision. |
| Every generation, validation, gate decision, guideline change is an event | `kernel_events` (append-only). An unlogged brand decision didn't happen. |
| Guideline set changes are git-visible | vcs auto-commit on mutate — brand history, rollback, and audit are the same mechanism. |
| LLM calls (generation + judge) | `src/lib/server/llm/` gateway only; brand context attaches as gateway **middleware** (see G4). Cost + principal + model recorded per call. |
| Module lifecycle | `modules/` manifest (id, version, tools, permissions, settings, migrations) + fail-closed activation row, per `src/lib/kernel/modules.ts`. |
| Semantics (voice fit, tone classification, brand-fit judging) | LLM + ontology + JSON schema only. Post-LLM code parses/validates/persists — never regexes meaning (repo guardrail). |

---

## 3. Rules

Normative language: **MUST / MUST NOT / SHOULD**. Each rule states the requirement, the evidence, the mechanism, and the source.

### A. Guidelines are curated context, not documents

**G1 — Guidelines MUST be structured, machine-readable data, CARE-shaped.**
Store as: context (brand mission, audience, product register) + rules (voice attributes, constraints, banned lists) + examples (golden copy, good/bad pairs) + glossary + visual tokens. Exact values (colors, type sizes, spacing, radii) as machine-readable tokens; prose rationale and do/don'ts alongside. Never a prose PDF.
*Mechanism:* `brand_guideline_sets` (versioned) + child tables: `brand_voice_examples`, `brand_lexicon` (allowed/banned/required terms), `brand_visual_tokens`, `brand_glossary`. DESIGN.md pattern: exact values + prose "what it's for" + don'ts.
*Source: UX-Context Design; CARE Prompt Structure; Vague Prototyping.*

**G2 — Voice is stored as exemplars first; tone adjectives second.**
Golden approved-copy examples and explicit good/bad pairs are the primary voice representation. Tone descriptors are always multi-word nuanced sets ("clear, approachable, action-oriented") — a single tone word MUST be rejected at schema level ("happy" alone → exaggerated output). Celebrity-author mimicry ("write like Hemingway") MUST NOT be used.
*Mechanism:* schema requires ≥N exemplar pairs before a guideline set can be activated; adjective arrays min-2 validated by zod; the generator prompt leads with exemplars, not adjectives. Deriving new tone guides from approved copy via LLM is allowed, then human-curated before commit.
*Source: ChatGPT and Tone.*

**G3 — Tone MUST be conditional, not one static voice.**
Tone rules are keyed by content type and situation (error message, incident notice, campaign, doc) — e.g., a humorous voice softens for error states.
*Mechanism:* tone rules carry a `context_key` (content-type × situation enum); resolution picks the specific rule, falling back to base voice only if defined. No default-all magic: unresolved context = validation error, not silent base-voice use (fail loud).
*Source: Promptframes.*

**G4 — Injection MUST be automatic.**
Brand context attaches to every eligible LLM call via gateway middleware. Users/agents NEVER paste guidelines per prompt; a generation call without active guideline context either injects automatically or fails loudly — it never proceeds on vibes.
*Mechanism:* `brand-context` middleware in the LLM gateway: resolves active guideline set → compiles CARE block (context, rules, exemplars) → appends to system prompt; records `guideline_set_id` in the call record for provenance.
*Source: AI as a UX Assistant ("set of prompts that help us keep tone consistent with the brand"); Preparing AI Workshops (custom AI pre-loaded with stylistic guidelines).*

**G5 — Visual identity uses named vocabulary + tokens; brand imitation MUST NOT substitute for it.**
Precise named styles ("neobrutalist") and design tokens steer generation; "design like Apple" is an anti-pattern (unsustainable, doesn't guarantee quality). Store the company's named style terms, reference assets, and token bindings.
*Mechanism:* `brand_visual_tokens` + named style vocabulary table; generation prompts for visual work resolve to tokens/references, never to famous-brand names. Anti-pattern checklist (clutter, repetition, hierarchy-vs-content mismatch) ships as critique criteria.
*Source: Vague Prototyping.*

### B. Generation

**G6 — AI drafts; AI never publishes.**
Every AI-generated brand output is a first draft. The only path to publication is a human-approved publish action.
*Mechanism:* generation tools return draft records with `status: draft`; `brand.content.publish` is a separate approval-gated tool (registry approval gate). No tool combines generate+publish.
*Source: UX Reset 2025; Your AI UX Intern.*

**G7 — Generation MUST produce N divergent variants, pre-ranked with rationale.**
Default 3–5+ variants; never a single output. An LLM ranking step scores variants against explicit stored criteria (brand-fit, clarity, goal-fit) with mandatory per-criterion rationale, returning a ranked table. Humans pick.
*Mechanism:* generate → judge-rank (structured output: score + rationale per dimension) → human selection UI/chat surface. Rationale is stored — it is the explainability layer for the review gate.
*Source: Facilitating AI-Enhanced Workshops; AI for UX: Getting Started.*

**G8 — Tactical/strategic split is enforced by tool scope, not convention.**
AI produces pattern-conforming tactical content (variant copy, alt text, subject lines, drafts). Strategic brand decisions — voice direction, positioning, brand vision edits — are human-owned; the corresponding tools (`brand.guidelines.update*`) require human principal + approval regardless of who asks.
*Mechanism:* permission model: guideline-mutation tools restricted to human principals with admin/owner roles; agents can propose changes, which land as approval requests with diff.
*Source: Redefine Your Design Skills (tactical vs. strategic); Taste vs. Technical Skills.*

**G9 — All model calls go through the gateway; brand context is a middleware concern.**
No direct provider calls; cost, principal, model, and guideline-set version are recorded per call (repo guardrail, phase-0 gateway design).
*Source: AGENTS.md guardrail; AI as a UX Assistant (integration beats context-switching).*

### C. Validation — judge–evaluate–iterate

**G10 — "Good" MUST be defined as objective, decomposed criteria per content type.**
No vague feel-based criteria ("feels too verbose"). First classify content type (via ontology + LLM classification with JSON-schema output), then apply per-type criteria ("headline ≤ 7 words, names the outcome, no superlatives").
*Mechanism:* `brand_criteria` table keyed by content type; each criterion has an id, a deterministic checker if checkable, else a judge prompt spec. The critique loop (define judge → evaluate → refine) is the module's core loop; new failure patterns become new criteria (see G22).
*Source: The Core Skill of Design in the AI Era: Critique.*

**G11 — Separation of powers: LLM classifies/drafts; deterministic engine decides.**
Everything mechanically checkable (char limits, banned terms, required terms, sentence counts, enum membership, token usage) is enforced by pure post-LLM functions — pass/fail in code, not in a judge's opinion. Semantic criteria (tone fit, voice match) go through the LLM judge. The two layers are never blended into one "AI check."
*Mechanism:* validation pipeline = deterministic pass first (cheap, exact) → judge pass only on survivors. Rule from Baymard: *"probabilistic AI only for identifying patterns; all evaluative analysis handled deterministically through predefined logic"* — combined LLM classification+judgment is where accuracy plummets.
*Source: Demand Accuracy in Your AI Tools (Baymard); AI Mock Data (never trust claimed compliance — verify programmatically).*

**G12 — The LLM judge MUST be calibrated against human annotations; accuracy is measured, tracked, and enforced.**
Judge output is benchmarked against a human-annotated set of approved/blocked examples. Target F1 ≥ 0.8 vs. human labels before a judge gate may block content autonomously. Measured accuracy is stored and queryable; below threshold → the gate degrades to "flag for human review" and emits a loud warning — it never silently passes or silently blocks (no silent degradation).
*Mechanism:* calibration sets stored as first-class data (like eval_cases/eval_runs in eigen); scheduled re-benchmarking; `judge_metrics` recorded per guideline-set version.
*Source: Critique (F1 ≥ 0.8); Baymard (publish accuracy; 70% without triage is a horrible value proposition).*

**G13 — Regression rule: guideline, prompt, or model changes re-run the full validation suite.**
Any change to guideline sets, judge prompts, or underlying model re-triggers evaluation across ALL criteria against the calibration sets — not just the changed one.
*Mechanism:* guideline-set versioning carries a `validation_run_id`; publishing a new set version requires a green regression run. Mirrors eigen's eval infrastructure.
*Source: Critique (re-evaluate across all criteria on change).*

**G14 — No string heuristics for brand semantics. Ever.**
No keyword/substring/regex logic decides tone fit, brand alignment, entity meaning, or classification. LLM + ontology + JSON schema only; post-LLM code only parses/validates/persists. (Deterministic checks in G11 are format/count/list-membership checks — syntax, not semantics.)
*Source: AGENTS.md guardrail; Baymard separation principle.*

**G15 — Numeric/format claims are verified, never trusted.**
If generated content contains structured data (prices, dates, counts, token values), the generator's claim of compliance is irrelevant — the deterministic layer recomputes and verifies.
*Source: AI for Mock Tables and Charts (hallucinated compliance).*

### D. Human authority & review gates

**G16 — Risk-tiered review gates; emotional stakes are stored per asset.**
High-visibility and emotionally heritage-laden artifacts (campaigns, holiday/tradition-laden content, public-facing brand moments) REQUIRE human sign-off — mandatory approval request. Internal low-stakes drafts (internal doc phrasing, first-pass subject lines) may auto-pass validation. Stakes classification is itself validated (LLM-classified + human-settable override).
*Mechanism:* `risk_tier` field on content types/assets (low | standard | heritage); heritage/standard → publish approval required; low → may auto-publish post-validation, still audited. Backlash evidence: AI-holiday-ads backlash intensity correlates with emotional heritage of the content.
*Source: Why AI-Generated Holiday Ads Fail; State of UX 2026 (trust levers).*

**G17 — Review authority rests with principals who hold brand context.**
Validation-blocking judgments and publish approvals are meaningful only from humans with brand/UX fundamentals; the module records reviewer, not just "approved." AI is never the reviewer of record.
*Mechanism:* approval gate binds to principal + role; reviewer identity lands in the event + commit trail.
*Source: Return of the UX Generalist (oversight requires fundamentals); AI for UX: Getting Started (output quality scales with reviewer expertise).*

**G18 — Synthetic audience feedback is hypothesis-grade.**
AI-simulated audience reactions ("would users like this headline?") may inform drafts but MUST be labeled synthetic, MUST NOT auto-approve content, and MUST NOT be presented as real-user validation.
*Mechanism:* any simulated-feedback result carries `provenance: synthetic` in schema; UI/chat renderings must show it; synthetic results cannot satisfy a publish gate.
*Source: Synthetic Users.*

**G19 — Governance artifacts are human-authored and inspectable; agents never self-author their own boundaries.**
Banned patterns: AI-maintained rule files approved after the fact, opaque "boundaries.md" the system itself wrote, permission click-through. Every rule the module enforces traces to a human-approved guideline version (git-committed).
*Source: Vibe Architects (agent attempted $200 purchase under AI-authored boundaries.md).*

### E. Provenance & trust

**G20 — Every brand asset carries full provenance.**
generated-by (principal/model/call), guideline_set version, validation results (per-criterion), reviewer, publish decision — append-only via kernel events, git-committed.
*Mechanism:* `brand_assets` rows reference event ids + vcs commits; provenance is queryable per asset.
*Source: kernel design (events + vcs); State of UX 2026 (transparency, control, consistency as trust fundamentals).*

**G21 — AI use in customer-facing creative is disclosed; human intent is foregrounded.**
For external brand artifacts, provenance includes a disclosure flag; the default posture is transparency about AI involvement with the human creative direction made visible.
*Source: Why AI-Generated Holiday Ads Fail (audiences read undisclosed AI use as values signal; trust plummets when they notice).*

### F. Maintenance & anti-drift

**G22 — Guidelines are never finished; observed failures evolve them.**
Every validation failure and human edit of AI output is a signal: recurring failure patterns become new criteria or exemplars. The module treats AI errors as the primary input to curation, alongside deliberate brand decisions.
*Mechanism:* failure-pattern review is a standing job (cron-triggered, orchestrator-surfaced); "promote failure to criterion" is a guided flow that lands as a guideline-set change request (human-approved per G8).
*Source: UX-Context Design (updated by watching what AI gets wrong); Critique (new failure patterns → new criteria).*

**G23 — Guideline sets are versioned; outputs pin the version they were validated against.**
Context drift is a known, named failure mode. Every generation/validation record stores `guideline_set_id`; stale references fail loudly, never resolve to "current" implicitly (no `|| 'latest'` — no fallbacks guardrail).
*Source: Return of the UX Generalist (context drift); Vibe Architects (single sources of truth fall out of sync).*

**G24 — Capabilities enter the module only at benchmarked thresholds.**
A validation capability goes live only after measuring accuracy vs. a human-expert baseline: ≥50% coverage = useful as assist-with-human-catch-net; ≥95% (stress-tested across contexts) = eligible for autonomous gating. Adoption decisions cite measured numbers, never vendor claims.
*Mechanism:* capability flags in the manifest carry a required `min_accuracy` + current measured value; activation rows gate on it (fail-closed, consistent with kernel module activation).
*Source: Why I'm Not Worried About My UX Job (50–85% pragmatic thresholds); Baymard (≥95% for shipped checks); VR Hype Cycle (define your own tradeoff points; test yourself).*

**G25 — Maintenance is budgeted as recurring operating cost.**
Drift monitoring, judge recalibration (G12), regression runs (G13), and failure-pattern review (G22) are standing scheduled jobs with owners — not one-time setup. Rationale: one bad brand-voice output costs more trust than ten good ones earn.
*Source: State of UX 2026 (AI's real operational costs: maintenance, drift, legal exposure; trust as major design problem).*

---

## 4. Data model sketch (v0)

```
brand_guideline_sets   id, version, status(draft|active|retired), context(jsonb: mission, audience, register),
                       activated_at, validation_run_id, event_id
brand_voice_examples   set_id, content_type, text, label(good|bad), rationale, situation
brand_lexicon          set_id, term, kind(allowed|banned|required), context_key, replacement
brand_visual_tokens    set_id, token, value, prose_rationale, style_vocabulary[]
brand_glossary         set_id, term, definition, usage_note
brand_criteria         set_id, content_type, criterion, kind(deterministic|judge), spec(jsonb), risk_tier
brand_assets           id, content_type, body, risk_tier, guideline_set_id, provenance(jsonb), status(draft|validated|published|rejected)
brand_validations      asset_id, layer(deterministic|judge), criterion, result, rationale, judge_metrics_ref
brand_judge_metrics    set_id, judge_id, f1, precision, recall, calibration_set_ref, measured_at
```

Every mutation → kernel event + vcs commit. Migrations follow the Drizzle guardrail (SQL file + journal entry + schema in `src/lib/server/db/`).

## 5. Validation pipeline (order of operations)

1. **Classify** content type (LLM + ontology, JSON-schema output) — required before judging (G10).
2. **Deterministic pass** — lexical/format/count checks from `brand_criteria(kind=deterministic)` + `brand_lexicon` (G11, G15). Fail → reject with exact violations; no judge call spent.
3. **Judge pass** — calibrated LLM judges for semantic criteria only (G12); structured verdict + rationale per criterion.
4. **Rank** (if generation): N variants scored with per-criterion rationale (G7).
5. **Gate** — risk-tiered: heritage/standard → approval request bound to human principal (G16); low → auto-proceed, audited.
6. **Record** — validation rows + events + (on publish) vcs commit with provenance (G20).
7. **Learn** — failures feed the curation queue (G22); regression suite runs on any change (G13).

## 6. Anti-pattern catalog (MUST NOT)

- Single tone adjective as voice spec; celebrity-author mimicry
- "Design like <famous brand>" as visual direction
- Guidelines as prose PDF with no machine-readable form
- Generate + publish in one tool call
- One AI output accepted without alternatives/ranking
- Blended "AI check" where the LLM both proposes and decides pass/fail
- Regex/keyword logic deciding semantic anything (voice, fit, classification)
- Silent judge degradation below calibration threshold
- Synthetic audience feedback satisfying a publish gate or presented as real validation
- AI-authored, human-unread constraint files ("boundaries.md" anti-pattern)
- Implicit "latest" guideline-set resolution; any `|| default` on brand context
- Undisclosed AI-generated customer-facing creative

## 7. Acceptance criteria (when this gets built)

- [ ] Registry parity: every `brand.*` tool renders in MCP + OpenAPI; activation gating fail-closed
- [ ] Generate → validate → approve → publish e2e, all steps as kernel events, publish vcs-committed
- [ ] Heritage-tier publish attempt without approval is blocked by the approval gate (test)
- [ ] Deterministic layer catches every lexicon/limit violation in the calibration set, 100% (test)
- [ ] Judge F1 vs. human annotations measured and stored; sub-threshold judge flips to flag-only + loud warning (test)
- [ ] Guideline-set change without green regression run cannot activate (test)
- [ ] No `||` fallbacks on guideline resolution anywhere (lint/test sweep)
- [ ] Provenance query returns full chain (generator → validations → reviewer → commit) for any asset

## 8. Open questions (for the grilling round)

1. Visual-asset generation pipeline: in-module v0 vs. owlery bootstraps tokens only?
2. Judge model routing: same principal/model as generator, or dedicated judge principal for cost isolation?
3. Multi-locale voice: same guideline set with per-locale exemplars, or per-locale sets? (Kindred v0: single locale.)
4. Disclosure UX: per-asset flag content, or blanket site-level statement + per-asset override?
