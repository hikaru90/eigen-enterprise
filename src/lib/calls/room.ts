import type { CallParticipant, Device, EndReason, MediaFailure } from './call-state'
import type { DeviceKind } from './devices'

/**
 * The live call's seam onto the media server (plan/video-calls.md §3). The
 * live implementation wraps `livekit-client` (./livekit-room.ts); component
 * tests use a fake room with fake MediaStreams — never a real server.
 */

export type RoomSignal =
  /** Who is in the room or what they publish changed: read participants() again. */
  | { type: 'participants' }
  | { type: 'reconnecting' }
  | { type: 'reconnected' }
  | { type: 'disconnected'; reason: EndReason }
  /** One of my devices changed outside the page's controls (e.g. the browser's "Stop sharing"). */
  | { type: 'media'; device: Device; on: boolean }
  /** The browser blocks sound until the person interacts with the page: offer startAudio(). */
  | { type: 'audio'; blocked: boolean }

export type CallRoom = {
  connect(url: string, token: string): Promise<void>
  /** Leaves the room (the reason the room reports afterwards is 'hung_up'). */
  disconnect(): Promise<void>
  /** Turns a device on or off; a device that does not turn on throws MediaError. */
  setDevice(device: Device, on: boolean): Promise<void>
  /**
   * Uses this microphone / speaker / camera from now on (LiveKit
   * switchActiveDevice). Before the device is on, it is the one used when it
   * turns on. Throws when the browser refuses (e.g. no setSinkId for speakers).
   */
  switchDevice(kind: DeviceKind, deviceId: string): Promise<void>
  /** The device in use for this kind, as far as the room knows (null: not decided yet). */
  activeDevice(kind: DeviceKind): string | null
  /** Plays remote audio after a click when the browser blocked autoplay. */
  startAudio(): Promise<void>
  participants(): CallParticipant[]
  on(listener: (signal: RoomSignal) => void): () => void
}

/** A device did not turn on; `failure` is the browser's reason, mapped by the room. */
export class MediaError extends Error {
  constructor(
    readonly failure: MediaFailure,
    message: string,
  ) {
    super(message)
    this.name = 'MediaError'
  }
}
