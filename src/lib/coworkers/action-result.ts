import { shownErrorOf, type ShownError } from '$lib/errors/agent-report'

/**
 * What a form action of the org chart or Settings → Co-workers answered
 * (src/lib/server/org/page-actions.ts): done, waiting for an approval, or an
 * error with its agent report. Read on the client for one seat / one action.
 */
export type ActionFeedback = { kind: 'done' } | { kind: 'waiting' } | ({ kind: 'error' } & ShownError)

export function feedbackFor(form: unknown, action: string, userId?: string): ActionFeedback | null {
  if (!form || typeof form !== 'object') return null
  const f = form as Record<string, unknown>
  if (f.action !== action) return null
  if (userId !== undefined && f.userId !== userId) return null
  const shown = shownErrorOf(f)
  if (shown) return { kind: 'error', ...shown }
  if (f.waiting === true) return { kind: 'waiting' }
  if (f.ok === true) return { kind: 'done' }
  return null
}
