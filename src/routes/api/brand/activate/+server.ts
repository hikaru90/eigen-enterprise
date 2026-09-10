import { json } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { activateBrandModule } from '$lib/server/brand/activation'

/**
 * Owner-facing activation entry for the branding module (phase-2d follow-up).
 * Admin-only; the tool call goes through the kernel registry, so the
 * approval gate applies: first call → pendingApproval (owner confirms in the
 * orchestrator chat), retry after approval → activated.
 */
export const POST = async (event: { locals: App.Locals }): Promise<Response> => {
  const user = await requireAdmin(event.locals.user)
  const result = await activateBrandModule(user)
  return json(result)
}
