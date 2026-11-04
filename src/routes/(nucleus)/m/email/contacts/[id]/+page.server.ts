import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { CONTACT_STATUSES, type ContactStatus } from '$lib/server/db/email-contacts.schema'
import { AudienceError } from '../../../../../../../modules/email/platform/flows/service'
import { emailPlatform } from '../../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../../access.server'

/** One contact list: its settings, its people, adding and importing them. */
export const load: PageServerLoad = async ({ locals, params, url }) => {
  await requireMember(locals)
  const a = emailPlatform().audience
  const list = await a.getList(params.id).catch((err: unknown) => {
    if (err instanceof AudienceError) error(404, 'No such list')
    throw err
  })
  const raw = url.searchParams.get('status') ?? ''
  const status = (CONTACT_STATUSES as readonly string[]).includes(raw)
    ? (raw as ContactStatus)
    : undefined
  const contacts = await a.contacts(list.id, status)
  return {
    list: {
      id: list.id,
      name: list.name,
      description: list.description,
      doubleOptIn: list.doubleOptIn,
      publicSignup: list.publicSignup,
    },
    status: status ?? '',
    signupUrl: `${url.origin}/mail/subscribe/${list.id}`,
    contacts: contacts.map((c) => ({
      id: c.id,
      email: c.email,
      name: [c.firstName, c.lastName].filter(Boolean).join(' '),
      status: c.status,
      reason: c.unsubscribeReason,
      createdAt: c.createdAt.toISOString(),
    })),
  }
}

export const actions: Actions = {
  add: async ({ locals, params, request }) => {
    await requireAdmin(locals)
    const form = await request.formData()
    return act('add', async () => {
      const out = await emailPlatform().audience.addContact(params.id, {
        email: field(form, 'email'),
        firstName: field(form, 'firstName') || null,
        lastName: field(form, 'lastName') || null,
      })
      return { email: out.contact.email, status: out.contact.status, created: out.created }
    })
  },
  import: async ({ locals, params, request }) => {
    await requireAdmin(locals)
    const csv = String((await request.formData()).get('csv') ?? '')
    return act('import', async () => emailPlatform().audience.importContacts(params.id, csv))
  },
  remove: async ({ locals, request }) => {
    await requireAdmin(locals)
    const id = field(await request.formData(), 'id')
    return act('remove', async () => {
      await emailPlatform().audience.removeContact(id)
      return {}
    })
  },
  settings: async ({ locals, params, request }) => {
    await requireAdmin(locals)
    const form = await request.formData()
    return act('settings', async () => {
      await emailPlatform().audience.updateList(params.id, {
        name: field(form, 'name'),
        description: field(form, 'description') || null,
        doubleOptIn: field(form, 'doubleOptIn') === 'on',
        publicSignup: field(form, 'publicSignup') === 'on',
      })
      return {}
    })
  },
  delete: async ({ locals, params }) => {
    await requireAdmin(locals)
    await emailPlatform().audience.deleteList(params.id)
    throw redirect(303, '/m/email/contacts')
  },
}
