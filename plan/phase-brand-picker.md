# Phase: Brand picker — choose your style like an artist on Spotify

**Status:** APPROVED direction (owner, 2026-10-31, corrected 2026-11-02). Milestone B1 (style taxonomy) produces a proposal for the owner to review before anything is precompiled.
**Owner direction (2026-10-31):** "compose a list of UI and styles and the user chooses one of those styles, like you choose your favourite artist on Spotify … when you selected one, more styles of this category get shown, and you can select a final granularity."
**Owner correction (2026-11-02):** choosing the style is the most important thing. "A pre-compiled list of different styles that are granular enough and broad enough and fine enough to make a real distinction" → "precompile them into a list of mini previews of websites or a component view" → "then apply them to the design system", i.e. a predefined set of components. **Applying the style to the company website is out of scope.**
**Builds on:** `plan/phase-2d-visual-branding.md` (corpus format, distance, Specimen, seed expansion, emitter). **Replaces its selection flow** (§5).

## 1. Owner decisions

- **P1 — Cards are mini previews** (a small website/component view rendered in the style), not names or swatches.
- **P2 — Spotify-style onboarding, one path down**: broad styles first → tap one → its finer relatives replace the grid → tap again → final style. About 3 levels, always one step back.
- **P3 — The style list is precompiled and curated**: broad enough at the top, fine enough at the bottom, every option visibly different from its siblings. Nothing is generated at pick time.
- **P4 — Applying = a predefined component set (the design system)**: the chosen style is a token set that drives a fixed set of components. The company website is not a target.

## 2. What exists (audit 2026-10-31)

- 83 corpus styles (`modules/brand/corpus/items`: 35 daisyUI, 36 tweakcn, 12 archetypes), cssVars light/dark + seeds; `styleDistance` (48-dim, weighted colour/shape/type/effects); k-NN K=8; only 3 clusters (light vs dark) → **no usable hierarchy**.
- `Specimen.svelte` (full mini site) and `extract/specimen-mini.svelte` (small preview); seed expansion (`expand.ts`, `reseed.ts`); emitter (`emitter.ts`) → CSS vars; `brand_visual_sets` + activation (`:root` override of the app).
- Gaps for this phase: no taxonomy (genre → style → variant); many corpus items are near-duplicates (daisyUI/tweakcn palettes differ mostly in colour); fonts not loaded; previews rendered live, not precompiled; no defined component set to apply to.

## 3. Design

### 3.1 The taxonomy (B1 — research + curation, owner reviews)
- **Level 1 — genres** (~8–12): visual directions a non-designer recognises at a glance (e.g. Swiss/minimal, editorial serif, brutalist, neo-brutalist, soft/rounded friendly, corporate/enterprise, luxury/dark, playful/colourful, retro/vintage, technical/terminal, organic/natural, glass/futuristic — final list from research).
- **Level 2 — styles** (~4–8 per genre): distinct takes within the genre (type pairing, colour mood, density, shape language).
- **Level 3 — variants** (~3–4 per style): the final granularity (accent colour, light/dark, roundness/density step).
- Target ≈ 150–300 precompiled leaves. Every node gets a name, a one-line description and a full token set (colour light/dark, type pairing with real fonts, radius, border, shadow/elevation, spacing/density, motion).
- **Distinctness rule (deterministic gate):** siblings must be at least a minimum `styleDistance` apart, and a parent's children must cover different axes; near-duplicates are merged or dropped. Existing corpus items are reused where they fit a node; gaps are authored as seeds.
- Sources to research: design-movement references, daisyUI/tweakcn/shadcn themes, public design systems, type-pairing collections. Licences recorded per source, as in phase 2d.

### 3.2 Precompiled previews (B2)
- One fixed **preview composition** (hero + nav + button set + card + input + badge), rendered per node at build time into a static image (light and dark) with its real fonts. Precompiled = fast grid, identical look on every machine.
- Stored as build assets with an index (`node id → parent, name, description, tokens, preview paths`), snapshot-tested.

### 3.3 The picker (B3)
- Full-width grid of preview cards. Level 1 shows the genres; tapping replaces the grid with that node's children (animated); a breadcrumb steps back. The final level has **Choose this style**.
- Choosing saves the style as the company's brand (`brand_visual_sets`, existing activation rules).

### 3.4 Apply to the design system (B4)
- A defined **component set** (from `docs/design-system.md` / the shadcn components the app uses): buttons, inputs, select, card, badge, alert, tabs, table, dialog, nav, typography scale.
- The chosen token set drives exactly those components (emitter → CSS variables), and a **design-system view** (`/brand/system`) shows every component in the chosen style, light and dark.
- The app console uses the same tokens (existing `:root` override).

## 4. Milestones

Tests first, gates green, one commit per workstream, a progress entry, e2e screenshots **inspected**.

- **B1 — Taxonomy proposal**: research + a draft tree (names, descriptions, axes, which corpus items map where, what must be authored), plus the distinctness gate as code. **The owner reviews the tree before B2.**
- **B2 — Precompile**: author the missing tokens, build-time preview rendering, the node index, snapshot tests.
- **B3 — Picker**: the drill-down page over the precompiled index.
- **B4 — Design-system view**: the component set driven by the chosen tokens.
- **B5 — E2E** in the local test server (ee-box): onboarding → 3 taps → Choose → the design-system view and the console show it.

## 5. Removals (announced before they ship — AGENTS.md "no silent removals")

- The `/brand` multi-select flow (pick ≥3 → centroid top-3 → "Use this design"), its "Similar styles" drawer and the swatch `style-card.svelte` — replaced by the picker. The agent tools `brand.selection_matches` / `brand.corpus_similar` stay.

## 6. Out of scope (named)

- Styling the company website or deployed apps with the brand.
- Chat fine-tuning of a chosen style; a simple editor (the existing advanced editor stays as it is).
- Phase-2c voice tools (tone, lexicon, glossary) stay untouched.
