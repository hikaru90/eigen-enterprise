import type { EngineContext, EngineToolListing, LoopEngine } from '../engine'
import { KernelError } from '../errors'

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

export type BuiltinJsonLoopOptions = {
  /** Overrides the gateway completion call (tests inject fakes; never a real LLM). */
  complete?: LlmCompleteFn
  /** Persona preamble; the engine appends the JSON protocol, tool list, and rules. */
  systemPrompt: string
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

function toolResultText(result: unknown): string {
  const json = JSON.stringify(result ?? null)
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json
  return `${json.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)`
}

/**
 * In-memory session memory (Map<sessionId, messages>) held by the engine
 * instance — DOCUMENTED DEBT (v0): not persisted; a restart starts fresh
 * conversations, matching the Phase-0 brain behavior.
 */
export class BuiltinJsonLoop implements LoopEngine {
  private readonly complete: LlmCompleteFn
  private readonly systemPrompt: string
  private readonly parseRetry: number
  private readonly llmUserId: string | undefined
  private readonly logContext: string
  private readonly sessions = new Map<string, EngineChatMessage[]>()

  constructor(options: BuiltinJsonLoopOptions) {
    this.complete = options.complete ?? gatewayComplete
    this.systemPrompt = options.systemPrompt
    this.parseRetry = options.parseRetry ?? MAX_PARSE_RETRIES
    this.llmUserId = options.llmUserId
    this.logContext = options.logContext ?? 'builtin_json_loop'
  }

  async run(sessionId: string, input: string, ctx: EngineContext): Promise<string> {
    const history = this.sessions.get(sessionId) ?? []
    const tools = ctx.listTools()
    const offeredNames = new Set(tools.map((t) => t.name))

    const messages: EngineChatMessage[] = [
      { role: 'system', content: composeSystemPrompt(this.systemPrompt, tools) },
      ...history,
      { role: 'user', content: input },
    ]

    let parseFailures = 0
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const raw = await this.complete({
        userId: this.llmUserId ?? ctx.agent.id,
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
        this.remember(sessionId, input, turn.content)
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

      try {
        const result = await ctx.executeTool(turn.tool, turn.arguments)
        messages.push({
          role: 'user',
          content: `Tool result for ${turn.tool}:\n${toolResultText(result)}\n\nIf more tools are needed, call one now. Otherwise give your final answer using {"answer": "<your response>"}.`,
        })
      } catch (err) {
        if (err instanceof KernelError && err.code === 'approval_required') {
          // Owner-approval gate: surface as a structured tool result so the
          // model can tell the user; every other error fails the cycle loud.
          messages.push({
            role: 'user',
            content: `Tool result for ${turn.tool}:\n${JSON.stringify({
              status: 'approval_pending',
              tool: turn.tool,
              message: `Tool "${turn.tool}" requires owner approval before it can run. The request is queued for an owner to decide.`,
            })}\n\nDo not claim the action executed. Tell the user it is pending owner approval, then give your final answer using {"answer": "<your response>"}.`,
          })
          continue
        }
        throw err
      }
    }

    return 'The assistant took too many steps to answer. Please try rephrasing your request.'
  }

  private remember(sessionId: string, userText: string, answer: string): void {
    const history = [
      ...(this.sessions.get(sessionId) ?? []),
      { role: 'user' as const, content: userText },
      { role: 'assistant' as const, content: answer },
    ]
    const trimmed = history.slice(-MAX_HISTORY_MESSAGES)
    this.sessions.set(sessionId, trimmed)
  }
}
