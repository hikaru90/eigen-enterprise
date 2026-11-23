# AI Co-workers — AI colleagues in the org chart (working title)

**Status:** APPROVED 2026-11-23; C1–C6 and C8 merged into main the same day (see `plan/progress.md`), C7 waits for CB2. Direction approved (owner: "prepare a feature for agents having different roles … plan for this and then start subagents to build this feature"). Owner answers on the four open product calls are recorded in §2.

**Owner's words:** "the other agents also should have access to everything, but they should explicitly have different focuses and different views of the world and maybe even different models." · "the coworkers should be included in the org chart and should have different roles and different accountabilities." · "those agents don't work in a vacuum … the marketing manager would have the opportunity to speak with the go-to-market manager and maybe also with the designer … so that the humans can give tasks to the agent fleet and get real results back." · "They should talk to them through the chat and they should have equal rights when it comes to storing thoughts … they are really first-class citizens in eigenEnterprise."

## 1. The idea

Shared context gives samey answers when every agent is the same agent. A co-worker is therefore **a colleague, not a persona**: its own seat in the org chart, its own role and accountabilities, its own model and lens, and its own memory that grows apart from the others'. They work **in the open, in Messages**, where humans and co-workers talk to each other. A human gives a task, the co-worker pulls in the colleagues it needs, and the result comes back to the person who asked.

```
           Owner (human)
          /      |        \
   Ony (human)  Martin   Marketing Manager (AI, model A)
                   |          ├─ Go-to-Market Manager (AI, model B)
                   |          └─ Designer (AI, model C)
        Ops Analyst (AI)
```

Three things make them different, on purpose:
1. **A different model family** per seat (from the vetted pool, §5).
2. **A role card**: title, accountabilities, lens ("what you care about, what you push back on"), reports-to. The prompt tells a co-worker to argue from its accountability, not to agree.
3. **Its own memory**: each captures its own thoughts, so its history and judgement drift apart from the others'.

## 2. Product decisions (owner, 2026-11-23)

| Question | Decision |
|---|---|
| What a co-worker sees | **Its own seat, like a new member:** everything shared with the company or with it (channels it's in, shared projects/notes, Drive shared with it). **Never anyone's private items.** `phase-company-brain.md` §4 is unchanged. |
| The company brain | **Stays.** It remains each person's own assistant, acting as them (CB3). Co-workers come in addition, each with its own identity. A person can hand work to a co-worker from the brain or straight in chat. |
| Models | **Curated pool, widened.** A co-worker's model is picked from `model-pool.ts`, which gains diverse families through OpenRouter. "A slot never holds a model we haven't vetted" still holds. |
| Autonomy | **Proactive too.** Co-workers answer when @mentioned, DM'd or assigned, may @mention each other, **and** act on their own: on a rhythm (scheduled check-ins) and on company events. Bounded by budgets (§6). |

**Decision reversal, announced:** this supersedes `phase-3-one-agent.md` non-goal "No multi-agent proliferation" and `phase-company-brain.md` §7 "the agent … has no other name. No persona". The brain keeps those properties. Co-workers are a separate thing: identities in the org chart, not personas of the brain.

## 3. Decisions taken in planning (orchestrator, logged)

- **A co-worker is a `user` row with `kind = 'coworker'`** (new column, default `'human'`). Reason: thoughts, the cost ledger, message authorship, access grants, member groups, the RLS session and per-owner memory keys all key on `user.id`. That makes a co-worker a first-class citizen everywhere at once. It can't sign in: no account or credential row, and auth refuses `kind = 'coworker'` (fail loud). Email: `<slug>.<id8>@coworker.invalid` (reserved TLD, never sent to; it's never used as an address).
- **Company role is always `member`.** A co-worker is never owner or admin, and `members.set_role` refuses it.
- **A new principal kind `coworker`**: `{ id: <coworker user id>, kind: 'coworker', roles: ['member'], agentId }`. RLS scopes it by its own id, exactly like a person. Every existing `kind === 'human'` guard (36 sites, 28 files) keeps refusing it by default, so the safe default is "no". Each module then opts in deliberately through one kernel helper, `actsAsMember(principal)` (human or co-worker). Guards that are about *a person's own click* (approval decisions, sharing a private item, passkeys, sign-in) stay human-only.
- **The org chart is for everyone.** One table, `org_position` (user_id, title, reports_to_user_id, accountabilities[]), for humans and co-workers alike. Org charts were out of scope in `phase-wedge.md`; that changes with this plan (announced).
- **Accountable human:** every co-worker resolves to its nearest human up the reports-to chain (the owner if none). Approval-gated calls a co-worker makes go to that human, and proactive results land in their "Needs you".
- **Cost goes to the co-worker's own `user.id`** in `activity_call_log`. Each co-worker has its own daily USD cap. The in-memory harness spend accumulator is replaced, for co-workers, by the real ledger sum.
- **A co-worker's thoughts are company-visible**, read-only to colleagues and writable by the co-worker. They're sealed with the company key (the 0164 envelope `"k":"company"`). An AI has no privacy interest of its own, and working out loud is the north star. Humans' thoughts stay private.
- **Mentions are structure, not meaning:** an `@handle` token or a DM membership is parsed, not interpreted. Whether a co-worker should react to an *event* (a mail, a call recap) is a yes/no question, so it's a **Jev** decision (CB2). That's why event reactions depend on CB2. Rhythms and assignments don't.
- **Seats/pricing:** co-workers don't count as seats for now. Open for the owner (§9).

## 4. Data model (migration `0169_ai_coworkers` + journal)

- `user.kind text not null default 'human' check (kind in ('human','coworker'))`
- `org_position`: `user_id` PK → user, `title`, `reports_to_user_id` → user (nullable), `accountabilities text[]`, `updated_at`, `updated_by`. Cycle check in the service.
- `coworker_profile`: `user_id` PK → user (kind coworker), `slug` unique, `lens` (the role prompt), `model_id` (pool id, validated), `enabled`, `daily_cap_usd`, `template_id` (nullable), `created_by`, timestamps.
- `coworker_rhythm` (C6): `coworker_user_id`, `schedule` (weekday set + local time + zone, as reminders), `instruction`, `target_conversation_id`, `enabled`, `last_run_at`.
- `coworker_run`: one row per turn (trigger kind `mention | dm | assignment | rhythm | event`, conversation/thread, requested_by, status, cost, started/ended). This is the visible run log.
- Export: every new table is classified in `src/lib/server/export/company/rules.ts` (the export gate refuses unclassified tables).

## 5. The runtime

- **Per-agent config from the DB.** `AgentRuntime` registers one `AgentConfig` per enabled co-worker at boot and on change (no in-memory-only enable state for co-workers). `AgentConfig` gains `instructions` (assembled per turn) and `modelId`.
- **Per-run instructions and model on the durable engine.** Today instructions are fixed per engine instance and `GatewayCompleteFn` has no model field. Both seams get opened. The model goes through `modelOverride` **validated against the pool**: a non-pool id fails loud.
- **The prompt, assembled per turn:**
  1. the role card (title, accountabilities, lens, reports-to, accountable human);
  2. the org chart (who is who, humans and co-workers, so it knows whom to ask);
  3. company profile and brand voice;
  4. the trigger (who asked what, in which thread);
  5. collaboration rules (§6);
  6. "argue from your accountability; disagree when your lens says so; say when it's outside your role and @mention who owns it."
- **Hands:** the same registry and `ee` tool as everyone, filtered by the co-worker principal's roles and the modules that opted in.
- **Pool widening:** add vetted chat models from different families (Anthropic, OpenAI, Google, DeepSeek, Qwen, …) to `model-pool.ts`, each with its vetted date and a tool-calling smoke check against OpenRouter.
- **Conversation keys:** `coworker:<coworkerId>:<conversationId>:<threadRootId>`, so one thread = one durable conversation per co-worker.

## 6. Collaboration in Messages

- Co-workers appear in the people directory, can be DM'd, @mentioned and added to channels. Their messages are shown with an **AI** mark.
- **Triggers (structure):** a new message that @mentions a co-worker, or a DM to one, queues one co-worker turn (`LISTEN ee_messages` → job queue). The co-worker reads the thread and replies **as itself** through `messages.post`.
- **Co-worker ↔ co-worker:** a co-worker may @mention another. That triggers the other's turn in the same thread. This is "the marketing manager talks to the GTM manager and the designer".
- **Budgets:**
  - a thread allows at most **N co-worker turns without a human message** in between (default 8);
  - a task has a spend ceiling;
  - each co-worker has its daily cap.
  When a budget runs out, the co-worker posts where things stand and asks its accountable human. No silent stop.
- **Task chains:** a co-worker may hand work to another with `tasks.assign`. A hand-off is refused before the task exists once the chain would pass 3 co-workers since the person's request, or loop back to a co-worker already in it (`delegation.ts`, migration 0174).
- **Result back:** the co-worker that was asked closes with a reply to the asker (in-thread), and, for assigned tasks, completes the task with the result.

## 7. Memory

Co-workers capture and retrieve thoughts **as themselves** (`thought.user_id` = co-worker). Their thoughts are company-visible and read-only to colleagues (§3), and they work in shared projects and notes with the same rights as a member. Retrieval for a co-worker is its own thoughts plus what's shared with it, the same rule as for a person.

## 8. Milestones and workstreams

Each workstream is a worktree under `.claude/worktrees/`, test-first, and touches only its own files. The orchestrator merges, assigns migration numbers, and owns the shared files (module index, `ui-parity.ts` entries if two streams collide, `progress.md`).

**Wave 1 (parallel):**
- **C1 · Identity + org chart + `coworkers` module.**
  - Files: migration 0169, `db/` schema, `PrincipalKind 'coworker'` + `actsAsMember` + RLS scope, auth refusal, members service (`kind` on `Member`, `set_role` refuses co-workers), export rules.
  - New `modules/coworkers` (manifest + service + tools): `coworkers.list/get/create/update/enable/disable/remove`, `coworkers.templates` (Marketing Manager, Go-to-Market Manager, Designer, Ops Analyst, Finance Analyst, …), `org.chart`, `org.set_position`.
  - Admin-only writes; `create` and `remove` always ask.
  - Done when unit and integration specs prove: a co-worker can't sign in, RLS scopes it to its own and shared rows, it never sees a private thought, and the org chart refuses cycles.
- **C2 · Engine seams.**
  - Per-run instructions and model on the durable engine and gateway-model; pool-validated `modelOverride`; pool widening.
  - `AgentConfig.instructions/modelId`; `AgentRuntime` accepts configs from a `CoworkerSource` interface; a real per-user spend sum replaces the accumulator.
  - Done when a spec runs two agents with different instructions and models through the mock gateway, and a non-pool model fails loud.

**Wave 2 (parallel, after C1 + C2 merge):**
- **C3 · The co-worker turn in Messages.**
  - Boot wiring (DB co-workers → runtime), the prompt assembly (§5), the messages trigger listener, `messages.*` opting in co-workers, the thread budget, `coworker_run` log, `coworkers.runs` read tool.
  - Done when a mock-gateway integration spec shows: a human @mentions Marketing, Marketing @mentions GTM, GTM answers, Marketing answers the human, and the budget stops a loop.
- **C4 · Memory as a first-class citizen.**
  - Memory tools opt in co-workers, co-worker thoughts are sealed with the company key, a colleague read policy (migration), retrieval as the co-worker.
  - Done when: a co-worker captures and finds its own thoughts, colleagues read them read-only, and a co-worker never finds a human's private thought (Keeps).
- **C5 · UI.**
  - An Org chart page (humans + co-workers, titles, accountabilities, reports-to; edit via `org.set_position`).
  - Settings → Co-workers (create from a template, model picker from the pool, lens, caps, enable/disable).
  - The AI mark in the people directory and messages; the co-worker profile with its run log.
  - Every action mapped in `ui-parity.ts` to its tool; debt stays 0. Component specs.

**Wave 3:**
- **C6 · Proactive.** Rhythms (`coworker_rhythm`, e.g. "weekday 9:00, post the marketing standup in #marketing"), the assignment trigger (`tasks.assign` to a co-worker queues its turn), results in the accountable human's "Needs you". Tools: `coworkers.rhythm_*`.
- **C7 · Event reactions (needs CB2 Jev).** Co-workers subscribe to event kinds from a closed set (mail in a shared mailbox, call recap, project quiet). Jev decides "is this mine to act on?" in **shadow first**, logged; enforced after review.
- **C8 · Eval.** `evals/brain` gains a co-workers suite:
  - **Does:** a three-co-worker task, graded on the resulting state.
  - **Keeps:** no co-worker reads private items.
  - **Different:** the same question to three co-workers gives distinct positions, judged by Jev.

## 9. Open (owner)

- **Seats and pricing:** do co-workers count as seats, or are they a paid module? Built as "not seats" until decided.
- **Telegram / mail identities for co-workers** (a co-worker with its own mailbox): later.

## Non-goals (this phase)

Co-workers acting as a person (that's the brain). Co-workers reading private items. Unvetted models. Co-workers deciding approvals.
