import type { Actions, PageServerLoad } from './$types'
import { fail } from '@sveltejs/kit'
import { requireCapability } from '$lib/server/auth/require-capability'
import { errorReport } from '$lib/server/errors/report'
import { sentGet, sentList, TracesError, withdraw } from '../../../../../../modules/traces/service'

/**
 * Settings → Company → What was sent (plan/traces-phone-home.md §4): every batch of product
 * signals this box sent the makers, its exact JSON, the values withheld from it, and the owner's
 * "delete from the hub". The same reads and act as traces.sent_list / sent_get / withdraw.
 */

const REASON = 'Only the owner or an admin can see what this box sent the makers.'
const tracesDeps = async () => (await import('$lib/server/traces/live')).liveTracesDeps()

export const load: PageServerLoad = async ({ locals, url }) => {
  const { role } = await requireCapability(locals, 'company.manage', REASON)
  const deps = await tracesDeps()
  const id = url.searchParams.get('batch')
  let open = null
  if (id) {
    try {
      open = await sentGet(deps, id)
    } catch (err) {
      if (!(err instanceof TracesError)) throw err
    }
  }
  return { ...(await sentList(deps, 100)), open, canWithdraw: role === 'owner' }
}

export const actions: Actions = {
  withdraw: async ({ locals, request }) => {
    const { user, role } = await requireCapability(locals, 'company.manage', REASON)
    const raw = (await request.formData()).get('batch')
    const batchId = typeof raw === 'string' && raw !== '' ? raw : null
    try {
      return { action: 'withdraw', ok: true, ...(await withdraw(await tracesDeps(), { id: user.id, isOwner: role === 'owner' }, batchId)) }
    } catch (err) {
      if (!(err instanceof TracesError)) throw err
      return fail(err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 502, {
        action: 'withdraw',
        ...errorReport(err, {
          attempted: 'Deleting product signals from the makers’ hub (Settings → Company → What was sent)',
          input: { batchId },
          plain: () => err.message,
          nextSteps: [`withdraw (modules/traces/service.ts, the traces.withdraw tool) failed with TracesError code "${err.code}".`],
        }),
      })
    }
  },
}
