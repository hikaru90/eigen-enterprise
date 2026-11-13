import type { Actions, PageServerLoad } from './$types'
import { ContactsError } from '../../../../../../../modules/contacts/errors'
import { contactsAction, contactsLoad, liveContactsDeps, personActor } from '../../../../../../../modules/contacts/http'
import { contactTags, importContacts, previewImport } from '../../../../../../../modules/contacts/service'

/**
 * /m/email/people/import: contacts from a vCard (.vcf) or CSV file. The file
 * is read in the browser (a CSV's columns are mapped by the person); the
 * server previews (nothing saved: new, already known by email, not
 * importable) and imports only what the person then confirms.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const actor = personActor(locals.user)
  // Only people in the company (contactTags checks).
  return contactsLoad(async () => ({ tags: await contactTags(await liveContactsDeps(), actor) }))
}

/** The candidates the page sends (JSON in one form field). */
function candidatesField(form: FormData): unknown {
  const raw = form.get('candidates')
  if (typeof raw !== 'string') throw new ContactsError('invalid', 'No contacts were sent.')
  try {
    return JSON.parse(raw)
  } catch {
    throw new ContactsError('invalid', 'The contacts sent are not readable (expected JSON).')
  }
}

export const actions: Actions = {
  preview: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return contactsAction('preview', async () => ({
      action: 'preview' as const,
      preview: await previewImport(await liveContactsDeps(), actor, candidatesField(form)),
    }))
  },
  import: async ({ locals, request }) => {
    const actor = personActor(locals.user)
    const form = await request.formData()
    return contactsAction('import', async () => {
      const out = await importContacts(await liveContactsDeps(), actor, candidatesField(form), { shared: form.get('shared') === 'on' })
      return {
        action: 'import' as const,
        imported: out.created.map((c) => ({ id: c.id, name: c.name })),
        skipped: out.skipped.length,
      }
    })
  },
}
