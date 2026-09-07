import type { Brain, TelegramSessionRef } from '../chat-gateway/telegram'
import type { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { KernelError } from '$lib/kernel/errors'
import type { ModuleRegistry } from '$lib/kernel/modules'
import { toolInputJsonSchema } from '$lib/kernel/openapi'
import type { KernelRegistry } from '$lib/kernel/registry'
import type { ToolDescriptor } from '$lib/kernel/types'
import type { ChatMessage } from '$lib/server/llm/llm-client'

/**
 * The orchestrator principal: the company agent that executes kernel tools on
 * behalf of gateway users. Every brain tool call runs under this principal —
 * permissions, approval gate, and audit all see it.
 */
export const ORCHESTRATOR_PRINCIPAL: {
  id: string
  kind: 'agent'
  roles: string[]
} = { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }

/**
 * Gateway billing/config identity for the orchestrator's LLM calls. The
 * llm-client resolves platform credentials for it (LLM_BASE_URL /
 * SERVICE_API_KEY_* env or the platform DB config).
 */
export const ORCHESTRATOR_LLM_USER_ID = 'orchestrator'

const MAX_ITERATIONS = 8
const MAX_PARSE_RETRIES = 3
/** Conversation turns kept per session (user+assistant pairs trimmed together). */
export const MAX_HISTORY_MESSAGES = 40
const MAX_TOOL_RESULT_CHARS = 12_000

export type LlmCompleteFn = (input: {
  userId: string
  messages: ChatMessage[]
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

export type OrchestratorBrainOptions = {
  registry: KernelRegistry
  /** Activation store access for the fail-closed tool surface. */
  modules: ModuleRegistry
  /** Overrides the gateway completion call (tests). */
  complete?: LlmCompleteFn
  llmUserId?: string
}

export class OrchestratorBrainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrchestratorBrainError'
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

/**
 * Same JSON protocol as src/lib/server/llm/agent-loop.ts: either
 * {"tool": "<name>", "arguments": {...}} or {"answer": "<text>"}.
 */
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

function buildSystemPrompt(tools: ToolDescriptor[]): string {
  const toolBlock =
    tools.length === 0
      ? '(no tools are currently available)'
      : tools
          .map(
            (tool) =>
              `- ${tool.name}: ${tool.summary}\n  Input schema: ${JSON.stringify(
                toolInputJsonSchema(tool.inputSchema as z.ZodType),
              )}`,
          )
          .join('\n')

  return [
    'You are the orchestrator: the general assistant of this company.',
    'You can act through kernel tools. Every tool call is permission-checked, audited, and (for external actions) gated behind owner approval.',
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
 * Phase-0 brain behind the chat gateway: same JSON agent protocol as the web
 * agent-loop, but executing kernel tools. Conversation state is an in-memory
 * map keyed by gateway session id — deliberately not persisted for Phase 0
 * (a restart starts fresh conversations; sessions themselves live in the DB).
 */
export class OrchestratorBrain implements Brain {
  private readonly registry: KernelRegistry
  private readonly modules: ModuleRegistry
  private readonly complete: LlmCompleteFn
  private readonly llmUserId: string
  private readonly conversations = new Map<string, ChatMessage[]>()

  constructor(options: OrchestratorBrainOptions) {
    this.registry = options.registry
    this.modules = options.modules
    this.complete = options.complete ?? gatewayComplete
    this.llmUserId = options.llmUserId ?? ORCHESTRATOR_LLM_USER_ID
  }

  async respond(session: TelegramSessionRef, text: string): Promise<string> {
    const requestId = randomUUID()
    const history = this.conversations.get(session.sessionId) ?? []
    const tools = await this.offeredTools()
    const offeredNames = new Set(tools.map((t) => t.name))

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(tools) },
      ...history,
      { role: 'user', content: text },
    ]

    let parseFailures = 0
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const raw = await this.complete({
        userId: this.llmUserId,
        messages,
        temperature: 0,
        logContext: 'orchestrator_brain',
      })
      const content = extractContent(raw)
      if (!content) return 'The assistant did not produce a response.'

      const turn = parseModelTurn(content)

      if (turn.type === 'parse_error') {
        parseFailures += 1
        if (parseFailures >= MAX_PARSE_RETRIES) {
          throw new OrchestratorBrainError(turn.reason)
        }
        messages.push({ role: 'assistant', content })
        messages.push({
          role: 'user',
          content: `Error: ${turn.reason} Respond with valid JSON only — either {"tool": "<tool_name>", "arguments": {...}} or {"answer": "<your response>"}.`,
        })
        continue
      }

      if (turn.type === 'final') {
        this.remember(session.sessionId, text, turn.content)
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
        const result = await this.registry.execute(turn.tool, turn.arguments, {
          principal: ORCHESTRATOR_PRINCIPAL,
          requestId,
        })
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

  /**
   * Fail-closed tool surface: only tools of activated modules whose role
   * requirements the orchestrator principal satisfies are offered to the model.
   */
  private async offeredTools(): Promise<ToolDescriptor[]> {
    const offered: ToolDescriptor[] = []
    for (const tool of this.registry.list()) {
      if (!(await this.modules.isToolActive(tool.name))) continue
      if (!tool.permission.roles.some((role) => ORCHESTRATOR_PRINCIPAL.roles.includes(role))) {
        continue
      }
      offered.push(tool)
    }
    return offered
  }

  private remember(sessionId: string, userText: string, answer: string): void {
    const history = [
      ...(this.conversations.get(sessionId) ?? []),
      { role: 'user' as const, content: userText },
      { role: 'assistant' as const, content: answer },
    ]
    const trimmed = history.slice(-MAX_HISTORY_MESSAGES)
    this.conversations.set(sessionId, trimmed)
  }
}
