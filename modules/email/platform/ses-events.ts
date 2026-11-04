import type { MessageStatus } from './status'
import { z } from 'zod'
import type { SuppressionReason } from '$lib/server/db/email.schema'

/**
 * SES event notifications (the Message inside an SNS Notification), ported
 * from Owlery's ses-hook-parser: which log status an event means, the detail
 * worth keeping on the timeline, and which recipients must be suppressed
 * (permanent bounces, spam complaints). Pure — the store applies the result.
 */

const recipient = z.object({ emailAddress: z.string(), diagnosticCode: z.string().optional() }).passthrough()

export const sesEvent = z
  .object({
    eventType: z.string(),
    mail: z
      .object({
        messageId: z.string(),
        timestamp: z.string().optional(),
        tags: z.record(z.string(), z.array(z.string())).optional(),
      })
      .passthrough(),
    bounce: z
      .object({
        bounceType: z.string().optional(),
        bounceSubType: z.string().optional(),
        bouncedRecipients: z.array(recipient).optional(),
        timestamp: z.string().optional(),
      })
      .passthrough()
      .optional(),
    complaint: z
      .object({
        complainedRecipients: z.array(recipient).optional(),
        complaintFeedbackType: z.string().optional(),
        timestamp: z.string().optional(),
      })
      .passthrough()
      .optional(),
    delivery: z.object({ timestamp: z.string().optional(), smtpResponse: z.string().optional() }).passthrough().optional(),
    send: z.record(z.string(), z.unknown()).optional(),
    reject: z.object({ reason: z.string().optional() }).passthrough().optional(),
    open: z.object({ timestamp: z.string().optional(), userAgent: z.string().optional() }).passthrough().optional(),
    click: z
      .object({ timestamp: z.string().optional(), link: z.string().optional(), userAgent: z.string().optional() })
      .passthrough()
      .optional(),
    deliveryDelay: z.object({ delayType: z.string().optional(), timestamp: z.string().optional() }).passthrough().optional(),
    renderingFailure: z.object({ errorMessage: z.string().optional() }).passthrough().optional(),
  })
  .passthrough()

export type SesEvent = z.infer<typeof sesEvent>

/** The tag ee puts on every send (SesSendInput.tags) — the log row id. */
export const LOG_ID_TAG = 'ee_message'

export type ParsedSesEvent = {
  status: MessageStatus
  sesMessageId: string
  logId: string | null
  occurredAt: Date
  /** What the timeline shows for this event (no message content). */
  detail: Record<string, unknown>
  suppress: { email: string; reason: SuppressionReason }[]
}

const STATUS: Record<string, MessageStatus> = {
  Send: 'sent',
  Delivery: 'delivered',
  Bounce: 'bounced',
  Complaint: 'complained',
  Reject: 'rejected',
  Open: 'opened',
  Click: 'clicked',
  'Rendering Failure': 'rendering_failure',
  DeliveryDelay: 'delivery_delayed',
}

function at(...candidates: (string | undefined)[]): Date {
  for (const c of candidates) {
    if (!c) continue
    const d = new Date(c)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

/** null for event types the log does not track (Subscription …). */
export function parseSesEvent(raw: unknown): ParsedSesEvent | null {
  const e = sesEvent.parse(raw)
  const status = STATUS[e.eventType]
  if (!status) return null
  const logId = e.mail.tags?.[LOG_ID_TAG]?.[0] ?? null
  const base = { status, sesMessageId: e.mail.messageId, logId }
  switch (status) {
    case 'bounced': {
      const permanent = e.bounce?.bounceType === 'Permanent'
      const recipients = e.bounce?.bouncedRecipients ?? []
      return {
        ...base,
        occurredAt: at(e.bounce?.timestamp, e.mail.timestamp),
        detail: {
          bounceType: e.bounce?.bounceType ?? 'Undetermined',
          bounceSubType: e.bounce?.bounceSubType ?? null,
          diagnostic: recipients[0]?.diagnosticCode ?? null,
        },
        suppress: permanent ? recipients.map((r) => ({ email: r.emailAddress, reason: 'HARD_BOUNCE' as const })) : [],
      }
    }
    case 'complained':
      return {
        ...base,
        occurredAt: at(e.complaint?.timestamp, e.mail.timestamp),
        detail: { feedbackType: e.complaint?.complaintFeedbackType ?? null },
        suppress: (e.complaint?.complainedRecipients ?? []).map((r) => ({ email: r.emailAddress, reason: 'COMPLAINT' as const })),
      }
    case 'delivered':
      return { ...base, occurredAt: at(e.delivery?.timestamp, e.mail.timestamp), detail: {}, suppress: [] }
    case 'opened':
      return { ...base, occurredAt: at(e.open?.timestamp), detail: { userAgent: e.open?.userAgent ?? null }, suppress: [] }
    case 'clicked':
      return { ...base, occurredAt: at(e.click?.timestamp), detail: { link: e.click?.link ?? null }, suppress: [] }
    case 'rejected':
      return { ...base, occurredAt: at(e.mail.timestamp), detail: { reason: e.reject?.reason ?? null }, suppress: [] }
    case 'rendering_failure':
      return { ...base, occurredAt: at(e.mail.timestamp), detail: { error: e.renderingFailure?.errorMessage ?? null }, suppress: [] }
    case 'delivery_delayed':
      return {
        ...base,
        occurredAt: at(e.deliveryDelay?.timestamp, e.mail.timestamp),
        detail: { delayType: e.deliveryDelay?.delayType ?? null },
        suppress: [],
      }
    default:
      return { ...base, occurredAt: at(e.mail.timestamp), detail: {}, suppress: [] }
  }
}

/** Opens and clicks repeat; only the first of each lands on the timeline. */
export function isRepeatableEngagement(status: MessageStatus): boolean {
  return status === 'opened' || status === 'clicked'
}
