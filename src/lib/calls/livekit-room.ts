import type { CallParticipant, Device, EndReason, MediaFailure } from './call-state'
import {
  DisconnectReason,
  MediaDeviceFailure,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
} from 'livekit-client'
import { MediaError, type CallRoom, type RoomSignal } from './room'

/**
 * CallRoom over `livekit-client` (Apache-2.0, pinned 2.23.0). Remote audio is
 * played through hidden <audio> elements this adapter owns; video goes to the
 * page as MediaStreams (one per track, reused so <video> never flickers).
 * Exercised against a real livekit-server in S4 (e2e); component tests use a
 * fake CallRoom.
 */

const SOURCE: Record<Device, Track.Source> = {
  microphone: Track.Source.Microphone,
  camera: Track.Source.Camera,
  screen: Track.Source.ScreenShare,
}

/** LiveKit's disconnect reason → what the page tells the person. */
export function endReasonOf(reason: DisconnectReason | undefined): EndReason {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return 'hung_up'
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'call_over'
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'joined_elsewhere'
    default:
      return 'connection_lost'
  }
}

/** The browser's getUserMedia / getDisplayMedia error → MediaFailure (LiveKit classifies it). */
export function mediaFailureOf(err: unknown): MediaFailure {
  switch (MediaDeviceFailure.getFailure(err)) {
    case MediaDeviceFailure.PermissionDenied:
      return 'permission_denied'
    case MediaDeviceFailure.NotFound:
      return 'not_found'
    case MediaDeviceFailure.DeviceInUse:
      return 'in_use'
    default:
      return 'other'
  }
}

export function createLiveKitRoom(): CallRoom {
  const room = new Room({ adaptiveStream: true, dynacast: true })
  const listeners = new Set<(s: RoomSignal) => void>()
  const emit = (s: RoomSignal) => {
    for (const fn of [...listeners]) fn(s)
  }
  const streams = new WeakMap<MediaStreamTrack, MediaStream>()
  const streamOf = (track: Track | undefined): MediaStream | null => {
    if (!track) return null
    const mst = track.mediaStreamTrack
    let s = streams.get(mst)
    if (!s) {
      s = new MediaStream([mst])
      streams.set(mst, s)
    }
    return s
  }
  const audio = document.createElement('div')
  audio.hidden = true
  audio.dataset.testid = 'call-remote-audio'

  const changed = () => emit({ type: 'participants' })
  room
    .on(RoomEvent.ParticipantConnected, changed)
    .on(RoomEvent.ParticipantDisconnected, changed)
    .on(RoomEvent.ParticipantNameChanged, changed)
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) audio.append(track.attach())
      changed()
    })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) for (const el of track.detach()) el.remove()
      changed()
    })
    .on(RoomEvent.TrackMuted, changed)
    .on(RoomEvent.TrackUnmuted, changed)
    .on(RoomEvent.LocalTrackPublished, changed)
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare) emit({ type: 'media', device: 'screen', on: false })
      changed()
    })
    .on(RoomEvent.ActiveSpeakersChanged, changed)
    .on(RoomEvent.Reconnecting, () => emit({ type: 'reconnecting' }))
    .on(RoomEvent.Reconnected, () => emit({ type: 'reconnected' }))
    .on(RoomEvent.AudioPlaybackStatusChanged, () => emit({ type: 'audio', blocked: !room.canPlaybackAudio }))
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      audio.replaceChildren()
      audio.remove()
      emit({ type: 'disconnected', reason: endReasonOf(reason) })
    })

  const snapshot = (p: Participant, isLocal: boolean): CallParticipant => {
    const camera = p.getTrackPublication(Track.Source.Camera)
    const screen = p.getTrackPublication(Track.Source.ScreenShare)
    return {
      identity: p.identity,
      name: p.name || p.identity,
      isLocal,
      micOn: p.isMicrophoneEnabled,
      cameraOn: p.isCameraEnabled && !!camera?.track && !camera.isMuted,
      speaking: p.isSpeaking,
      camera: streamOf(camera?.track),
      screen: screen && !screen.isMuted ? streamOf(screen.track) : null,
    }
  }

  return {
    async connect(url, token) {
      document.body.append(audio)
      await room.connect(url, token)
      if (!room.canPlaybackAudio) emit({ type: 'audio', blocked: true })
    },
    async disconnect() {
      await room.disconnect()
    },
    async setDevice(device, on) {
      const lp = room.localParticipant
      try {
        if (device === 'microphone') await lp.setMicrophoneEnabled(on)
        else if (device === 'camera') await lp.setCameraEnabled(on)
        else await lp.setScreenShareEnabled(on, { audio: false })
      } catch (err) {
        throw new MediaError(mediaFailureOf(err), err instanceof Error ? err.message : String(err))
      }
      // A cancelled screen picker resolves without a track.
      if (on && !lp.getTrackPublication(SOURCE[device])?.track) {
        throw new MediaError(device === 'screen' ? 'permission_denied' : 'other', `${device} did not start`)
      }
    },
    async startAudio() {
      await room.startAudio()
      emit({ type: 'audio', blocked: !room.canPlaybackAudio })
    },
    participants() {
      return [snapshot(room.localParticipant, true), ...[...room.remoteParticipants.values()].map((p) => snapshot(p, false))]
    },
    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
