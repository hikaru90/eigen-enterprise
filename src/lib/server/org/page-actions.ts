import { fail } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { CoworkerError } from '$lib/server/coworkers/service'
import { errorReport } from '$lib/server/errors/report'
import { isWaitingForApproval, NotAMemberError } from './person-run'

/**
 * One answer shape for the org chart and Settings → Co-workers form actions
 * (plan/phase-ai-coworkers.md C5): done, waiting for an approval (not an
 * error: the change is asked for, an owner or admin decides it), or refused /
 * failed with the one error shape (a plain sentence + the agent report).
 */

export type ActionDone<A extends string> = { action: A; ok: true; userId?: string }
export type ActionWaiting<A extends string> = { action: A; waiting: true; userId?: string }

/** The form's names for the tools' input keys (a refused field is named the way the form shows it). */
const FIELD_LABELS: Record<string, string> = {
  name: 'the name',
  title: 'the title',
  lens: 'the lens',
  accountabilities: 'the accountabilities (1 to 8, one per line)',
  model_id: 'the model',
  reports_to_user_id: 'who it reports to',
  reports_to_user_ids: 'who it reports to',
  avatar_preset: 'the avatar preset',
  avatar_sha256: 'the uploaded avatar',
  daily_cap_usd: 'the daily cap (dollars above 0, at most 1000)',
  template_id: 'the template',
  user_id: 'who this is for',
  weekdays: 'the days (pick at least one)',
  time: 'the time (HH:MM)',
  time_zone: 'the time zone',
  instruction: 'what to post (1 to 2000 characters)',
  conversation_id: 'where it posts',
  rhythm_id: 'which rhythm',
}

/** The service's own sentence for a refusal (who may, cycles, the pool, …); a field the schema refused, by name. */
function plain(err: unknown): string {
  if (err instanceof CoworkerError) return err.message
  if (err instanceof NotAMemberError) return 'You are not a member of this company.'
  if (err instanceof KernelError) {
    if (err.code === 'permission_denied') return 'Only the owner or an admin can do this.'
    if (err.code === 'invalid_input') {
      const issues = err.details?.issues
      const first = Array.isArray(issues) ? (issues[0] as { path?: unknown } | undefined) : undefined
      const field = typeof first?.path === 'string' && first.path !== '' ? first.path.split('.')[0] : null
      return field
        ? `Check ${FIELD_LABELS[field] ?? `the field “${field}”`}: it is not valid as entered.`
        : 'Some of what was entered is not valid. Check it and try again.'
    }
    return err.message
  }
  return 'Something went wrong. Try again; if it keeps happening, copy the agent instructions and give them to your agent.'
}

function status(err: unknown): number {
  if (err instanceof CoworkerError) return err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400
  if (err instanceof NotAMemberError) return 403
  if (err instanceof KernelError) return err.code === 'permission_denied' ? 403 : err.code === 'invalid_input' ? 400 : 500
  return 500
}

export async function runAction<A extends string>(
  action: A,
  ctx: { attempted: string; tool: string; input: unknown; userId?: string; log: string },
  run: () => Promise<unknown>,
) {
  const id = ctx.userId === undefined ? {} : { userId: ctx.userId }
  try {
    await run()
    return { action, ok: true as const, ...id } satisfies ActionDone<A>
  } catch (err) {
    if (isWaitingForApproval(err)) return { action, waiting: true as const, ...id } satisfies ActionWaiting<A>
    const code = status(err)
    if (code === 500) console.error(`[${ctx.log}] ${ctx.tool} failed`, err)
    return fail(code, {
      action,
      ...id,
      ...errorReport(err, {
        attempted: ctx.attempted,
        tool: ctx.tool,
        input: ctx.input,
        plain,
        nextSteps: [
          err instanceof CoworkerError
            ? `The co-workers service (src/lib/server/coworkers/service.ts) refused this with CoworkerError "${err.code}"; the sentence says why. Its rules (who may change what, no reporting cycles, pool models only) are intended.`
            : `The ${ctx.tool} tool failed (modules/coworkers/tools.ts → src/lib/server/coworkers/service.ts).`,
        ],
      }),
    })
  }
}

/** A form field as text ('' when missing). */
export const field = (form: FormData, key: string): string => form.get(key)?.toString() ?? ''
