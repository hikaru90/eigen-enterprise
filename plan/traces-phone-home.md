# Traces phone-home (concept, not started — waiting for the owner's 3 answers in §6)

Owner wish `3b18c845`: "We need to capture all traces from every box to make our product better."

Goal: every box tells the makers **how the product behaved** (which tool, which model, how long,
what failed, on which version) without telling them **what the company did** (whose email, what
prompt, which customer). Same idea as `plan/contribute-phone-home.md`, same transport, a second
payload.

## 1. What traces a box has today

| Trace | Where | Fields | Content inside? | Volume (estimate, 10-person company) |
|---|---|---|---|---|
| **LLM call log** | `activity_call_log` (Postgres, `brain.schema.ts`); written by `logActivityCall` in `llm-client.ts` per attempt | `operation` = `llm.chat.<logContext>.success\|error(attempt=n)`, provider, gateway_host, cost (base/markup/total), duration_ms, group_id (trace), user_id, `context` = first user message + error text, ≤300 chars | **Yes**: `context` holds the prompt start (Memory text excluded by `LlmContentOrigin`) | 500–3,000 rows/day; no retention, grows forever |
| **Tool calls** | `kernel_events` type `tool.executed` (`registry.ts`) | tool, auditClass, ok, error message, `activity` sentence ("Emailed Acme…"), durationMs, principal_id, via (brain/agent) | **Yes**: activity sentence, error text | 2,000–10,000/day; no retention |
| **Other kernel events** | `kernel_events` (approval.*, module events, contribute.*) | type, principal, source, payload jsonb | Often (payloads) | 100s/day |
| **Co-worker runs** | `coworker_run` | trigger_kind, status, stop_reason (closed enums), cost_usd, triggered/started/ended, `error` text, delegation_chain | `error` text; ids link to messages | 10–200/day |
| **Decisions (Jev)** | `decision_log` | kind, module, outcome, jev choice/confidence/distribution, model, cost, duration; `input` jsonb (redacted of secrets only) | **Yes**: `input` | 100s–1,000s/day |
| **Background jobs** | `user_job_queue`, `heartbeat_run`, `consolidation_run`, `graph_sync_job`, `mail_jobs`, `eval_run/event` | job_type, status, attempt_count, `last_error` text, timings | `last_error`, payload | 100s/day |
| **Retrieval quality** | `retrieval_quality_event` | surface, top_k, weights, result counts, semantic shares | No — already numbers only | 100s/day |
| **Error reports** | `errors/report.ts` builds `{error, agent{tool, input(redacted), code, details, cause}}` | Returned to the page, **not stored** | Input + cause chain | n/a |
| **Server journal** | journald (stdout of the os units) | `[llm.chat:<ctx>]` full prompts and responses for non-Memory calls, failures, stacks | **Yes, the most** | rotated by journald |
| **ee journal** | `/var/lib/ee/journal.json` + upgrade jobs (`ee/src/journal.ts`, `upgrade-job.ts`) | ≤500 events (type, workload, message), deploy records, upgrade `outcome {release, from, step, ok, reason, rolledBack}` | `message`/`reason` free text, mostly machine | tens/day |
| **Token counts** | in process only (`trace-context.ts`) | tokens per trace | No | **never stored** |

**Already leaving a box today:**

- Contribute proposals → `os.cerberusblue.com/api/hub/contributions` (scrubbed, allowlisted).
- Module run state → `/api/hub/modules/:id/run` (`hub_module_runs`: install, module, bundle, state).
- Managed boxes only: the fleet poll report (version, health, reconcile error, seats, hosts, disk,
  backup, mail domains) → control plane.
- PostHog `$ai_generation` from `llm-client.ts` **if** `POSTHOG_API_KEY` is set (the installer never
  sets it). It would carry prompt text, output text, model, tokens and the gateway base URL to a
  third party. This is a legacy path from eigen with no allowlist.
- Upgrade outcome reports are **decided** (phase-upgrades §9 Q4: on by default, with a switch) but
  **not built**.

**Gaps that block useful traces:**

1. `activity_call_log` has no model id, no token counts and no structured outcome; they are packed
   into the `operation` string or lost.
2. Tool calls and LLM calls cannot be joined into one run: only chat replies, capture and MCP run
   inside `runWithTrace`; co-worker runs, jobs and decisions don't, and `tool.executed` has no trace id.
3. `logContext` is a free string, not a closed list.

## 2. Product signal vs company data — three tiers

Each box is one company's single-tenant system. Its traces are full of the company: prompts, tool
inputs, email addresses, names, customer domains. The rule is the same as for proposals: **only
named fields leave, each from a closed set or a number**. A field that can hold free text is Tier B
or C, never A.

### Tier A — structural signals, safe by construction

Every value is an enum from the code, a number or a version. No free text field exists in the schema.

| Field | Source | Allowed values |
|---|---|---|
| `kind` | span type | `run · llm_call · tool_call · decision · job · upgrade · module_run · error` |
| `run_kind` | what started the run | `chat_reply · coworker:<trigger_kind> · capture · mcp · job:<job_type> · upgrade` |
| `tool` | registry | a core tool name from `contracts/core-api.lock.json`, or `<module_id>.<tool>` of a hub-receipted module (public under R6); anything else → `other` |
| `log_context` | gateway | the closed `LLM_LOG_CONTEXTS` list (T0) |
| `model`, `provider_kind` | gateway | a model id from `catalog.ts`, else `custom`; provider kind enum |
| `tokens_in`, `tokens_out`, `cost_usd` | gateway | integers; cost rounded to 4 decimals |
| `duration_ms`, `attempt`, `start_offset_ms` | timers | integers; offset from the run's start, not a clock time |
| `outcome` | span | `ok · error · stopped · rolled_back` |
| `error_code` | error | `KernelErrorCode`, a stop_reason, an HTTP status, or a registered error class name; else `other` |
| `audit_class`, `via` | registry | `read · mutate · external`; `person · brain · coworker · cli · mcp` |
| `app_version`, `ee_version` | build | semver / release name |
| `day` | span | `YYYY-MM-DD` only |
| `trace_id`, `span_id`, `parent_id` | exporter | fresh random UUIDs minted for the export, never the local ids |

Never in Tier A: principal ids, counts of members, hostnames, base URLs, any `error`/`context`/
`activity`/`input`/`payload` column.

### Tier B — content-bearing traces, only with explicit company opt-in

Prompt and response text, tool inputs and outputs, error messages and cause chains, activity
sentences, decision inputs, job errors. Sent only when the company opted in (§4), and every text
field goes through the same scrub as proposals: one gateway call on the company's own provider
(`logContext: 'trace_scrub'`, JSON schema `{text, removed[]}`), English, PII and customer names
stripped **on the box**; a failed or impossible scrub means the span is not sent and the reason is
shown — never the raw text. Attached to a Tier A span by its export `span_id`.

### Tier C — never, no switch exists

- Memory-origin text (already never logged), email bodies and addresses, contact records, Drive
  files and attachments, call audio and transcripts, embedding inputs.
- Secrets, even redacted; BYOK keys; gateway base URLs.
- Names, emails or ids of people; company name, domains, hosts, IPs; exact timestamps.

## 3. Shape — reuse the contribute transport (recommended) vs OpenTelemetry/OTLP

| | Contribute phone-home transport | OTLP export to a collector |
|---|---|---|
| Identity | exists: per-install Ed25519 key, signed requests, revocation | new: collector auth, keys per box |
| Allowlist | zod `.strict()` on both ends; a key-set test | attributes are open key/value; auto-instrumentation adds content (`gen_ai.prompt`, `http.url`) by default |
| What was sent | outbox pattern, already shown to the company | nothing built in |
| Hub | exists on os.cerberusblue.com | a collector + trace store to run (Tempo/Jaeger/Langfuse) |
| Tooling | we build the hub views | trace UIs for free |

**Recommendation: reuse the contribute transport**, with a payload *shaped like OTel spans*
(trace/span/parent ids, name, start offset, duration, status, attributes named after OTel `gen_ai.*`
where they fit). The privacy guarantee comes from the strict schema; OTLP's strength (open
attributes, auto-instrumentation) is exactly what we must not have on a company box. If the owner
later wants a trace UI, the **hub** can forward its already-clean spans to an OTLP backend — the
open-ended format then lives only behind the allowlist.

```
box                                                         hub (os.cerberusblue.com)
───                                                         ──────────────────────────
activity_call_log ┐                                          POST /api/hub/traces  (signed, v:1, ≤500 spans, gzip)
kernel_events     ├─ exporter on job-queue tick ─► trace_batch ──────────────────► hub_trace_spans (install_id, …)
coworker_run, …   ┘  (cursor per source,          (kept 30 d,                     hub_trace_daily  (rollups)
ee journal (via os) toHubSpansV1, strict)          = "what was sent")             trace_hub.* tools
```

- **No second write path:** the exporter reads the existing tables through a cursor per source
  (`trace_export_cursor`), builds spans with one pure function `toHubSpansV1(rows)`, and writes the
  exact batch it sends to `trace_batch` before sending. Idempotent by batch id.
- Backoff, 4xx = stop and show, 429/5xx retry, offline catch-up: copied from the contribute worker.
- Hub URL: the same `CONTRIBUTE_HUB_URL` the installer writes (one central hub per install); no
  default in code; `--contribute-hub off` turns traces off too. Box + e2e use the mock hub (Q8).
- **PostHog server capture on boxes is replaced by Tier A** (announced removal, logged in
  `plan/progress.md`): it is a second, unconstrained phone-home the moment a key is set.

## 4. Consent, defaults, visibility, retention

| Tier | Default | Who switches | Where |
|---|---|---|---|
| A | **on** (owner Q1) | owner | Settings → Company → "Share product signals with the eigenEnterprise makers", with the field table of §2 |
| B | **off** (owner Q2 decides the scope) | owner, per run or per company | the run's page + Settings |
| C | — | nobody | — |

- New and upgraded installs get the same one-time "Needs you" notice as proposals: what is shared,
  link to the switch. Informational, not a consent step. No backfill: only spans after the feature lands.
- **The company sees exactly what was sent:** Settings → Company → "What was sent" lists every batch
  (time, tier, span count) and opens the exact JSON. Kernel tools in the same change (no UI-only
  actions): `traces.sent_list`, `traces.sent_get` (read, owner/admin/agent), `traces.settings_get`,
  `traces.settings_set` (owner), `traces.withdraw` (owner: delete one batch or everything from the
  hub). `ee tool run traces.sent_list` works the same; `ui-parity.ts` maps each entry point.
- **Switching off** stops sending; the owner picks "keep what was sent" or "delete it from the hub"
  (`DELETE /api/hub/installs/:id/traces`).
- **Hub retention (owner Q3):** Tier A raw spans 90 days, then only daily rollups (counts,
  p50/p95 durations, error rates, tokens, cost per tool/model/version) kept indefinitely; Tier B 30
  days, then deleted. A revoked or withdrawn install's spans go immediately.
- **The owner reads it** through `trace_hub.stats` (failure rate, p95, cost by tool/model/version/
  day), `trace_hub.list` (runs filtered by outcome/error_code/version) and `trace_hub.get` (one run's
  span tree), plus a hub page. The owner's agent reads it over MCP, like `contribute_hub.*`.
- Local retention of `activity_call_log` and `kernel_events` (none today) is not changed by this plan.

## 5. Milestones (TDD; each ships on its own)

| # | Milestone | Done when | Tests |
|---|---|---|---|
| **T0** | **Local traces complete** | Migration (expand only) adds `model`, `log_context`, `attempt`, `outcome`, `tokens_in`, `tokens_out`, `trace_id` to `activity_call_log` and `trace_id` to `tool.executed` payloads; `logContext` becomes the closed `LLM_LOG_CONTEXTS` type; co-worker runs, jobs and decisions run inside `runWithTrace(runId)`. Useful on the box alone (AI usage page can show model + tokens). | `llm-client.spec.ts` (row has model + tokens), `log-contexts.spec.ts` (exhaustive), `registry.spec.ts` (trace id on tool.executed), `coworker-runtime.spec.ts` (run's LLM + tool rows share its trace), `npm run lint:migrations` |
| **T1** | **Tier A payload (pure)** | `modules/traces/payload.ts`: `toHubSpansV1`, zod strict `HubSpanV1`, enum guards (`other` fallbacks are enum values, not text). | `payload.spec.ts` (exact key set; extras rejected); `allowlist.spec.ts` (rows seeded with names, emails, URLs, a pasted secret in every text column → no string in the output outside the enum sets) |
| **T2** | **Exporter + settings + tools** | Migration for `trace_export_cursor`, `trace_batch`, `trace_share_settings` (enabled default true); worker on the job-queue tick; `traces.*` tools; ui-parity entries; Needs-you notice. | `worker.spec.ts` (fake hub + clock: cursor never re-sends, backoff, 4xx stop, off = nothing), `db-store.pg.spec.ts`, `tools.spec.ts`, `ui-parity.spec.ts` |
| **T3** | **Hub ingest** | `POST /api/hub/traces` (signature reuse, rate + size limits, strict), `hub_trace_spans`, `hub_trace_daily`, retention job, `trace_hub.list/get/stats`, withdraw route. | `hub-routes.spec.ts` (bad signature, extra key, oversize, replay), `retention.spec.ts`, `rollup.spec.ts`, `tools.spec.ts` |
| **T4** | **UI** | Settings card + "What was sent" page on the box; hub "Traces" page (error rate and p95 by tool/model/version). | component specs; `traces-phone-home.e2e.ts`: a co-worker run whose prompt contains a name and an email → mock hub receives spans with only allowlisted keys, none of that text; owner withdraws → hub gets DELETE |
| **T5** | **Upgrade + module outcomes** | ee's upgrade `outcome` (step, ok, rolledBack, release/from — `reason` dropped) and module breakage become Tier A spans; the switch is the phase-upgrades one (§9 Q4); waves can halt on them. | `upgrade-job.spec.ts` (outcome reported, `reason` absent), `worker.spec.ts` |
| **T6** | **Retire box PostHog capture** (announced) | `captureServerEvent`/`captureServerException` no longer run on installs; the removal is in the session summary and `plan/progress.md` first. | `llm-client.spec.ts` (no PostHog call) |
| **T7** | **Tier B** (after Q2) | Opt-in as answered; `trace_scrub` gateway call per text field; scrub failure = not sent + shown; Tier B in "What was sent". | `trace-scrub.spec.ts` (schema, 3 attempts, no raw fallback), `worker.spec.ts`, e2e: an opted-in failed run arrives scrubbed |

Release after each milestone; T3 is activated on os.cerberusblue.com with the owner's go, like the
contribute hub.

## 6. Owner questions (product choices only)

1. **Tier A default — on for every box, with a switch?**
   Recommended: **yes, on by default, owner switch in Settings**, like proposals (Q6) and upgrade
   outcomes (§9 Q4). Without a default, almost no box sends, and the data is the fleet's behaviour.
2. **Tier B — how does content ever leave?**
   Recommended: **only runs a person sends on purpose** ("Send this run to the makers" on a run's
   page, owner/admin, scrubbed, shown before sending). No company-wide "send all content" switch.
   Alternative: an owner switch that sends every *failed* run's scrubbed content automatically.
3. **Hub retention and readers — keep it on os.cerberusblue.com, 90 days raw / rollups forever /
   Tier B 30 days?**
   Recommended: **yes**. Consequence: cerberusblue's admins and agent can read every box's traces,
   as they can read proposals today. Alternative: a separate hub install for traces only.

From here, details are decided by the builder and logged in `plan/progress.md`.
