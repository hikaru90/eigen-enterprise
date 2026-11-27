# AI usage overview — where the company's AI money goes (owner, 2026-11-27)

Source (owner): "I want there to be an AI overview in the company that oversees how much of the
AI is used … usage statistics … broken down by user and by task … an overview of every single
AI-enabled product, be it the assistant, the AI co-workers, the memory, brain, the branding,
website, whatever … which AI gets used where and where cost is going … we have spent $10 in my
company and I have absolutely no visibility where those dollars went."

## Where we start

- **Every gateway call already writes one row** to `activity_call_log` through
  `logActivityCall` (`src/lib/server/activity/log-call.ts`): chat (`llmChatCompletion`),
  embeddings (`llmCreateEmbeddings`), STT, TTS, decisions (`llm-decide.ts`), provider test, plus
  zero-cost tool-call rows from the agent loop. Each row has the billed principal (`user_id`: a
  person or an AI co-worker's user), provider, gateway host, USD (base / markup / total), tokens
  (0187), duration and the trace `group_id`.
- **What a row lacks:** *what it was for* and *which model*. The purpose is only the free-text
  `logContext` folded into `operation` (`llm.chat.enrich_thought_bundle.success(attempt=1)`);
  ~40 call sites pass ad-hoc strings, embeddings/STT/TTS pass none. The model is not stored.
- **What people can see today:** their own usage today vs. the member cap
  (`settings.my_ai_usage`), each reply's cost in the assistant, a co-worker's run cost
  (`coworker_run.cost_usd`). Nothing company-wide.

## Shape

```
call site ──task: AiTaskId──▶ llm-client / llm-decide ──▶ logActivityCall ──▶ activity_call_log
                                                     (task, model columns, 0190)
settings.ai_usage_overview (kernel read tool, owner+admin)  ◀── Settings → AI usage (client)
                                                           ◀── ee CLI / MCP / the agent
```

1. **Task catalog** (`src/lib/ai-usage/tasks.ts`, client-safe): a closed `AI_TASKS` record,
   `id → { product, label }`, and `AI_PRODUCTS` (`id → { label, description }`) — every
   AI-enabled product listed even when it spent nothing. Products: Assistant, AI co-workers,
   Memory (capture, enrichment), Brain (retrieval, answers, grounding, graph), Decisions (Jev),
   Calls, Contacts, Calendar, Handover, Repos, Branding, Website, Email, Speech (STT/TTS),
   Setup (provider test). Embeddings count toward the task that asked for them. The
   task → product mapping is a static table (structure), never inferred from text.
2. **Every model call names its task.** `logContext?: string` on `llmChatCompletion` becomes
   a required `task: AiTaskId`; `llmCreateEmbeddings`, `llmCreateTranscription`,
   `llmCreateSpeech`, `llm-decide` and the provider test take one too. The agent loop takes
   the task from its caller (assistant turn, co-worker turn, durable agent). A call without a
   task does not compile. Console log lines use the task id.
3. **Migration 0190** (0188 presence, 0189 mail reputation): `activity_call_log.task text`,
   `activity_call_log.model text` (both nullable: legacy rows), index on `created_at`.
   Backfill `task` for existing rows by exact match of the legacy `logContext` segment against
   a fixed table in the migration (the $10 already spent becomes visible). Rows that cannot be
   matched (legacy embeddings, `agent_iter_*`) stay `null` and show as **"Not attributed
   (before task tracking)"**: an explicit bucket, never guessed.
4. **Read tool `settings.ai_usage_overview`** (kernel, owner + admin; members get
   `forbidden` — they already have `settings.my_ai_usage`). Input: optional `from` / `to`
   (ISO dates, UTC). Output, LLM providers only (`ACTIVITY_PAGE_LLM_PROVIDERS`), USD =
   `total_cost_usd` (what the company is billed, same as the cap):
   - `totals` { costUsd, calls, promptTokens, completionTokens, cachedTokens }
   - `products[]` — every catalog product (zero included) + the unattributed bucket, each with
     its `tasks[]`
   - `people[]` — every principal with usage: name, `kind: person | coworker`, totals, and a
     per-product breakdown
   - `models[]` — model, totals
   - `daily[]` — date, costUsd per product
   Aggregation is SQL `GROUP BY` (task, model, user, day); folding tasks into products happens
   in code from the catalog.
5. **Settings → AI usage** (`/settings/ai-usage`, owner + admin): period switch (7 / 30 / 90
   days / all), a KPI row (spend · calls · tokens), daily spend stacked by product, then three
   tables: Products (expand → tasks), People & co-workers (expand → products), Models. Restrained
   look (board neutrals, one accent). A `ui-parity` entry points at the tool.

## Rules it keeps

- Observation, not judgment: amounts and counts only. No "top spender", no ranking language.
- No estimates: costs are the gateway-reported ones already in the log.
- No silent removal: `logContext` strings are replaced by task ids; the log rows keep
  `operation` as today, so the Activity page and per-reply costs work unchanged.

## Decisions (owner may veto)

1. Owner and admins see everyone's usage; members only their own (existing tool).
2. A call's product is the product of its task, not of where the work started: brain retrieval
   inside an assistant turn counts as Brain. The People table shows each co-worker's full spend
   with its per-product split, so "what did co-worker X cost" is one row.
3. Cost shown = billed total (incl. markup), the same number the cap and the reply cost use.
4. Legacy rows are backfilled by an exact table in the migration; the rest are shown as
   unattributed rather than guessed.

## Later (not in this phase)

- Who asked a co-worker (join `coworker_run.requested_by_user_id` on `group_id`).
- Budgets / alerts per product.
