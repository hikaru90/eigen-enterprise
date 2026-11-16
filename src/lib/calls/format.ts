import type { CallDto } from './client'

/** How a call line in a DM/channel reads (structured data from Messages, never parsed text). */
export type CallLine = { callId: string; outcome: 'ended' | 'missed' | 'declined'; durationSeconds: number | null }

/** "4 min", "1 h 5 min" — a call shorter than a minute still reads "1 min". */
export function durationLabel(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export function callLineLabel(line: CallLine): string {
  if (line.outcome === 'ended') return `Call, ${durationLabel(line.durationSeconds ?? 0)}`
  return line.outcome === 'missed' ? 'Missed call' : 'Declined call'
}

export type CallHistory = {
  outcome: string
  /** missed = something you did not pick up (shown in the destructive colour). */
  tone: 'normal' | 'missed' | 'muted'
  direction: 'incoming' | 'outgoing'
  live: boolean
}

/** One call as `me` sees it on the calls page. */
export function historyOf(call: CallDto, me: string): CallHistory {
  const direction = call.startedBy === me ? 'outgoing' : 'incoming'
  const mine = call.participants.find((p) => p.userId === me)
  const out = (outcome: string, tone: CallHistory['tone'], live = false): CallHistory => ({ outcome, tone, direction, live })
  switch (call.state) {
    case 'ringing':
      return out('Ringing', 'normal', true)
    case 'active':
      return out('In progress', 'normal', true)
    case 'missed':
      return direction === 'outgoing' ? out('No answer', 'muted') : out('Missed', 'missed')
    case 'declined':
      return direction === 'outgoing' ? out('Declined', 'muted') : out('You declined', 'muted')
    case 'ended': {
      if (direction === 'incoming' && mine && mine.joinedAt === null) {
        return mine.response === 'declined' ? out('You declined', 'muted') : out('Missed', 'missed')
      }
      const seconds =
        call.answeredAt && call.endedAt ? (new Date(call.endedAt).getTime() - new Date(call.answeredAt).getTime()) / 1000 : 0
      return out(`Call, ${durationLabel(seconds)}`, 'normal')
    }
  }
}

/** The /calls page's load key (invalidated when a live call ends). */
export const CALLS_DEPENDENCY = 'app:calls'
