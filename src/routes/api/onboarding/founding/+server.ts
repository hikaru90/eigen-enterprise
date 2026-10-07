import type { RequestHandler } from './$types'
import { randomUUID } from 'node:crypto'
import { error, json } from '@sveltejs/kit'
import { bootApp } from '$lib/server/boot'
import { recordFoundingInterview } from '$lib/server/onboarding/founding'
import { ORCHESTRATOR_PRINCIPAL, WEBSITE_FOUNDING_JOURNEY } from '../../../../../modules/orchestrator/brain'

/**
 * The welcome wizard's founding interview (tone of voice, company name,
 * positioning) — recorded as the website-founding journey with its artifacts
 * executed through the kernel (publishes stay owner-approval gated). This is
 * where the onboarding questions live now: the chat never asks them.
 *
 * Contract: all answers optional; every answer blank → { skipped: true };
 * an already-founded company (pages exist, no active journey) → 409 with an
 * explicit message — the founding artifacts execute exactly once.
 */

const FOUNDING_SLUGS = ['brand-tone-of-voice', 'home', 'about', 'contact']

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

  const boot = await bootApp()

  const active = await boot.journeys.getActive(WEBSITE_FOUNDING_JOURNEY.kind)
  if (!active) {
    // Deterministic already-founded check (no error-message sniffing): the
    // founding slugs exist and no journey is open → the artifacts ran once.
    const listed = (await boot.kernel.registry.execute(
      'website.list_pages',
      {},
      { principal: ORCHESTRATOR_PRINCIPAL, requestId: randomUUID() },
    )) as Array<{ slug: string }>
    const founded = listed.filter((p) => FOUNDING_SLUGS.includes(p.slug))
    if (founded.length > 0) {
      return json(
        {
          error:
            'Your company website already exists. Ask the assistant to change it — the founding interview runs once.',
        },
        { status: 409 },
      )
    }
  }

  const result = await recordFoundingInterview({
    registry: boot.kernel.registry,
    journeys: boot.journeys,
    eventSink: boot.kernel.eventSink,
    sessionId: `onboarding:${event.locals.user.id}`,
    answers,
  })

  return json(result)
}
