import type { Actions, PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../../../modules/email/platform/service'
import { act, requireAdmin, requireMember } from '../../access.server'

/** One sent mail: who, what, from where, and its status timeline. */
export const load: PageServerLoad = async ({ locals, params }) => {
  await requireMember(locals)
  const store = emailPlatform().store
  const m = await store.getMessage(params.id)
  if (!m) error(404, 'No such mail')
  const events = await store.events(m.id)
  return {
    message: {
      id: m.id,
      to: m.toAddress,
      from: m.fromAddress,
      replyTo: m.replyTo,
      subject: m.subject,
      status: m.status,
      source: m.source,
      apiKeyName: m.apiKeyName,
      sesMessageId: m.sesMessageId,
      error: m.error,
      scheduledAt: m.scheduledAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      contentStored: m.contentStored,
      html: m.html,
      text: m.text,
      headers: m.headers ?? [],
    },
    events: events.map((e) => ({
      id: e.id,
      status: e.status,
      detail: e.detail,
      at: e.occurredAt.toISOString(),
    })),
  }
}

export const actions: Actions = {
  cancel: async ({ locals, params }) => {
    await requireAdmin(locals)
    return act('cancel', async () => {
      await emailPlatform().cancelScheduled(params.id)
      return {}
    })
  },
}
