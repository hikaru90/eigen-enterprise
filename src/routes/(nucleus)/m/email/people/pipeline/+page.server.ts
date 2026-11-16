import type { Actions, PageServerLoad } from './$types'
import {
  contactsAction,
  contactsLoad,
  formLogInput,
  formPipelineInput,
  liveContactsDeps,
  personActor,
} from '../../../../../../../modules/contacts/http'
import { logContact, pipeline, updateContact } from '../../../../../../../modules/contacts/service'

/**
 * /m/email/people/pipeline (Contribute 8c6a0cb7): every contact you may see in
 * its GTD list — our move, waiting for a reply, keep in the loop, not
 * contacted yet — with the weekly review. Today is the person's own day.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const actor = personActor(locals.user)
  return contactsLoad(async () => {
    const d = await liveContactsDeps()
    const { todayFor } = await import('../../../../../../../modules/contacts/live')
    return { pipeline: await pipeline(d, actor, await todayFor(actor.userId)) }
  })
}

const idOf = (form: FormData) => (typeof form.get('id') === 'string' ? (form.get('id') as string) : '')

export const actions: Actions = {
  /** One inline change (list, who holds it, via, status, next step, day): only the fields sent. */
  update: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    const id = idOf(form)
    return contactsAction(
      'update',
      async () => {
        const { todayFor } = await import('../../../../../../../modules/contacts/live')
        await updateContact(await liveContactsDeps(), actor, id, formPipelineInput(form), { today: await todayFor(actor.userId) })
        return { action: 'update' as const, id }
      },
      id,
    )
  },
  /** "Log contact" on a row, with where they are now. */
  log: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    const id = idOf(form)
    return contactsAction(
      'log',
      async () => {
        await logContact(await liveContactsDeps(), actor, id, formLogInput(form))
        return { action: 'log' as const, id }
      },
      id,
    )
  },
}
