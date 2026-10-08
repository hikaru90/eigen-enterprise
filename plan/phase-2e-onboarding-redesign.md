# Phase-2e Plan — Onboarding redesign: the boot sequence

**Trigger:** owner review of the phase-1e welcome wizard on 2026-09-07. Verdict: the wizard
treated onboarding as an afterthought — dead surfaces, internal jargon, module tourism,
form-wizard framing. Ruled: onboarding is a valuable first-run experience ("Her"-grade boot),
the chat is the only interface, and nothing may be shown without tangible purpose
(see `.pi/skills/tangible-purpose-ui/SKILL.md` — permanent rule).

## What dies (and why)

| Removed | Reason (tangible-purpose test it failed) |
|---|---|
| "Step X of 5" counter | Form-wizard framing; the sequence is an experience, not a form |
| "Here is what it can do" capability list | Six cards the user cannot click, choose, or use. Internal jargon (Nucleus, capture, knowledge graph, brand studio). Modules are invisible at first run — activation is decided by talking with the agent later |
| "Your AI is connected." confirmation screen | Pure dead surface — states a fact, asks nothing, offers nothing |
| Founding-interview step (tone / company name / positioning) | Belongs to the branding surface, activated later. Duplicated the agent's first conversation (`plan/first-conversation.md` P1). **Endpoint `/api/onboarding/founding` + tests stay** — the branding flow will reuse them (owner decision: option A) |
| "What do you want to do first?" destination buttons (capture/memory/brand/graph) | The agent chat is the only user interface; deep links into module UIs violate that. Fake choice — every path led to the same place |

## The boot sequence (what ships)

Full viewport width (`w-full` everywhere — no max-width container on the page). Monochrome.
Centered vertically in the remaining space (fixes the min-h-dvh-inside-header skew bug).

1. **Boot** — dark screen; a point of light blooms into a breathing orb. Soft synthesized
   swell. Any click/key skips ahead.
2. **Hello** — "Hello." (or "Hello, {name}." when the name is known — no ask again).
3. **Name** (only if unknown) — "What should I call you?" One input, Enter or Continue.
   Persisted via new `display_name` column. Blank = no name, no call. Fail loud inline.
4. **What this is** — two lines, one at a time, no jargon:
   "This is the operating system for your company." →
   "You talk. It builds — your website, your work — and it remembers everything. Nothing
   happens without your approval."
5. **The mind** (only when `providerReady === false`; silently skipped otherwise) —
   "First, it needs a mind to think with." → the existing `ProviderOnboarding` wizard
   (subscription / API key / OpenRouter — real choices). Its own connected summary
   (provider · model · latency) is the confirmation. Done → handoff. No extra screen.
   "Skip for now" stays as a muted corner link on every act (same semantics as before:
   completing = never nagging again; the provider gate still catches a provider-less
   product — no silent degradation).
6. **Handoff** — orb dissolves into the chat input; the chat opens with a seeded,
   deterministic agent turn (no LLM call):
   *"Hello{name}. Your company's OS is getting set up — that happens by talking. So:
   what's your company called, and what does it do?"*
   Honest by design: the setup IS the first conversation (first-conversation.md P0–P1).

**Sound:** Web Audio synth (no assets, no deps), **on by default** (owner decision) — boot
swell, act pulse, connect chime. AudioContext starts on first user gesture; `ee-sound`
localStorage flag; mute toggle in the home settings menu. `prefers-reduced-motion` → no
motion; sound still respects the mute flag.

## Server changes

- `drizzle/0083_user_display_name.sql` + journal idx 83: `user_preference.display_name text`.
- `brain.schema.ts`: `displayName` column.
- `onboarding/welcome.ts`: `setWelcomeDisplayName(userId, name)` (upsert, fail loud).
  `resetWelcomeOnboarding` does NOT wipe the name — identity is not tour state.
- New `POST /api/onboarding/name` — trim, ≤ 80 chars, 401 unauth, fail loud.

## Files

- `src/lib/sound/boot-sound.ts` (new) — synth + mute flag.
- `src/lib/components/welcome-wizard.svelte` — full rewrite (acts, orb, sound hooks, skip).
- `src/lib/components/welcome-wizard.svelte.spec.ts` — rewritten for the new flow (TDD).
- `src/routes/(nucleus)/+page.svelte` — full width, header fix, seeded greeting handoff.
- `src/routes/(nucleus)/+page.server.ts` — also load `displayName`; spec updated.
- `src/lib/components/home-settings-menu.svelte` (+ spec) — sound on/off toggle.
- `src/routes/api/onboarding/name/+server.ts` (+ spec, following `welcome/server.spec.ts`).
- `src/routes/e2e/onboarding-welcome.e2e.ts` — rewritten: happy path (name → identity →
  mind via API save → seeded chat), skip path (gate still holds), restart path
  (name persists, personalized hello).
- Untouched: provider-onboarding wizard + its e2e, founding/welcome/reset endpoints + specs,
  capture-onboarding-overlay.

## Ownership decision logged

Owner mandated (2026-09-07): never show the user anything without real tangible purpose;
modules are invisible at first run; agent chat is the only interface. Captured permanently in
`.pi/skills/tangible-purpose-ui/SKILL.md`.
