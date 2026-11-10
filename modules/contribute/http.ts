import type { ContributeDeps } from './service'
import { json } from '@sveltejs/kit'
import { ContributeError, ERROR_STATUS } from './errors'

/**
 * Shared plumbing for /api/contribute/*: signed-in only, the live deps, and
 * ContributeError → HTTP status. Anything else (the gateway's own errors —
 * no AI provider, no credits) is a 500 with its message, logged.
 */
export async function contributeRoute(
  user: { id: string } | null | undefined,
  run: (userId: string, deps: ContributeDeps) => Promise<unknown>,
  live: () => Promise<ContributeDeps> = async () => (await import('./live')).contributeDeps(),
): Promise<Response> {
  if (!user) return json({ error: 'sign in first' }, { status: 401 })
  try {
    const out = await run(user.id, await live())
    return out instanceof Response ? out : json(out ?? { ok: true })
  } catch (err) {
    if (err instanceof ContributeError) return json({ error: err.message, code: err.code }, { status: ERROR_STATUS[err.code] })
    console.error('[contribute] request failed', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new ContributeError('invalid', 'expected a JSON object body')
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  throw new ContributeError('invalid', 'expected a JSON object body')
}

/** Owner and admins manage the board (status, note). */
export async function canManage(userId: string): Promise<boolean> {
  const { isUserAdmin } = await import('$lib/server/auth/user-role')
  return isUserAdmin(userId)
}
