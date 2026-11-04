# Design System

Two visual styles guide the project's aesthetic vocabulary. Both are described below with colors remapped to the canonical brand palette.

---

## Style 1: Brand Slider (Warm Minimalist / Data-Visualization)

A brand positioning diagram built around high whitespace, a glowing data path, and weighted node hierarchy. The palette leans organic and understated so that the luminous connecting line commands full attention.

### Color Mapping

| Role                           | Brand Token | Hex       |
| ------------------------------ | ----------- | --------- |
| Canvas Background              | Off-White   | `#F6F0E6` |
| Glow Primary (connecting path) | Aquamarine  | `#9BF0E1` |
| Highlight Node                 | Tangerine   | `#FF4632` |
| Typography & Nodes             | Black       | `#191414` |
| UI Accents / pill containers   | Warm Gray   | `#C3C3B6` |

### Typography & Layout

- **Font:** Modern Sans-Serif (Inter, Aeonik, or Graphik).
- **Transform:** All-caps labels — conveys authority and structure.
- **Weight:** Medium / Semi-bold for small-size legibility.
- **Alignment:** Left/right-justified labels flanking a centered horizontal axis per slider row.

### Visual Language

- **Liquid Path:** A blurred, semi-transparent Aquamarine stroke (`opacity: 40–60%`, `blur: 30–50px`) connects primary nodes. Mimics bioluminescent glow against the Off-White field.
- **Node Hierarchy:** Varying circle diameters encode weight or multiple data points, implying depth and priority without 3D.
- **Glassmorphism Lite:** Pill-shaped toggle buttons (e.g. "Classic / Futuristic") use Warm Gray backgrounds with `border-radius: 20px` and subtle backdrop shifts.
- **Texture:** A faint grain or paper texture over the Off-White background prevents a "flat digital" appearance.

### Brand Positioning Encoded

| Dimension   | Positioning                            |
| ----------- | -------------------------------------- |
| Temperament | Lean towards Optimistic                |
| Era         | Strongly Futuristic (highlighted node) |
| Persona     | Strongly Supportive                    |
| Reliability | Strongly Trustworthy                   |
| Origin      | Balanced, slightly Human-Focused       |

---

## Style 2: Geometric Constructivist (Scandi-Tech / Blueprint)

An architectural diagram meets Bauhaus-inspired composition. Strict grid geometry, monospace type, and a muted retro palette create an "engineer's notebook" feel.

### Color Mapping

| Role                      | Brand Token  | Hex       |
| ------------------------- | ------------ | --------- |
| Canvas Background         | Warm Gray    | `#C3C3B6` |
| Primary accent            | Tangerine    | `#FF4632` |
| Secondary accent          | Pale Mint    | `#B8E9D0` |
| Tertiary accent           | Vibrant Pink | `#FE86B1` |
| Quaternary accent         | Sky Blue     | `#A3D8F4` |
| Highlight / energy        | Citric       | `#CDF564` |
| Primary node & connectors | Black        | `#191414` |

### Typography & Grid

- **Font:** Monospace (Roboto Mono, IBM Plex Mono, or Courier).
- **Character:** Small floating numbers add a "process" / "blueprint" quality.
- **Layout:** Strict 8×8 grid. Elements snap to intersections or cell centers — mathematical precision is the point.

### Visual Language

- **Connective Tissue:** Thin `1–2px` Black paths using Manhattan geometry (90° and 45° angles only). Evokes circuit boards or logical flowcharts.
- **Nodes:** Borderless, shadow-free circles. Overlapping creates depth without 3D.
- **Grid:** Hairline grid in a lighter tint of Warm Gray provides structural skeleton without competing with content.
- **Approach:** "Constrained randomness" — place nodes organically, but snap every connector to 45° or 90°.

### Style Attributes

| Element     | Direction                       |
| ----------- | ------------------------------- |
| Aesthetic   | Functionalist / Information Art |
| Composition | Asymmetrical but balanced       |
| Line Work   | Precision-weighted, non-tapered |
| Depth       | Flat (2D) with layering         |

---

## Shared Principles

- Whitespace is structural, not decorative. Both styles treat empty space as an active layout element.
- Color signals intent: Tangerine for urgency/highlight, Aquamarine/Citric for energy/accent, neutrals for everything structural.
- Typography is restrained — one family per style, tight weight range, no decorative variation.
- All brand colors are sourced from [`docs/brand-palette.md`](brand-palette.md). Do not introduce off-palette colors without updating that file first.

---

## Page frame (app shell, C3b — binding)

Every area page inside the shell opens the same way. Use the shared components in
`src/lib/components/page/`; never hand-roll a header, breadcrumb or tab bar.

- **`PageHeader`** — `h1` title (the area name: Website, Email, Brand, Assistant,
  Memory, Drive, Settings; the dashboard at `/` greets by name instead), an optional one-line plain-language description, an optional
  status pill, optional actions on the right, and optional sub-nav **tabs below** the
  header (`tabs` from `src/lib/shell/area-nav.ts`, `settings-nav.ts`,
  `memory-surface-nav.ts`). One `h1` per page.
- **`StatusPill`** — the one status style: a bordered pill with a dot (`bg-primary` when
  on, muted when off) and a short label ("Active", "Not active", "Connected").
- **`SectionHeader`** — the `h2` heading of a tab's content (`text-base font-semibold`),
  optional description and actions (e.g. Roadmap's "Add item").
- **Back links** (`← Back to apps`, `← Back to runs`) appear only on detail pages, as a
  small muted link above the detail's `h2`. No breadcrumbs, no underlined text-link
  sub-navs.
- **Primary actions** use the primary token (`Button` default variant or
  `bg-primary text-primary-foreground`), never hard-coded black/neutral, so the chosen
  brand style re-skins them.

### Content width rule (polish P-3: full width is the rule)

- **`PageFrame`** — every area page uses the **full width** of the content pane:
  `px-4 sm:px-8`, `pt-6 sm:pt-10`, no centred `max-w-*` column. The header and the content
  share this frame, so the left edge never moves between pages. There is no width
  variant any more (the old `width="default"` centred `max-w-5xl` column and
  `width="full"` are gone).
- **Forms and reading text** inside it cap themselves at **`max-w-2xl`** (Settings) or
  **`max-w-3xl`** (Website site/settings, detail pages) — left-aligned, never re-centred.
- **Card grids** (Brand styles, Website apps, the dashboard) grow their columns with the
  width (`sm:grid-cols-2 xl:grid-cols-3 …`) instead of capping the frame.
- App-style areas (Messages, Drive) and full-pane tools (the brand set editor) render
  their own panes without the frame's padding.
- The **assistant** is not a page: the shell's top bar ("Ask the assistant… ⌘K") opens
  it as a resizable panel on the right of every signed-in page. Its linkable pages
  (`/assistant`, `/assistant/[id]`, `/assistant/activity`) use the frame like any area.

### Signed-out and public pages

Login, signup, claim, invite and the signed-out error page use **`PublicFrame`** (or
`PublicSurface` for error pages): the shell's tokens (the app's white default, or the
active brand style), the shell's type, the one wordmark **`eigenEnterprise`** (`Wordmark`),
an `h1`, and a one-line subtitle. Login and signup both carry "← Back to home". The public
company site (`/s`) is for visitors: it is named after the company and its errors never
offer "Sign in".
