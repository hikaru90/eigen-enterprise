import type { DraftFor, ExtractMode, NextUp, ShareTargets, SharingResult } from './types'

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

// ── Next up ──────────────────────────────────────────────────────────────────

export const CONTACTS_NEXT_UP_URL = '/api/contacts/next-up'

/** The assistant's pick, or why there is none: `unavailable` = no AI provider set up (said plainly, no list). */
export type NextUpResult = { ok: true; nextUp: NextUp } | { ok: false; unavailable: boolean; message: string }

export type LoadNextUp = (refresh: boolean) => Promise<NextUpResult>

/** GET the (cached) pick, or POST to ask the assistant again. */
export const loadNextUp: LoadNextUp = async (refresh) => {
  const res = await fetch(CONTACTS_NEXT_UP_URL, { method: refresh ? 'POST' : 'GET' })
  const raw = await res.text()
  let body: { nextUp?: NextUp; error?: unknown; code?: unknown } | null
  try {
    body = JSON.parse(raw) as { nextUp?: NextUp; error?: unknown; code?: unknown }
  } catch {
    return { ok: false, unavailable: false, message: `Couldn’t load suggestions (HTTP ${res.status}).` }
  }
  if (!res.ok) {
    const message = typeof body?.error === 'string' ? body.error : `Couldn’t load suggestions (HTTP ${res.status}).`
    return { ok: false, unavailable: body?.code === 'unavailable', message }
  }
  if (!body?.nextUp || !Array.isArray(body.nextUp.items)) return { ok: false, unavailable: false, message: 'Contacts answered without suggestions.' }
  return { ok: true, nextUp: body.nextUp }
}

// ── Sharing many at once (Contribute 9d28020a) ───────────────────────────────

export const CONTACTS_SHARING_URL = '/api/contacts/sharing'

export type SharingRequest = { action: 'share'; ids: string[]; targets: ShareTargets } | { action: 'private'; ids: string[] }

export type ChangeSharing = (request: SharingRequest) => Promise<SharingResult>

/** POST one sharing change for the chosen contacts; the server's plain sentence on failure. */
export const changeSharing: ChangeSharing = async (request) => {
  const res = await fetch(CONTACTS_SHARING_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const raw = await res.text()
  let body: (Partial<SharingResult> & { error?: unknown }) | null
  try {
    body = JSON.parse(raw) as Partial<SharingResult> & { error?: unknown }
  } catch {
    throw new Error(`Couldn’t change who sees them (HTTP ${res.status}).`)
  }
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Couldn’t change who sees them (HTTP ${res.status}).`)
  if (!Array.isArray(body?.changed) || !Array.isArray(body?.skipped)) throw new Error('Contacts answered without a result.')
  return { changed: body.changed, skipped: body.skipped }
}
