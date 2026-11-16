import type { RateLimiter } from './api-send'
import { z } from 'zod'

/**
 * POST /api/mail/subscribe — an app's server adds a visitor to a contact list
 * (e.g. the marketing site's early-access form). The same gate as the public
 * page /mail/subscribe/<list id>: only lists whose public sign-up is on, so a
 * leaked app key cannot fill a private list. The key must be allowed to send
 * mail, because a double-opt-in list sends a confirmation mail.
 */

/** The list service refused the contact (a bad address, a suppressed one, …). */
export class SubscribeRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubscribeRefused'
  }
}

export type MailSubscribeOutcome =
  'added' | 'forbidden' | 'invalid_request' | 'not_found' | 'rate_limited'

export type MailSubscribeDeps = {
  canSendMail(keyId: string): Promise<boolean>
  /** The list, or null when it doesn't exist or its public sign-up is off. */
  publicList(listId: string): Promise<{ id: string } | null>
  /** Throws SubscribeRefused when the list service refuses the contact. */
  addContact(
    listId: string,
    input: { email: string; firstName: string | null },
  ): Promise<{ status: string; created: boolean }>
  limiter: RateLimiter
  audit(entry: {
    keyName: string
    email: string | null
    outcome: MailSubscribeOutcome
    ok: boolean
    activity: string
  }): Promise<void>
}

export type MailSubscribeResult = {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

const body = z
  .object({
    listId: z.string().uuid(),
    email: z.string().trim().min(3).max(320),
    firstName: z.string().trim().max(100).optional(),
  })
  .strict()

export async function handleMailSubscribe(
  deps: MailSubscribeDeps,
  req: { apiKey: { id: string; name: string } | null; body: unknown },
): Promise<MailSubscribeResult> {
  const key = req.apiKey
  if (!key) return { status: 401, body: { error: 'unauthorized' } }

  const audit = (email: string | null, outcome: MailSubscribeOutcome) =>
    deps.audit({
      keyName: key.name,
      email,
      outcome,
      ok: outcome === 'added',
      activity:
        outcome === 'added'
          ? `Added ${email} to a contact list (via key ${key.name})`
          : `Could not add ${email ?? 'a contact'} to a contact list (via key ${key.name}): ${outcome.replace(/_/g, ' ')}`,
    })

  if (!(await deps.canSendMail(key.id))) {
    await audit(null, 'forbidden')
    return { status: 403, body: { error: 'forbidden', message: 'this key may not send mail' } }
  }

  const parsed = body.safeParse(req.body)
  if (!parsed.success) {
    await audit(null, 'invalid_request')
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'body', i.message]),
        ),
      },
    }
  }
  const { listId, email, firstName } = parsed.data

  const rate = deps.limiter.take(key.id)
  if (!rate.ok) {
    await audit(email, 'rate_limited')
    return {
      status: 429,
      body: {
        error: 'rate_limited',
        message: `Too many sign-ups from this key. Retry in ${rate.retryAfterSec}s.`,
      },
      headers: { 'Retry-After': String(rate.retryAfterSec) },
    }
  }

  const list = await deps.publicList(listId)
  if (!list) {
    await audit(email, 'not_found')
    return {
      status: 404,
      body: { error: 'not_found', message: 'no list with public sign-up has this id' },
    }
  }

  try {
    const out = await deps.addContact(list.id, { email, firstName: firstName || null })
    await audit(email, 'added')
    return { status: 200, body: { status: out.status, created: out.created } }
  } catch (err) {
    if (!(err instanceof SubscribeRefused)) throw err
    await audit(email, 'invalid_request')
    return { status: 400, body: { error: 'invalid_request', message: err.message } }
  }
}
