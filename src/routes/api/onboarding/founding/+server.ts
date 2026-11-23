import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { isUserAdmin, personFor } from '$lib/server/auth/user-role'
import { bootApp } from '$lib/server/boot'
import { AlreadyFoundedError, foundCompanyWebsite } from '$lib/server/onboarding/founding'

/**
 * The welcome wizard's founding interview (tone of voice, company name,
 * positioning) — recorded as the website-founding journey with its artifacts
 * executed through the kernel (publishes stay owner-approval gated). This is
 * where the onboarding questions live now: the chat never asks them.
 *
 * Contract: all answers optional; every answer blank → { skipped: true };
 * an already-founded company (pages exist, no active journey) → 409 with an
 * explicit message — the founding artifacts execute exactly once.
 *
 * The artifacts run as the signed-in person (their own click, their kernel
 * roles — CB3: no admin agent identity): a member who may not change the
 * website gets 403.
 */

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') error(400, 'Answers must be strings')
  return value
}

export const POST: RequestHandler = async (event) => {
  if (!event.locals.user) {
    return json({ error: 'You must be signed in.' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    error(400, 'Invalid JSON')
  }
  if (typeof body !== 'object' || body === null) error(400, 'Body must be an object')
  const raw = body as Record<string, unknown>
  // Validate the input BEFORE touching any infrastructure — a malformed body
  // never reaches the kernel or the journey store.
  const answers = {
    tone: optionalString(raw.tone),
    companyName: optionalString(raw.companyName),
    positioning: optionalString(raw.positioning),
  }

  const person = await personFor(event.locals.user.id)
  // The website is the owner's and admins' (website.manage): a member's wizard does not found it.
  if (!person || !(await isUserAdmin(person.id))) {
    return json({ error: 'Only the owner or an admin founds the company website.' }, { status: 403 })
  }
  const principal = { id: person.id, kind: 'human' as const, roles: person.roles }

  const boot = await bootApp()

  try {
    return json(
      await foundCompanyWebsite({
        registry: boot.kernel.registry,
        journeys: boot.journeys,
        eventSink: boot.kernel.eventSink,
        sessionId: `onboarding:${event.locals.user.id}`,
        principal,
        answers,
      }),
    )
  } catch (err) {
    if (err instanceof KernelError && err.code === 'permission_denied') {
      return json({ error: 'Only the owner or an admin founds the company website.' }, { status: 403 })
    }
    if (err instanceof AlreadyFoundedError) return json({ error: err.message }, { status: 409 })
    throw err
  }
}
