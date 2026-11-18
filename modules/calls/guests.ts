import type { Call, CallRecord, Guest } from './store'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { CallsError } from './errors'
import { isLive, WINDOW_EARLY_MS, WINDOW_GRACE_MS } from './state'

/**
 * Guests (Contribute proposal 844bab56): customers, authorities and partners
 * join a meeting from a personal link in the browser — no account, no
 * install. Each guest gets their own unguessable token (32 random bytes);
 * only its SHA-256 is stored. A link works for its one meeting and only
 * inside the meeting's window: from WINDOW_EARLY_MS before the start until
 * WINDOW_GRACE_MS after the scheduled end (decided: 15 min each side).
 */

export { guestIdentity } from './state'

/** An ad-hoc meeting ("now") without a chosen duration runs this long (decided 2026-11-18). */
export const DEFAULT_DURATION_MINUTES = 60
export const MIN_DURATION_MINUTES = 5
export const MAX_DURATION_MINUTES = 8 * 60
/** A start a little in the past still counts as "now" (a slow form, a clock a bit off). */
export const START_SLACK_MS = 5 * 60_000
export const MAX_DAYS_AHEAD = 365
export const MAX_GUESTS = 20
export const MAX_GUEST_NAME = 80
export const MAX_EXTERNAL_URL = 2000

export const hashGuestToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export function newGuestToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashGuestToken(token) }
}

export const guestJoinUrl = (origin: string, token: string) => `${origin.replace(/\/$/, '')}/join/${encodeURIComponent(token)}`

/** The meeting's slot from the form: now (or a time) and a duration in minutes. */
export function scheduleOf(input: { startsAt: Date | null; durationMinutes?: number | null }, now: Date): { start: Date; end: Date } {
  const minutes = input.durationMinutes ?? DEFAULT_DURATION_MINUTES
  if (!Number.isInteger(minutes) || minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES) {
    throw new CallsError('invalid', `a meeting lasts between ${MIN_DURATION_MINUTES} minutes and ${MAX_DURATION_MINUTES / 60} hours`)
  }
  const start = input.startsAt ?? now
  if (Number.isNaN(start.getTime())) throw new CallsError('invalid', 'the start time is not a time')
  if (start.getTime() < now.getTime() - START_SLACK_MS) throw new CallsError('invalid', 'the start time is in the past')
  if (start.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86_400_000) throw new CallsError('invalid', `book a meeting at most ${MAX_DAYS_AHEAD} days ahead`)
  return { start, end: new Date(start.getTime() + minutes * 60_000) }
}

/** When a guest link works: from 15 min before the start to 15 min after the scheduled end. */
export function guestWindow(call: Pick<Call, 'id' | 'scheduledStart' | 'scheduledEnd'>): { opensAt: Date; closesAt: Date } {
  if (!call.scheduledStart || !call.scheduledEnd) throw new Error(`calls: ${call.id} has no window`)
  return {
    opensAt: new Date(call.scheduledStart.getTime() - WINDOW_EARLY_MS),
    closesAt: new Date(call.scheduledEnd.getTime() + WINDOW_GRACE_MS),
  }
}

export type GuestLinkStatus = 'ok' | 'too_early' | 'expired' | 'over' | 'revoked'

export function guestLinkStatus(rec: CallRecord, guest: Guest, now: Date): GuestLinkStatus {
  if (guest.revokedAt) return 'revoked'
  const { opensAt, closesAt } = guestWindow(rec.call)
  const t = now.getTime()
  if (t >= closesAt.getTime()) return 'expired'
  if (!isLive(rec.call.state)) return 'over'
  if (t < opensAt.getTime()) return 'too_early'
  return 'ok'
}

const email = z.string().trim().toLowerCase().pipe(z.email())

export function parseGuestEmails(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new CallsError('invalid', 'guests must be a list of email addresses')
  const bad: string[] = []
  const out: string[] = []
  for (const r of raw) {
    const parsed = email.safeParse(r)
    if (!parsed.success) bad.push(typeof r === 'string' ? r.trim() : String(r))
    else if (!out.includes(parsed.data)) out.push(parsed.data)
  }
  if (bad.length > 0) throw new CallsError('invalid', `not an email address: ${bad.join(', ')}`)
  if (out.length > MAX_GUESTS) throw new CallsError('invalid', `invite at most ${MAX_GUESTS} guests to a meeting`)
  return out
}

export function parseExternalUrl(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CallsError('invalid', 'the other call link must be a full web address (https://…)')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CallsError('invalid', 'the other call link must start with https://')
  if (value.length > MAX_EXTERNAL_URL) throw new CallsError('invalid', `the other call link is at most ${MAX_EXTERNAL_URL} characters`)
  return value
}

export function parseGuestName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new CallsError('invalid', 'enter your name')
  if (name.length > MAX_GUEST_NAME) throw new CallsError('invalid', `a name is at most ${MAX_GUEST_NAME} characters`)
  return name
}

/** The host's IANA time zone (the invitation shows times in it). */
export function parseTimeZone(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) throw new CallsError('invalid', 'timeZone is an IANA time zone')
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: raw })
  } catch {
    throw new CallsError('invalid', `unknown time zone: ${raw}`)
  }
  return raw
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export type InvitationInput = {
  companyName: string | null
  hostName: string
  title: string
  start: Date
  end: Date
  timeZone: string
  /** The personal guest link, or the other provider's link. */
  url: string
  external: boolean
}

/** The invitation a guest receives (plain words; times in the host's zone, named). */
export function invitationEmail(i: InvitationInput): { subject: string; text: string; html: string } {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: i.timeZone, dateStyle: 'full' }).format(i.start)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: i.timeZone, hour: '2-digit', minute: '2-digit' })
  const when = `${day}, ${time.format(i.start)}–${time.format(i.end)} (${i.timeZone})`
  const from = i.companyName ? `${i.hostName} (${i.companyName})` : i.hostName
  const how = i.external
    ? 'The call takes place on another service. Join it here:'
    : 'Join in your browser — no account, no install. The link is personal and works from 15 minutes before the start until 15 minutes after the end:'
  const subject = `${i.hostName} invited you to a video call: ${i.title}`
  const text = `${from} invited you to a video call.\n\n${i.title}\n${when}\n\n${how}\n${i.url}\n`
  const html =
    `<p>${escapeHtml(from)} invited you to a video call.</p>` +
    `<p><strong>${escapeHtml(i.title)}</strong><br>${escapeHtml(when)}</p>` +
    `<p>${escapeHtml(how)}</p>` +
    `<p><a href="${escapeHtml(i.url)}">Join the call</a></p>` +
    `<p style="color:#666;font-size:12px">${escapeHtml(i.url)}</p>`
  return { subject, text, html }
}
