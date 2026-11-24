import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { activityProviderForLlmConfig } from '$lib/server/activity/gateway-providers'
import { logActivityCall } from '$lib/server/activity/log-call'
import { addTraceTokens } from '$lib/server/activity/trace-context'
import { captureServerEvent } from '$lib/server/analytics/posthog-server'
import { getDb } from '$lib/server/db'
import { env } from '$lib/server/env/private-env'
import { LlmHttpError, LlmNotConfiguredError } from '$lib/server/llm/errors'
import { gatewayReportedCostUsdForLog, reportedTokenCount, type TokenUsage } from '$lib/server/llm/gateway-cost'
import { routingRuleLookupErrorMessage } from '$lib/server/llm/llm-config-guard'
import { fitEmbeddingResponse } from '$lib/server/llm/matryoshka'
import { assertGatewayCallWithinMemberDailyCap } from '$lib/server/llm/member-daily-cap'
import { assertPoolModel } from '$lib/server/llm/model-pool'
import { companySlotSource, resolveSlot, type SlotTarget } from '$lib/server/llm/slots'
import { isGraphScaleQuiet } from '$lib/server/observability/graph-scale-quiet'
import { sanitizeChatMessages } from '$lib/server/observability/strip-embeddings'

/**
 * Tool calls carried on an assistant message (OpenAI chat-completions shape),
 * passed through to the gateway verbatim (durable agent engine).
 */
export type AssistantToolCalls = Array<{
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}>

/**
 * A file the model reads together with a user message's text (e.g. an uploaded
 * brand guide). Sent as an OpenAI chat-completions content part: `image_url`
 * (data URL) for images, `file` (`file_data` data URL) for PDFs. A provider or
 * model without that input answers with an HTTP error, surfaced as
 * LlmHttpError — never a silent text-only call. The bytes go to the provider
 * only: logs and analytics record the type, name and size.
 */
export type ChatAttachment =
  | { type: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }
  | { type: 'pdf'; filename: string; base64: string }

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant message tool calls (OpenAI shape, verbatim passthrough). */
  tool_calls?: AssistantToolCalls
  /** role:'tool' messages: the id of the call this message answers. */
  tool_call_id?: string
  /** Files sent with this message's text; user messages only. */
  attachments?: ChatAttachment[]
}

function attachmentContentPart(attachment: ChatAttachment): Record<string, unknown> {
  switch (attachment.type) {
    case 'image':
      return {
        type: 'image_url',
        image_url: { url: `data:${attachment.mime};base64,${attachment.base64}` },
      }
    case 'pdf':
      return {
        type: 'file',
        file: {
          filename: attachment.filename,
          file_data: `data:application/pdf;base64,${attachment.base64}`,
        },
      }
  }
}

/** The request-body message: a message with attachments becomes text + file content parts. */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const { attachments, ...rest } = message
  if (!attachments || attachments.length === 0) return rest
  return {
    ...rest,
    content: [{ type: 'text', text: message.content }, ...attachments.map(attachmentContentPart)],
  }
}

function assertAttachmentsOnUserMessages(messages: ChatMessage[]): void {
  for (const message of messages) {
    if (message.attachments && message.attachments.length > 0 && message.role !== 'user') {
      throw new Error(
        `attachments are only sent on a user message; got them on a ${message.role} message`,
      )
    }
  }
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** Messages as analytics sees them: attachments described (type, name, size), never their bytes. */
function messagesForObservability(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (!message.attachments || message.attachments.length === 0) return message
    return {
      ...message,
      attachments: message.attachments.map((attachment) =>
        attachment.type === 'image'
          ? { type: 'image', mime: attachment.mime, bytes: base64ByteLength(attachment.base64) }
          : {
              type: 'pdf',
              filename: attachment.filename,
              bytes: base64ByteLength(attachment.base64),
            },
      ),
    }
  })
}
/** Providers with no embeddings endpoint — memory features need a different provider. */
const NO_EMBEDDING_PROVIDERS = new Set(['github_copilot'])

export {
  extractGatewayReportedCostUsd,
  gatewayReportedCostUsdForLog,
  requireGatewayReportedCostUsd,
} from '$lib/server/llm/gateway-cost'

type RoutingConfig = { ruleId?: string; model: string; provider?: Record<string, unknown> }
type AiMessageRole = 'system' | 'user' | 'assistant'
type AiOutputChoice = { role: AiMessageRole; content: string }

export type { LlmContentOrigin, LlmProviderKind, ResolvedLlmConfig } from '$lib/server/llm/types'
import type { LlmContentOrigin, LlmProviderKind, ResolvedLlmConfig } from '$lib/server/llm/types'

const EMBEDDING_DIMENSIONS = 1536
const AI_ID_ALLOWED = /^[A-Za-z0-9\-_.~@()!':|]+$/

function normalizeAiIdentifier(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  if (AI_ID_ALLOWED.test(trimmed)) return trimmed
  const normalized = trimmed.replace(/[^A-Za-z0-9\-_.~@()!':|]/g, '-').replace(/-+/g, '-')
  return normalized || fallback
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .filter(Boolean)
    .join('')
}

function extractAiOutputChoices(body: unknown): AiOutputChoice[] {
  if (!body || typeof body !== 'object') return []
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return []
  return choices
    .map((choice): AiOutputChoice | null => {
      if (!choice || typeof choice !== 'object') return null
      const message = (choice as { message?: { role?: unknown; content?: unknown } }).message
      if (!message || typeof message !== 'object') return null
      const role = message.role === 'system' || message.role === 'user' ? message.role : 'assistant'
      return {
        role,
        content: messageContentText(message.content),
      }
    })
    .filter((choice): choice is AiOutputChoice => choice !== null)
}

/** Hostname from gateway base URL for activity logs (handles missing `https://`). */
export function gatewayHostFromBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, '')
  try {
    return new URL(trimmed).hostname.toLowerCase()
  } catch {
    try {
      return new URL(`https://${trimmed}`).hostname.toLowerCase()
    } catch {
      return trimmed.slice(0, 120)
    }
  }
}

const routingRuleCache = new Map<string, RoutingConfig>()

/**
 * Per-user rate-limit state. Keyed by userId so that concurrent captures from different users
 * do not queue behind each other — only a single user's own successive LLM calls are spaced out.
 * Using a shared global queue previously caused one user's capture to block every other user's
 * LLM access for the duration of their pipeline.
 */
type UserLlmState = {
  lastRequestAt: number
  lastEndedAt: number
  queue: Promise<void>
  /** Separate queue for STT requests — avoids contention with ingest/enrichment. */
  sttQueue: Promise<void>
  lastSttRequestAt: number
  serialQueue: Promise<void>
}
const userLlmState = new Map<string, UserLlmState>()

/** Nested LLM calls (e.g. agent tool follow-ups) must not re-enter the user gate. */
const llmNestDepth = new AsyncLocalStorage<number>()

function getUserLlmState(userId: string): UserLlmState {
  let state = userLlmState.get(userId)
  if (!state) {
    state = {
      lastRequestAt: 0,
      lastEndedAt: 0,
      queue: Promise.resolve(),
      sttQueue: Promise.resolve(),
      lastSttRequestAt: 0,
      serialQueue: Promise.resolve(),
    }
    userLlmState.set(userId, state)
  }
  return state
}

function serialLlmRequestsEnabled(): boolean {
  const raw = env.LLM_SERIAL_REQUESTS?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * Serial mode: one in-flight request per user; next starts only after the prior finishes
 * and `LLM_MIN_REQUEST_INTERVAL_MS` has elapsed since it ended.
 */
async function runLlmRequestGated<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const depth = llmNestDepth.getStore() ?? 0
  if (depth > 0) {
    return llmNestDepth.run(depth + 1, fn)
  }

  const intervalMs = minRequestIntervalMs()
  const state = getUserLlmState(userId)

  // Chain synchronously (assign before await) so concurrent callers cannot pass the gate together.
  const slot = state.serialQueue.then(async () => {
    const elapsed = Date.now() - state.lastEndedAt
    const waitMs = Math.max(0, intervalMs - elapsed)
    if (waitMs > 0) {
      await sleep(waitMs)
    }
    try {
      return await llmNestDepth.run(1, fn)
    } finally {
      state.lastEndedAt = Date.now()
    }
  })
  state.serialQueue = slot.then(
    () => undefined,
    () => undefined,
  )
  return slot
}

function extractUsage(body: unknown): TokenUsage | undefined {
  if (!body || typeof body !== 'object') return undefined
  return (body as { usage?: TokenUsage }).usage
}

function minRequestIntervalMs(): number {
  const raw = env.LLM_MIN_REQUEST_INTERVAL_MS?.trim()
  if (!raw) return 1000
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('LLM_MIN_REQUEST_INTERVAL_MS must be a non-negative number')
  }
  return parsed
}

function requestTimeoutMs(): number {
  const raw = env.LLM_REQUEST_TIMEOUT_MS?.trim()
  if (!raw) return 60_000 // 60 s default
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('LLM_REQUEST_TIMEOUT_MS must be a positive number')
  }
  return parsed
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractChatResponseText(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const message = (choices[0] as { message?: { content?: unknown } }).message
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  return ''
}

/** Memory text never reaches the logs: its calls log sizes, not words (LlmContentOrigin). */
function keepsText(origin: LlmContentOrigin | undefined): boolean {
  return origin !== 'memory'
}

function logLlmChatRequest(
  logCtx: string,
  attempt: number,
  messages: ChatMessage[],
  origin: LlmContentOrigin | undefined,
): void {
  if (isGraphScaleQuiet()) return
  console.log(`[llm.chat:${logCtx}] request attempt ${attempt}/${3}`)
  for (const message of messages) {
    console.log(
      keepsText(origin)
        ? `[llm.chat:${logCtx}] ${message.role}:\n${message.content}`
        : `[llm.chat:${logCtx}] ${message.role}: (${origin}, ${message.content.length} chars not logged)`,
    )
  }
}

function logLlmChatResponse(
  logCtx: string,
  attempt: number,
  body: unknown,
  origin: LlmContentOrigin | undefined,
): void {
  if (isGraphScaleQuiet()) return
  const text = extractChatResponseText(body)
  console.log(
    keepsText(origin)
      ? `[llm.chat:${logCtx}] response attempt ${attempt}:\n${text}`
      : `[llm.chat:${logCtx}] response attempt ${attempt}: (${origin}, ${text.length} chars not logged)`,
  )
}

const EMBEDDING_LOG_INPUT_MAX = 100

function truncateForEmbeddingLog(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= EMBEDDING_LOG_INPUT_MAX) return trimmed
  return `${trimmed.slice(0, EMBEDDING_LOG_INPUT_MAX - 3)}...`
}

function logLlmEmbeddingRequest(
  attempt: number,
  input: string | string[],
  origin: LlmContentOrigin | undefined,
  logCtx = 'embedding',
): void {
  if (isGraphScaleQuiet()) {
    console.info(`[graph-scale] llm ${logCtx} attempt ${attempt}/${3}`)
    return
  }
  console.log(`[llm.embedding] request attempt ${attempt}/${3}`)
  if (!keepsText(origin)) {
    const count = Array.isArray(input) ? input.length : 1
    console.log(`[llm.embedding] input: ${count} text(s) (${origin}, not logged)`)
    return
  }
  if (Array.isArray(input)) {
    for (const [index, text] of input.entries()) {
      console.log(`[llm.embedding] input[${index}]: ${truncateForEmbeddingLog(text)}`)
    }
  } else {
    console.log(`[llm.embedding] input: ${truncateForEmbeddingLog(input)}`)
  }
}

function logLlmSttRequest(
  attempt: number,
  model: string,
  audio: { bytes: Uint8Array; format: string; language?: string },
): void {
  if (isGraphScaleQuiet()) return
  console.log(
    `[llm.stt] request attempt ${attempt}/${3} model=${model} format=${audio.format} bytes=${audio.bytes.byteLength}${audio.language ? ` language=${audio.language}` : ''}`,
  )
}

function logLlmSttResponse(
  attempt: number,
  body: unknown,
  origin: LlmContentOrigin | undefined,
): void {
  if (isGraphScaleQuiet()) return
  if (!keepsText(origin)) {
    console.log(`[llm.stt] response attempt ${attempt}: (${origin} transcript not logged)`)
    return
  }
  if (!body || typeof body !== 'object') {
    console.log(`[llm.stt] response attempt ${attempt}: (empty response)`)
    return
  }
  if ('text' in body && typeof (body as { text?: unknown }).text === 'string') {
    console.log(`[llm.stt] response attempt ${attempt}:\n${(body as { text: string }).text}`)
    return
  }
  const choices = (body as { choices?: unknown }).choices
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const content = (choices[0] as { message?: { content?: unknown } }).message?.content
    if (typeof content === 'string') {
      console.log(`[llm.stt] response attempt ${attempt}:\n${content}`)
      return
    }
  }
  console.log(`[llm.stt] response attempt ${attempt}: (no transcript text in response)`)
}

async function waitForLlmRateLimit(userId: string): Promise<void> {
  if (serialLlmRequestsEnabled()) return

  const intervalMs = minRequestIntervalMs()
  if (intervalMs === 0) return

  const state = getUserLlmState(userId)

  // Each call appends a slot to this user's queue. The slot:
  //   1. Waits for the previous slot to finish (i.e. previous request started).
  //   2. Computes how long to wait based on when the last request started.
  //   3. Sleeps only for that gap.
  //   4. Records the new start time and resolves — releasing the queue for the next caller.
  //
  // Crucially the slot resolves *before* the HTTP request completes, so a nested
  // llmChatCompletion call (e.g. from answer_question inside the agent loop) never
  // deadlocks waiting on the outer call's in-flight HTTP request.
  const slot = state.queue.then(async () => {
    const now = Date.now()
    const elapsed = now - state.lastRequestAt
    const waitMs = Math.max(0, intervalMs - elapsed)
    if (waitMs > 0) {
      await sleep(waitMs)
    }
    state.lastRequestAt = Date.now()
    // Slot resolves here — next queued call for this user can now run its spacing check.
  })
  state.queue = slot
  await slot
}

/**
 * Rate limiter for STT requests — separate queue so speech-to-text does not contend
 * with ingest/enrichment LLM calls. Uses the same per-user interval but independent
 * queue chain.
 */
async function waitForSttRateLimit(userId: string): Promise<void> {
  if (serialLlmRequestsEnabled()) return

  const intervalMs = minRequestIntervalMs()
  if (intervalMs === 0) return

  const state = getUserLlmState(userId)

  const slot = state.sttQueue.then(async () => {
    const now = Date.now()
    const elapsed = now - state.lastSttRequestAt
    const waitMs = Math.max(0, intervalMs - elapsed)
    if (waitMs > 0) {
      await sleep(waitMs)
    }
    state.lastSttRequestAt = Date.now()
  })
  state.sttQueue = slot
  await slot
}


/**
 * Resolves a routing rule to its model + provider config (cached).
 * Exported for the onboarding provider dry-run test.
 */
export async function resolveRoutingRuleById(
  ruleId: string,
  apiKey: string,
  baseUrl: string,
): Promise<RoutingConfig> {
  const cached = routingRuleCache.get(ruleId)
  if (cached) return cached

  const res = await fetch(`${baseUrl}/routing-rules/${ruleId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch {
    json = { raw: text }
  }

  if (!res.ok) {
    throw new Error(
      routingRuleLookupErrorMessage({
        ruleId,
        baseUrl,
        status: res.status,
        bodyPreview: text,
      }),
    )
  }

  const candidate =
    (typeof json === 'object' && json && 'data' in json
      ? (json as { data?: unknown }).data
      : json) ?? {}

  const model =
    typeof (candidate as { model?: unknown }).model === 'string'
      ? (candidate as { model: string }).model.trim()
      : ''
  if (!model) {
    throw new Error(`Routing rule ${ruleId} is missing a model`)
  }

  const provider =
    typeof (candidate as { provider?: unknown }).provider === 'object' &&
    (candidate as { provider?: unknown }).provider
      ? ((candidate as { provider: Record<string, unknown> }).provider ?? {})
      : undefined

  const resolved: RoutingConfig = { ruleId, model, ...(provider ? { provider } : {}) }
  routingRuleCache.set(ruleId, resolved)
  return resolved
}

/**
 * THE check on a per-call chat model (plan/phase-ai-coworkers.md §5): an override names a chat
 * model of the vetted pool (model-pool.ts), whoever passes it (a co-worker's own model, the
 * brand extraction model). Anything else, a blank string included, fails loud
 * (ModelNotInPoolError) before any request: a slot never holds a model we haven't vetted, and
 * neither does a single call.
 */
function chatModelOverride(requested: string): string {
  return assertPoolModel('chat', requested.trim())
}

/**
 * The model a chat call sends. On eigenInference and an OpenRouter key: the company's chat slot
 * (a pool model), unless the caller is a dedicated tool identity with an explicit model. A
 * bring-your-own-key provider outside the pool's namespace routes as it always did.
 */
async function chatRoutingConfig(
  target: SlotTarget,
  ruleOverride?: string,
  requestedOverride?: string,
): Promise<RoutingConfig> {
  const modelOverride = requestedOverride === undefined ? undefined : chatModelOverride(requestedOverride)
  if (target.model) return { model: modelOverride || target.model }
  const config = target.config
  // Every non-EUrouter provider (OpenRouter, Copilot, models.dev catalog, …) is
  // OpenAI-compatible and routes by direct model name.
  if (config.provider !== 'eurouter') {
    const model = modelOverride || config.modelChat?.trim() || env.LLM_MODEL_CHAT?.trim()
    if (!model) {
      throw new LlmNotConfiguredError(
        `No chat model configured for this ${config.provider} credential — set one under Settings → LLM.`,
      )
    }
    return { model }
  }
  // EUrouter: resolve via routing rule or env model override
  const ruleId = ruleOverride?.trim() || config.ruleChat
  const model = modelOverride || env.LLM_MODEL_CHAT?.trim()
  if (model) return { ...(ruleId ? { ruleId } : {}), model }
  if (ruleId) return resolveRoutingRuleById(ruleId, config.apiKey, config.baseUrl)
  throw new LlmNotConfiguredError(
    'LLM chat rule not configured: set LLM_RULE_CHAT in environment or configure via Settings → LLM Provider',
  )
}

/** The install's fixed embedding model; a bring-your-own-key provider outside the pool routes as it always did. */
async function embeddingRoutingConfig(target: SlotTarget): Promise<RoutingConfig> {
  if (target.model) return { model: target.model }
  const config = target.config
  // Every non-EUrouter provider (OpenRouter, Copilot, models.dev catalog, …) is
  // OpenAI-compatible and routes by direct model name.
  if (config.provider !== 'eurouter') {
    if (NO_EMBEDDING_PROVIDERS.has(config.provider) && !config.modelEmbedding?.trim()) {
      throw new LlmNotConfiguredError(
        `${config.provider} does not provide embeddings — save an embedding-capable provider (EUrouter, OpenRouter, …) for memory features.`,
      )
    }
    const model = config.modelEmbedding?.trim() || env.LLM_MODEL_EMBEDDING?.trim()
    if (!model) {
      throw new LlmNotConfiguredError(
        `No embedding model configured for this ${config.provider} credential — set one under Settings → LLM.`,
      )
    }
    return { model }
  }
  // EUrouter: resolve via routing rule or env model override
  const ruleId = config.ruleEmbedding
  const model = env.LLM_MODEL_EMBEDDING?.trim()
  if (model) return { ...(ruleId ? { ruleId } : {}), model }
  if (ruleId) return resolveRoutingRuleById(ruleId, config.apiKey, config.baseUrl)
  throw new LlmNotConfiguredError(
    'LLM embedding rule not configured: set LLM_RULE_EMBEDDING in environment or configure via Settings → LLM Provider',
  )
}

/** What a chat completion for this identity resolves to right now — the truthful "which model am I". */
export type ChatModelDescription = {
  provider: LlmProviderKind
  /** The upstream model name the gateway sends (resolved from the routing rule when no model is set). */
  model: string
  routingRuleId: string | null
  billing: 'byok' | 'platform'
  gatewayHost: string
}

/**
 * The provider + model a chat completion for `userId` resolves to, by the
 * exact resolution llmChatCompletion uses (the company's chat slot, routing).
 * Never returns credentials.
 */
export async function describeChatModel(userId: string): Promise<ChatModelDescription> {
  const target = await resolveSlot('chat', userId)
  const config = target.config
  const byok = target.source === 'byok'
  const routing = await chatRoutingConfig(target)
  return {
    provider: config.provider,
    model: routing.model,
    routingRuleId: routing.ruleId ?? null,
    billing: byok ? 'byok' : 'platform',
    gatewayHost: gatewayHostFromBaseUrl(config.baseUrl),
  }
}

/**
 * Default completion budget when callers omit maxTokens.
 * Gateways that treat missing max_tokens as the full model context window
 * (e.g. 262144) reject small prompts: prompt + context > context.
 * Keep this well below typical context windows and large enough for JSON judges.
 */
export const DEFAULT_CHAT_MAX_TOKENS = 8192

/** The AI usage log's preview of a chat: its first user message, never Memory text. */
function chatActivityPreview(
  messages: ChatMessage[],
  origin: LlmContentOrigin | undefined,
): string | undefined {
  if (!keepsText(origin)) return undefined
  return messages.find((m) => m.role === 'user')?.content || ''
}

/** The AI usage log's preview of an embedding: its first input, never Memory text. */
function embeddingActivityPreview(
  input: string | string[],
  origin: LlmContentOrigin | undefined,
): string | undefined {
  if (!keepsText(origin)) return undefined
  return Array.isArray(input) ? input[0] : input
}

/**
 * Chat completions: `POST ${baseUrl}/chat/completions`.
 * Body uses `rule_id` from the user's LLM config (DB row) or LLM_RULE_CHAT env var.
 */
export async function llmChatCompletion(input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** Dev/server observability only; appears in logs to disambiguate parallel chat uses. */
  logContext?: string
  /** Override chat routing rule (e.g. LLM_RULE_ROUTER for the agent router judge). */
  routingRuleId?: string
  /**
   * Explicit chat model for this call (a co-worker's own model) — wins
   * over per-credential/env chat routing, never silently defaulted. Must be a chat model of the
   * vetted pool (model-pool.ts), else ModelNotInPoolError before any request.
   */
  modelOverride?: string
  /** OpenAI-compatible JSON object mode — gateway must support response_format. */
  responseFormat?: 'json_object'
  /** Optional conversation-level identifier for PostHog AI observability session grouping. */
  aiSessionId?: string
  /** Optional turn-level identifier for PostHog AI observability trace grouping. */
  aiTraceId?: string
  /** `'memory'` when the messages carry a person's Memory: its text is never logged or analysed. */
  contentOrigin?: LlmContentOrigin
  /**
   * OpenAI chat-completions `tools` definitions — passed through to the
   * gateway request body verbatim. Requires an OpenAI-shaped provider;
   * API-shape providers (Anthropic messages, Codex responses) fail loud
   * instead of silently dropping the tools.
   */
  tools?: unknown[]
  /** OpenAI `tool_choice`, passed through verbatim when tools are sent. */
  toolChoice?: unknown
}): Promise<unknown> {
  // The company's daily AI cap per member (DC3): refused before any provider call or retry.
  await assertGatewayCallWithinMemberDailyCap(input.userId)
  return serialLlmRequestsEnabled()
    ? runLlmRequestGated(input.userId, () => llmChatCompletionInner(input))
    : llmChatCompletionInner(input)
}

async function llmChatCompletionInner(input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  logContext?: string
  routingRuleId?: string
  modelOverride?: string
  responseFormat?: 'json_object'
  aiSessionId?: string
  aiTraceId?: string
  contentOrigin?: LlmContentOrigin
  tools?: unknown[]
  toolChoice?: unknown
}): Promise<unknown> {
  assertAttachmentsOnUserMessages(input.messages)
  const target = await resolveSlot('chat', input.userId)
  const config = target.config
  const activityProvider = activityProviderForLlmConfig(config.provider)
  const gatewayHost = gatewayHostFromBaseUrl(config.baseUrl)
  const url = `${config.baseUrl}/chat/completions`
  const routing = await chatRoutingConfig(target, input.routingRuleId, input.modelOverride)
  const logCtx = (input.logContext?.trim() || 'chat').replace(/\s+/g, '_')
  // sanitizeChatMessages spreads each message, so tool calls and attachments pass through it.
  const messages = sanitizeChatMessages(input.messages) as ChatMessage[]
  const origin = input.contentOrigin
  // Memory calls send PostHog the call's shape (model, tokens, latency), never its text.
  const observedText = keepsText(origin) ? { $ai_input: messagesForObservability(messages) } : {}
  const aiSessionId = normalizeAiIdentifier(input.aiSessionId, `user-${input.userId}`)
  const aiTraceId = normalizeAiIdentifier(input.aiTraceId, randomUUID())

  const maxAttempts = 3
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now()
    const db = getDb()
    try {
      if (!isGraphScaleQuiet()) {
        console.info(`[llm.chat:${logCtx}] attempt ${attempt}/${maxAttempts}`, {
          model: routing.model,
          ruleId: routing.ruleId ?? null,
          messageCount: messages.length,
          totalChars: messages.reduce((n, m) => n + m.content.length, 0),
        })
      } else {
        console.info(`[graph-scale] llm ${logCtx} attempt ${attempt}/${maxAttempts}`)
      }
      logLlmChatRequest(logCtx, attempt, messages, origin)
      await waitForLlmRateLimit(input.userId)
      const fetchStart = Date.now()
      const timeoutMs = requestTimeoutMs()
      const ac = new AbortController()
      const timeoutHandle = setTimeout(
        () => ac.abort(new Error(`LLM request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      let res: Response
      try {
        res = await fetch(url, {
          signal: ac.signal,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            ...(routing.ruleId ? { rule_id: routing.ruleId } : {}),
            model: routing.model,
            ...(routing.provider ? { provider: routing.provider } : {}),
            messages: messages.map(toWireMessage),
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            max_tokens: input.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
            ...(input.responseFormat === 'json_object'
              ? { response_format: { type: 'json_object' } }
              : {}),
            ...(input.tools !== undefined ? { tools: input.tools } : {}),
            ...(input.toolChoice !== undefined ? { tool_choice: input.toolChoice } : {}),
          }),
        })
      } finally {
        clearTimeout(timeoutHandle)
      }

      const text = await res.text()
      let json: unknown
      try {
        json = JSON.parse(text) as unknown
      } catch {
        json = { raw: text }
      }

      if (!res.ok) {
        console.error(`[llm.chat:${logCtx}] DIAG 4xx`, {
          status: res.status,
          model: routing.model,
          ruleId: routing.ruleId ?? null,
          provider: routing.provider ?? null,
          messageCount: messages.length,
          messageSizes: messages.map((m) => ({ role: m.role, len: m.content.length })),
          totalChars: messages.reduce((n, m) => n + m.content.length, 0),
          responseBody: keepsText(origin) ? text : `(${origin}, ${text.length} chars not logged)`,
        })
        const message =
          typeof json === 'object' && json && 'error' in json
            ? JSON.stringify((json as { error?: unknown }).error)
            : text.slice(0, 500)
        throw new LlmHttpError(res.status, message)
      }

      const attemptMs = Date.now() - attemptStart
      const fetchMs = Date.now() - fetchStart
      const usage = extractUsage(json)
      const baseCost = gatewayReportedCostUsdForLog(json)
      if (!isGraphScaleQuiet()) {
        console.info(`[llm.chat:${logCtx}] gateway response ok`, {
          attempt,
          httpStatus: res.status,
          attemptMs,
          fetchMs,
          prompt_tokens: usage?.prompt_tokens,
          completion_tokens: usage?.completion_tokens,
          total_tokens: usage?.total_tokens,
        })
      }
      logLlmChatResponse(logCtx, attempt, json, origin)
      // The trace (e.g. one assistant reply) counts the tokens its calls reported.
      addTraceTokens(reportedTokenCount(usage))
      await logActivityCall(db, input.userId, {
        provider: activityProvider,
        gatewayHost,
        operation: `llm.chat.${logCtx}.success(attempt=${attempt})`,
        baseCostUsd: baseCost,
        context: chatActivityPreview(input.messages, origin),
        durationMs: attemptMs,
      })
      captureServerEvent({
        distinctId: input.userId,
        event: '$ai_generation',
        properties: {
          $ai_trace_id: aiTraceId,
          $ai_session_id: aiSessionId,
          $ai_model: routing.model,
          $ai_provider: config.provider,
          ...observedText,
          $ai_input_tokens: usage?.prompt_tokens,
          ...(keepsText(origin) ? { $ai_output_choices: extractAiOutputChoices(json) } : {}),
          $ai_output_tokens: usage?.completion_tokens,
          $ai_latency: attemptMs / 1000,
          $ai_http_status: res.status,
          $ai_base_url: config.baseUrl,
          $ai_request_url: url,
          $ai_stop_reason:
            typeof (json as { choices?: Array<{ finish_reason?: unknown }> })?.choices?.[0]
              ?.finish_reason === 'string'
              ? ((json as { choices: Array<{ finish_reason: string }> }).choices[0].finish_reason ??
                undefined)
              : undefined,
        },
      })

      return json
    } catch (err) {
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[llm.chat:${logCtx}] attempt ${attempt} failed`, {
        afterMs: Date.now() - attemptStart,
        message: msg.slice(0, 500),
      })
      await logActivityCall(db, input.userId, {
        provider: activityProvider,
        gatewayHost,
        operation: `llm.chat.${logCtx}.error(attempt=${attempt})`,
        baseCostUsd: 0,
        context: chatActivityPreview(input.messages, origin),
        errorMessage: msg,
        durationMs: Date.now() - attemptStart,
      })
      if (attempt === maxAttempts) {
        captureServerEvent({
          distinctId: input.userId,
          event: '$ai_generation',
          properties: {
            $ai_trace_id: aiTraceId,
            $ai_session_id: aiSessionId,
            $ai_model: routing.model,
            $ai_provider: config.provider,
            ...observedText,
            $ai_is_error: true,
            $ai_error: msg,
            $ai_http_status: err instanceof LlmHttpError ? err.status : undefined,
            $ai_latency: (Date.now() - attemptStart) / 1000,
            $ai_base_url: config.baseUrl,
            $ai_request_url: url,
          },
        })
      }
      if (attempt === maxAttempts) break
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM request failed after ${maxAttempts} attempts`)
}

/**
 * Embeddings: `POST ${baseUrl}/embeddings` with rule_id from the user's LLM config.
 */
export async function llmCreateEmbeddings(input: {
  userId: string
  input: string | string[]
  /** `'memory'` when the texts are a person's Memory: they are never logged. */
  contentOrigin?: LlmContentOrigin
}): Promise<unknown> {
  await assertGatewayCallWithinMemberDailyCap(input.userId)
  return serialLlmRequestsEnabled()
    ? runLlmRequestGated(input.userId, () => llmCreateEmbeddingsInner(input))
    : llmCreateEmbeddingsInner(input)
}

async function llmCreateEmbeddingsInner(input: {
  userId: string
  input: string | string[]
  contentOrigin?: LlmContentOrigin
}): Promise<unknown> {
  const target = await resolveSlot('embedding', input.userId)
  const config = target.config
  const activityProvider = activityProviderForLlmConfig(config.provider)
  const gatewayHost = gatewayHostFromBaseUrl(config.baseUrl)
  const url = `${config.baseUrl}/embeddings`
  const routing = await embeddingRoutingConfig(target)

  const maxAttempts = 3
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now()
    const db = getDb()
    try {
      logLlmEmbeddingRequest(attempt, input.input, input.contentOrigin)
      await waitForLlmRateLimit(input.userId)
      const embAc = new AbortController()
      const embTimeoutMs = requestTimeoutMs()
      const embTimeoutHandle = setTimeout(
        () => embAc.abort(new Error(`LLM embedding request timed out after ${embTimeoutMs}ms`)),
        embTimeoutMs,
      )
      let res: Response
      try {
        if (NO_EMBEDDING_PROVIDERS.has(config.provider)) {
          // Fail loud BEFORE the request: this provider cannot embed at all.
          throw new LlmNotConfiguredError(
            `${config.provider} does not provide embeddings — save an embedding-capable provider (EUrouter, OpenRouter, …) for memory features.`,
          )
        }
        res = await fetch(url, {
          signal: embAc.signal,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            ...(routing.ruleId ? { rule_id: routing.ruleId } : {}),
            model: routing.model,
            ...(routing.provider ? { provider: routing.provider } : {}),
            dimensions: EMBEDDING_DIMENSIONS,
            input: input.input,
          }),
        })
      } finally {
        clearTimeout(embTimeoutHandle)
      }

      const text = await res.text()
      let json: unknown
      try {
        json = JSON.parse(text) as unknown
      } catch {
        json = { raw: text }
      }

      if (!res.ok) {
        const message =
          typeof json === 'object' && json && 'error' in json
            ? JSON.stringify((json as { error?: unknown }).error)
            : text.slice(0, 500)
        throw new LlmHttpError(res.status, message)
      }

      const baseCost = gatewayReportedCostUsdForLog(json)
      await logActivityCall(db, input.userId, {
        provider: activityProvider,
        gatewayHost,
        operation: `llm.embedding.success(attempt=${attempt})`,
        baseCostUsd: baseCost,
        context: embeddingActivityPreview(input.input, input.contentOrigin),
        durationMs: Date.now() - attemptStart,
      })

      // A gateway may ignore `dimensions` for a Matryoshka model (Qwen3: 4096 natively).
      return fitEmbeddingResponse(routing.model, json, EMBEDDING_DIMENSIONS)
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      await logActivityCall(db, input.userId, {
        provider: activityProvider,
        gatewayHost,
        operation: `llm.embedding.error(attempt=${attempt})`,
        baseCostUsd: 0,
        context: embeddingActivityPreview(input.input, input.contentOrigin),
        errorMessage: message,
        durationMs: Date.now() - attemptStart,
      })
      if (attempt === maxAttempts) break
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM embedding request failed after ${maxAttempts} attempts`)
}

export type LlmTranscriptionAudio = {
  bytes: Uint8Array
  format: string
  language?: string
  /**
   * Vocabulary/spelling context. OpenRouter's STT body has no `prompt`; it reaches OpenAI's
   * transcription `prompt` through the provider passthrough (`provider.options.openai`), and
   * other providers never see it.
   */
  prompt?: string
}

function sttTranscriptPreview(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  if ('text' in body && typeof (body as { text?: unknown }).text === 'string') {
    return (body as { text: string }).text.slice(0, 200)
  }
  const choices = (body as { choices?: unknown }).choices
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const content = (choices[0] as { message?: { content?: unknown } }).message?.content
    if (typeof content === 'string') return content.slice(0, 200)
  }
  return ''
}

/**
 * Where speech-to-text's credentials come from: the company's source (Settings → AI). Audio
 * always goes to an OpenRouter-namespace endpoint, whatever chat provider the company picked:
 * eigenInference, or the company's own OpenRouter key.
 */
export async function sttCredentialSource(userId: string): Promise<'byok' | 'platform'> {
  return (await companySlotSource(userId)) === 'byok' ? 'byok' : 'platform'
}

/** The endpoint + key a transcription uses; throws LlmNotConfiguredError when it is missing. */
export async function loadOpenRouterSttConfig(userId: string): Promise<ResolvedLlmConfig> {
  return (await resolveSlot('stt', userId)).config
}

/** The model a slot resolves to (pool slots on an OpenRouter-namespace endpoint always carry one). */
function slotModel(target: SlotTarget): string {
  if (!target.model) {
    throw new LlmNotConfiguredError(`The ${target.slot} slot resolved without a model.`)
  }
  return target.model
}

/**
 * Speech-to-text via OpenRouter `POST /audio/transcriptions` (OpenAI-compatible JSON body), on
 * the company's speech-to-text slot.
 */
export async function llmCreateTranscription(input: {
  userId: string
  audio: LlmTranscriptionAudio
  /** `'memory'` for a voice note to Memory: its transcript is never logged. */
  contentOrigin?: LlmContentOrigin
}): Promise<unknown> {
  await assertGatewayCallWithinMemberDailyCap(input.userId)
  const target = await resolveSlot('stt', input.userId)
  const run = () => llmCreateTranscriptionDedicated({ ...input, model: slotModel(target) }, target.config)
  return serialLlmRequestsEnabled() ? runLlmRequestGated(input.userId, run) : run()
}

async function llmCreateTranscriptionDedicated(
  input: {
    userId: string
    model: string
    audio: LlmTranscriptionAudio
    contentOrigin?: LlmContentOrigin
  },
  config: ResolvedLlmConfig,
): Promise<unknown> {
  const activityProvider = activityProviderForLlmConfig(config.provider)
  const gatewayHost = gatewayHostFromBaseUrl(config.baseUrl)
  const url = `${config.baseUrl}/audio/transcriptions`
  const audioBase64 = Buffer.from(input.audio.bytes).toString('base64')

  const maxAttempts = 3
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now()
    const db = getDb()
    try {
      logLlmSttRequest(attempt, input.model, input.audio)
      await waitForSttRateLimit(input.userId)
      const timeoutMs = requestTimeoutMs()
      const ac = new AbortController()
      const timeoutHandle = setTimeout(
        () => ac.abort(new Error(`LLM STT request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      let res: Response
      try {
        res = await fetch(url, {
          signal: ac.signal,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: input.model,
            input_audio: {
              data: audioBase64,
              format: input.audio.format,
            },
            ...(input.audio.language ? { language: input.audio.language } : {}),
            ...(input.audio.prompt ? { provider: { options: { openai: { prompt: input.audio.prompt } } } } : {}),
            temperature: 0,
          }),
        })
      } finally {
        clearTimeout(timeoutHandle)
      }

      const text = await res.text()
      let json: unknown
      try {
        json = JSON.parse(text) as unknown
      } catch {
        json = { raw: text }
      }

      if (!res.ok) {
        const message =
          typeof json === 'object' && json && 'error' in json
            ? JSON.stringify((json as { error?: unknown }).error)
            : text.slice(0, 500)
        throw new Error(`LLM STT HTTP ${res.status}: ${message}`)
      }

      const sttCost = gatewayReportedCostUsdForLog(json)
      logLlmSttResponse(attempt, json, input.contentOrigin)
      await logActivityCall(db, input.userId, {
        provider: activityProvider,
        gatewayHost,
        operation: `llm.stt.success(attempt=${attempt},model=${input.model})`,
        baseCostUsd: sttCost,
        context:
          (keepsText(input.contentOrigin) ? sttTranscriptPreview(json) : '') ||
          `stt:${input.model}${sttCost === 0 ? ' (usage cost missing from gateway)' : ''}`,
        durationMs: Date.now() - attemptStart,
      })

      return json
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      await logActivityCall(db, input.userId, {
        provider: activityProvider,
        gatewayHost,
        operation: `llm.stt.error(attempt=${attempt},model=${input.model})`,
        baseCostUsd: 0,
        context: `format=${input.audio.format}`,
        errorMessage: message,
        durationMs: Date.now() - attemptStart,
      })
      if (attempt === maxAttempts) break
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM STT request failed after ${maxAttempts} attempts`)
}

/**
 * Text-to-speech via OpenRouter `POST /audio/speech` (OpenAI-compatible).
 * Returns the gateway's raw audio bytes (mp3) — the assistant's voice is the
 * gateway's neural TTS, never the browser's speechSynthesis.
 * Runs on the company's text-to-speech slot (eigenInference or the company's
 * own OpenRouter key), like speech to text.
 */
export async function llmCreateSpeech(input: {
  userId: string
  voice: string
  text: string
}): Promise<Uint8Array> {
  await assertGatewayCallWithinMemberDailyCap(input.userId)
  const target = await resolveSlot('tts', input.userId)
  const run = () => llmCreateSpeechDedicated({ ...input, model: slotModel(target) }, target.config)
  return serialLlmRequestsEnabled() ? runLlmRequestGated(input.userId, run) : run()
}

async function llmCreateSpeechDedicated(
  input: { userId: string; model: string; voice: string; text: string },
  config: ResolvedLlmConfig,
): Promise<Uint8Array> {
  const activityProvider = activityProviderForLlmConfig(config.provider)
  const gatewayHost = gatewayHostFromBaseUrl(config.baseUrl)
  const url = `${config.baseUrl}/audio/speech`

  const maxAttempts = 3
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now()
    const db = getDb()
    try {
      await waitForSttRateLimit(input.userId)
      const timeoutMs = requestTimeoutMs()
      const ac = new AbortController()
      const timeoutHandle = setTimeout(
        () => ac.abort(new Error(`LLM TTS request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      let res: Response
      try {
        res = await fetch(url, {
          signal: ac.signal,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: input.model,
            input: input.text,
            voice: input.voice,
            response_format: 'mp3',
          }),
        })
      } finally {
        clearTimeout(timeoutHandle)
      }

      if (!res.ok) {
        const text = await res.text()
        let message = text.slice(0, 500)
        try {
          const json = JSON.parse(text) as unknown
          if (typeof json === 'object' && json && 'error' in json) {
            message = JSON.stringify((json as { error?: unknown }).error)
          }
        } catch {
          // not JSON — the sliced text is the message
        }
        throw new Error(`LLM TTS HTTP ${res.status}: ${message}`)
      }

      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        // A JSON body here is a gateway shape mismatch, not audio — fail loud.
        const text = await res.text()
        throw new Error(`LLM TTS returned JSON instead of audio bytes: ${text.slice(0, 200)}`)
      }

      const bytes = new Uint8Array(await res.arrayBuffer())
      await logActivityCall(db, input.userId, {
        provider: activityProvider,
        gatewayHost,
        operation: `llm.tts.success(attempt=${attempt},model=${input.model})`,
        baseCostUsd: 0,
        context: `tts:${input.model} (usage cost not reported for /audio/speech)`,
        durationMs: Date.now() - attemptStart,
      })
      return bytes
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      await logActivityCall(db, input.userId, {
        provider: activityProvider,
        gatewayHost,
        operation: `llm.tts.error(attempt=${attempt},model=${input.model})`,
        baseCostUsd: 0,
        context: `tts:${input.model}`,
        errorMessage: message,
        durationMs: Date.now() - attemptStart,
      })
      if (attempt === maxAttempts) break
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM TTS request failed after ${maxAttempts} attempts`)
}
