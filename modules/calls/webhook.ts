import type { LiveKitConfig } from './livekit'
import type { CallsService, CallWebhookEvent } from './service'
import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk'
import { CallsError } from './errors'

/**
 * POST /api/calls/livekit — LiveKit's signed webhook (via ee's loopback
 * listener). Nothing is read before the signature verifies: the
 * Authorization header is a JWT signed with the API secret that carries the
 * body's sha256 (WebhookReceiver). participant_joined / participant_left /
 * room_finished are the truth about who was really in a call.
 */

export type WebhookResult = { status: number; body: Record<string, unknown> }

/** The call meaning of a verified LiveKit event; null for events Calls does not use. */
export function callEventOf(event: WebhookEvent): CallWebhookEvent | null {
  const room = event.room?.name
  if (!room) return null
  switch (event.event) {
    case 'room_finished':
      return { kind: 'room_finished', room }
    // A connection that never completed (aborted) is someone who did not stay: left.
    case 'participant_joined':
    case 'participant_left':
    case 'participant_connection_aborted': {
      const identity = event.participant?.identity
      if (!identity) return null
      return { kind: event.event === 'participant_joined' ? 'participant_joined' : 'participant_left', room, identity }
    }
    default:
      return null
  }
}

export async function handleLiveKitWebhook(
  service: Pick<CallsService, 'applyWebhook'>,
  config: () => LiveKitConfig,
  rawBody: string,
  authorization: string | null,
): Promise<WebhookResult> {
  let cfg: LiveKitConfig
  try {
    cfg = config()
  } catch (err) {
    if (err instanceof CallsError && err.code === 'not_configured') return { status: 503, body: { error: err.message, code: err.code } }
    throw err
  }
  if (!authorization) return { status: 401, body: { error: 'missing webhook signature' } }
  let event: WebhookEvent
  try {
    event = await new WebhookReceiver(cfg.apiKey, cfg.apiSecret).receive(rawBody, authorization)
  } catch {
    return { status: 401, body: { error: 'invalid webhook signature' } }
  }
  const ev = callEventOf(event)
  if (!ev) return { status: 200, body: { ok: true, applied: false } }
  const out = await service.applyWebhook(ev)
  return { status: 200, body: { ok: true, applied: out.applied } }
}
