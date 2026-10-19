import { ZodError } from 'zod'
import { redactForLog } from '../../server/observability/redact-for-log'
import { KernelError } from '../errors'

/**
 * The structured tool result a failed tool call hands back to the model, so
 * the agent can see the failure and fix it (activate a module, correct its
 * arguments, retry) instead of the turn aborting. Shared by both loop engines.
 *
 * Boundary (decided here, applied by both engines): everything that REJECTS
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
    if (err.code === 'module_inactive' && typeof moduleId === 'string') {
      result.remediation = {
        module: moduleId,
        fix: 'kernel.module_activate',
        input: { module_id: moduleId },
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
