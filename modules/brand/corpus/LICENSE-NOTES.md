# Brand corpus and picker index: licence notes

These notes cover the third-party material behind `corpus/items/*.json` and `taxonomy/styles.json`. They were verified on 2026-11-02 (brand picker B2a).

## Token sources

| Source | What we reuse | Licence | How it was verified |
|---|---|---|---|
| tweakcn presets (github.com/jnsahaj/tweakcn, `public/r/registry.json`) | colour token values (the `tweakcn-*` items) | **Apache-2.0** | The repo `LICENSE` file is the Apache License 2.0, and the GitHub licence API reports `spdx_id: Apache-2.0`. The repo has no `NOTICE` file. |
| daisyUI themes (`daisyui` devDependency) | colour token values (the `daisyui-*` items) | MIT | npm package licence |
| Archetypes (`corpus/seeds/*.json`) and the authored nodes in `taxonomy/authoring/palettes.json` | authored in this repo | Apache-2.0 (this repo) | n/a |

The ingest script used to describe tweakcn as MIT. That was wrong, and the script now records Apache-2.0. Apache-2.0 allows reuse and redistribution provided the licence and attribution are kept. Every `tweakcn-*` item records its source URL in `provenance`, and this file is the attribution.

## Fonts

Every family named in `taxonomy/styles.json` is a Google Fonts family under the **SIL Open Font License 1.1**. To verify this, we checked that each family's `METADATA.pb` lives under the `ofl/` tree of github.com/google/fonts (the `main` branch, 2026-11-02). None of them sit under `apache/` or `ufl/`.

The families are: Anton, Archivo, Baloo 2, Bodoni Moda, Cormorant Garamond, Courier Prime, DM Sans, EB Garamond, Fraunces, Geist, Geist Mono, Gloock, IBM Plex Mono, IBM Plex Sans, IBM Plex Sans Condensed, Inter, Inter Tight, JetBrains Mono, Josefin Sans, Jost, Karla, Lato, Libre Baskerville, Libre Caslon Text, Libre Franklin, Lora, Manrope, Merriweather, Montserrat, Newsreader, Nunito, Nunito Sans, Open Sans, Orbitron, Oswald, Outfit, Oxanium, Patrick Hand, Playfair Display, Plus Jakarta Sans, Poiret One, Poppins, Press Start 2P, Public Sans, Quicksand, Rajdhani, Share Tech Mono, Shrikhand, Sora, Source Code Pro, Source Sans 3, Source Serif 4, Space Grotesk, Space Mono, Syne, Work Sans and Zen Kaku Gothic New.

## Removed items (owner decision 2026-11-02, announced)

`tweakcn-clean-slate`, `daisyui-light`, `daisyui-fantasy` and `daisyui-caramellatte` were dropped from the corpus because they are near-duplicates. `ingest-tier1.mjs` skips them, so they are not re-ingested.
