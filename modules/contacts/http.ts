import type { Actor, ContactInput, ContactsDeps } from './service'
import { error, fail, redirect } from '@sveltejs/kit'
import { ContactsError, ERROR_STATUS } from './errors'

/**
 * The /m/contacts pages' seam onto the service: signed-in people only, form
 * fields → service input, ContactsError → the page's error or a form failure
 * the page shows. Anything else is a real failure: logged and rethrown.
 */

export async function liveContactsDeps(): Promise<ContactsDeps> {
  const { contactsDeps } = await import('./live')
  return contactsDeps()
}

/** The signed-in person as a Contacts actor (else to /login). */
export function personActor(user: { id: string } | null | undefined): Actor & { kind: 'user' } {
  if (!user) throw redirect(302, '/login')
  return { kind: 'user', userId: user.id }
}

const text = (form: FormData, key: string): string => {
  const v = form.get(key)
  return typeof v === 'string' ? v : ''
}

/** Every editable field from the contact form (blank = cleared; unchecked tags and removed channels are gone). */
export function formContactInput(form: FormData): ContactInput {
  const types = form.getAll('channelType')
  const values = form.getAll('channelValue')
  if (types.length !== values.length) throw new ContactsError('invalid', 'Every channel needs a type and a value.')
  const channels = types
    .map((type, i) => ({ type, value: values[i] }))
    // The editor always offers one empty row: a row with no value is not a channel.
    .filter((c) => typeof c.value === 'string' && c.value.trim() !== '')
  const custom = text(form, 'customTags')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
  return {
    name: text(form, 'name'),
    organisation: text(form, 'organisation'),
    title: text(form, 'title'),
    channels,
    metHow: text(form, 'metHow'),
    whyRelevant: text(form, 'whyRelevant'),
    tags: [...form.getAll('tag'), ...custom],
    lastContactedOn: text(form, 'lastContactedOn'),
    nextFollowUpOn: text(form, 'nextFollowUpOn'),
    nextStep: text(form, 'nextStep'),
  }
}

/** The "Log a contact" form. */
export function formLogInput(form: FormData): { on: string; nextFollowUpOn: string; nextStep: string } {
  return { on: text(form, 'on'), nextFollowUpOn: text(form, 'nextFollowUpOn'), nextStep: text(form, 'nextStep') }
}

/** A form action: a ContactsError comes back to the form as `{ action, id, error }` with its status. */
export async function contactsAction<T>(action: string, run: () => Promise<T>, id: string | null = null) {
  try {
    return await run()
  } catch (err) {
    if (err instanceof ContactsError) return fail(ERROR_STATUS[err.code], { action, id, error: err.message })
    throw err
  }
}

/** A page load: not found (or not yours to see) is a 404, a bad filter a 400. */
export async function contactsLoad<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof ContactsError) error(ERROR_STATUS[err.code], err.code === 'not_found' ? 'No such contact' : err.message)
    throw err
  }
}
