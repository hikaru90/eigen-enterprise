import type { WebsiteStore } from './store'
import { z } from 'zod'
import { moduleSource } from '$lib/kernel/cloudevents'
import { emitKernelEvent, type EventSink } from '$lib/kernel/events'

/**
 * Contact capture: validate a public form submission, persist it, and emit a
 * kernel event. Event payloads carry identifiers only — never the submitter's
 * name, email, or message content.
 */

export const contactInputSchema = z.object({
  name: z.string().trim().max(200).optional(),
  email: z.email(),
  message: z.string().trim().max(5000).optional(),
})

export type ContactCaptureDeps = {
  store: Pick<WebsiteStore, 'createContact'>
  eventSink: EventSink
  /** Optional principal attribution (who processed the submission). */
  principalId?: string
}

export type ContactCaptureResult = {
  id: string
}

function absentWhenBlank(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * Pure contact-submit handler: zod validation (throws loud), store persist,
 * one `website.contact.captured` event. HTTP concerns live in the caller.
 */
export async function handleContactSubmit(
  rawInput: unknown,
  deps: ContactCaptureDeps,
): Promise<ContactCaptureResult> {
  const input = contactInputSchema.parse(rawInput)

  const contact = await deps.store.createContact({
    name: absentWhenBlank(input.name),
    email: input.email,
    message: absentWhenBlank(input.message),
  })

  await emitKernelEvent(deps.eventSink, {
    type: 'website.contact.captured',
    ...(deps.principalId === undefined ? {} : { principalId: deps.principalId }),
    source: moduleSource('website'),
    payload: { contactId: contact.id },
  })

  return { id: contact.id }
}
