# Phase: Brand picker — choose your style like an artist on Spotify

**Status:** APPROVED direction (owner, 2026-10-31). Implementation starts after the owner's "go" on this plan. §6 has two open questions.
**Owner direction (2026-10-31):** "compose a list of UI and styles and the user chooses one of those styles, like you choose your favourite artist on Spotify or YouTube Music … you select one, and when you selected one more styles of this category get shown, and you can select a final granularity."
**Builds on:** `plan/phase-2d-visual-branding.md` (corpus, distance, k-NN, Specimen, emitter, editor). **Changes its selection flow** (§5).

## 1. Owner decisions (2026-10-31)

- **P1 — Cards are mini website previews**: hero, button, card and text rendered in that style's colours, fonts and shapes. You judge the look, not a name.
- **P2 — One path, drill down**: tap one style → its closest relatives replace the grid → tap again → narrower, about 3 levels to the final style. Always one step back (breadcrumb).
- **P3 — Apply, then fine-tune**: the chosen style applies right away to the website and the app; afterwards a simple editor or a chat request adjusts it.

## 2. What exists (audit 2026-10-31) and how it's used

| Exists | Use |
|---|---|
| 83 corpus styles (`modules/brand/corpus/items`: 35 daisyUI, 36 tweakcn, 12 archetypes), cssVars light/dark + seeds | the style pool for levels 1–2 |
| `styleDistance` (48-dim vector, weighted colour/shape/type/effects), precomputed k-NN K=8, `index.json` | builds the level tree |
| `Specimen.svelte` (full mini site), `extract/specimen-mini.svelte` (small preview) | card = specimen-mini; preview + editor = Specimen |
| Seed expansion (`expand.ts`, `reseed.ts` `applySeedEdit`, owner pins) | level-3 variations + simple editor |
| `brand_visual_sets` draft/active/retired, `activation.ts`, global `:root` override in `+layout.svelte` | apply |
| Editor `/brand/editor/[setId]` (seeds, OKLCH, pins, drivers) | stays as "Advanced" |

Gaps: swatch cards instead of mini sites; corpus fonts not loaded; the start grid shows all 83 grouped into only 3 (light/dark) clusters; drill-down is a side drawer over a ≥3-pick centroid flow; flat K=8 neighbours that don't narrow; applying needs draft → activate tool → chat approval; the company website takes only `--background`/`--foreground`; chat can't adjust a style (`visual_set_update` is human-only); no brand e2e.

## 3. Design

### 3.1 The level tree (precomputed, deterministic, no LLM at runtime)
- **Level 1, "genres"**: ~10–12 maximally distinct entry styles, picked by farthest-point sampling over `styleDistance` (deterministic start: the corpus medoid). Each corpus item belongs to the genre whose entry style is nearest.
- **Level 2, "artists"**: the members of the tapped genre, ordered by distance to its entry style, at most 12 shown.
- **Level 3, "final granularity"**: 6–9 **variations of the tapped style**, generated through seed expansion: accent hue ± steps, roundness, density, type pairing, light/dark lean. They're deterministic (fixed offsets) and every variation passes the same 16-role check as activation. This gives level 3 real choice even with a 83-style corpus.
- Built into `index.json` by the existing build spec; snapshot-tested like the rest of phase 2d. Genre names: one-time build-time naming, as phase 2d planned for clusters.

### 3.2 The page (`/brand`)
- A full-width grid of mini-site cards (specimen-mini, style scoped onto the card, corpus fonts loaded from Google Fonts per visible card).
- Tapping a card replaces the grid with the next level (animated), and the breadcrumb on top steps back. Nothing else to configure.
- "Preview" on any card: the whole app shows that style temporarily (scoped override, nothing saved) until you leave the preview.
- The final level has **Use this style**.

### 3.3 Apply (P3)
- **Use this style** = one owner click: create the visual set and activate it in one step (an owner click is a human action, D11 precedent; the activation rules stay: 16 roles, previous set retired). The chat agent's activation stays approval-gated.
- Applies to: the app console (existing `:root` override) and the company website: `/s/[slug]` gets the full token set instead of only bg/fg.

### 3.4 Fine-tune
- **Simple editor** (default): primary colour, font pairing, roundness, density, light/dark. Each control maps to one seed edit (`applySeedEdit`) with a live Specimen.
- **Advanced**: today's editor, unchanged, behind a toggle.
- **Chat**: new tool `brand.style_adjust` takes a structured seed edit (the LLM turns "make it warmer / rounder" into the edit, as JSON schema output), produces a draft, and the owner approves it in chat. No string heuristics.

## 4. Milestones

Each one: tests first, gates green, one commit per workstream, a progress entry, and an e2e with **inspected** screenshots.

- **B1 — Level tree + mini-site cards**: farthest-point genres, level-2 membership, level-3 variation generator, `index.json` snapshot; card = specimen-mini with loaded fonts.
- **B2 — Drill-down page**: grid → level → level with breadcrumb back, preview mode. Replaces the drawer and the ≥3-pick flow (§5).
- **B3 — One-click apply + website tokens**: create + activate in one owner action; `/s/[slug]` uses the full token set.
- **B4 — Simple editor + chat adjust**: simple controls over seeds; `brand.style_adjust` (approval-gated).
- **B5 — E2E journey** in the local test server (ee-box): claim → `/brand` → 3 taps → Use this style → the console and the website both show it → simple-editor tweak → chat "make it rounder" → approve → visible.

## 5. Removals (announced before they ship — AGENTS.md "no silent removals")

- The `/brand` multi-select flow (pick ≥3 → centroid top-3 → "Use this design") and its "Similar styles" drawer — replaced by the drill-down. The agent tools `brand.selection_matches` and `brand.corpus_similar` stay (the agent can still use them).
- The swatch `style-card.svelte` — replaced by the mini-site card.

## 6. Open questions

1. **Deployed apps** (Website → Apps, your GitHub repos) can't be restyled from outside. Should eigenEnterprise publish the active brand as a stylesheet (e.g. `/brand/tokens.css` plus an env var for deployed apps) that your own apps can opt into? Recommendation: yes, but in a later milestone, not B1–B5.
2. **Phase-2c voice tools** (tone, lexicon, glossary; not connected to the visual flow) — keep as they are, or fold "brand voice" into the same picker later? Recommendation: keep untouched, decide later.
