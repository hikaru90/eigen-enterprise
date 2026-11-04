import type { Actions, PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../modules/email/platform/service'

/**
 * /mail/confirm/<token> — double opt-in. Opening the link only asks (mail
 * scanners open links); the button confirms, then the list's flows start.
 */
export const load: PageServerLoad = async ({ params }) => {
  const c = await emailPlatform().audience.contactByToken(params.token)
  if (!c) error(404, 'This confirmation link is not valid (any more).')
  return { email: c.email, list: c.listName, status: c.status }
}

export const actions: Actions = {
  default: async ({ params }) => {
    const c = await emailPlatform().audience.confirm(params.token)
    if (!c) error(404, 'This confirmation link is not valid (any more).')
    return { status: c.status }
  },
}
