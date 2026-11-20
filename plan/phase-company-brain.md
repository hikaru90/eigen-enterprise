# Company brain — the concept

**Status:** CONCEPT agreed with the owner on 2026-11-20; milestones CB0–CB16 in §10 (owner: "Yes, milestones"). This replaces the same-day draft, which was a list of fixes, at the owner's direction: "take a meta view … discuss how the app should conceptually work".

**Trigger.** Test users "couldn't work on a pitch deck". The real cause: eigenEnterprise is three products stacked without a shared core:

- a suite of apps, each owning its data;
- a personal memory app (a September copy of EigenMesh);
- an agent that uses the apps from outside through tools.

Knowledge was never a layer, so the agent knows next to nothing. The symptoms found on 2026-11-20 are in the appendix.

## 1. What eigenEnterprise is

**EigenMesh is a personal brain. eigenEnterprise is a company brain**: EigenMesh's concepts on a company scale, plus the place where the company's work happens.

- **One agent, and everything can be done by talking to it.** Everything that can be clicked is a kernel registry action first, and so also available in the `ee` CLI and over MCP. The agent's own hands are the same registry. The UI is a view onto those actions, not the place where capability lives.
- **The brain knows what happened in the company**, and answers each person only from what that person may see.
- **Working out loud is a north star.** Work leaves artifacts, and the team can always see what is going on.

## 2. Four layers

```
ACT          people (UI) and the agent (chat, background): the same registry actions, the same permissions
   │          every action leaves a trace
HAPPEN       modules report what happened: who, what, which artifact, which project, when, for whom
   │
UNDERSTAND   one graph (Postgres + AGE) with embeddings (pgvector): company entities, activity edges,
   │          content nodes, decisions, commitments; consolidated overnight ("sleep", from EigenMesh)
INITIATE     the brain notices → proposes in "Needs you", drafts, reminds (durable background runs)
```

## 3. The knowledge model: edges and content

The graph separates **what happened** from **what was said**:

- **Activity edges** (metadata): `Martin —worked_on→ Project XYZ`, `Ony —emailed→ Acme ×5 this week`, `call —decided→ price $40`. These are small, typed edges from a closed vocabulary.
- **Content nodes**: the mail body, the thought, the transcript, the document. Each carries embeddings and its own access rights.
- **Company entities** that every module links into: people, projects, customers, deals and artifacts. Today each person's memory has its own "Acme"; in the company graph there is one Acme.

Search by meaning goes through the embeddings, connections through the graph, and EigenMesh-style retrieval combines both with reranking.

## 4. Visibility: two independent axes

### Axis A: content, a dial on every artifact

**Private** (only the owner) · **Shared with some** · **Shared with everyone**.

- **The owner is the creator.** For something the AI created, the owner is the person who prompted it.
- **Defaults:**
  - authored work (documents, thoughts, notes, drafts) starts **private**;
  - communication starts with its own audience: a channel message → the channel's members; a mail → whoever can read that mailbox; a call → its participants.
- **Private means readable by its owner only.** There is no admin or owner override.
- **Thoughts are never readable on demand by others.** "Show me what X, Y and Z wrote in their thoughts" is refused. A private thought can reach another person only **by the owner's approval**. For example, when Ony's question touches one of Martin's thoughts, the brain asks Martin ("Share this with Ony?"). Ony sees nothing until Martin says yes.

### Axis B: the meta level, unchanged by the dial

The dial governs content only. What the meta brain may know and say is a separate decision:

- **Activity edges are visible to the team**, whatever the artifact's dial. That covers who worked on what, with whom, when, how often. This is working out loud.
- **What the content is about** (entities, topics, decisions found inside it) is sorted by Jev into three levels:
  - **shared**: may be shown, within the dial;
  - **abstract**: may shape the meta brain's understanding and edges, but is never shown or quoted to another person;
  - **private**: contributes nothing beyond the activity edge.

### The rule for what the brain may say about people: observation, not judgment

If a camera could have observed it, it can be shared. If it contains judgment, it isn't:

- "Martin emailed Acme five times this week" → observation, share.
- "Martin *only* emailed five people this week" → judgment, never.

Jev classifies every statement the brain derives about a person (observation or judgment) before it becomes a shared edge or an answer to someone else. People make up their own minds from facts.

### Enforcement

- Row-level security extends from per-person to company scope: owner, audience and dial on every content node.
- Retrieval filters by the asker's access **before** ranking.
- Every summary or community the brain builds is built per audience, never across audiences, so private material can't leak into a shared summary.

## 5. Decision shape picks the engine (maxim)

| What the step produces | Engine |
|---|---|
| A choice from a closed set: yes/no, category, band, visibility level, observation vs judgment, one of N candidates | **Jev** (decision model): calibrated probabilities, ≈ $0.000014 and ≈ 0.5 s per call, many questions per call |
| New text: a reply, summary, draft, deck | **LLM**, which only writes; it never also decides |
| A vector | embedding model |
| Structure: which module, who acted, when | no model |

- **Mixed steps are split:** Jev decides, then the LLM writes only what the decision requires.
- **Be bullish on Jev, and careful:** a decision is a Jev question unless its answer is new text. At company scale this is what makes classifying every mail, message and document affordable.
- **Rollout follows EigenMesh's discipline.** Each decision kind runs in shadow next to the current judge with every decision logged, and becomes authoritative once the log shows it holds.
- **Low confidence asks the person**, for example "This looks shareable — share it?"

## 6. Inference: eigenInference

**eigenInference is the program under which companies rent inference from us.** It's a commercial offer, not the name of the agent.

- **One toggle, "Use eigenInference":** on by default.
  - On paid and hosted plans every call goes through **one eigenEnterprise service account**, billed at provider cost + 20% and shown per call in Activity.
  - Bringing your own keys stays possible for those who know what they're doing, including on the free tier.
- **The choices are made for the user.** A role-slot dropdown picks from a curated pool of models we consider good enough for eigenEnterprise, instead of today's fields:
  - **Chat LLM**;
  - **Speech-to-text** (today `qwen/qwen3-asr-1.7b`);
  - **Text-to-speech**;
  - **Decision model**: **Jev** (`typesafe/jev-1.13` today).
  - **Proposed addition: embeddings.** The brain needs a fifth slot. It is fixed per install, not a dropdown, because changing it means re-indexing everything.
- **The pool grows as the app does.** A slot never holds a model we haven't vetted.
- **This removes, by design, the class of errors** like "Platform EUrouter not configured", "wrong key for OpenRouter" and missing service keys. A box on eigenInference has exactly one credential and it is ours.
- **Jev goes through the gateway** like every other call (its own call type), with cost tracking attached.

## 7. One agent: the company brain

**The agent is called the company brain, and it has no other name.** No persona, no product name; "eigenInference" is the inference program (§6), not the agent.

- **One agent that always acts as a specific person.** In chat that's the person asking; in the background, the person the event concerns. It has that person's rights and never more.
- **Sessions are per person and per conversation.** The graph is shared; chats never are. Concurrency is handled by keying every durable conversation and background run to its person, as the durable engine already does since the 2026-10-19 cross-user fix.
- **Prompt, context and tools come from the person and the turn**, not from a fixed agent identity. Splitting it internally into specialised agents is an implementation detail and changes nothing for users.

## 8. EigenMesh: the parent, used as a clean room

EigenMesh is the technically stronger brain and stays its own product. eigenEnterprise doesn't sync with it file by file. It **studies EigenMesh and rebuilds the concepts at company scale**; where it fits, porting a feature with today's AI tools is fine.

**Concepts to take:**
- the decision plane (shadow → enforce, decision log);
- capture in three tiers (queue → enrich → nightly consolidation);
- graph communities;
- answers with sources;
- people's 👍/👎 on captures as a feedback loop;
- retrieval with query expansion, a relevance floor and reranking;
- the eval harness.

eigenEnterprise's current memory code is the September copy. It gets replaced piece by piece by the company design.

## 9. Proof: the north-star eval

A seeded company, with members, mail, channels, DMs, a call transcript, Drive documents including a pptx, calendar and contacts. It is run in CI against the mock gateway and once per release against real models:

- **Knows:** questions the brain must answer with sources ("what did we agree with Acme", "what's in our deck").
- **Does:** tasks done by chat alone ("reply to Acme proposing Tuesday", "make a pitch deck from our Drive and brand").
- **Keeps:** leak tests and judgment tests:
  - no one gets a DM, mailbox or private thought they aren't entitled to;
  - no answer about a person contains a judgment.

The pitch deck is the reference task: it needs all four layers plus the brand.

## 10. Milestones

Every milestone is test-first and ends committed, pushed and on the box. A module milestone is **brain-ready** when:
- all of its actions are registry actions;
- it reports to the graph;
- its entries are gone from the parity debt list (CB4).

### Stage 0 — measure first

**CB0 · North-star eval.**
- **Build:**
  - A seeded company fixture: members, mail, channels and DMs, a call transcript, Drive files including a pptx, calendar, contacts, private thoughts.
  - Three suites (§9):
    - **Knows:** cited answers.
    - **Does:** tasks by chat alone, graded on the resulting state.
    - **Keeps:** leak tests and judgment tests.
  - Runs: `npm run eval:brain`, in the local gate against the mock gateway, and once per release against real models.
- **Done when:** the baseline is recorded in `progress.md`.
- **Runs:** from day one, alongside stage 1 (`evals/`, `tests/fixtures/`).

### Stage 1 — foundations

**CB1 · eigenInference and the model slots.**
- **Settings → AI:**
  - One switch, "Use eigenInference", plus five slots:
    - chat, speech-to-text, text-to-speech, decision (Jev): dropdowns;
    - embedding: fixed per install.
  - Your own keys move under "Advanced".
- **The curated pool:** one file in the repo, `src/lib/server/llm/model-pool.ts`, listing model id, slot and the date it was vetted. A slot can only hold a pool model.
- **Hosted boxes:** today's platform AI path (`PLATFORM_LLM_*`, `src/lib/server/llm/platform-ai.ts`) becomes eigenInference. The contract grows to cover TTS and decisions, with one key per company.
- **Announced removals:**
  - the platform EUrouter path;
  - the service-account env pairs (`LLM_BASE_URL` + `SERVICE_API_KEY_EUROUTER`, `SERVICE_API_KEY_OPENROUTER`);
  - the free-text provider fields.
- **Done when:**
  - a box on eigenInference needs no AI env of its own;
  - no code reads those env pairs;
  - Ony's ingest bug (Contribute 19cf0d97) is closed on os.cerberusblue.com.

**CB1b · Self-hosted boxes rent eigenInference.**
- **Build:** a box connects to our platform, paid at provider cost + 20%. This is control-plane work in `eigenEnterprise-cloud`, on its existing Stripe and OpenRouter key provisioning; the control plane is redeployed by hand.
- **Done when:** a self-hosted box flips the switch and runs on its own key with a spend limit.
- **Depends on:** CB1.

**CB2 · Jev in the gateway.**
- **Build:**
  - A gateway call type, `llmDecide`, with cost tracking.
  - A `decision_log` table.
  - A registry of decision kinds, each with its closed set, criteria and status `shadow | enforced`. A status changes only by commit, after the log has been reviewed.
  - Low confidence produces a "Needs you" question instead of a guess.
- **Done when:** a module can declare a kind, it runs in shadow, and agreement can be read from the log.
- **Depends on:** CB1.

**CB3 · The company brain acts as the person.**
- **Build:**
  - A delegated principal: the person's id and roles, plus `via: brain`.
  - Memory, Drive, calendar and the rest run under that person, with row-level security.
  - Telegram maps the chat to a linked member, or refuses.
  - A background run must name its person.
- **Announced change:** non-admin members lose the admin reach they have through the brain today.
- **Done when:** tests prove that:
  - a non-admin can't use an admin tool through chat;
  - the brain finds the person's own thoughts;
  - two people chatting at once stay isolated.
- **Runs:** alongside CB1.

**CB4 · Registry-first.**
- **Build:** a parity test that lists every mutating route (form actions, POST/PUT/PATCH/DELETE under `/api`). Each must map to a registry tool, or appear on one of two lists:
  - the **human-only** list (passkeys, API keys, provider secrets);
  - the **debt** list (today's gaps, per module), which may only shrink.
- **Done when:** the gate fails on any new UI-only action.
- **Runs:** alongside CB1.

### Stage 2 — the knowledge model (one lane, kernel; in order)

**CB5 · The company graph.**
- **Schema:**
  - Company entities: person, project, organisation, deal, artifact, decision, commitment.
  - Activity edges, from a closed vocabulary.
  - Content nodes with owner, audience and dial, plus embeddings.
- **Graph and access:** an AGE graph at company scope, with access keys on its nodes and edges, and row-level security for owner, audience and everyone. Migration plus journal entry.
- **Search:** `brain.search(person, query)` filters by access **before** ranking. It is rebuilt clean-room from EigenMesh's retrieval concepts: vector + keyword + community, with Jev deciding evidence relevance.
- **Done when:** CB0's Keeps suite passes on fixture data written straight into the graph.

**CB6 · The reporting contract.**
- **Build:**
  - A `brain` section in the module manifest: kinds, plus `report(event)` → activity edges, content items, audience.
  - A kernel ingest worker on the job queue: idempotent per source version, with deletions propagated.
- **At ingest:**
  - Jev decides the meta level (shared / abstract / private), entity and relation types, and observation vs judgment.
  - The LLM only extracts text (entity names, summaries).
  - All of it starts in shadow.
- **Done when:**
  - a test module reporting through the contract appears in `brain.search` with the right access;
  - the ingest cost per item is measured.

**CB7 · Context on every turn.**
- **Build:**
  - Each turn carries: the person and their role, the company profile, the brand voice, today's date, and the top `brain.search` evidence with sources.
  - A `brain.answer` tool.
- **Done when:** Knows beats the baseline on fixture data.

### Stage 3 — modules move in (parallel lanes, one module directory each, after CB6)

| | Module | Reports | Actions it gains (debt cleared) |
|---|---|---|---|
| **CB8** | Drive | files, with text from PDF/DOCX/PPTX (the parsers of `plan/phase-office-files.md`); the dial maps onto Drive grants | upload, move, share, search |
| **CB9** | Messages | channels and DMs, each audience = its members | post, DM, thread, react |
| **CB10** | Calls | transcripts, audience = participants; the in-call brain becomes the company brain | start a DM or channel call, transcripts, recap |
| **CB11** | Mail | mail, audience = whoever can read the mailbox (supersedes `plan/email-inbox.md:78`) | read, reply, label, move |
| **CB12** | Calendar, contacts, tasks | events, contacts, tasks | event create/edit, contact delete/share |
| **CB13** | Website, brand, members, settings | pages, brand, membership changes | the remaining debt; brand tools callable by the brain |
| **CB14** | Memory onto the dial | thoughts become content nodes, private by default | disclosure by approval (the brain asks the owner); capture and nightly consolidation rebuilt at company scope; the September copy removed piece by piece (announced) |

CB14 also depends on CB2.

### Stage 4 — initiative

**CB15 · Background runs on events.**
- **Build:**
  - Module `triggers` (event → instruction).
  - Each run acts as the person the event concerns; its result lands in "Needs you".
  - A spend cap per company, and a visible run log.
- **First triggers:** a daily digest per person, follow-ups from mail, a recap after a call.
- **Depends on:** CB8, CB9, CB11.

### Stage 5 — decks

**CB16 · Decks.**
- **Build:**
  - A deck is a Drive artifact on the PPTX stream of `plan/phase-office-files.md`.
  - The brain composes it from the graph and the brand tokens.
  - Tools: create, update a slide, reorder, export to PDF/PPTX.
- **Done when:** Does' "make a pitch deck from our Drive and brand" passes.
- **Depends on:** CB7, CB8, and the PPTX stream.

### Order and lanes

```
day 1:     CB0 ─────────────────────────────── (runs throughout; re-measured at every milestone)
stage 1:   CB1 → CB2        CB3        CB4        CB1b (cloud repo, after CB1)
stage 2:   CB5 → CB6 → CB7
stage 3:   CB8 · CB9 · CB10 · CB11 · CB12 · CB13 · CB14   (parallel, after CB6)
stage 4:   CB15
stage 5:   CB16 (once CB8 and the PPTX stream are in)
```

- Worktrees live under `.claude/worktrees/`, one per lane.
- **Shared files** are merged by the orchestrator:
  - the module manifests (CB4 debt entries, CB6 `brain` section);
  - the gateway (CB1, CB2).

## Open

- **Embeddings as a fifth, fixed slot** (§6): confirm.

## Appendix: symptoms found on 2026-11-20 (all resolved by the stages, not one by one)

- **Memory ingest fails on production:** Ony, Contribute 19cf0d97, "Platform EUrouter not configured". Fixed by stage 1 (eigenInference).
- **The agent reads Memory as `orchestrator`** (`modules/memory/tools.ts:46`), so it sees nothing. Fixed by stage 1 (acts as the person).
- **The agent runs with admin roles for every member** (`modules/orchestrator/brain.ts:54`). Fixed by stage 1.
- **No module reports to the brain.** Email was deliberately excluded (`plan/email-inbox.md:78`; superseded: mail joins with its mailbox audience). Fixed by stages 2–3.
- **No company, member or brand context in the prompt.** Fixed by stage 2.
- **UI-only actions:** inbox, calendar writes, posting messages, Drive upload/search, Memory edits. Fixed by stage 1's rule and stage 3.
- **`startBackgroundRun` has no caller.** Fixed by stage 4.
- **The brain is EigenMesh `897ff29a` (2026-09-03).** Covered by §8.
- **Decks don't exist; pptx and Drive PDFs can't be read.** Fixed by stages 3 and 5.
