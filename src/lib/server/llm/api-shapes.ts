import { LlmHttpError } from '$lib/server/llm/errors'
import { ANTHROPIC_OAUTH_BETAS, ANTHROPIC_OAUTH_HEADERS, ANTHROPIC_OAUTH_SYSTEM_PREFIX } from '$lib/server/llm/oauth/anthropic'
import type { ResolvedLlmConfig } from '$lib/server/llm/types'

/**
 * API-shape adapters for subscription providers whose gateways do not speak the
 * OpenAI chat-completions shape. Each adapter performs the provider-shaped request
 * and returns a synthetic 200 Response whose JSON is normalized to OpenAI shape
 * (choices/usage), so llm-client's logging, cost tracking, and PostHog pipeline run
 * unchanged. Errors surface as real-status Responses for the standard retry loop.
 */

export type ChatMessages = Array<{ role: 'system' | 'user' | 'assistant'; content: string }>

const CHAT_SHAPED_PROVIDERS = new Set(['anthropic', 'openai_codex'])

/** True when the provider needs an API-shape adapter instead of /chat/completions. */
export function usesApiShape(provider: string): boolean {
  return CHAT_SHAPED_PROVIDERS.has(provider)
}

/** Providers with no embeddings endpoint — memory features need a different provider. */
export const NO_EMBEDDING_PROVIDERS = new Set(['github_copilot', 'anthropic', 'openai_codex'])

type NormalizedChat = {
  model: string
  choices: Array<{ message: { role: 'assistant'; content: string }; finish_reason: string }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

function normalized(model: string, text: string, promptTokens: number, completionTokens: number): Response {
  const body: NormalizedChat = {
    model,
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }
  return new Response(JSON.stringify(body), { status: 200 })
}

type SimpleMessage = { role: 'user' | 'assistant'; content: string }

function splitSystem(messages: ChatMessages): { system: string | null; rest: SimpleMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const rest = messages
    .filter((m): m is SimpleMessage => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))
  return { system: system || null, rest }
}

async function anthropicChat(
  config: ResolvedLlmConfig,
  opts: { model: string; messages: ChatMessages; maxTokens: number; signal?: AbortSignal },
): Promise<Response> {
  const { system, rest } = splitSystem(opts.messages)
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    stream: false,
    // OAuth tokens MUST carry the Claude Code identity system preamble (pi: buildParams).
    system: [{ type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_PREFIX }, ...(system ? [{ type: 'text', text: system }] : [])],
    messages: rest,
  }
  const res = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // OAuth tokens authenticate via Bearer — never x-api-key (pi: createClient OAuth branch).
      Authorization: `Bearer ${config.apiKey}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': ANTHROPIC_OAUTH_BETAS.join(','),
      ...ANTHROPIC_OAUTH_HEADERS,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) {
    return res
  }
  const data = (await res.json()) as {
    model?: unknown
    content?: Array<{ type?: unknown; text?: unknown }>
    usage?: { input_tokens?: unknown; output_tokens?: unknown }
  }
  const text = (data.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
  const promptTokens = typeof data.usage?.input_tokens === 'number' ? data.usage.input_tokens : 0
  const completionTokens = typeof data.usage?.output_tokens === 'number' ? data.usage.output_tokens : 0
  return normalized(typeof data.model === 'string' ? data.model : opts.model, text, promptTokens, completionTokens)
}

/** Codex only streams: accumulate output_text deltas until response.completed. */
async function codexChat(
  config: ResolvedLlmConfig,
  opts: { model: string; messages: ChatMessages; maxTokens: number; signal?: AbortSignal },
): Promise<Response> {
  const { system, rest } = splitSystem(opts.messages)
  const body = {
    model: opts.model,
    store: false,
    stream: true,
    instructions: system ?? 'You are a helpful assistant.',
    input: rest.map((message) => ({
      role: message.role,
      content: [{ type: 'input_text', text: message.content }],
    })),
    text: { verbosity: 'medium' },
    include: ['reasoning.encrypted_content'],
    parallel_tool_calls: false,
  }

  let accountId = ''
  try {
    const parts = config.apiKey.split('.')
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1] ?? '')) as Record<string, unknown>
      const claim = payload['https://api.openai.com/auth'] as { chatgpt_account_id?: unknown } | undefined
      if (typeof claim?.chatgpt_account_id === 'string') accountId = claim.chatgpt_account_id
    }
  } catch {
    accountId = ''
  }

  const res = await fetch(`${config.baseUrl}/codex/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${config.apiKey}`,
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      originator: 'pi',
      'OpenAI-Beta': 'responses=experimental',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok || !res.body) {
    return res
  }

  // Accumulate the SSE stream: output_text deltas for text, response.completed for usage.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let model = opts.model
  let promptTokens = 0
  let completionTokens = 0
  let settled = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
        if (dataLine && dataLine !== '[DONE]') {
          try {
            const event = JSON.parse(dataLine) as { type?: unknown; delta?: unknown; response?: unknown }
            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
              text += event.delta
            }
            if (
              event.type === 'response.completed' ||
              event.type === 'response.done' ||
              event.type === 'response.incomplete'
            ) {
              const response = event.response as
                | { model?: unknown; output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>; usage?: { input_tokens?: unknown; output_tokens?: unknown } }
                | undefined
              if (response) {
                if (typeof response.model === 'string') model = response.model
                const responseText = (response.output ?? [])
                  .flatMap((item) => item.content ?? [])
                  .filter((block) => block.type === 'output_text' && typeof block.text === 'string')
                  .map((block) => block.text as string)
                  .join('')
                if (responseText) text = responseText
                promptTokens = typeof response.usage?.input_tokens === 'number' ? response.usage.input_tokens : promptTokens
                completionTokens =
                  typeof response.usage?.output_tokens === 'number' ? response.usage.output_tokens : completionTokens
              }
              settled = true
            }
          } catch {
            // skip malformed events
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (!settled) {
    return new Response(JSON.stringify({ error: { message: 'Codex stream ended before completion.' } }), {
      status: 502,
    })
  }
  return normalized(model, text, promptTokens, completionTokens)
}

/**
 * Single dispatch point for chat completions across API shapes. Returns the provider's
 * Response — for adapted providers the body is normalized to OpenAI shape; errors keep
 * their real status so llm-client's typed retry/error handling is unchanged.
 * OpenAI-compatible providers do NOT go through here (llm-client owns that path — it
 * carries EUrouter rule ids and response_format).
 */
export async function fetchProviderChatCompletion(
  config: ResolvedLlmConfig,
  opts: { model: string; messages: ChatMessages; maxTokens: number; temperature?: number; signal?: AbortSignal },
): Promise<Response> {
  if (config.provider === 'anthropic') {
    return anthropicChat(config, opts)
  }
  if (config.provider === 'openai_codex') {
    return codexChat(config, opts)
  }
  throw new LlmHttpError(500, `No API-shape adapter for provider: ${config.provider}`)
}

/**
 * Embeddings across shapes: only OpenAI-compat providers support them. Subscription
 * adapters (anthropic, openai_codex, github_copilot) fail loud naming the fix.
 */
export async function fetchProviderEmbeddings(
  config: ResolvedLlmConfig,
  opts: { model: string; input: string | string[]; dimensions: number; signal?: AbortSignal },
): Promise<Response> {
  if (NO_EMBEDDING_PROVIDERS.has(config.provider)) {
    throw new LlmHttpError(
      400,
      `${config.provider} does not provide embeddings — save an embedding-capable provider (EUrouter, OpenRouter, …) for memory features.`,
    )
  }
  return fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      dimensions: opts.dimensions,
      input: opts.input,
    }),
    signal: opts.signal,
  })
}
