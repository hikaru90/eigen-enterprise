import { KernelError } from '$lib/kernel/errors'
import type { ErrorReport } from '$lib/errors/agent-report'
import { refusalReport } from '$lib/server/errors/report'

/**
 * The one error shape for surfaces a signed-out visitor sees (sign-in,
 * sign-up, invite, claim, owner link, public forms). The agent half carries
 * only what was attempted, the error code and next steps: no cause text, no
 * details and no input, so nothing about the server's internals, and no
 * email, code or token, leaves through "Copy agent instructions". The full
 * error stays in the server journal.
 */
export function publicErrorReport(
  sentence: string,
  ctx: { attempted: string; err?: unknown; nextSteps?: string[] },
): ErrorReport {
  const report = refusalReport(sentence, {
    attempted: ctx.attempted,
    ...(ctx.nextSteps ? { nextSteps: ctx.nextSteps } : {}),
  })
  const code =
    ctx.err instanceof KernelError
      ? ctx.err.code
      : ctx.err instanceof Error
        ? ctx.err.name
        : undefined
  return code ? { ...report, agent: { ...report.agent, code } } : report
}
