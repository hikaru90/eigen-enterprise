import type {
  EngineContext,
  EngineSurfaceEvent,
  EngineToolListing,
  LoopEngine,
} from '../engine'
import type { AgentSessionLog } from '../session-log'
import { KernelError } from '../errors'
import { toolErrorResult } from './tool-error'

/**
 * The 'builtin-json' loop engine: the orchestrator's JSON agent protocol,
 * extracted verbatim from modules/orchestrator/brain.ts (plan/phase-1b-
 * harness.md demotion #1). Per model turn the protocol accepts exactly
 * {"tool": "<name>", "arguments": {...}} or {"answer": "<text>"}; leading
 * <think> blocks and markdown fences are stripped; a balanced-object salvage
 * pass runs before a parse failure is counted; parse failures are fed back to
 * the model and fail loud after `parseRetry` consecutive misses.
 */

/** Kernel-local chat message shape (structurally the LLM gateway client's ChatMessage). */
export type EngineChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type LlmCompleteFn = (input: {
  userId: string
  messages: EngineChatMessage[]
  temperature?: number
  logContext?: string
}) => Promise<unknown>

/**
 * Streaming completion seam. Same contract as LlmCompleteFn plus `onDelta`,
 * which receives raw model text chunks while the response is generated. The
 * engine extracts the protocol's answer field incrementally (see
 * StreamedAnswerExtractor) — raw JSON protocol bytes never reach the surface.
 * llmChatCompletion offers no streaming today, so production runs the
 * fallback path: the final reply is emitted as one delta.
 */
export type LlmStreamCompleteFn = (input: {
  userId: string
  messages: EngineChatMessage[]
  temperature?: number
  logContext?: string
  onDelta: (delta: string) => void
}) => Promise<unknown>

/**
 * Production completion path: the existing LLM gateway client. Loaded lazily
 * so unit tests can inject `complete` without importing the provider stack;
 * production never calls providers directly — only through this client.
 */
async function gatewayComplete(input: Parameters<LlmCompleteFn>[0]): Promise<unknown> {
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  return llmChatCompletion(input)
}

const MAX_ITERATIONS = 8
export const MAX_PARSE_RETRIES = 3
/** Conversation turns kept per session (user+assistant pairs trimmed together). */
export const MAX_HISTORY_MESSAGES = 40
const MAX_TOOL_RESULT_CHARS = 12_000

/** Upper bound for tool results fed to the model; longer results are truncated. */
export const MAX_TOOL_RESULT_CHARS_LIMIT = MAX_TOOL_RESULT_CHARS

/**
 * The tool-result text one kernel result is fed to the model as (JSON, bounded).
 * Shared with the durable engine so both engines show the model equivalent content.
 */
export function toolResultText(result: unknown): string {
  const json = JSON.stringify(result ?? null)
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json
  return `${json.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)`
}

/**
 * The structured tool result an approval-gated tool call produces: the request
 * is queued for the company owner and has NOT executed. Shared with the
 * durable engine so the orchestrator's approval UX wording stays consistent.
 */
export function approvalPendingResult(tool: string): {
  status: 'approval_pending'
  tool: string
  message: string
} {
  return {
    status: 'approval_pending',
    tool,
    message: `Tool "${tool}" requires owner approval before it can run. The request is queued for an owner to decide.`,
  }
}

export type BuiltinJsonLoopOptions = {
  /** Overrides the gateway completion call (tests inject fakes; never a real LLM). */
  complete?: LlmCompleteFn
  /**
   * Streaming completion (used only when the EngineContext carries a `stream`
   * sink). When absent, the fallback emits the final reply as one delta.
   */
  streamComplete?: LlmStreamCompleteFn
  /** Persona preamble; the engine appends the JSON protocol, tool list, and rules. */
  systemPrompt: string
  /**
   * Durable conversation memory (required — no fallback): history is derived
   * from `list(sessionId)` per run and each completed turn appends the user
   * message + the reply, so conversations survive engine/process restarts.
   */
  sessionLog: AgentSessionLog
  /** Parse-failure retries before failing loud (default 3). */
  parseRetry?: number
  /**
   * Gateway billing/config identity for LLM calls. Defaults to the agent's
   * principal id (ctx.agent.id) so billing follows the hosted agent.
   */
  llmUserId?: string
  /** Observability log discriminator (default 'builtin_json_loop'). */
  logContext?: string
}

/** The model repeatedly failed to produce protocol-valid JSON — fail loud. */
export class LoopProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoopProtocolError'
  }
}

type ModelTurn =
  | { type: 'tool_call'; tool: string; arguments: Record<string, unknown> }
  | { type: 'final'; content: string }
  | { type: 'parse_error'; reason: string }

function extractContent(raw: unknown): string {
  const choices = (raw as { choices?: Array<{ message?: { content?: unknown } }> })?.choices
  const content = choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

/** Strips a leading <think>...</think> block from the raw LLM output. */
function extractThinking(raw: string): { thinking: string; rest: string } {
  const match = raw.match(/^<think>([\s\S]*?)<\/think>\s*/i)
  if (match) return { thinking: match[1].trim(), rest: raw.slice(match[0].length).trim() }
  return { thinking: '', rest: raw }
}

/** Either {"tool": "<name>", "arguments": {...}} or {"answer": "<text>"}. */
function parseModelTurn(raw: string): ModelTurn {
  const { rest } = extractThinking(raw)
  let trimmed = rest.trim()

  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)```\s*$/)
  if (fenceMatch) trimmed = fenceMatch[1].trim()
  trimmed = trimmed.replace(/```[\s\S]*$/, '').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const firstBrace = trimmed.indexOf('{')
    if (firstBrace >= 0) {
      let depth = 0
      for (let i = firstBrace; i < trimmed.length; i++) {
        if (trimmed[i] === '{') depth++
        else if (trimmed[i] === '}') {
          depth--
          if (depth === 0) {
            try {
              parsed = JSON.parse(trimmed.slice(firstBrace, i + 1))
            } catch {
              parsed = undefined
            }
            if (parsed) break
          }
        }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { type: 'parse_error', reason: 'The model response was not valid JSON.' }
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.tool === 'string' && obj.arguments && typeof obj.arguments === 'object') {
    return {
      type: 'tool_call',
      tool: obj.tool,
      arguments: obj.arguments as Record<string, unknown>,
    }
  }
  if (typeof obj.answer === 'string') return { type: 'final', content: obj.answer }
  return {
    type: 'parse_error',
    reason: 'The model JSON must include either a "tool" or an "answer" field.',
  }
}

function composeSystemPrompt(personaPrompt: string, tools: readonly EngineToolListing[]): string {
  const toolBlock =
    tools.length === 0
      ? '(no tools are currently available)'
      : tools
          .map(
            (tool) =>
              `- ${tool.name}: ${tool.summary}\n  Input schema: ${JSON.stringify(
                tool.inputJsonSchema,
              )}`,
          )
          .join('\n')

  return [
    personaPrompt,
    '',
    'Respond with JSON only. To call a tool:',
    '{"tool": "<tool_name>", "arguments": {<args>}}',
    'When done:',
    '{"answer": "<your response>"}',
    '',
    '=== AVAILABLE TOOLS ===',
    toolBlock,
    '',
    '=== RULES ===',
    '- Only use tools from the list above; never invent tool names.',
    '- Use tools when the request needs stored data or an action; answer directly for plain conversation.',
    '- If a tool result reports status "approval_pending", the action is queued for the company owner: tell the user it is pending owner approval and do not claim it executed.',
    '- If a tool fails, say so in your final answer.',
    '- Output ONLY the JSON object.',
  ].join('\n')
}

/** Upper bound for the metadata-only input summary on tool.preview events. */
export const MAX_TOOL_INPUT_SUMMARY_CHARS = 120

/**
 * Short, truncated, metadata-only projection of a tool call's arguments for
 * surface previews. Never the full arguments — bounded wire payload, no
 * secrets beyond what a one-line summary already exposes.
 */
export function shortToolInputSummary(args: Record<string, unknown>): string | null {
  if (!args || Object.keys(args).length === 0) return null
  try {
    const s = JSON.stringify(args)
    if (s.length <= MAX_TOOL_INPUT_SUMMARY_CHARS) return s
    return `${s.slice(0, MAX_TOOL_INPUT_SUMMARY_CHARS - 1)}…`
  } catch {
    return null
  }
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'
const ANSWER_KEY = '"answer"'

/**
 * Incremental extractor for the protocol's `{"answer": "…"}` string while raw
 * model text streams in. Emits only the unescaped answer characters; nothing
 * before the top-level `"answer"` key opens, nothing after the string closes.
 * Rescans the buffered prefix per feed — buffers are model-turn sized, the
 * simplicity is worth the quadratic worst case.
 */
export class StreamedAnswerExtractor {
  private buffer = ''
  private thinkStripped = false
  private state: 'seek' | 'collect' | 'closed' = 'seek'
  /** Unescaped answer chars confirmed so far (what has been emitted). */
  private confirmed = ''

  /** Feed one raw chunk; returns newly extracted unescaped answer text (may be ''). */
  feed(chunk: string): string {
    if (this.state === 'closed') return ''
    this.buffer += chunk

    if (!this.thinkStripped) {
      if (this.buffer.startsWith(THINK_OPEN)) {
        const close = this.buffer.indexOf(THINK_CLOSE)
        if (close < 0) return ''
        this.buffer = this.buffer.slice(close + THINK_CLOSE.length)
      }
      this.thinkStripped = true
    }

    if (this.state === 'seek') {
      const keyAt = this.buffer.indexOf(ANSWER_KEY)
      if (keyAt < 0) return ''
      let cursor = keyAt + ANSWER_KEY.length
      while (cursor < this.buffer.length && /\s/.test(this.buffer[cursor]!)) cursor += 1
      if (cursor >= this.buffer.length || this.buffer[cursor] !== ':') return ''
      cursor += 1
      while (cursor < this.buffer.length && /\s/.test(this.buffer[cursor]!)) cursor += 1
      if (cursor >= this.buffer.length) return ''
      if (this.buffer[cursor] !== '"') {
        // Not a string value at the answer key — never extract from this turn.
        this.state = 'closed'
        return ''
      }
      this.buffer = this.buffer.slice(cursor + 1)
      this.state = 'collect'
    }

    // Collect: decode the JSON string body up to the closing quote.
    let out = ''
    let i = 0
    while (i < this.buffer.length) {
      const ch = this.buffer[i]!
      if (ch === '"') {
        this.state = 'closed'
        this.buffer = ''
        break
      }
      if (ch === '\\') {
        const next = this.buffer[i + 1]
        if (next === undefined) break // incomplete escape — wait for more
        if (next === 'u') {
          const hex = this.buffer.slice(i + 2, i + 6)
          if (hex.length < 4) break // incomplete \u escape — wait for more
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
          continue
        }
        const decoded = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[
          next as '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't'
        ]
        if (decoded === undefined) break // invalid escape — stop emitting
        out += decoded
        i += 2
        continue
      }
      out += ch
      i += 1
    }

    // `out` is the full decoded answer-so far (the body is re-walked on every
    // feed); emit only the newly decoded suffix.
    if (out.length <= this.confirmed.length) return ''
    const delta = out.slice(this.confirmed.length)
    this.confirmed = out
    return delta
  }

  /** How many answer characters have been extracted so far. */
  get emitted(): number {
    return this.confirmed.length
  }
}

/**
 * The orchestrator's chat loop. Stateless between runs: conversation memory
 * lives entirely in the injected AgentSessionLog (append-only), so sessions
 * resume across engine instances and process restarts.
 */
export class BuiltinJsonLoop implements LoopEngine {
  private readonly complete: LlmCompleteFn
  private readonly streamComplete: LlmStreamCompleteFn | undefined
  private readonly systemPrompt: string
  private readonly sessionLog: AgentSessionLog
  private readonly parseRetry: number
  private readonly llmUserId: string | undefined
  private readonly logContext: string

  constructor(options: BuiltinJsonLoopOptions) {
    if (!options.sessionLog) {
      throw new KernelError(
        'invalid_input',
        'BuiltinJsonLoop requires a sessionLog (durable conversation memory) — none was injected.',
      )
    }
    this.complete = options.complete ?? gatewayComplete
    this.streamComplete = options.streamComplete
    this.systemPrompt = options.systemPrompt
    this.sessionLog = options.sessionLog
    this.parseRetry = options.parseRetry ?? MAX_PARSE_RETRIES
    this.llmUserId = options.llmUserId
    this.logContext = options.logContext ?? 'builtin_json_loop'
  }

  async run(sessionId: string, input: string, ctx: EngineContext): Promise<string> {
    const history = await this.loadHistory(sessionId)
    const tools = ctx.listTools()
    const offeredNames = new Set(tools.map((t) => t.name))

    const messages: EngineChatMessage[] = [
      { role: 'system', content: composeSystemPrompt(this.systemPrompt, tools) },
      ...history,
      { role: 'user', content: input },
    ]

    // Streaming: only when the surface attached a delta sink. Without a
    // configured streaming completion the final reply is emitted as ONE delta
    // (graceful fallback); with one, answer text streams incrementally. A
    // throwing surface sink must never break the loop.
    const streamFn = ctx.stream
    const streamingComplete = streamFn ? this.streamComplete : undefined
    const emitDelta = (delta: string): void => {
      if (!streamFn || !delta) return
      try {
        streamFn(delta)
      } catch {
        // best-effort channel — the reply still returns through the harness
      }
    }
    const emitSurface = (event: EngineSurfaceEvent): void => {
      if (!ctx.surfaceEvent) return
      try {
        ctx.surfaceEvent(event)
      } catch {
        // best-effort channel
      }
    }

    let parseFailures = 0
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      let emittedAnswerChars = 0
      const raw = streamingComplete
        ? await this.callStreamingComplete(messages, ctx, (n) => {
            emittedAnswerChars = n
          }, emitDelta)
        : await this.complete({
            userId: ctx.llmUserId ?? this.llmUserId ?? ctx.agent.id,
            messages,
            temperature: 0,
            logContext: this.logContext,
          })
      const content = extractContent(raw)
      if (!content) return 'The assistant did not produce a response.'

      const turn = parseModelTurn(content)

      if (turn.type === 'parse_error') {
        parseFailures += 1
        if (parseFailures >= this.parseRetry) {
          throw new LoopProtocolError(turn.reason)
        }
        messages.push({ role: 'assistant', content })
        messages.push({
          role: 'user',
          content: `Error: ${turn.reason} Respond with valid JSON only — either {"tool": "<tool_name>", "arguments": {...}} or {"answer": "<your response>"}.`,
        })
        continue
      }

      if (turn.type === 'final') {
        await this.recordTurn(sessionId, ctx.agent.id, input, turn.content)
        // Completeness guarantee: whatever incremental streaming already
        // emitted is a prefix of the answer; emit any remainder (the whole
        // answer on the fallback path).
        emitDelta(turn.content.slice(emittedAnswerChars))
        return turn.content
      }

      parseFailures = 0
      messages.push({ role: 'assistant', content })

      if (!offeredNames.has(turn.tool)) {
        messages.push({
          role: 'user',
          content: `Error: tool "${turn.tool}" is not available. Available tools: ${
            [...offeredNames].join(', ') || '(none)'
          }.`,
        })
        continue
      }

      emitSurface({
        type: 'tool.preview',
        tool: turn.tool,
        inputSummary: shortToolInputSummary(turn.arguments),
      })

      try {
        const result = await ctx.executeTool(turn.tool, turn.arguments)
        messages.push({
          role: 'user',
          content: `Tool result for ${turn.tool}:\n${toolResultText(result)}\n\nIf more tools are needed, call one now. Otherwise give your final answer using {"answer": "<your response>"}.`,
        })
      } catch (err) {
        if (err instanceof KernelError && err.code === 'approval_required') {
          // Owner-approval gate: surface as a structured tool result so the
          // model can tell the user; every other error is reported below.
          emitSurface({ type: 'approval.required', tool: turn.tool })
          messages.push({
            role: 'user',
            content: `Tool result for ${turn.tool}:\n${toolResultText(approvalPendingResult(turn.tool))}\n\nDo not claim the action executed. Tell the user it is pending owner approval, then give your final answer using {"answer": "<your response>"}.`,
          })
          continue
        }
        // Every other tool failure is the tool's result (see tool-error.ts for
        // the boundary): the model sees it and can fix it and retry.
        messages.push({
          role: 'user',
          content: `Tool result for ${turn.tool}:\n${toolResultText(toolErrorResult(turn.tool, err))}\n\nThe tool call failed. Fix it yourself if you can (e.g. call the remediation tool, correct the arguments) and retry. Otherwise give your final answer using {"answer": "<your response>"}, explaining in plain language what you could not do.`,
        })
      }
    }

    return 'The assistant took too many steps to answer. Please try rephrasing your request.'
  }

  /**
   * One streaming completion call: forwards incrementally extracted answer
   * deltas to the surface and reports how many answer chars were emitted so
   * the final turn can guarantee completeness.
   */
  private async callStreamingComplete(
    messages: EngineChatMessage[],
    ctx: EngineContext,
    onEmitted: (chars: number) => void,
    emitDelta: (delta: string) => void,
  ): Promise<unknown> {
    const extractor = new StreamedAnswerExtractor()
    const streamFn = this.streamComplete!
    return streamFn({
      userId: ctx.llmUserId ?? this.llmUserId ?? ctx.agent.id,
      messages,
      temperature: 0,
      logContext: this.logContext,
      onDelta: (delta) => {
        const answer = extractor.feed(delta)
        if (answer) emitDelta(answer)
        onEmitted(extractor.emitted)
      },
    })
  }

  /** History = the session's logged events, capped to the last MAX_HISTORY_MESSAGES. */
  private async loadHistory(sessionId: string): Promise<EngineChatMessage[]> {
    const events = await this.sessionLog.list(sessionId, MAX_HISTORY_MESSAGES)
    return events.map((event) => ({
      role: event.kind,
      content: this.payloadText(event, sessionId),
    }))
  }

  private payloadText(
    event: { kind: string; payload: Record<string, unknown> },
    sessionId: string,
  ): string {
    const text = event.payload['text']
    if (typeof text !== 'string') {
      throw new KernelError(
        'invalid_output',
        `session log ${event.kind} event for session ${sessionId} has no text payload`,
      )
    }
    return text
  }

  /** Append-only turn record: the user input, then the reply. Never updated. */
  private async recordTurn(
    sessionId: string,
    agentId: string,
    userText: string,
    answer: string,
  ): Promise<void> {
    await this.sessionLog.append({ sessionId, agentId, kind: 'user', payload: { text: userText } })
    await this.sessionLog.append({
      sessionId,
      agentId,
      kind: 'assistant',
      payload: { text: answer },
    })
  }
}
