import type { ManagedMailConfig } from '$lib/server/mail/managed-config'
import type { OwleryStore } from '../owlery/store'
import type { SnsMessage } from '../platform/sns-signature'
import type { IngestDeps } from './ingest'
import { isSnsUrl } from '../platform/sns-signature'
import { IngestRejected, ingestReceived, parseReceipt } from './ingest'

/**
 * A verified SNS message on /api/mail/ses-inbound (the signature is checked by
 * the route before this runs). Only the receiving topic S2 stored is accepted;
 * its SubscriptionConfirmation flips receiving to `ready`; a Received
 * notification is ingested. Status codes tell SNS what to do: 2xx done, 4xx
 * never retry (not ours / can never be stored), 5xx retry (S3 or DB failed).
 */

export type InboundDeps = {
  owlery: Pick<OwleryStore, 'read' | 'writeReceiving'>
  fetch: typeof fetch
  ingest: IngestDeps
  /**
   * eigenEnterprise Mail's config while the box is in managed mode, else null:
   * then only EE_MAIL_INBOUND_TOPIC_ARN is accepted, nothing is written to
   * owlery_settings, and objects must sit under EE_MAIL_INBOUND_PREFIX (D9).
   */
  managed?: () => Promise<ManagedMailConfig | null>
}

export type InboundReply = { status: number; body: Record<string, unknown> }

export async function handleInboundSns(deps: InboundDeps, m: SnsMessage): Promise<InboundReply> {
  const managed = deps.managed ? await deps.managed() : null
  if (managed) return handleManagedInbound(deps, managed, m)
  const settings = await deps.owlery.read()
  if (!settings?.receivingTopicArn || settings.receivingTopicArn !== m.TopicArn) {
    return { status: 403, body: { error: 'This SNS topic does not belong to this company.' } }
  }
  if (m.Type === 'SubscriptionConfirmation') {
    if (!m.SubscribeURL || !isSnsUrl(m.SubscribeURL)) return { status: 400, body: { error: 'SubscribeURL is not an SNS address.' } }
    const res = await deps.fetch(m.SubscribeURL, { redirect: 'error' })
    if (!res.ok) {
      await deps.owlery.writeReceiving({ receivingStatus: 'failed', receivingError: `Amazon SNS refused the confirmation (HTTP ${res.status}).` })
      return { status: 502, body: { error: 'confirmation failed' } }
    }
    await deps.owlery.writeReceiving({ receivingStatus: 'ready', receivingError: null })
    return { status: 200, body: { ok: true, confirmed: true } }
  }
  if (m.Type === 'UnsubscribeConfirmation') {
    await deps.owlery.writeReceiving({
      receivingStatus: 'failed',
      receivingError: 'The SNS subscription for received mail was removed at Amazon. Set up receiving again.',
    })
    return { status: 200, body: { ok: true } }
  }

  let message: unknown
  try {
    message = JSON.parse(m.Message)
  } catch {
    return { status: 400, body: { error: 'The notification is not an SES receipt notification.' } }
  }
  try {
    const parsed = parseReceipt(message)
    if (parsed.kind === 'other') return { status: 200, body: { ok: true, ignored: parsed.notificationType } }
    if (!settings.receivingBucket) {
      // S2 stores the bucket before it subscribes; without it nothing can be checked. Retry, don't drop.
      return { status: 503, body: { error: 'Receiving has no inbound bucket stored yet.' } }
    }
    const out = await ingestReceived(deps.ingest, parsed.notification, settings.receivingBucket)
    return { status: 200, body: { ok: true, ...out } }
  } catch (err) {
    if (err instanceof IngestRejected) return { status: 400, body: { error: err.message } }
    throw err
  }
}

/** Managed mode: the topic, bucket and prefix are pinned by EE_MAIL_* (D9); the subscription is the control plane's. */
async function handleManagedInbound(deps: InboundDeps, managed: ManagedMailConfig, m: SnsMessage): Promise<InboundReply> {
  if (m.TopicArn !== managed.inboundTopicArn) return { status: 403, body: { error: 'This SNS topic does not belong to this company.' } }
  if (m.Type === 'SubscriptionConfirmation') {
    if (!m.SubscribeURL || !isSnsUrl(m.SubscribeURL)) return { status: 400, body: { error: 'SubscribeURL is not an SNS address.' } }
    const res = await deps.fetch(m.SubscribeURL, { redirect: 'error' })
    if (!res.ok) return { status: 502, body: { error: 'confirmation failed' } }
    return { status: 200, body: { ok: true, confirmed: true } }
  }
  if (m.Type === 'UnsubscribeConfirmation') {
    console.error('[inbox] the managed inbound subscription was removed at Amazon', { topicArn: m.TopicArn })
    return { status: 200, body: { ok: true } }
  }
  let message: unknown
  try {
    message = JSON.parse(m.Message)
  } catch {
    return { status: 400, body: { error: 'The notification is not an SES receipt notification.' } }
  }
  try {
    const parsed = parseReceipt(message)
    if (parsed.kind === 'other') return { status: 200, body: { ok: true, ignored: parsed.notificationType } }
    const out = await ingestReceived(deps.ingest, parsed.notification, managed.inboundBucket, { prefix: managed.inboundPrefix })
    return { status: 200, body: { ok: true, ...out } }
  } catch (err) {
    if (err instanceof IngestRejected) return { status: 400, body: { error: err.message } }
    throw err
  }
}
