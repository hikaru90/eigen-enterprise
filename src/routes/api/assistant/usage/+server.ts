import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { getUserRole } from '$lib/server/auth/user-role'
import { loadMemberAiCap } from '$lib/server/settings/member-ai-cap-page'

/**
 * The assistant's usage meter (proposal 30a8d920): the signed-in person's AI use today
 * against the company's daily cap per member. A client of settings.my_ai_usage, run as them.
 */
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await getUserRole(locals.user.id))) {
    return json({ error: 'Only members of this company have AI usage here.' }, { status: 403 })
  }
  const { usage } = await loadMemberAiCap(locals.user.id)
  return json(usage)
}
