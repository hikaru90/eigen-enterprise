import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { approvalModeFromResponse, type ApprovalMode } from '$lib/chat/approvals-client'
import { isUserAdmin } from '$lib/server/auth/user-role'

/**
 * Settings → Approval mode: how much the agent may do without asking. The
 * same dropdown as under the chat composer (one component, rule 4); owner and
 * admins only. A failed load is shown as such — never replaced by a default.
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  if (!(await isUserAdmin(event.locals.user.id))) throw redirect(303, '/settings')

  const res = await event.fetch('/api/approvals/mode')
  const mode: ApprovalMode | null = res.ok ? approvalModeFromResponse(await res.json()) : null
  if (!mode) console.error('[settings] approval mode load failed', { status: res.status })
  return {
    approvalMode: mode
      ? ({ status: 'ok', mode } as const)
      : ({ status: 'unavailable' } as const),
  }
}
