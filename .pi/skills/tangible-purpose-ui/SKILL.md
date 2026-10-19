---
name: tangible-purpose-ui
description: Non-negotiable UI rule — never show the user anything without a real, tangible purpose. Use when designing or reviewing any screen, step, card, button, label, or message in this project.
---

# Tangible Purpose UI

## The Rule

**Never show the user anything that doesn't have a real, tangible purpose.**

Every element on screen must answer: *what does the person sitting in front of this screen DO with this?* If the answer is "nothing — it's just information," it does not ship. Delete it or replace it with something actionable.

This rule was mandated by the owner on 2026-09-07 after the v1 welcome wizard shipped dead surfaces ("Your AI is connected." — connected to what? why am I reading this? "Here is what it can do" — six module cards I cannot click, select, or use). It applies forever, to every surface.

## Tests every element must pass

1. **The Action Test** — Can the user click, choose, answer, or act on it right now? Pure status/confirmation screens ("X is connected", "X is done") fail unless the confirmation itself carries a decision.
2. **The Vocabulary Test** — Would someone who has never heard our internal names understand it? "Nucleus chat", "capture", "memory module", "knowledge graph", "brand studio", "module" — internal jargon never reaches a first-run user. Speak in outcomes they care about (building their company), not building blocks.
3. **The Ownership Test** — Does this decision belong to the user here, now? If a question belongs to a specialist surface (e.g. branding questions belong to the branding module, activated later via the chat), it does not belong in first-run onboarding.
4. **The Duplication Test** — Is this step redundant with another step or with the agent's first conversation? If two screens ask or say the same thing, one dies.

## Corollaries

- **Options must be options.** If you list capabilities, they must be selectable/toggleable — a non-interactive list is neither marketing nor UI, it is noise.
- **Modules are invisible at first run.** What is activated behind the scenes is decided by talking WITH the user afterwards (in the agent chat), never shown as a static feature tour.
- **The agent chat is the only user interface.** No buttons that deep-link into module UIs ("capture a thought", "open my memory", "design my brand") — module UIs appear in settings only after a module is activated, never as onboarding destinations.
- **Meaningful choices only.** Real choices = things that change what happens (choose a provider, enter a key, pick OpenRouter for EU/open-source routing, pick a model). Fake choices = "what do you want to do first?" when all paths lead to the same chat.
- **Silence is fine.** When something is already done (e.g. provider already connected), skip silently — do not spend a screen confirming it.
- **Fail loud, never vague.** When we DO show something, it carries exactly the information the user needs at that moment (which AI, which model, what it costs, what to do next).

## Where this bites hardest

- Onboarding / welcome wizard (`src/lib/components/welcome-wizard.svelte`)
- Provider onboarding (`src/lib/components/provider-onboarding.svelte`)
- Empty states, success states, settings pages, agent chat copy
- Any "capability tour" or feature-list temptation

## Review ritual

Before merging any screen, walk it element by element and ask: "If I were a stranger who has to get something done — would I leave this app?" If yes, the screen has failed.
