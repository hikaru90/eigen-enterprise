import type { Actions, PageServerLoad } from './$types'
import { error, fail } from '@sveltejs/kit'
import { createMemoryRateLimiter } from '$lib/server/mail/api-send'
import { AudienceError } from '../../../../../modules/email/platform/flows/service'
import { emailPlatform } from '../../../../../modules/email/platform/service'

/**
 * /mail/subscribe/<list id> — the public sign-up page of a list (only when the
 * owner turned "public sign-up" on). Double-opt-in lists send the confirmation
 * mail; a per-visitor rate limit keeps the form from being used to spam.
 */
const limiter = createMemoryRateLimiter({ limit: 5, windowMs: 60 * 60_000 })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function publicList(listId: string) {
  if (!UUID.test(listId)) error(404, 'This sign-up page does not exist.')
  const list = await emailPlatform()
    .audience.getList(listId)
    .catch((err: unknown) => {
      if (err instanceof AudienceError) return null
      throw err
    })
  if (!list || !list.publicSignup) error(404, 'This sign-up page does not exist.')
  return list
}

export const load: PageServerLoad = async ({ params }) => {
  const list = await publicList(params.listId)
  return { list: { name: list.name, description: list.description, doubleOptIn: list.doubleOptIn } }
}

export const actions: Actions = {
  default: async ({ params, request, getClientAddress }) => {
    const list = await publicList(params.listId)
    const form = await request.formData()
    const email = String(form.get('email') ?? '').trim()
    const firstName = String(form.get('firstName') ?? '').trim()
    if (!limiter.take(getClientAddress()).ok) return fail(429, { error: 'Too many sign-ups from here. Try again in an hour.' })
    try {
      const { contact } = await emailPlatform().audience.addContact(list.id, { email, firstName: firstName || null })
      return { done: true, pending: contact.status === 'pending' }
    } catch (err) {
      if (err instanceof AudienceError) return fail(400, { error: err.message })
      throw err
    }
  },
}
