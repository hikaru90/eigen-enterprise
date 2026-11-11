/**
 * Pure client state for the call page (plan/video-calls.md §3): where the
 * connection is, which of my devices are on, what went wrong and what to do
 * about it. LiveKit stays behind the CallRoom interface (./room.ts); the page
 * turns room signals into CallEvents and renders CallViewState.
 *
 *   connecting ─connected→ connected ⇄ reconnecting
 *   any ─disconnected→ ended (hung_up | call_over | connection_lost | joined_elsewhere)
 *   any ─failed→ error (not_configured | over | failed)
 *   ended/error ─retry→ connecting
 */

export type CallPhase = 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error'
/** joined_elsewhere: the same person joined from another tab or device. */
export type EndReason = 'hung_up' | 'call_over' | 'connection_lost' | 'joined_elsewhere'
export type Device = 'microphone' | 'camera' | 'screen'
/** Why a device did not turn on (from the browser's media error, mapped by the room adapter). */
export type MediaFailure = 'permission_denied' | 'not_found' | 'in_use' | 'other'

/** What stops the call page from joining (fatal until retried). */
export type CallProblem = { kind: 'not_configured' | 'over' | 'failed'; message: string }

export type MediaNotice = { device: Device; failure: MediaFailure; message: string }

export type CallViewState = {
  phase: CallPhase
  problem: CallProblem | null
  ended: EndReason | null
  mic: boolean
  camera: boolean
  screen: boolean
  /** At most one per device. */
  notices: MediaNotice[]
}

export type CallEvent =
  | { type: 'connected' }
  | { type: 'reconnecting' }
  | { type: 'reconnected' }
  | { type: 'disconnected'; reason: EndReason }
  | { type: 'failed'; problem: CallProblem }
  | { type: 'media'; device: Device; on: boolean }
  | { type: 'media_failed'; device: Device; failure: MediaFailure; detail?: string }
  | { type: 'dismiss_notice'; device: Device }
  | { type: 'retry' }

export const initialCallState: CallViewState = Object.freeze({
  phase: 'connecting',
  problem: null,
  ended: null,
  mic: false,
  camera: false,
  screen: false,
  notices: [],
}) as CallViewState

const FLAG = { microphone: 'mic', camera: 'camera', screen: 'screen' } as const

/** What the person reads when a device did not turn on — and what to do about it. */
export function noticeText(device: Device, failure: MediaFailure, detail?: string): string {
  if (device === 'screen') {
    if (failure === 'permission_denied') return 'Screen sharing did not start: it was cancelled, or your browser blocks it for this site.'
    return `Screen sharing did not start${detail ? `: ${detail}` : '.'}`
  }
  switch (failure) {
    case 'permission_denied':
      return `Your browser blocked the ${device}. Allow ${device} access for this site (the icon at the left of the address bar, or your browser's site settings), then turn the ${device} on again.`
    case 'not_found':
      return `No ${device} found. Connect one, then turn the ${device} on again.`
    case 'in_use':
      return `The ${device} is in use by another app. Close that app, then turn the ${device} on again.`
    case 'other':
      return `The ${device} did not turn on${detail ? `: ${detail}` : '.'}`
  }
}

const withoutNotice = (notices: MediaNotice[], device: Device) => notices.filter((n) => n.device !== device)

export function callReducer(s: CallViewState, e: CallEvent): CallViewState {
  if (e.type === 'retry') return s.phase === 'ended' || s.phase === 'error' ? initialCallState : s
  if (s.phase === 'ended' || s.phase === 'error') return s
  switch (e.type) {
    case 'connected':
    case 'reconnected':
      return s.phase === 'connected' ? s : { ...s, phase: 'connected' }
    case 'reconnecting':
      return s.phase === 'reconnecting' ? s : { ...s, phase: 'reconnecting' }
    case 'disconnected':
      return { ...s, phase: 'ended', ended: e.reason, mic: false, camera: false, screen: false }
    case 'failed':
      return { ...s, phase: 'error', problem: e.problem, mic: false, camera: false, screen: false }
    case 'media': {
      const flag = FLAG[e.device]
      const notices = e.on ? withoutNotice(s.notices, e.device) : s.notices
      if (s[flag] === e.on && notices === s.notices) return s
      return { ...s, [flag]: e.on, notices }
    }
    case 'media_failed':
      return {
        ...s,
        [FLAG[e.device]]: false,
        notices: [...withoutNotice(s.notices, e.device), { device: e.device, failure: e.failure, message: noticeText(e.device, e.failure, e.detail) }],
      }
    case 'dismiss_notice':
      return { ...s, notices: withoutNotice(s.notices, e.device) }
  }
}

/**
 * A refused /api/calls request → the problem the page shows. Decided by the
 * server's error `code` (CallsError), never by its wording; the wording is
 * shown as it is (e.g. "Calls are not set up on this server").
 */
export function problemFromResponse(status: number, body: { code?: unknown; error?: unknown }): CallProblem {
  const message = typeof body.error === 'string' && body.error ? body.error : `request failed (${status})`
  if (body.code === 'not_configured') return { kind: 'not_configured', message }
  if (body.code === 'conflict' || body.code === 'not_found') return { kind: 'over', message }
  return { kind: 'failed', message }
}

/** One person in the room as the call page sees them (the room adapter's snapshot). */
export type CallParticipant = {
  identity: string
  name: string
  isLocal: boolean
  micOn: boolean
  cameraOn: boolean
  speaking: boolean
  /** Their camera video, when on. */
  camera: MediaStream | null
  /** Their shared screen, when sharing. */
  screen: MediaStream | null
}

export type CallTile = {
  key: string
  kind: 'camera' | 'screen'
  identity: string
  name: string
  isLocal: boolean
  micOn: boolean
  speaking: boolean
  stream: MediaStream | null
}

/** The grid: screen shares first, then you, then everyone else by name. */
export function tilesOf(participants: readonly CallParticipant[]): CallTile[] {
  const people = [...participants].sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name))
  const tile = (p: CallParticipant, kind: 'camera' | 'screen'): CallTile => ({
    key: `${p.identity}:${kind}`,
    kind,
    identity: p.identity,
    name: p.name,
    isLocal: p.isLocal,
    micOn: p.micOn,
    speaking: kind === 'camera' && p.speaking,
    stream: kind === 'camera' ? (p.cameraOn ? p.camera : null) : p.screen,
  })
  return [...people.filter((p) => p.screen).map((p) => tile(p, 'screen')), ...people.map((p) => tile(p, 'camera'))]
}
