import { describe, expect, it } from 'vitest'
import { parseSesEvent } from './ses-events'
import { nextStatus } from './status'
import { normalizeEmail, partitionSuppressed } from './suppression'

const mail = { messageId: 'ses-1', timestamp: '2026-11-04T12:00:00.000Z', tags: { ee_message: ['log-1'] } }

describe('parseSesEvent', () => {
  it('maps every tracked event type to a log status, with our log id from the tag', () => {
    const types: [string, string][] = [
      ['Send', 'sent'],
      ['Delivery', 'delivered'],
      ['Open', 'opened'],
      ['Click', 'clicked'],
      ['Reject', 'rejected'],
      ['DeliveryDelay', 'delivery_delayed'],
      ['Rendering Failure', 'rendering_failure'],
    ]
    for (const [eventType, status] of types) {
      expect(parseSesEvent({ eventType, mail })).toMatchObject({ status, sesMessageId: 'ses-1', logId: 'log-1' })
    }
    expect(parseSesEvent({ eventType: 'Subscription', mail })).toBeNull()
  })

  it('a permanent bounce suppresses its recipients; a transient one does not', () => {
    const permanent = parseSesEvent({
      eventType: 'Bounce',
      mail,
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'NoEmail',
        timestamp: '2026-11-04T12:01:00.000Z',
        bouncedRecipients: [{ emailAddress: 'Gone@x.co', diagnosticCode: '550 5.1.1 user unknown' }],
      },
    })
    expect(permanent).toMatchObject({
      status: 'bounced',
      detail: { bounceType: 'Permanent', bounceSubType: 'NoEmail', diagnostic: '550 5.1.1 user unknown' },
      suppress: [{ email: 'Gone@x.co', reason: 'HARD_BOUNCE' }],
    })
    expect(permanent!.occurredAt.toISOString()).toBe('2026-11-04T12:01:00.000Z')
    const transient = parseSesEvent({ eventType: 'Bounce', mail, bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'a@x.co' }] } })
    expect(transient!.suppress).toEqual([])
  })

  it('a complaint suppresses the complainer', () => {
    expect(
      parseSesEvent({ eventType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: 'a@x.co' }], complaintFeedbackType: 'abuse' } }),
    ).toMatchObject({ status: 'complained', detail: { feedbackType: 'abuse' }, suppress: [{ email: 'a@x.co', reason: 'COMPLAINT' }] })
  })

  it('keeps the clicked link but no message content', () => {
    const e = parseSesEvent({ eventType: 'Click', mail, click: { link: 'https://kindred.com/x', timestamp: '2026-11-04T13:00:00Z' } })
    expect(e!.detail).toEqual({ link: 'https://kindred.com/x' })
  })

  it('recognises a webmail send by its tag (no log id), and still suppresses its hard bounces', () => {
    const e = parseSesEvent({
      eventType: 'Bounce',
      mail: { messageId: 'ses-9', tags: { ee_webmail: ['1'] } },
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'gone@x.co' }] },
    })
    expect(e).toMatchObject({ webmail: true, logId: null, suppress: [{ email: 'gone@x.co', reason: 'HARD_BOUNCE' }] })
    expect(parseSesEvent({ eventType: 'Delivery', mail: { messageId: 'ses-2' } })).toMatchObject({ webmail: false })
  })

  it('works without our tag (mail sent before tagging)', () => {
    expect(parseSesEvent({ eventType: 'Delivery', mail: { messageId: 'ses-2' } })).toMatchObject({ logId: null })
  })

  it('throws on a body that is not an SES event', () => {
    expect(() => parseSesEvent({ nope: true })).toThrow()
  })
})

describe('nextStatus (log status transitions)', () => {
  it('only moves forward, whatever order SNS delivers in', () => {
    expect(nextStatus('queued', 'sent')).toBe('sent')
    expect(nextStatus('sent', 'delivered')).toBe('delivered')
    expect(nextStatus('opened', 'delivered')).toBe('opened')
    expect(nextStatus('clicked', 'opened')).toBe('clicked')
    expect(nextStatus('delivered', 'complained')).toBe('complained')
    expect(nextStatus('delivered', 'delivery_delayed')).toBe('delivered')
  })

  it('a scheduled message takes whatever happens next', () => {
    expect(nextStatus('scheduled', 'queued')).toBe('queued')
    expect(nextStatus('scheduled', 'cancelled')).toBe('cancelled')
  })
})

describe('suppression filtering', () => {
  it('compares trimmed + lowercased and keeps input order', () => {
    expect(normalizeEmail('  A@B.Co ')).toBe('a@b.co')
    expect(partitionSuppressed(['x@y.co', ' Gone@Y.co', 'z@y.co'], new Set(['gone@y.co']))).toEqual({
      allowed: ['x@y.co', 'z@y.co'],
      suppressed: [' Gone@Y.co'],
    })
  })
})
