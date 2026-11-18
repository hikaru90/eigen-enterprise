import { AccessToken, RoomServiceClient, ServerError, TrackSource } from 'livekit-server-sdk'
import { CALLS_NOT_SET_UP, CallsError } from './errors'
import { GUEST_ATTRIBUTE, GUEST_ROLE } from './guest-attribute'

/**
 * The company's LiveKit server (run by ee as a system workload, plan/video-calls.md §4).
 * ee puts LIVEKIT_URL (wss://rtc.<console host>, for browsers), LIVEKIT_API_URL
 * (LiveKit's server API on a loopback listener, for this server), LIVEKIT_API_KEY
 * and LIVEKIT_API_SECRET into the console's env; they are read at use time and
 * any missing one is an explicit not_configured error — never a default.
 * The secret is never logged or serialized.
 */

export const LIVEKIT_ENV = ['LIVEKIT_URL', 'LIVEKIT_API_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const

/** A room token is good for joining for ten minutes (a connected call outlives it). */
export const TOKEN_TTL_SECONDS = 600

export type LiveKitConfig = {
  /** wss:// signalling URL the browser connects to. */
  readonly url: string
  /** http(s):// server API URL this server calls (close a room); never the public calls host. */
  readonly apiUrl: string
  readonly apiKey: string
  /** Non-enumerable: JSON.stringify and log formatters never see it. */
  readonly apiSecret: string
}

export function livekitConfig(env: Record<string, string | undefined> = process.env): LiveKitConfig {
  const missing = LIVEKIT_ENV.filter((name) => !env[name]?.trim())
  if (missing.length > 0) throw new CallsError('not_configured', `${CALLS_NOT_SET_UP} (missing ${missing.join(', ')})`)
  const url = env.LIVEKIT_URL!.trim()
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new CallsError('not_configured', `${CALLS_NOT_SET_UP} (LIVEKIT_URL is not a URL)`)
  }
  if (protocol !== 'wss:' && protocol !== 'ws:') {
    throw new CallsError('not_configured', `${CALLS_NOT_SET_UP} (LIVEKIT_URL must be a ws:// or wss:// URL)`)
  }
  const apiUrl = env.LIVEKIT_API_URL!.trim()
  let apiProtocol: string
  try {
    apiProtocol = new URL(apiUrl).protocol
  } catch {
    throw new CallsError('not_configured', `${CALLS_NOT_SET_UP} (LIVEKIT_API_URL is not a URL)`)
  }
  if (apiProtocol !== 'http:' && apiProtocol !== 'https:') {
    throw new CallsError('not_configured', `${CALLS_NOT_SET_UP} (LIVEKIT_API_URL must be an http:// or https:// URL)`)
  }
  const cfg = { url, apiUrl, apiKey: env.LIVEKIT_API_KEY!.trim() } as LiveKitConfig
  Object.defineProperty(cfg, 'apiSecret', { value: env.LIVEKIT_API_SECRET!.trim(), enumerable: false })
  return Object.freeze(cfg)
}

export type RoomToken = { token: string; expiresAt: Date }

/** A join token for one room: identity = the user id, name = their display name. */
export async function mintRoomToken(
  cfg: LiveKitConfig,
  who: { room: string; identity: string; name: string },
): Promise<RoomToken> {
  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity: who.identity, name: who.name, ttl: TOKEN_TTL_SECONDS })
  at.addGrant({ roomJoin: true, room: who.room, canPublish: true, canSubscribe: true, canPublishData: true })
  const token = await at.toJwt()
  return { token, expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000) }
}

export { GUEST_ATTRIBUTE } from './guest-attribute'

/**
 * A join token for a guest (proposal 844bab56): that one room, publishing
 * only their own camera, microphone and screen — no data messages, no
 * metadata changes, no admin. Expires at the latest when the guest window
 * closes (`notAfter`).
 */
export async function mintGuestToken(
  cfg: LiveKitConfig,
  who: { room: string; identity: string; name: string; notAfter: Date; now: Date },
): Promise<RoomToken> {
  const left = Math.floor((who.notAfter.getTime() - who.now.getTime()) / 1000)
  if (left <= 0) throw new CallsError('conflict', 'this guest link has expired')
  const ttl = Math.min(TOKEN_TTL_SECONDS, left)
  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity: who.identity, name: who.name, ttl, attributes: { [GUEST_ATTRIBUTE]: GUEST_ROLE } })
  at.addGrant({
    roomJoin: true,
    room: who.room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
    canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE],
  })
  const token = await at.toJwt()
  return { token, expiresAt: new Date(who.now.getTime() + ttl * 1000) }
}

/** What the service needs from LiveKit's server API: close a room (everyone in it is disconnected), remove one person. */
export type RoomControl = {
  closeRoom(roomName: string): Promise<void>
  /** Disconnects one participant (a revoked guest). Someone not in the room is fine. */
  removeParticipant(roomName: string, identity: string): Promise<void>
}

/** RoomServiceClient over LIVEKIT_API_URL (loopback, from ee). A room or person already gone is fine. */
export function liveRoomControl(config: () => LiveKitConfig): RoomControl {
  const client = () => {
    const cfg = config()
    return new RoomServiceClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret)
  }
  const goneIsFine = (err: unknown) => {
    if (err instanceof ServerError && err.code === 'not_found') return
    throw err
  }
  return {
    async closeRoom(roomName) {
      await client().deleteRoom(roomName).catch(goneIsFine)
    },
    async removeParticipant(roomName, identity) {
      await client().removeParticipant(roomName, identity).catch(goneIsFine)
    },
  }
}
