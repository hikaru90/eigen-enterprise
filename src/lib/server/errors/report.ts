import { redact, type AgentReport, type ErrorReport } from '$lib/errors/agent-report'
import { KernelError, type KernelErrorCode } from '$lib/kernel/errors'

/**
 * Server side of the one error shape (see `$lib/errors/agent-report`). Every
 * page action, load and JSON route that shows a failure builds it here:
 *
 *   } catch (err) {
 *     return fail(400, { action, ...errorReport(err, { attempted, tool, input, plain }) })
 *   }
 *
 * `plain` is the surface's sentence helper (`plainAppMessage`, GitHub's
 * `plainMessage`, …) — the person's sentence is never rewritten here. The
 * agent half is structured (tool, redacted input, code, details, cause) plus
 * next steps chosen by the error's code, never by its text.
 */

export const GENERIC_SENTENCE =
  'Something went wrong. Try again; if it keeps happening, copy the agent instructions and give them to your agent.'

/** Next steps per kernel code — exhaustive: a new code without steps is a type error. */
const KERNEL_STEPS: Record<KernelErrorCode, string[]> = {
  invalid_input: [
    'The kernel registry refused the input before the tool ran; `details.issues` names each rejected field (path + reason).',
    'Compare the input with the tool schema (`ee tool help <tool>`). If the person typed it, the form should say which field to change (add a FIELD_HINTS sentence in src/lib/server/website/owner-run.ts or the surface helper). If the page built it, fix the page action that maps the form to the input.',
  ],
  invalid_output: [
    "The tool ran but its output failed its own output schema: a bug in the tool's module. Find the tool's implementation and fix the output or the schema.",
  ],
  permission_denied: [
    "The signed-in principal lacks the tool's permission. Check the person's role (`ee tool run kernel.whoami`) and the tool's `permission` in its module manifest; only change the role if the owner asks.",
  ],
  approval_required: [
    'The tool is approval-gated and is waiting: list it with `ee approvals list --status pending`; a person decides it, an agent never approves on their behalf.',
  ],
  human_decision_required: [
    'Only a person can decide this approval. Ask the owner to decide it in the chat or on the approvals page.',
  ],
  unknown_tool: [
    'The page called a tool that is not registered. Check the name (`ee tool list`) and that its module is wired in modules/index.ts.',
  ],
  duplicate_tool: ['Two modules register the same tool name. Rename one; tool names are unique.'],
  module_inactive: [
    'The tool belongs to a module that is not active. `ee module list`; activate it only if the owner wants it on.',
  ],
  module_switched_off: [
    'A person switched this plugin off. Only an owner or admin switches it back on (Settings → Plugins); never re-enable it yourself.',
  ],
  module_required: ['Another active module needs this one; deactivate the dependant first.'],
  core_module: ['Core modules cannot be switched off; the call should not have been offered.'],
  unknown_module: ['The module id does not exist. Check `ee module list`.'],
  run_in_progress: ['A run is already in progress for this target. Wait for it, then retry.'],
  unknown_agent: ['The agent id is not registered. Check `ee tool run agent.list`.'],
  agent_disabled: ['The agent is disabled. Enable it only if the owner wants it on.'],
  duplicate_agent: ['An agent with this id already exists.'],
  unknown_engine: ['The loop engine is not registered: a wiring bug in modules/index.ts.'],
  duplicate_engine: ['Two loop engines share an id: a wiring bug.'],
  budget_exceeded: [
    "The company's model spend budget is used up. The owner raises it in Settings → LLM; do not bypass the gateway.",
  ],
  onboarding_inactive: ['The onboarding hand-off is not active for this company.'],
  unknown_principal: ['The principal id is unknown. Check the signed-in user and `kernel.whoami`.'],
  invalid_principal: [
    'The principal is malformed: a bug in how the caller builds its ToolContext.',
  ],
  not_configured: [
    'This feature is not set up on this deployment yet (`details` may say what is missing). Set it up as the owner directs; never default it silently.',
  ],
  no_person: [
    'The company brain acts only as a person; the run named none. Pass the person the run acts for.',
  ],
  turn_not_editable: ['The message is no longer in the conversation; reload the chat.'],
}

function causeChain(err: unknown): string | undefined {
  const parts: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    parts.push(cur.message)
    cur = cur.cause
  }
  if (parts.length === 0 && err !== undefined && err !== null) parts.push(String(err))
  return parts.length ? parts.join(' ← ') : undefined
}

function codeOf(err: unknown): string | undefined {
  if (err instanceof KernelError) return err.code
  if (err instanceof Error) return err.name
  return undefined
}

function detailsOf(err: unknown): unknown {
  if (err instanceof KernelError) return err.details === undefined ? undefined : redact(err.details)
  // Structured fields some error classes carry (GitHubApiError.status, token error kind).
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const out: Record<string, unknown> = {}
    if (typeof e.status === 'number') out.status = e.status
    if (typeof e.kind === 'string') out.kind = e.kind
    return Object.keys(out).length ? out : undefined
  }
  return undefined
}

export type ReportContext = {
  /** What the person was doing, in words: "Deploying an app". */
  attempted: string
  /** The registry tool that ran, when one did (adds a reproduce step). */
  tool?: string
  /** The tool input; redacted before it is kept. */
  input?: unknown
  /** The surface's plain-sentence helper; defaults to the generic sentence. */
  plain?: (err: unknown) => string
  /** Extra steps specific to this surface, listed first. */
  nextSteps?: string[]
}

const JOURNAL_STEP =
  'Read the server journal at the time above for the full error and stack (the page logs every failure).'

function reproduceStep(tool: string, input: unknown): string {
  const json = input === undefined ? '{}' : JSON.stringify(redact(input))
  return `Reproduce: \`ee tool run ${tool} --input '${json}' --principal <owner-id>\` (put back any redacted values first; \`ee tool help ${tool}\` shows the schema).`
}

/** The one error shape, from a caught error. */
export function errorReport(err: unknown, ctx: ReportContext): ErrorReport {
  const code = codeOf(err)
  const steps = [
    ...(ctx.nextSteps ?? []),
    ...(err instanceof KernelError ? KERNEL_STEPS[err.code] : []),
    ...(ctx.tool ? [reproduceStep(ctx.tool, ctx.input)] : []),
    JOURNAL_STEP,
  ]
  const agent: AgentReport = {
    attempted: ctx.attempted,
    ...(ctx.tool ? { tool: ctx.tool } : {}),
    ...(ctx.input !== undefined ? { input: redact(ctx.input) } : {}),
    ...(code ? { code } : {}),
    ...(detailsOf(err) !== undefined ? { details: detailsOf(err) } : {}),
    ...(causeChain(err) ? { cause: causeChain(err) } : {}),
    nextSteps: steps,
  }
  return { error: ctx.plain ? ctx.plain(err) : GENERIC_SENTENCE, agent }
}

/** The one error shape for a refusal that is not an exception (a tool answered `ok: false`). */
export function refusalReport(
  error: string,
  ctx: Omit<ReportContext, 'plain'> & { cause?: string },
): ErrorReport {
  return {
    error,
    agent: {
      attempted: ctx.attempted,
      ...(ctx.tool ? { tool: ctx.tool } : {}),
      ...(ctx.input !== undefined ? { input: redact(ctx.input) } : {}),
      ...(ctx.cause ? { cause: ctx.cause } : {}),
      nextSteps: [
        ...(ctx.nextSteps ?? []),
        ...(ctx.tool ? [reproduceStep(ctx.tool, ctx.input)] : []),
        JOURNAL_STEP,
      ],
    },
  }
}
