import type { PageServerLoad } from './$types'

/** Overridable in tests. */
export const _deps = {
  service: async () => (await import('../../../../modules/index')).liveCallsService(),
}

/**
 * /join/[token] — a guest's personal call link (proposal 844bab56). Public,
 * outside the shell: no account, no install; the unguessable token is the
 * proof. The link's state decides the page: not found, too early, expired,
 * over, withdrawn (a plain page, nothing to join) or ok (name → preview →
 * join). The guest's call view comes along only while the link works.
 */
export const load: PageServerLoad = async ({ params, setHeaders }) => {
  const { CallsError } = await import('../../../../modules/calls/errors')
  setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  const service = await _deps.service()
  try {
    const view = await service.guestView(params.token)
    const call = view.status === 'ok' ? await service.guestCall(params.token) : null
    return { token: params.token, view, call }
  } catch (err) {
    if (err instanceof CallsError && err.code === 'not_found') return { token: params.token, view: null, call: null }
    throw err
  }
}
