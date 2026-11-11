import { AccessToken, RoomServiceClient, ServerError } from 'livekit-server-sdk'
import { CALLS_NOT_SET_UP, CallsError } from './errors'

/**
 * The company's LiveKit server (run by ee as a system workload, plan/video-calls.md §4).
 * ee puts LIVEKIT_URL (wss://rtc.<console host>), LIVEKIT_API_KEY and
 * LIVEKIT_API_SECRET into the console's env; they are read at use time and
 * any missing one is an explicit not_configured error — never a default.
 * The secret is never logged or serialized.
 */

export const LIVEKIT_ENV = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const

/** A room token is good for joining for ten minutes (a connected call outlives it). */
export const TOKEN_TTL_SECONDS = 600

export type LiveKitConfig = {
  /** wss:// signalling URL the browser connects to. */
  readonly url: string
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
  const cfg = { url, apiKey: env.LIVEKIT_API_KEY!.trim() } as LiveKitConfig
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

/** What the service needs from LiveKit's server API: close a room (everyone in it is disconnected). */
export type RoomControl = { closeRoom(roomName: string): Promise<void> }

/** RoomServiceClient over LIVEKIT_URL (the SDK speaks HTTP(S) to the same host). A room already gone is fine. */
export function liveRoomControl(config: () => LiveKitConfig): RoomControl {
  return {
    async closeRoom(roomName) {
      const cfg = config()
      const client = new RoomServiceClient(cfg.url, cfg.apiKey, cfg.apiSecret)
      try {
        await client.deleteRoom(roomName)
      } catch (err) {
        if (err instanceof ServerError && err.code === 'not_found') return
        throw err
      }
    },
  }
}
