import type { PushSubscription } from '$lib/server/db/schema'
import { endpointHash } from '$lib/push/endpoint-hash'

/** Pure views of a stored push subscription (no DB: unit-tested in subscription.spec.ts). */

/**
 * The endpoint a renewed subscription replaces (the service worker's
 * `pushsubscriptionchange` posts the new one with `replacesEndpoint`): that
 * row is removed, so the dead endpoint is not pushed to again. null = none.
 */
export function parseReplacedEndpoint(body: unknown, endpoint: string): string | null {
  if (!body || typeof body !== 'object' || !('replacesEndpoint' in body)) return null
  const raw = (body as { replacesEndpoint?: unknown }).replacesEndpoint
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new Error('replacesEndpoint must be a string')
  const old = raw.trim()
  return old && old !== endpoint ? old : null
}

/** One of a person's devices with notifications on, as Settings and the agent see it (no endpoint, no keys). */
export type PushDevice = {
  id: string
  /** SHA-256 of the endpoint: the page finds "this device" by hashing its own (src/lib/push/endpoint-hash.ts). */
  endpointHash: string
  /** The push service's host (web.push.apple.com, fcm.googleapis.com, …). */
  service: string
  userAgent: string | null
  /** When notifications were turned on on this device. */
  since: string
  /** When this device last (re)registered its subscription — every app start does. */
  lastSeen: string
}

export async function pushDeviceView(row: PushSubscription): Promise<PushDevice> {
  return {
    id: row.id,
    endpointHash: await endpointHash(row.endpoint),
    service: new URL(row.endpoint).host,
    userAgent: row.userAgent,
    since: row.createdAt.toISOString(),
    lastSeen: row.updatedAt.toISOString(),
  }
}

