# The First Conversation

The Tag-1 agent flow for the Company OS. This is the moment `the-wedge.md` calls the make-or-break: *"I described my company in a conversation, and 10 minutes later it was running on my own VPS."* The architecture in `company-os-architecture.md` makes this flow *possible*; this document makes it *good*.

## 1. Why this flow is the wedge

The install is one command. The first conversation is the product. If the conversation is a form with agent cosmetics, the wedge is dead — the founder could have used Wix. The conversation has to feel like co-founding: the agent asks sharp questions, builds from real answers, and shows something worth shipping before attention runs out.

## 2. The flow

| Phase | Goal | Time budget |
|---|---|---|
| P0 — Arrival | Confirm substrate is alive | < 30 s |
| P1 — Interrogation | Get the raw material of a company | ~4 min |
| P2 — First render | Build the website module | ~3 min (streamed) |
| P3 — Reveal | Show, don't tell | < 30 s |
| P4 — Iteration loop | Conversation-driven edits | ~2 min |
| P5 — Handoff | Ownership moment + next steps | < 30 s |

Total: **≤ 10 minutes** to a running, personalized, owned website.

### P0 — Arrival

The agent opens the session. No menus, no dashboard.

> "Welcome. Your OS is running — I checked: Postgres ✓, Redis ✓, module runtime ✓. We're going to set up your company in the next few minutes. First: what's your company called, and what do you do in one sentence?"

Fail fast: if the substrate is broken, say exactly what and offer the fix command. Never fake readiness.

### P1 — Interrogation

**Maximum 7 questions. One at a time. Never a form.** Each question earns its place by directly feeding the website module:

| # | Question | Feeds |
|---|---|---|
| 1 | Name + one-sentence what | Hero, title, meta |
| 2 | Who is it for? | Copy tone, sections |
| 3 | What should a visitor do first? (book, buy, write) | Primary CTA |
| 4 | Show me tone: paste an old email/post, or 3 adjectives | Voice model |
| 5 | What makes you different? (one sentence, their words) | Differentiator section |
| 6 | Anything to show? (logo, photos, links) | Assets — optional, skippable |
| 7 | Domain in mind? | Setup, can be deferred |

Rules:
- **Never invent content.** If an answer is thin, ask a *better* question, don't fabricate. Every sentence on the generated site must trace to something the founder said.
- **"Don't know" is a valid answer.** The agent then proposes *two* concrete options derived from the other answers and asks which feels right — a choice, not a blank page.
- **Skip anything skippable.** Questions 6–7 may be skipped entirely; the module ships with placeholders that are visibly placeholders.

### P2 — First render

The agent installs + configures the website module — visibly:

> "Got it. I'm setting up your website now — writing the copy in your voice, building the sections around your goal (getting booking requests). Watch this space."

- Stream progress in one-line steps: `→ installing website module` · `→ writing hero copy` · `→ composing sections`. No spinners with no text.
- The website is stored as a git repo (per the module contract) from the first render. Even version 0.1 is committed.
- Eigen Mesh is wired in from this moment: brand answers (tone, differentiator, audience) go to memory, not just into the template. The site *remembers the company*, which is the flywheel hook.

### P3 — Reveal

The agent gives a preview URL and then *stops talking* — no tour, no feature list.

> "Your website: https://preview.<domain> — have a look. What stands out to you?"

The founder's first reaction is the product telemetry. Whatever they say next drives P4.

### P4 — Iteration loop

Pure conversation: "make the headline punchier", "the color feels corporate", "add a section about pricing". Each edit is an agent tool call to the module, re-rendered, re-committed. The loop ends when the founder says something in the family of *"I would ship this."*

Cap the loop at ~3 iterations before offering: "Want to park it here and refine later? It's saved — it's yours." Ownership includes the right to stop.

### P5 — Handoff

The ownership moment, made explicit:

> "Done. Your website lives at `<domain>`, and it's yours: git repo at `~/modules/website` on your server, every version committed. It runs on your machine; nobody can take it away.
> Next, whenever you want: a contact form (needs email — Owlery is already installed), or a shop for your products. Just tell me in a sentence."

Then the agent goes quiet. The flywheel (wedge doc, step 2–4) starts with the *founder* wanting the next module — not the agent upselling it.

## 3. Design rules

1. **One question at a time.** Two is a form. Forms are what we're against.
2. **Stream everything slow.** Any step > 2 s gets a named progress line, not a spinner.
3. **Never invent.** Site copy derives from answers; placeholders are visibly placeholders. This is a hard rule — it's the difference between "generated" and "fabricated", and founders smell the difference instantly.
4. **Choices over blanks.** When the founder doesn't know, propose 2 concrete options. A blank page is a step backward from Wix.
5. **Show, then ask.** Reveal before iterating. Concrete artifacts get better feedback than abstract questions.
6. **The agent proposes, the founder disposes.** For everything structural (domain, CTA), the agent recommends with a reason and lets the founder decide.
7. **Silence is fine.** After the reveal, don't fill the pause. The founder looking at their website *is* the moment.

## 4. Success criteria

| Metric | Target |
|---|---|
| Install → live personalized site | ≤ 10 min |
| Questions asked | ≤ 7 |
| Questions per turn | 1 |
| Site copy traceable to answers | 100 % |
| Invented facts | 0 |
| Founder reaction at reveal | voluntary positive signal (e.g. laughs, "wait, that's good") |
| Second-module mention by *founder* (not agent) within session | target yes |

The only metric that really matters: **would the founder ship this?** Everything else is instrumentation for that question.

## 5. Risks & edge cases

| Risk | Mitigation |
|---|---|
| Output quality is embarrassing (the honest risk from `the-wedge.md`) | The voice model from Q4 (pasted sample > 3 adjectives). Site templates must have a "handmade" register, not "AI startup" register. Pre-launch eval: 20 fake companies through the flow, human-judged. |
| Undecisive founder ("whatever you think") | Agent makes *all* decisions, marks them, offers one review pass at the end. Never bounces the question back. |
| Non-German/English language | Website module generates in the conversation language from the start; language detection is explicit ("Should the site be in German or English?") — Q2.5, only if ambiguous. |
| Missing assets (no logo, no photos) | Typographic/monogram fallback, clearly intentional, not placeholder-gray. Q6 being skipped must not degrade quality. |
| Deploy works but render fails mid-P2 | Agent shows partial output + exact error + fix path. A broken first conversation with *honest* errors beats a fake-complete one. |
| Founder leaves mid-conversation | State persisted after every answer (Eigen Mesh); re-entry resumes: "You were setting up <company> — where were we?" Nothing is lost, ever. |
| Legal/pricing claims invented by the LLM | Hard filter: no prices, legal claims, or certifications unless literally provided by the founder. |

## 6. What this flow requires from the architecture

Mapping to `company-os-architecture.md`, this flow needs — in build order:

1. **Agent harness with the question/answer loop + streaming** (Phase 1 core loop)
2. **Website module** installable in P2, storing output as git (Phase 1's "one module")
3. **Eigen Mesh wired for brand memory** from day one (shared-service integration)
4. **Preview routing** through Caddy (`preview.<domain>`) (Phase 2 shell/routing)
5. **Owlery** only at the point the founder asks for the contact form (Phase 3)

Everything else in the architecture can wait. If the first conversation works, the rest of the OS has a reason to exist. If it doesn't, nothing else matters.
