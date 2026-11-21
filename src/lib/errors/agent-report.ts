/**
 * One error shape for every surface (owner, 2026-11-21: "every error message
 * should be written for the user … but there should always be a button saying
 * copy agent instructions").
 *
 * An error that reaches a person is an `ErrorReport`: `error` is the plain
 * sentence for the person (what happened, what to do), `agent` is what a coding
 * or ops agent needs to act on it. Servers build it (`$lib/server/errors/report`);
 * pages hand it to `<ErrorNotice>`, which shows the sentence and a "Copy agent
 * instructions" button. This module is isomorphic: the browser renders the
 * instructions text, the server builds the report.
 */

/** What an agent needs to pick a failure up: what ran, what came back, what to do next. */
export type AgentReport = {
  /** What was attempted, in words ("Deploying an app from /m/website/apps/new"). */
  attempted: string
  /** The kernel registry tool that ran, when one did. */
  tool?: string
  /** The tool's input, secrets redacted. */
  input?: unknown
  /** The structured error code (a `KernelError` code, or the error class name). */
  code?: string
  /** The error's structured details (`KernelError.details`), secrets redacted. */
  details?: unknown
  /** The raw cause chain (error message → cause message), secrets redacted. */
  cause?: string
  /** Concrete next steps for a coding or ops agent. */
  nextSteps: string[]
}

/** The wire shape: `fail(400, { ...report })` in actions, `xError: ErrorReport | null` in loads. */
export type ErrorReport = { error: string; agent: AgentReport }

const REDACTED = '[redacted]'

/** AGENTS.md: never log raw credentials — `*key`, `*token`, `*secret`, `password` (and env/secret values). */
function isSecretKey(key: string): boolean {
  const k = key.toLowerCase()
  return (
    k.endsWith('key') ||
    k.endsWith('token') ||
    k.endsWith('secret') ||
    k.includes('password') ||
    k === 'value' ||
    k === 'authorization' ||
    k === 'cookie'
  )
}

/** A deep copy with every secret-named field replaced by "[redacted]". */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[too deep]'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString()
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        isSecretKey(k) && v !== null && v !== undefined && v !== ''
          ? REDACTED
          : redact(v, depth + 1)
    }
    return out
  }
  return value
}

/** Where and when the person saw the error (added by the browser at copy time). */
export type SeenAt = { page: string; at: string }

/**
 * The text the "Copy agent instructions" button puts on the clipboard: a
 * self-contained brief a coding or ops agent can act on without the page.
 * Without a server report (a browser-side failure) it still says what the
 * person saw, where and when, and where to look.
 */
export function agentInstructions(
  error: string,
  agent: AgentReport | null | undefined,
  seen: SeenAt,
  attempted?: string,
): string {
  const lines: string[] = [
    '# eigenEnterprise error — instructions for an agent',
    '',
    `The person saw: "${error}"`,
    `Page: ${seen.page}`,
    `Time: ${seen.at}`,
    `Attempted: ${agent?.attempted ?? attempted ?? 'not recorded by the page'}`,
  ]
  if (agent?.tool) lines.push(`Kernel tool: ${agent.tool}`)
  if (agent?.code) lines.push(`Error code: ${agent.code}`)
  if (agent?.input !== undefined) {
    lines.push(
      '',
      'Input (secrets redacted):',
      '```json',
      JSON.stringify(agent.input, null, 2),
      '```',
    )
  }
  if (agent?.details !== undefined) {
    lines.push('', 'Details:', '```json', JSON.stringify(agent.details, null, 2), '```')
  }
  if (agent?.cause) lines.push('', `Cause: ${agent.cause}`)
  const steps = agent?.nextSteps?.length
    ? agent.nextSteps
    : [
        'This failure happened in the browser or the server sent no report. Reproduce it on the page above, then read the browser console and the server journal (journalctl -u <unit>) at the time above.',
        'Fix the cause in code; if this error has no agent report yet, add one where it is raised (src/lib/server/errors/report.ts).',
      ]
  lines.push('', 'Next steps:', ...steps.map((s, i) => `${i + 1}. ${s}`))
  lines.push(
    '',
    'Rules: the repo is eigenEnterprise (AGENTS.md). Reproduce first, fix the root cause, never weaken checks or add fallbacks.',
  )
  return lines.join('\n')
}

/** An error as a page shows it: the sentence, and the agent report when the server sent one. */
export type ShownError = { error: string; agent: AgentReport | null }

function isAgentReport(v: unknown): v is AgentReport {
  if (!v || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  return typeof a.attempted === 'string' && Array.isArray(a.nextSteps)
}

/**
 * The error half of an action or JSON answer (`{ error, agent }`), read on the
 * client: null when there is no error sentence; `agent` null when it is missing
 * or not a report.
 */
export function shownErrorOf(d: unknown): ShownError | null {
  if (!d || typeof d !== 'object') return null
  const o = d as Record<string, unknown>
  if (typeof o.error !== 'string' || o.error === '') return null
  return { error: o.error, agent: isAgentReport(o.agent) ? o.agent : null }
}
