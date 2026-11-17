import type { NextUpPorts } from './next-up'
import type { Actor, ContactInput, ContactsDeps } from './service'
import { error, fail, json, redirect } from '@sveltejs/kit'
import { ContactsError, ERROR_STATUS } from './errors'
import { contactTags } from './service'
import { EXTRACT_MODES } from './types'

/**
 * The /m/email/people pages' seam onto the service: signed-in people only, form
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

/** The "Log a contact" form ("Where they are now" only when the form asks it; blank = leave as it is). */
export function formLogInput(form: FormData): { on: string; note: string; nextFollowUpOn: string; nextStep: string; stage?: string } {
  return {
    on: text(form, 'on'),
    note: text(form, 'note'),
    nextFollowUpOn: text(form, 'nextFollowUpOn'),
    nextStep: text(form, 'nextStep'),
    ...(form.has('stage') ? { stage: text(form, 'stage') } : {}),
  }
}

/** The pipeline's inline edits: only the fields the request sends (blank clears an optional one). */
export const PIPELINE_FORM_FIELDS = ['stage', 'ownerId', 'via', 'latestStatus', 'nextStep', 'nextFollowUpOn', 'waitingSince'] as const

export function formPipelineInput(form: FormData): ContactInput {
  const out: Record<string, string> = {}
  for (const key of PIPELINE_FORM_FIELDS) if (form.has(key)) out[key] = text(form, key)
  return out
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

/**
 * POST /api/contacts/extract { mode: 'contact' | 'log', text }: the AI's
 * reading of a free description → `{ draft }` to prefill the form with.
 * Saves nothing. Signed-in people in the company only; ContactsError → its
 * status with `{ error, code }`; anything else is logged and a 500.
 */
export async function contactsExtractResponse(user: { id: string } | null | undefined, request: Request): Promise<Response> {
  if (!user) return json({ error: 'sign in first' }, { status: 401 })
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new ContactsError('invalid', 'expected a JSON object body')
    }
    const { mode, text } = (body && typeof body === 'object' ? body : {}) as { mode?: unknown; text?: unknown }
    if (typeof mode !== 'string' || !(EXTRACT_MODES as readonly string[]).includes(mode)) {
      throw new ContactsError('invalid', `mode must be one of ${EXTRACT_MODES.join(', ')}`)
    }
    const actor = personActor(user)
    const d = await liveContactsDeps()
    const { todayFor } = await import('./live')
    const { extractContactDraft, extractLogDraft, liveExtractChat } = await import('./extract')
    // Only people in the company (contactTags checks), and the tags this person's form offers.
    const [tags, today] = await Promise.all([contactTags(d, actor), todayFor(actor.userId)])
    const draft =
      mode === 'contact'
        ? await extractContactDraft(liveExtractChat, { userId: actor.userId, text, today, tags })
        : await extractLogDraft(liveExtractChat, { userId: actor.userId, text, today })
    return json({ draft })
  } catch (err) {
    if (err instanceof ContactsError) return json({ error: err.message, code: err.code }, { status: ERROR_STATUS[err.code] })
    console.error('[contacts.extract] request failed', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/** What the "Next up" endpoint runs on: live by default, doubles in unit tests. */
export type NextUpWiring = {
  deps: () => Promise<ContactsDeps>
  ports: () => Promise<NextUpPorts>
  today: (userId: string) => Promise<string>
}

const liveNextUpWiring: NextUpWiring = {
  deps: liveContactsDeps,
  ports: async () => (await import('./next-up')).liveNextUpPorts(),
  today: async (userId) => (await import('./live')).todayFor(userId),
}

/**
 * GET /api/contacts/next-up (the cached pick, or a new one when it is stale)
 * and POST (refresh: "Suggest again") → `{ nextUp }`. Signed-in people in the
 * company only; no AI provider → 503 `{ error, code: 'unavailable' }`; the
 * provider failing or an unreadable answer → 502; anything else logged, 500.
 */
export async function contactsNextUpResponse(
  user: { id: string } | null | undefined,
  opts: { refresh: boolean },
  wiring: NextUpWiring = liveNextUpWiring,
): Promise<Response> {
  if (!user) return json({ error: 'sign in first' }, { status: 401 })
  try {
    const actor = personActor(user)
    const { nextUp } = await import('./next-up')
    const [d, ports, today] = await Promise.all([wiring.deps(), wiring.ports(), wiring.today(actor.userId)])
    return json({ nextUp: await nextUp(d, ports, actor, { today, refresh: opts.refresh }) })
  } catch (err) {
    if (err instanceof ContactsError) return json({ error: err.message, code: err.code }, { status: ERROR_STATUS[err.code] })
    console.error('[contacts.next-up] request failed', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
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
