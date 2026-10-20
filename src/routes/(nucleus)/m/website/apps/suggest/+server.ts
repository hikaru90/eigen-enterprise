import type { ContractSuggestion } from '../../../../../../../modules/website/apps/suggest'
import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { logAppFailure, ownerRun } from '$lib/server/website/owner-run'
import { AppUserError } from '../../../../../../../modules/website/apps/contract'

/**
 * POST /m/website/apps/suggest {name, repo?, branch?}: "Let AI fill this out"
 * for the build form. Owner/admin only; runs website.app_suggest_contract as
 * the signed-in owner. Failures come back as one plain sentence.
 */

const FALLBACK_MESSAGE =
  "The AI couldn't fill this in right now. Try again, or fill the form in yourself."

function plainSuggestMessage(err: unknown): string {
  if (err instanceof AppUserError) return err.message
  if (err instanceof KernelError) {
    if (err.code === 'permission_denied') return 'Only an admin can do this.'
    if (err.code === 'invalid_input') return 'Pick the repo and a valid app name first.'
  }
  return FALLBACK_MESSAGE
}

export const POST: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  let input: unknown
  try {
    input = await event.request.json()
  } catch {
    return json({ error: 'Pick the repo and a valid app name first.' }, { status: 400 })
  }
  try {
    const suggestion = await ownerRun<ContractSuggestion>(
      user,
      'website.app_suggest_contract',
      input,
    )
    return json({ suggestion })
  } catch (err) {
    logAppFailure('website.app_suggest_contract', err)
    return json({ error: plainSuggestMessage(err) }, { status: 400 })
  }
}
