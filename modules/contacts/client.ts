import type { DraftFor, ExtractMode } from './types'

/** "Tell me about them" from the browser: the AI's reading of a description. Saves nothing. */

export const CONTACTS_EXTRACT_URL = '/api/contacts/extract'

export type ReadDescription = <M extends ExtractMode>(mode: M, text: string) => Promise<DraftFor<M>>

/** POST the description; the server's plain sentence on failure. */
export const readDescription: ReadDescription = async (mode, text) => {
  const res = await fetch(CONTACTS_EXTRACT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, text }),
  })
  const raw = await res.text()
  let body: { draft?: unknown; error?: unknown } | null
  try {
    body = JSON.parse(raw) as { draft?: unknown; error?: unknown }
  } catch {
    throw new Error(`Contacts couldn’t read that (HTTP ${res.status}).`)
  }
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Contacts couldn’t read that (HTTP ${res.status}).`)
  if (!body?.draft || typeof body.draft !== 'object') throw new Error('Contacts answered without a draft.')
  return body.draft as DraftFor<typeof mode>
}
