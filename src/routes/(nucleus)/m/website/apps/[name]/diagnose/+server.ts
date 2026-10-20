import type { DiagnoseResult } from '../../../../../../../../modules/website/apps/tools'
import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { logAppFailure, ownerRun, plainAppMessage } from '$lib/server/website/owner-run'

/** POST { deployId }: "Ask AI what went wrong" — website.app_diagnose (LLM gateway, JSON schema). */
export const POST: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const body = (await event.request.json().catch(() => ({}))) as { deployId?: unknown }
  try {
    const out = await ownerRun<DiagnoseResult>(user, 'website.app_diagnose', {
      name: event.params.name,
      deployId: body.deployId,
    })
    return json(out)
  } catch (err) {
    logAppFailure('website.app_diagnose', err)
    return json({ error: plainAppMessage(err) }, { status: 400 })
  }
}
