import type { ChatMessage } from '$lib/server/llm/llm-client'
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type Models,
  type PiMessage,
  type PiTool,
  type ProviderStreams,
  type StopReason,
  type TextContent,
  type ToolCall,
  type TranscriptContext,
  type PiUsage,
} from './pi-durable'

/**
 * The pi-ai provider whose model calls ARE LLM-gateway calls
 * (plan/phase-durable.md D4): there is no direct provider HTTP anywhere —
 * BYOK resolution, rate limits, gateway retries, activity_call_log and PostHog
 * cost tracking all stay in the gateway. Non-streaming: one complete
 * AssistantMessage per call (the gateway has no streaming variant today).
 */

/** The provider id recorded in every durable conversation's pi.agent doc. */
export const GATEWAY_PROVIDER_ID = 'ee-gateway'
/** The single model this provider exposes (routed by the gateway, not here). */
export const GATEWAY_MODEL_ID = 'orchestrator'
const GATEWAY_API_ID = 'ee-gateway'

/** The gateway completion seam — production wires llmChatCompletion here. */
export type GatewayCompleteFn = (input: {
  userId: string
  messages: ChatMessage[]
  tools?: unknown[]
  temperature?: number
  maxTokens?: number
  /** The durable conversation's provider session id — PostHog session grouping. */
  aiSessionId?: string
  logContext?: string
}) => Promise<unknown>

export type GatewayModelDeps = {
  complete: GatewayCompleteFn
  /**
   * provider-session-id → gateway billing identity. A missing mapping throws
   * loud: the durable agent must never make an anonymous model call.
   */
  resolveUserId: (providerSessionId: string) => Promise<string>
}

const GATEWAY_TEMPERATURE = 0
const GATEWAY_LOG_CONTEXT = 'durable_agent'

/** OpenAI chat-completions `tools` entry for one pi-ai tool declaration. */
function toOpenAiTool(tool: PiTool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function textOfContent(content: string | ReadonlyArray<TextContent | { type: 'image'; data: string; mimeType: string }>): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('')
}

/**
 * TranscriptContext → OpenAI chat messages: the composed system prompt first
 * (pi-ai carries prompt + tools in system messages), then user / assistant
 * (toolCall blocks → `tool_calls`, arguments JSON-stringified) / toolResult
 * (role "tool" + tool_call_id) history.
 */
export function toOpenAiMessages(context: TranscriptContext): ChatMessage[] {
  const out: ChatMessage[] = []
  const systemPrompt = getCurrentSystemPrompt(context.messages)
  if (systemPrompt.trim()) out.push({ role: 'system', content: systemPrompt })

  for (const message of context.messages as readonly PiMessage[]) {
    if (message.role === 'system') {
      // Mid-conversation system messages add instructions from that point on.
      const text = textOfContent(message.content)
      if (text.trim()) out.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'user') {
      const text = textOfContent(message.content)
      out.push({ role: 'user', content: text })
      continue
    }
    if (message.role === 'assistant') {
      const text = message.content
        .filter((block): block is TextContent => block.type === 'text')
        .map((block) => block.text)
        .join('')
      const toolCalls = message.content.filter((block): block is ToolCall => block.type === 'toolCall')
      if (!text && toolCalls.length === 0) continue
      out.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      })
      continue
    }
    // toolResult
    const text = message.content
      .filter((block): block is TextContent => block.type === 'text')
      .map((block) => block.text)
      .join('')
    out.push({ role: 'tool', content: text, tool_call_id: message.toolCallId })
  }
  return out
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as const

/** OpenAI finish_reason → pi-ai stop reason (minimal, mirrors openai-completions). */
function mapStopReason(raw: unknown, hasToolCall: boolean): StopReason {
  if (raw === null || raw === undefined) return hasToolCall ? 'toolUse' : 'stop'
  if (raw === 'stop' || raw === 'end') return 'stop'
  if (raw === 'length') return 'length'
  if (raw === 'tool_calls' || raw === 'function_call') return 'toolUse'
  throw new Error(`gateway returned unsupported finish_reason: ${String(raw)}`)
}

type RawToolCall = {
  id?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

/**
 * Gateway response (raw OpenAI-shaped JSON) → one complete AssistantMessage.
 * Text and/or toolCall blocks; usage mapped from prompt/completion tokens;
 * malformed tool arguments become `argumentsError` with empty arguments.
 */
export function assistantMessageFromGatewayResponse(
  raw: unknown,
  model: Model<string>,
  _providerSessionId: string | undefined,
): AssistantMessage {
  const choice = (raw as { choices?: Array<Record<string, unknown>> })?.choices?.[0]
  if (!choice) throw new Error('gateway response has no choices[0]')
  const message = (choice.message ?? {}) as {
    content?: unknown
    tool_calls?: RawToolCall[]
  }
  const finishReason = choice.finish_reason

  const content: AssistantMessage['content'] = []
  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content })
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const name = typeof call.function?.name === 'string' ? call.function.name : ''
    const rawArguments = call.function?.arguments
    let args: ToolCall['arguments'] = {}
    let argumentsError: string | undefined
    if (typeof rawArguments === 'string' && rawArguments.length > 0) {
      try {
        const parsed = JSON.parse(rawArguments) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as ToolCall['arguments']
        } else {
          argumentsError = 'tool arguments were not a JSON object'
        }
      } catch (err) {
        argumentsError = `tool arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    content.push({
      type: 'toolCall',
      id: typeof call.id === 'string' ? call.id : `call_${content.length}`,
      name,
      arguments: args,
      ...(argumentsError === undefined ? {} : { argumentsError }),
    })
  }

  const usageRaw = (raw as { usage?: Record<string, unknown> })?.usage
  const input = typeof usageRaw?.prompt_tokens === 'number' ? usageRaw.prompt_tokens : 0
  const output = typeof usageRaw?.completion_tokens === 'number' ? usageRaw.completion_tokens : 0
  const usage: PiUsage = {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens:
      typeof usageRaw?.total_tokens === 'number' ? usageRaw.total_tokens : input + output,
    cost: { ...ZERO_COST },
  }

  let stopReason: StopReason
  try {
    stopReason = mapStopReason(finishReason, content.some((block) => block.type === 'toolCall'))
  } catch (err) {
    return {
      role: 'assistant',
      content,
      api: GATEWAY_API_ID,
      provider: GATEWAY_PROVIDER_ID,
      model: model.id,
      usage,
      stopReason: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
      rawStopReason: typeof finishReason === 'string' ? finishReason : undefined,
      timestamp: Date.now(),
    }
  }

  return {
    role: 'assistant',
    content,
    api: GATEWAY_API_ID,
    provider: GATEWAY_PROVIDER_ID,
    model: model.id,
    ...(typeof choice.id === 'string' ? { responseId: choice.id } : {}),
    usage,
    stopReason,
    rawStopReason: typeof finishReason === 'string' ? finishReason : undefined,
    timestamp: Date.now(),
  }
}

function errorAssistantMessage(model: Model<string>, error: unknown): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: GATEWAY_API_ID,
    provider: GATEWAY_PROVIDER_ID,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST } },
    stopReason: 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  }
}

/**
 * Emit the complete response on the event stream (faux.js shape): start, one
 * end-event per content block (single delta — the gateway is non-streaming),
 * then done. pi-durable commits partials from these events; one delta per
 * block keeps the durable trace honest without fabricating token streams.
 */
function emitMessage(
  events: ReturnType<typeof createAssistantMessageEventStream>,
  message: AssistantMessage,
  reason: Extract<StopReason, 'stop' | 'length' | 'toolUse'>,
): void {
  const partial: AssistantMessage = { ...message, content: [], stopReason: 'pending' }
  events.push({ type: 'start', partial: { ...partial } })
  message.content.forEach((block, contentIndex) => {
    if (block.type === 'text') {
      partial.content = [...partial.content, { type: 'text', text: '' }]
      events.push({ type: 'text_start', contentIndex, partial: { ...partial } })
      if (block.text) {
        ;(partial.content[contentIndex] as TextContent).text += block.text
        events.push({ type: 'text_delta', contentIndex, delta: block.text, partial: { ...partial } })
      }
      events.push({ type: 'text_end', contentIndex, content: block.text, partial: { ...partial } })
      return
    }
    if (block.type === 'toolCall') {
      partial.content = [
        ...partial.content,
        { type: 'toolCall', id: block.id, name: block.name, arguments: {} },
      ]
      events.push({ type: 'toolcall_start', contentIndex, partial: { ...partial } })
      const delta = JSON.stringify(block.arguments)
      if (delta !== '{}') {
        events.push({ type: 'toolcall_delta', contentIndex, delta, partial: { ...partial } })
      }
      partial.content[contentIndex] = block
      events.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: { ...partial } })
    }
  })
  events.push({ type: 'done', reason, message })
  events.end(message)
}

/**
 * The custom provider api: `stream`/`streamSimple` call the LLM gateway.
 * Errors are emitted on the stream (pi-durable's own retry/backoff then
 * applies) — this layer never retries on its own.
 */
export function createGatewayProviderApi(deps: GatewayModelDeps): ProviderStreams {
  const stream = (
    model: Model<string>,
    context: TranscriptContext,
    options?: { sessionId?: string },
  ) => {
    const events = createAssistantMessageEventStream()
    void (async () => {
      try {
        const providerSessionId = options?.sessionId
        if (!providerSessionId) {
          throw new Error('durable gateway model call has no provider sessionId — cannot attribute billing')
        }
        const userId = await deps.resolveUserId(providerSessionId)
        const messages = toOpenAiMessages(context)
        const tools = getCurrentTools(context.messages).map(toOpenAiTool)
        const raw = await deps.complete({
          userId,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          temperature: GATEWAY_TEMPERATURE,
          maxTokens: model.maxTokens,
          aiSessionId: providerSessionId,
          logContext: GATEWAY_LOG_CONTEXT,
        })
        const message = assistantMessageFromGatewayResponse(raw, model, providerSessionId)
        if (message.stopReason === 'error') {
          const error = errorAssistantMessage(model, message.errorMessage ?? 'gateway error')
          events.push({ type: 'error', reason: 'error', error })
          events.end(error)
          return
        }
        emitMessage(events, message, message.stopReason as Extract<StopReason, 'stop' | 'length' | 'toolUse'>)
      } catch (err) {
        const error = errorAssistantMessage(model, err)
        events.push({ type: 'error', reason: 'error', error })
        events.end(error)
      }
    })()
    return events
  }
  return {
    stream,
    streamSimple: (model, context, options) =>
      stream(model, context, options as { sessionId?: string } | undefined),
  }
}

/** The ee-gateway model descriptor as it appears in the Models catalog. */
export function gatewayModelDescriptor(): Model<string> {
  return {
    id: GATEWAY_MODEL_ID,
    name: 'Orchestrator (EE LLM gateway)',
    api: GATEWAY_API_ID,
    provider: GATEWAY_PROVIDER_ID,
    // The gateway owns the upstream URL; this field is never dialed.
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  }
}

/**
 * The Models catalog with the gateway-backed provider registered. Injectable
 * in tests: pass a fake `complete` — no HTTP anywhere.
 */
export function createGatewayModelCatalog(deps: GatewayModelDeps): Models {
  const models = createModels()
  models.setProvider(
    createProvider({
      id: GATEWAY_PROVIDER_ID,
      name: 'eigenEnterprise LLM gateway',
      auth: { apiKey: { name: 'EE gateway', resolve: async () => ({ auth: {} }) } },
      models: [gatewayModelDescriptor()],
      api: createGatewayProviderApi(deps),
    }),
  )
  return models
}
