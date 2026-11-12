import { ZodError } from 'zod'
import { redactForLog } from '../../server/observability/redact-for-log'
import { KernelError } from '../errors'

/**
 * The structured tool result a failed tool call hands back to the model, so
 * the agent can see the failure and fix it (activate a module, correct its
 * arguments, retry) instead of the turn aborting. Used by the durable loop engine.
 *
 * Boundary (decided here, applied by the engine): everything that REJECTS
 * from `EngineContext.executeTool` is the tool's outcome — KernelError of any
 * code except approval_required (which keeps its own approval_pending result),
 * zod validation errors, and errors thrown by the tool handler. Failures
 * OUTSIDE that call — the durable harness, its storage, the LLM gateway, the
 * conversation index — are infrastructure and still fail the run loud.
 * Known limitation: an audit/vcs write failing inside registry.execute also
 * rejects from executeTool and is therefore reported to the model, not thrown.
 */
export type ToolErrorResult = {
  status: 'error'
  tool: string
  code: string
  message: string
  details?: unknown
  /** Present when the kernel knows the fix: the tool to call and its input. */
  remediation?: { fix: string; input: Record<string, unknown>; module?: string }
}

export function toolErrorResult(tool: string, err: unknown): ToolErrorResult {
  if (err instanceof KernelError) {
    const details = err.details === undefined ? undefined : redactForLog(err.details)
    const result: ToolErrorResult = {
      status: 'error',
      tool,
      code: err.code,
      message: err.message,
      ...(details === undefined ? {} : { details }),
    }
    const moduleId = err.details?.module
    // Owner, 2026-11-12: the agent may switch on a module that was never
    // switched on (switchedOff: false), never one a person switched off — and
    // never on a guess (the detail missing).
    if (err.code === 'module_inactive' && typeof moduleId === 'string') {
      if (err.details?.switchedOff === false) {
        result.remediation = {
          module: moduleId,
          fix: 'kernel.module_activate',
          input: { module_id: moduleId },
        }
      } else if (err.details?.switchedOff === true) {
        result.message = `${err.message} A person switched it off on purpose. Do not switch it back on yourself: tell the person it is switched off and that the owner or an admin can switch it on in Settings → Plugins.`
      }
    }
    return result
  }
  if (err instanceof ZodError) {
    return {
      status: 'error',
      tool,
      code: 'invalid_input',
      message: 'tool arguments failed validation',
      // path + message only — never the received values (may carry secrets).
      details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    }
  }
  return {
    status: 'error',
    tool,
    code: 'tool_failed',
    message: err instanceof Error ? err.message : String(err),
  }
}

/**
 * The pending approval request id carried by an approval_required KernelError
 * (set by the registry gate). Missing id is a broken invariant: fail loud.
 */
export function approvalIdFromError(err: KernelError): string {
  const id = err.details?.approvalId
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`approval_required error without an approvalId (${err.message})`, { cause: err })
  }
  return id
}

/**
 * The structured tool result an approval-gated tool call produces: the request
 * is queued for the company owner and has NOT executed. The orchestrator's
 * approval UX wording lives here, next to the other structured tool results.
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
