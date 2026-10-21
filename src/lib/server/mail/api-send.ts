/**
 * POST /api/mail/send, framework-free so it can be tested end to end with fakes.
 * Contract: docs/agents/send-mail.md.
 *
 * Order of checks: key (401) → "Can send mail" scope (403) → body (400) →
 * rate limit (429) → Email set up (503) → idempotency (200 replay / 409) → send
 * (200 / 502). The owner's tick on the key is the consent, so there is no
 * approval round (decision log, plan/progress.md).
 *
 * Never logged or audited: the key itself, the subject, the text and the html.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MailNotConfiguredError, MailSetupError, type CompanyMail } from './company-mail'

export const mailSendBody = z
  .object({
    to: z.email(),
    subject: z.string().min(1).max(998),
    text: z.string().min(1),
    html: z.string().optional(),
    replyTo: z.email().optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict()

export type MailSendBody = z.infer<typeof mailSendBody>

export type MailSendStore = {
  /** Whether the owner ticked "Can send mail" for this (active) key. */
  canSendMail(keyId: string): Promise<boolean>
  /**
   * Reserve (keyId, idempotencyKey) for 24h. Returns the existing row when one
   * younger than 24h is there; an older one is replaced.
   */
  claim(input: {
    keyId: string
    idempotencyKey: string
    bodyHash: string
    to: string
  }): Promise<
    | { kind: 'claimed'; id: string }
    | { kind: 'existing'; id: string; bodyHash: string; status: 'pending' | 'sent' }
  >
  markSent(id: string, messageId: string | null): Promise<void>
  /** Drop a reservation whose send failed, so a retry can send. */
  release(id: string): Promise<void>
}

export type RateLimiter = {
  take(keyId: string): { ok: true } | { ok: false; retryAfterSec: number }
}

export type MailSendOutcome =
  | 'sent'
  | 'replayed'
  | 'forbidden'
  | 'invalid_request'
  | 'rate_limited'
  | 'mail_not_configured'
  | 'idempotency_conflict'
  | 'delivery_failed'

/** One audit record per attempt. Recipient and key name only, never content. */
export type MailSendAudit = {
  keyName: string
  to: string | null
  outcome: MailSendOutcome
  ok: boolean
  id: string | null
  activity: string
}

export type MailSendDeps = {
  mail: Pick<CompanyMail, 'isConfigured' | 'send'>
  store: MailSendStore
  limiter: RateLimiter
  audit(entry: MailSendAudit): Promise<void>
  newId(): string
}

export type MailSendResult = {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

/**
 * Per-key fixed window, in process memory. ee runs one console process per
 * company, so memory is exact; a restart resets the window, which only ever
 * lets a few more mails through, never blocks wrongly.
 */
export function createMemoryRateLimiter(opts: {
  limit: number
  windowMs: number
  now?: () => number
}): RateLimiter {
  const now = opts.now ?? Date.now
  const windows = new Map<string, { start: number; count: number }>()
  return {
    take(keyId) {
      const t = now()
      const w = windows.get(keyId)
      if (!w || t - w.start >= opts.windowMs) {
        windows.set(keyId, { start: t, count: 1 })
        return { ok: true }
      }
      if (w.count >= opts.limit) {
        return {
          ok: false,
          retryAfterSec: Math.max(1, Math.ceil((w.start + opts.windowMs - t) / 1000)),
        }
      }
      w.count += 1
      return { ok: true }
    },
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function textToHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</p>`
}

function bodyHash(b: MailSendBody): string {
  const canonical = JSON.stringify([b.to, b.subject, b.text, b.html ?? null, b.replyTo ?? null])
  return createHash('sha256').update(canonical).digest('hex')
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys) fields[k] = 'unknown field'
      continue
    }
    const path = issue.path.length > 0 ? issue.path.join('.') : 'body'
    fields[path] ??= issue.message
  }
  return fields
}

const NOT_CONFIGURED = new MailNotConfiguredError().message

export async function handleMailSend(
  deps: MailSendDeps,
  req: { apiKey: { id: string; name: string } | null; body: unknown },
): Promise<MailSendResult> {
  const key = req.apiKey
  if (!key) return { status: 401, body: { error: 'unauthorized' } }

  const audit = (to: string | null, outcome: MailSendOutcome, id: string | null = null) => {
    const ok = outcome === 'sent' || outcome === 'replayed'
    const activity = ok
      ? `Sent an email to ${to} (via key ${key.name})`
      : `Could not send an email${to ? ` to ${to}` : ''} (via key ${key.name}): ${outcome.replace(/_/g, ' ')}`
    return deps.audit({ keyName: key.name, to, outcome, ok, id, activity })
  }

  if (!(await deps.store.canSendMail(key.id))) {
    await audit(null, 'forbidden')
    return { status: 403, body: { error: 'forbidden', message: 'this key may not send mail' } }
  }

  const parsed = mailSendBody.safeParse(req.body)
  if (!parsed.success) {
    await audit(null, 'invalid_request')
    return { status: 400, body: { error: 'invalid_request', fields: fieldErrors(parsed.error) } }
  }
  const body = parsed.data

  const rate = deps.limiter.take(key.id)
  if (!rate.ok) {
    await audit(body.to, 'rate_limited')
    return {
      status: 429,
      body: {
        error: 'rate_limited',
        message: `Too many mails from this key. Retry in ${rate.retryAfterSec}s.`,
      },
      headers: { 'Retry-After': String(rate.retryAfterSec) },
    }
  }

  if (!(await deps.mail.isConfigured())) {
    await audit(body.to, 'mail_not_configured')
    return { status: 503, body: { error: 'mail_not_configured', message: NOT_CONFIGURED } }
  }

  let id: string
  let claimed = false
  if (body.idempotencyKey) {
    const hash = bodyHash(body)
    const claim = await deps.store.claim({
      keyId: key.id,
      idempotencyKey: body.idempotencyKey,
      bodyHash: hash,
      to: body.to,
    })
    if (claim.kind === 'existing') {
      if (claim.bodyHash !== hash) {
        await audit(body.to, 'idempotency_conflict', claim.id)
        return {
          status: 409,
          body: {
            error: 'idempotency_conflict',
            message: 'This idempotencyKey was already used with a different body.',
          },
        }
      }
      if (claim.status === 'pending') {
        await audit(body.to, 'idempotency_conflict', claim.id)
        return {
          status: 409,
          body: {
            error: 'idempotency_conflict',
            message:
              'A send with this idempotencyKey is still in progress. Retry in a few seconds.',
          },
        }
      }
      await audit(body.to, 'replayed', claim.id)
      return { status: 200, body: { id: claim.id, status: 'sent', to: body.to } }
    }
    id = claim.id
    claimed = true
  } else {
    id = deps.newId()
  }

  let messageId: string | null
  try {
    ;({ messageId } = await deps.mail.send({
      to: body.to,
      subject: body.subject,
      text: body.text,
      html: body.html ?? textToHtml(body.text),
      ...(body.replyTo ? { replyTo: body.replyTo } : {}),
    }))
  } catch (err) {
    if (claimed) await deps.store.release(id)
    if (err instanceof MailNotConfiguredError) {
      await audit(body.to, 'mail_not_configured')
      return { status: 503, body: { error: 'mail_not_configured', message: NOT_CONFIGURED } }
    }
    await audit(body.to, 'delivery_failed')
    const message =
      err instanceof MailSetupError
        ? err.message
        : 'The email could not be delivered. Check the Email module status, then retry.'
    return { status: 502, body: { error: 'delivery_failed', message } }
  }

  if (claimed) await deps.store.markSent(id, messageId)
  await audit(body.to, 'sent', id)
  return { status: 200, body: { id, status: 'sent', to: body.to } }
}
