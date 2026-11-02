# Brand taxonomy — B1 draft for owner review

**Status:** PROPOSAL (2026-11-02). Nothing is precompiled until the owner approves this tree (plan/phase-brand-picker.md §3.1, milestone B1).
**Data:** `modules/brand/taxonomy/draft.json` (validated by `modules/brand/taxonomy/schema.ts`). **Gate:** `modules/brand/taxonomy/distinct.ts`.

## How to read this

- Three levels: **genre** (first grid, 11 cards) → **style** (4–6 per genre) → **variant** (3–4 per style, the final pick). 11 genres, 57 styles, **174 leaves**.
- Every node names the axes that set it apart from its siblings: colour mood, type pairing, density, shape language, elevation, motion.
- Token intent is what B2 authors: real Google Fonts names (heading / body), radius step, light/dark, density, elevation, border weight, palette mood in words.
- "→ `slug`" means an existing corpus item (`modules/brand/corpus/items/<slug>.json`) already fits the leaf; "author" means B2 writes the tokens.
- Variants mostly change colour mood and light/dark; where a variant reuses a corpus item whose fonts differ from the style's pairing, the variant intent records that item's real fonts.

## Genres

1. **Swiss & Minimal** — grid, whitespace, one confident accent.
2. **Editorial & Magazine** — reading-first, serif headlines, print rhythm.
3. **Corporate & Enterprise** — trustworthy, dense, accessible.
4. **Modern SaaS & Product** — friendly sans, rounded cards, soft gradients.
5. **Brutalist & Raw** — hard edges, thick borders, loud contrast.
6. **Playful & Friendly** — round, colourful, bouncy.
7. **Luxury & Elegant** — refined serif, restrained palette.
8. **Retro & Vintage** — nostalgia by decade.
9. **Technical & Developer** — mono, dark, data-dense.
10. **Organic & Natural** — earthy palettes, soft serifs, texture.
11. **Futuristic & Neon** — glass, glow, neon.

## The tree

### 1. Swiss & Minimal (`swiss-minimal`)

Grid, whitespace and one confident accent — nothing decorative. The most restrained direction: strict grids, neo-grotesk type, no ornament. Siblings differ in how much colour survives (one signal colour, none at all, soft greys) and in the cultural flavour (Swiss poster vs Japanese "ma").

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Swiss Grid** | International Typographic Style: grid, grotesk, a single signal colour. | colour-mood, shape-language | Inter Tight / Inter; none radius; light; regular; flat; hairline border; pure white, near-black text, one signal accent | Signal Red (light) → `archetype-swiss-grid`<br>Cobalt (light) → author<br>Night Grid (dark) → author |
| **Monochrome** | Strictly black and white, no accent colour at all. | colour-mood, type-pairing | Geist / Geist; sm radius; light; regular; flat; hairline border; black and white only | Ink on White (light) → `tweakcn-vercel`<br>Pure Black (dark) → `daisyui-black`<br>Lo-fi (light) → `daisyui-lofi` |
| **Quiet Minimal** | Soft greys, small radii, airy spacing — calm rather than stark. | density, shape-language, colour-mood | DM Sans / DM Sans; sm radius; light; airy; subtle; hairline border; soft greys, low-chroma accent | Graphite (light) → `tweakcn-graphite`<br>Blue Minimal (light) → `tweakcn-modern-minimal`<br>Slate Night (dark) → author |
| **Wireframe** | Looks like a polished sketch: outlines, grey fills, no colour. | elevation, colour-mood | Inter / Inter; xs radius; light; regular; flat; bold border; white, mid greys, outline black | Sketch (light) → `daisyui-wireframe`<br>Drafting Green (light) → author<br>Dark Outline (dark) → author |
| **Japanese Minimal** | "Ma": generous emptiness, warm paper and a single vermilion mark. | type-pairing, density, colour-mood | Zen Kaku Gothic New / Zen Kaku Gothic New; none radius; light; airy; flat; hairline border; warm off-white, sumi ink, vermilion | Washi (light) → author<br>Sumi (dark) → author<br>Matcha (light) → author |

### 2. Editorial & Magazine (`editorial`)

Reading-first: serif headlines, columns and print rhythm. Directions borrowed from print. Siblings are separated mainly by type pairing (old-style news serif, Didone fashion serif, Garamond book face, serif+grotesk hybrid) and by density (compact broadsheet vs airy slow-living).

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Newspaper** | Broadsheet: dense columns, rules, condensed headlines. | density, type-pairing | Playfair Display / Libre Franklin; none radius; light; compact; flat; hairline border; paper white, ink black, one muted accent | Broadsheet (light) → `archetype-editorial-serif`<br>Tabloid (light) → author<br>Evening Edition (dark) → author |
| **Literary Journal** | Book typography: Garamond-style text, wide margins, quiet colour. | type-pairing, density | EB Garamond / EB Garamond; none radius; light; airy; flat; hairline border; paper white, ink black, one muted accent | Cream (light) → author<br>Midnight Ink (light) → `tweakcn-starry-night`<br>Candlelight (dark) → author |
| **Fashion Magazine** | High-contrast Didone headlines, huge whitespace, black and blush. | type-pairing, density, colour-mood | Bodoni Moda / Jost; none radius; light; airy; flat; hairline border; white, black, blush | Blush (light) → author<br>Noir (dark) → author<br>Cobalt Cover (light) → author |
| **Modern Editorial** | Serif headlines over a clean sans body — blog/newsletter feel. | type-pairing, shape-language | Fraunces / Inter; sm radius; light; regular; subtle; hairline border; paper white, ink black, one muted accent | Clay (light) → `tweakcn-claude`<br>Sage (light) → author<br>Night Read (dark) → author |
| **Slow Living** | Kinfolk-style: light serif, linen tones, lots of air. | density, colour-mood | Cormorant Garamond / Karla; none radius; light; airy; flat; hairline border; linen, taupe, soft black | Linen (light) → author<br>Stone (light) → author<br>Dusk (dark) → author |

### 3. Corporate & Enterprise (`corporate`)

Trustworthy, dense and accessible — built for work tools and B2B. Sober, information-dense directions. Siblings differ by colour mood (enterprise blue, Nordic frost, finance green/navy, civic high-contrast, clinical teal, consulting burgundy) and type pairing (Plex, Public Sans, serif-led consulting).

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Enterprise Blue** | The classic business application: blue on cool greys. | colour-mood | IBM Plex Sans / IBM Plex Sans; sm radius; light; compact; subtle; hairline border; white, cool greys, corporate blue | Corporate (light) → `daisyui-corporate`<br>Business Dark (dark) → `daisyui-business`<br>Winter (light) → `daisyui-winter` |
| **Nordic Calm** | Desaturated frost blues and birch neutrals. | colour-mood, density | Inter / Inter; sm radius; light; regular; subtle; hairline border; frost white, polar blue-greys | Nord (light) → `daisyui-nord`<br>Polar Night (dark) → author<br>Birch (light) → author |
| **Fintech** | Money and trust: navy, green, tabular numbers. | colour-mood, type-pairing | Manrope / Manrope; md radius; light; compact; subtle; hairline border; white, cool greys, corporate blue | Emerald Trust (light) → `daisyui-emerald`<br>Navy & Gold (light) → author<br>Ledger Dark (dark) → author |
| **Public Sector** | GOV.UK-style accessibility: high contrast, bold focus, plain type. | colour-mood, elevation, type-pairing | Public Sans / Public Sans; none radius; light; regular; flat; bold border; white, black, civic blue, yellow focus | Civic Blue (light) → author<br>Civic Green (light) → author<br>High Contrast (dark) → author |
| **Clinical Clean** | Healthcare calm: teal/aqua, airy, rounded, reassuring. | colour-mood, shape-language, density | Nunito Sans / Nunito Sans; md radius; light; airy; subtle; hairline border; white, aqua, teal | Aqua (light) → `tweakcn-ocean-breeze`<br>Lavender Care (light) → author<br>Night Shift (dark) → author |
| **Consulting** | Serif-led authority: classic serif headings, sober accent. | type-pairing, colour-mood | Libre Baskerville / Source Sans 3; xs radius; light; regular; subtle; hairline border; white, cool greys, corporate blue | Burgundy (light) → author<br>Navy (light) → author<br>Charcoal (dark) → author |

### 4. Modern SaaS & Product (`saas`)

Today's product look: friendly sans, rounded cards, soft gradients. The current default of software marketing and product UIs. Siblings differ in colour energy (pastel calm vs bold gradients vs developer dark), shape (pill buttons, xl bento cards) and elevation.

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Soft SaaS** | Calm pastel B2B: lavender tints, gentle shadows. | colour-mood | Inter / Inter; lg radius; light; regular; subtle; hairline border; white, cool greys, violet accent | Lavender (light) → `archetype-soft-saas-pastel`<br>Cosmic Violet (light) → `tweakcn-cosmic-night`<br>Soft Dark (dark) → author |
| **Startup Bold** | High-energy gradients, saturated violet/indigo, expressive motion. | colour-mood, motion, type-pairing | Plus Jakarta Sans / Plus Jakarta Sans; lg radius; light; regular; subtle; hairline border; white, saturated violet, gradient accents | Electric Violet (light) → `tweakcn-bold-tech`<br>Midnight Bloom (light) → `tweakcn-midnight-bloom`<br>Sunrise (light) → author |
| **Developer Platform** | Dev-platform marketing: dark-friendly, neon-ish single accent. | colour-mood, type-pairing | Outfit / Outfit; md radius; light; regular; subtle; hairline border; white, cool greys, violet accent | Emerald (light) → `tweakcn-supabase`<br>Berry (light) → `tweakcn-t3-chat`<br>Indigo Dark (dark) → `daisyui-dark` |
| **Bento Showcase** | Apple-style bento grid: big rounded tiles, layered depth. | shape-language, elevation | Geist / Geist; xl radius; light; airy; layered; hairline border; light grey canvas, white tiles | Daylight (light) → author<br>Graphite Tiles (dark) → author<br>Sand Tiles (light) → author |
| **Social App** | Consumer-social: pill buttons, bright brand colour. | shape-language, colour-mood | Open Sans / Open Sans; pill radius; light; regular; subtle; hairline border; white, cool greys, violet accent | Sky (light) → `tweakcn-twitter`<br>Tangerine (light) → `tweakcn-tangerine`<br>Dim (dark) → author |
| **Productivity Tool** | Linear/Notion-like: compact, neutral, keyboard-first. | density, colour-mood | Inter / Inter; md radius; light; compact; subtle; hairline border; neutral greys, one quiet accent | Amber Note (light) → `tweakcn-amber-minimal`<br>Slate (light) → author<br>Focus Dark (dark) → author |

### 5. Brutalist & Raw (`brutalist`)

Unpolished on purpose: hard edges, thick borders, loud contrast. Directions that reject polish. Siblings differ by shape language (raw default HTML vs thick-border hard-shadow neo-brutalism), colour (none vs acid vs poster red) and cultural reference (constructivist poster, photocopy zine).

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Raw Brutalist** | Default-HTML honesty: system-like type, no decoration. | shape-language, colour-mood | Archivo / Archivo; none radius; light; regular; flat; bold border; white, black, one loud accent | Concrete (light) → `archetype-brutalist`<br>Newsprint (light) → author<br>Raw Black (dark) → author |
| **Neo-Brutalist** | Thick black borders, hard offset shadows, saturated fills. | elevation, colour-mood | Space Grotesk / Space Grotesk; none radius; light; regular; layered; bold border; white, black, saturated fill | Yellow (light) → `archetype-neo-brutalist`<br>Coral (light) → `tweakcn-neo-brutalism`<br>Neo Dark (dark) → author |
| **Anti-Design** | Clashing colours and rounded chaos — deliberately wrong. | colour-mood, shape-language | Archivo / Archivo; lg radius; light; regular; flat; bold border; clashing saturated colours | Acid (light) → `daisyui-acid`<br>CMYK (light) → `daisyui-cmyk`<br>Clash Dark (dark) → author |
| **Constructivist Poster** | Red, black, diagonals and condensed caps. | type-pairing, colour-mood | Oswald / Archivo; none radius; light; regular; flat; bold border; off-white, black, poster red | Red & Black (light) → author<br>Ochre (light) → author<br>Poster Night (dark) → author |
| **Photocopy Zine** | DIY xerox and risograph: grain, typewriter, misregistered colour. | type-pairing, colour-mood | Anton / Courier Prime; none radius; light; regular; flat; bold border; paper white, toner black, riso colour | Photocopy (light) → author<br>Riso Pink (light) → author<br>Riso Teal (light) → author |

### 6. Playful & Friendly (`playful`)

Round, colourful and bouncy — approachable consumer brands. Directions that smile. Siblings differ by shape (pill vs clay-puffy vs hand-drawn), colour saturation (candy vs pastel vs primary) and motion.

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Candy Pop** | Saturated candy pinks and pill shapes. | colour-mood, shape-language | Nunito / Nunito; pill radius; light; regular; subtle; none border; white, candy pink | Magenta (light) → `archetype-playful-round`<br>Bubblegum (light) → `tweakcn-bubblegum`<br>Valentine (light) → `daisyui-valentine`<br>Candyland (light) → `tweakcn-candyland` |
| **Pastel Dream** | Low-saturation pastels, very round, dreamy. | colour-mood | Quicksand / Open Sans; pill radius; light; regular; subtle; none border; pastel lilac, mint, peach | Lilac (light) → `tweakcn-pastel-dreams`<br>Rainbow Pastel (light) → `daisyui-pastel`<br>Cupcake (light) → `daisyui-cupcake` |
| **Claymorphism** | Puffy 3-D clay surfaces with inner and outer shadows. | elevation, shape-language | Plus Jakarta Sans / Plus Jakarta Sans; xl radius; light; regular; layered; none border; warm grey, periwinkle | Periwinkle (light) → `tweakcn-claymorphism`<br>Peach (light) → author<br>Mint (light) → author |
| **Primary Bright** | Kids-and-games energy: primary yellow, chunky rounded type. | colour-mood, type-pairing | Baloo 2 / Nunito; lg radius; light; regular; subtle; none border; white, primary yellow, black | Bumblebee (light) → `daisyui-bumblebee`<br>Lemonade (light) → `daisyui-lemonade`<br>Primary Trio (light) → author |
| **Hand-drawn** | Sketchy borders, handwritten headings, notebook warmth. | type-pairing, shape-language | Patrick Hand / Nunito; md radius; light; regular; flat; bold border; notebook white, pencil grey, marker colour | Notebook (light) → author<br>Crayon (light) → author<br>Chalkboard (dark) → author |

### 7. Luxury & Elegant (`luxury`)

Refined serif type, restrained palettes, expensive emptiness. Premium directions. Siblings differ by type (high-contrast serif, geometric Deco, Caslon heritage), palette (champagne, black-gold, blush, forest-burgundy) and light/dark.

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Quiet Luxury** | Old money: ivory, champagne, nothing loud. | colour-mood | Cormorant Garamond / Lato; none radius; light; airy; flat; hairline border; ivory, black, champagne gold | Champagne (light) → `archetype-luxury-serif`<br>Silk (light) → `daisyui-silk`<br>Cashmere (light) → author |
| **Black & Gold** | Dark luxury: black surfaces, gold or white accents. | colour-mood | Cormorant Garamond / Lato; none radius; dark; airy; flat; hairline border; black, gold | Noir (dark) → `daisyui-luxury`<br>Gilded (dark) → author<br>Emerald & Gold (dark) → author |
| **Art Deco** | Geometric 1920s glamour: thin caps, fan motifs, gold lines. | type-pairing, shape-language | Poiret One / Josefin Sans; none radius; light; airy; flat; hairline border; navy, gold, cream | Gatsby (light) → author<br>Jade (light) → author<br>Deco Night (dark) → author |
| **Boutique** | Fashion boutique: blush, rose, delicate serif and small radii. | colour-mood, shape-language | Playfair Display / Lato; sm radius; light; airy; flat; hairline border; blush, rose | Blush Rose (light) → author<br>Rose Quantum (light) → `tweakcn-quantum-rose`<br>Burgundy Velvet (dark) → author |
| **Heritage** | Established-house serif: crests, forest green and burgundy. | type-pairing, colour-mood | Libre Caslon Text / Libre Caslon Text; none radius; light; regular; flat; hairline border; ivory, black, champagne gold | Racing Green (light) → author<br>Oxblood (light) → `tweakcn-elegant-luxury`<br>Library (dark) → author |

### 8. Retro & Vintage (`retro`)

Nostalgia by decade: paper, 70s warmth, pixels, Y2K chrome. Each style is a recognisable decade. Siblings are separated by era-specific type (Baskerville paper, 70s soft display, pixel fonts, Y2K wide sans, mid-century geometric) and palette.

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Vintage Paper** | Aged paper, sepia ink, letterpress feel. | colour-mood | Libre Baskerville / Lora; sm radius; light; regular; subtle; hairline border; aged paper, sepia, faded accent | Parchment (light) → `tweakcn-vintage-paper`<br>Solar Dusk (light) → `tweakcn-solar-dusk`<br>Old Map (light) → author |
| **Seventies** | Groovy warmth: orange, brown, mustard, soft bold display. | type-pairing, colour-mood, shape-language | Shrikhand / DM Sans; lg radius; light; regular; subtle; hairline border; cream, orange, brown, mustard | Retro Cream (light) → `daisyui-retro`<br>Sunset Stripe (light) → `tweakcn-sunset-horizon`<br>Autumn (light) → `daisyui-autumn` |
| **Pixel Arcade** | 8-bit: pixel fonts, square corners, arcade colours. | type-pairing, shape-language | Press Start 2P / VT323; none radius; light; regular; subtle; hairline border; cream, arcade pink, cyan | Arcade (light) → `tweakcn-retro-arcade`<br>Doom (light) → `tweakcn-doom-64`<br>Handheld (light) → author |
| **Y2K** | Millennium chrome: bubbly, glossy, aqua and silver. | colour-mood, elevation | Syne / Inter; xl radius; light; regular; layered; hairline border; aqua, silver, bubble pink | Aqua (dark) → `daisyui-aqua`<br>Bubble (light) → author<br>Chrome (light) → author |
| **Mid-Century** | 1950s modern: geometric sans, teal, mustard, atomic shapes. | type-pairing, colour-mood | Josefin Sans / Work Sans; md radius; light; regular; subtle; hairline border; cream, teal, mustard, tomato | Atomic Teal (light) → author<br>Tomato (light) → author<br>Lounge (dark) → author |

### 9. Technical & Developer (`technical`)

Built by and for engineers: mono type, dark themes, data density. Directions from code editors, terminals and engineering drawings. Siblings differ by type (pure mono vs techno display vs condensed data sans), density, and the editor-theme palettes developers already know.

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Terminal** | Everything mono: the machine's own notebook. | type-pairing, colour-mood | JetBrains Mono / JetBrains Mono; none radius; dark; compact; flat; hairline border; near-black, terminal green | Phosphor Green (dark) → `archetype-terminal-mono`<br>Mono Paper (light) → `tweakcn-mono`<br>Amber CRT (dark) → author |
| **Blueprint** | Engineering drawing: grid lines, blue, technical mono. | colour-mood, type-pairing | IBM Plex Mono / IBM Plex Mono; none radius; light; compact; flat; hairline border; pale blue grid, blueprint blue | Drafting (light) → `archetype-blueprint-constructivist`<br>Cyanotype (dark) → author<br>Pencil (light) → author |
| **Dev Tool** | Developer-tool product: techno display, small radius, teal glow. | type-pairing, shape-language | Oxanium / Oxanium; xs radius; dark; compact; subtle; hairline border; near-black, terminal green | Teal Glow (light) → `archetype-dark-techy`<br>Perpetuity (light) → `tweakcn-perpetuity`<br>Dim Lime (dark) → `daisyui-dim` |
| **Editor Themes** | The palettes from code editors developers already love. | colour-mood | Inter / Inter; sm radius; dark; regular; flat; hairline border; near-black, terminal green | Dracula (dark) → `daisyui-dracula`<br>Catppuccin (light) → `tweakcn-catppuccin`<br>Night (dark) → `daisyui-night`<br>Coffee (dark) → `daisyui-coffee` |
| **Data Dense** | Dashboards and ops consoles: condensed sans, tabular numbers, tight grid. | density, type-pairing | IBM Plex Sans Condensed / IBM Plex Sans Condensed; xs radius; dark; compact; flat; hairline border; graphite, status colours | Ops Dark (dark) → author<br>Ops Light (light) → author<br>Control Room (dark) → author |

### 10. Organic & Natural (`organic`)

Earthy warmth: natural palettes, soft serifs, hand-made texture. Directions from nature and craft. Siblings differ by palette family (earth, forest, coast, wellness pastels) and by texture/type (grain, hand-made display, soft serif).

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Earthy Warm** | Ceramic and linen: cream, clay, coffee. | colour-mood | Fraunces / Work Sans; md radius; light; airy; subtle; hairline border; cream, earth brown, terracotta | Ceramic (light) → `archetype-warm-minimal`<br>Mocha (light) → `tweakcn-mocha-mousse`<br>Caffeine (light) → `tweakcn-caffeine` |
| **Botanical** | Leaf greens and forest floors. | colour-mood, type-pairing | Merriweather / Montserrat; md radius; light; airy; subtle; hairline border; cream, leaf green | Nature (light) → `tweakcn-nature`<br>Kodama Grove (light) → `tweakcn-kodama-grove`<br>Forest (dark) → `daisyui-forest`<br>Garden (light) → `daisyui-garden` |
| **Coastal** | Sand, sea and sky; breezy and light. | colour-mood | Lora / Nunito Sans; md radius; light; airy; subtle; hairline border; sand, sea blue | Sand (light) → author<br>Sea Glass (light) → author<br>Night Tide (dark) → author |
| **Wellness** | Spa calm: sage, lavender, clay, extra round and slow. | colour-mood, shape-language, motion | Lora / Nunito; xl radius; light; airy; subtle; hairline border; sage, cream | Sage (light) → author<br>Lavender Field (light) → author<br>Clay Pink (light) → author |
| **Handcrafted** | Maker texture: paper grain, stamped display type. | type-pairing, elevation | Gloock / Work Sans; xs radius; light; airy; flat; hairline border; kraft paper, ink | Kraft (light) → author<br>Indigo Dye (light) → author<br>Kiln (dark) → author |

### 11. Futuristic & Neon (`futuristic`)

Glass, glow and neon — the screen as a light source. Directions where light itself is the material. Siblings differ by elevation (frosted glass vs flat neon), colour mood (synthwave magenta, cyberpunk yellow, aurora greens, deep space) and motion.

| Style | What it is | Differs from siblings by | Token intent | Variants (→ source) |
|---|---|---|---|---|
| **Glassmorphism** | Frosted translucent panels over soft colour. | elevation | Sora / Sora; lg radius; dark; regular; layered; hairline border; deep dark, neon accents | Frost (light) → `archetype-glassmorphism-lite`<br>Aurora Glass (dark) → author<br>Smoke (dark) → author |
| **Synthwave** | 80s retro-future: magenta and cyan over purple night. | colour-mood, type-pairing | Orbitron / Sora; lg radius; dark; regular; flat; hairline border; purple night, magenta, cyan | Outrun (dark) → `daisyui-synthwave`<br>Sunset Grid (dark) → `daisyui-sunset`<br>Neon Pumpkin (dark) → `daisyui-halloween` |
| **Cyberpunk** | Hard-edged high-tech: yellow/pink, angular, glitch. | shape-language, colour-mood | Rajdhani / Rajdhani; none radius; dark; regular; flat; hairline border; deep dark, neon accents | Night City Yellow (light) → `daisyui-cyberpunk`<br>Neon Pink (light) → `tweakcn-cyberpunk`<br>Glitch (dark) → author |
| **Aurora** | Northern-lights greens and violets, soft glow. | colour-mood | Plus Jakarta Sans / Plus Jakarta Sans; lg radius; dark; regular; layered; hairline border; night, aurora green, violet | Northern Lights (light) → `tweakcn-northern-lights`<br>Polar (dark) → author<br>Violet Veil (dark) → author |
| **Deep Space** | Abyssal dark, single luminous accent, wide spacing. | density, colour-mood | Space Grotesk / Inter; lg radius; dark; airy; subtle; hairline border; deep dark, neon accents | Abyss (dark) → `daisyui-abyss`<br>Nebula (dark) → author<br>Starlight (dark) → author |

## Coverage

| Genre | Styles | Leaves | Reuse corpus | Author |
|---|---|---|---|---|
| Swiss & Minimal | 5 | 15 | 7 | 8 |
| Editorial & Magazine | 5 | 15 | 3 | 12 |
| Corporate & Enterprise | 6 | 18 | 6 | 12 |
| Modern SaaS & Product | 6 | 18 | 10 | 8 |
| Brutalist & Raw | 5 | 15 | 5 | 10 |
| Playful & Friendly | 5 | 16 | 10 | 6 |
| Luxury & Elegant | 5 | 15 | 5 | 10 |
| Retro & Vintage | 5 | 15 | 8 | 7 |
| Technical & Developer | 5 | 16 | 10 | 6 |
| Organic & Natural | 5 | 16 | 7 | 9 |
| Futuristic & Neon | 5 | 15 | 8 | 7 |
| **Total** | **57** | **174** | **79 (45%)** | **95 (55%)** |

79 of the 83 corpus items are mapped to exactly one leaf each. Not mapped (4):

- `tweakcn-clean-slate`: **proposed drop**. It is the hub of the near-duplicate list below (under 0.2 from cosmic-night, claymorphism, modern-minimal and bold-tech).
- `daisyui-light`, `daisyui-fantasy`, `daisyui-caramellatte`: no leaf needs them. `light` is the generic daisyUI default; `fantasy` and `caramellatte` are close in mood to Soft SaaS and Earthy Warm. **Proposed drop** unless the owner wants them as spares.

Even where an item is reused, B2 still has to author the leaf's fonts. The daisyUI items all carry the same ingest fonts (Inter / Source Serif 4) and have no dark set, because each daisyUI theme is a single mode. Reuse covers the palette and the radius only.

## Distinctness gate

Rule: siblings must be at least **styleDistance 0.20** apart (`DISTINCTNESS_THRESHOLD`).

How the threshold was chosen: I measured all 3403 pairs of the 83 corpus items.
- All pairs: p5 0.450, median 0.507, max 0.716.
- Nearest neighbour of each item: p10 0.186, median 0.450.
- The colour component saturates at a mean OKLab ΔE of 0.1. So any real palette change scores at least 0.45 on its own, and the low tail is items from the same palette family.
- The nearest-neighbour list has its clearest gap between 0.190 and 0.232, and 0.20 sits in that gap.

What 0.20 does not catch: two variants that differ only in their accent colour pass easily, because a different accent alone scores at least 0.45. Shape, type and density changes add on top of that. So the gate catches palette clones. It does not prove that two styles feel different.

**Result over the draft.** A node is represented by its first mapped corpus item. A style uses its first mapped variant, and a genre uses its first mapped style.

- 172 sibling pairs measured. Median distance 0.497, minimum 0.094.
- 110 nodes are unmeasured because they still need authoring. Their distinctness **cannot be checked until B2** authors their tokens.
- **2 violations**, both at the root (genre) level:
  - `editorial` ↔ `luxury`: **0.094**. The representatives are `archetype-editorial-serif` and `archetype-luxury-serif`. Both are serif archetypes with near-identical low-chroma warm palettes from the same seed expansion.
  - `brutalist` ↔ `saas`: **0.174**. The representatives are `archetype-brutalist` and `archetype-soft-saas-pastel`. Both are low-chroma, cool-tinted archetype palettes, so the radius difference alone is not enough.
- No violations at the style or variant level. The closest variant pair is Parchment ↔ Solar Dusk at 0.291.

Proposed fix, to be decided in B2: give the genre cards their own authored representative previews rather than reusing the first leaf. For example, Luxury would lead with Black & Gold. The archetype palettes also come out too uniform (all of them have background L 0.962 and primary L 0.536), which is worth fixing when the archetypes are re-authored.

**Near-duplicate corpus pairs under 0.20** (from `findNearDuplicates`):

| Distance | Pair | Proposal |
|---|---|---|
| 0.094 | archetype-editorial-serif ↔ archetype-luxury-serif | Keep both. They are distinct by intent (Newsreader vs Cormorant/Playfair, oxblood vs champagne), but B2 must re-author their palettes apart. |
| 0.157 | tweakcn-clean-slate ↔ tweakcn-cosmic-night | Drop clean-slate |
| 0.157 | tweakcn-claymorphism ↔ tweakcn-clean-slate | (same) |
| 0.166 | tweakcn-clean-slate ↔ tweakcn-modern-minimal | (same) |
| 0.174 | archetype-brutalist ↔ archetype-soft-saas-pastel | Keep both and re-author the palettes apart (see above) |
| 0.186 | archetype-dark-techy ↔ archetype-glassmorphism-lite | Keep both. They map to different genres; B2 should separate the palettes. |
| 0.190 | tweakcn-bold-tech ↔ tweakcn-clean-slate | (same: drop clean-slate) |

## Sources and licences

| Source | Use | Licence |
|---|---|---|
| daisyUI themes v5.7.28 | tokens (already in corpus) | MIT |
| tweakcn presets | tokens (already in corpus) | MIT per ecosyste.ms listing; one mirror says Apache-2.0. **Unverified**: check the repo LICENSE before B2. |
| shadcn/ui themes | tokens / component contract | MIT |
| Google Fonts | every font named | SIL OFL 1.1 per family. Each family still needs to be verified in B2 (Press Start 2P, VT323, Poiret One, Shrikhand and the others in this draft). |
| IBM Carbon, GOV.UK Design System, Nord, Catppuccin, Dracula | reference for the matching styles | Apache-2.0 / MIT+OGL / MIT / MIT / MIT |
| daisyUI 2026 trends, superdesign styles encyclopedia, UX Planet "UI design styles", Typewolf/Fontpair, Wikipedia design-movement articles | style vocabulary, reference only | reference only (nothing copied) |

## Open questions for the owner

1. **Genre count.** There are 11 genres. Should Futuristic and Technical merge, or should "Dark & Moody" become its own genre? Right now dark lives as variants inside each style.
2. **Dark mode as a variant vs a toggle.** Most styles spend one of their three variants on a dark version. If dark should instead be a global toggle on every leaf, each style frees a slot for another accent, and the leaf count stays the same.
3. **Corpus drops.** Drop `tweakcn-clean-slate`, `daisyui-light`, `daisyui-fantasy` and `daisyui-caramellatte`? (Nothing is deleted in B1.)
4. **Genre previews.** Should genre and style cards get their own authored representative tokens? This would fix the 2 root violations.
5. **Display fonts.** Playful novelty fonts (Press Start 2P, Shrikhand, Patrick Hand, Poiret One) are fine for headings only. Is that acceptable on the design-system component set?
