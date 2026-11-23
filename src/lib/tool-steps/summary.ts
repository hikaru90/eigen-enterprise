/**
 * One tool the assistant ran, as the person reads it (proposal 6b91931f): which tool, a
 * short input summary and a short result summary. Pure and client-safe — the durable engine
 * builds the summaries before they leave the server, and the run page summarizes the
 * (already key-redacted) arguments it receives.
 *
 * These are structural projections (field names, value types, lengths), never a reading of
 * what the input means. Values under secret-looking keys never appear: a key ending in
 * key / token / secret / password / credentials (any case, snake or camel) shows as hidden.
 */

export type ToolStepStatus = 'running' | 'done' | 'failed' | 'stopped'

/** What a finished tool step reports: did it fail, and a short summary of what came back. */
export type ToolStepResult = { failed: boolean; summary: string | null }

/** The brain's CLI meta tool (src/cli/brain-tool.ts EE_AGENT_TOOL_NAME). */
const EE_TOOL = 'ee'

const MAX_INPUT_CHARS = 200
const MAX_RESULT_CHARS = 240
const MAX_VALUE_CHARS = 60
const HIDDEN = '[hidden]'

const SECRET_SUFFIXES = ['key', 'token', 'secret', 'password', 'passwd', 'credentials', 'authorization', 'cookie']

/** A field whose value must never be shown (case and separators ignored). */
export function isSecretKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z]/g, '')
  return flat === 'auth' || SECRET_SUFFIXES.some((suffix) => flat.endsWith(suffix))
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function scalar(value: unknown): string | null {
  if (value === null) return 'none'
  if (typeof value === 'string') return clip(value, MAX_VALUE_CHARS)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function items(n: number): string {
  return n === 1 ? '1 item' : `${n} items`
}

function valueText(value: unknown): string {
  const plain = scalar(value)
  if (plain !== null) return plain
  if (Array.isArray(value)) {
    const parts = value.map(scalar)
    if (value.length > 0 && value.length <= 3 && parts.every((p) => p !== null)) {
      return clip(parts.join(', '), MAX_VALUE_CHARS)
    }
    return items(value.length)
  }
  if (value !== undefined && typeof value === 'object') return '{…}'
  return ''
}

function fieldsText(record: Record<string, unknown>, max: number): string | null {
  const parts: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    parts.push(`${key}: ${isSecretKey(key) ? HIDDEN : valueText(value)}`)
  }
  return parts.length > 0 ? clip(parts.join(' · '), max) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The tool a call really runs: a call of the brain's `ee` CLI with `tool run <name>` is that
 * tool with the CLI's `input`; any other `ee` command stays `ee` with its command words.
 */
export function toolStepTarget(tool: string, args: unknown): { tool: string; input: unknown } {
  if (tool !== EE_TOOL || !isRecord(args) || !Array.isArray(args.args)) return { tool, input: args }
  const words = args.args.filter((w): w is string => typeof w === 'string')
  if (words[0] === 'tool' && words[1] === 'run' && words[2]) {
    return { tool: words[2], input: args.input ?? {} }
  }
  return { tool, input: { command: words.join(' ') } }
}

/** A short, secret-free summary of a tool's input (null when it takes none). */
export function summarizeToolInput(input: unknown): string | null {
  if (input === undefined || input === null) return null
  if (isRecord(input)) return fieldsText(input, MAX_INPUT_CHARS)
  const text = valueText(input)
  return text ? clip(text, MAX_INPUT_CHARS) : null
}

/**
 * A short, secret-free summary of what a tool returned. The engine's structured outcomes
 * keep their meaning: `{status:'error'}` is a failed step (its message is the summary),
 * `{status:'approval_pending'}` is a step waiting for a person.
 */
export function summarizeToolResult(result: unknown): ToolStepResult {
  if (result === undefined || result === null) return { failed: false, summary: null }
  if (isRecord(result) && result.status === 'error') {
    const message = typeof result.message === 'string' ? result.message : 'The tool failed.'
    return { failed: true, summary: clip(message, MAX_RESULT_CHARS) }
  }
  if (isRecord(result) && result.status === 'approval_pending') {
    return { failed: false, summary: 'Waiting for approval; it has not run yet.' }
  }
  if (Array.isArray(result)) return { failed: false, summary: items(result.length) }
  if (isRecord(result)) return { failed: false, summary: fieldsText(result, MAX_RESULT_CHARS) }
  const text = valueText(result)
  return { failed: false, summary: text ? clip(text, MAX_RESULT_CHARS) : null }
}

function words(snake: string): string {
  const text = snake.replace(/[_-]+/g, ' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : snake
}

/**
 * The tool's name in words: `memory.capture_thought` → "Capture thought" in "Memory".
 * The brain's `ee` CLI (anything but `tool run`) is "Company CLI".
 */
export function toolStepLabel(tool: string): { title: string; area: string | null } {
  if (tool === EE_TOOL) return { title: 'Company CLI', area: null }
  const dot = tool.indexOf('.')
  if (dot <= 0 || dot === tool.length - 1) return { title: words(tool), area: null }
  return { title: words(tool.slice(dot + 1)), area: words(tool.slice(0, dot)) }
}
