import type { InvitationPerson } from './ics'
import type { AppointmentChat } from './mail-extract'
import type { ProposalRow, ProposalStore } from './proposal-store'
import type { CalendarDeps, EventInput } from './service'
import type { EventDto, ProposalDto } from './types'
import { randomUUID } from 'node:crypto'
import { CalendarError } from './errors'
import { invitationIcs } from './ics'
import { extractAppointment } from './mail-extract'
import { createEvent, deleteEvent, type Actor } from './service'
import { localOf, localSpan } from './time'

/**
 * Appointments from mail (plan/calendar.md §7, K7) and their invitation (§5,
 * K4). Owner decision (2026-11-12): always a proposal — nothing is added to a
 * calendar or sent on its own.
 * - A mail received into a member's own personal inbox is read by the
 *   gateway (./mail-extract.ts); an agreed appointment becomes an open
 *   proposal. Shared mailboxes are not read: no single person's calendar, and
 *   an invitation would go out from a team address.
 * - Only the mailbox holder sees a proposal, and only while the mail is in
 *   their mailbox (inbox privacy). The owner, admins and the agent see none.
 * - The holder accepts (as found, or as edited in the event dialog) → the
 *   event (source `email_proposal`, external id = the mail) and the iMIP
 *   invitation to the guests outside the company, sent from the holder's own
 *   mailbox so replies come back to them. If the invitation can't go out the
 *   event is removed again and the proposal stays open. Or they dismiss it.
 * - The agent never accepts, dismisses or sends.
 * Kernel events carry ids and counts only.
 */

export type ProposalMailPerson = { name: string | null; address: string }

export type ProposalMailRef = {
  mailbox: { id: string; address: string; aliases: string[] }
  message: {
    id: string
    mailboxId: string
    folder: string
    subject: string
    from: ProposalMailPerson
    to: ProposalMailPerson[]
    cc: ProposalMailPerson[]
    receivedAt: Date
    textBody: string | null
    htmlBody: string | null
  }
}

/** The invitation mail: plain text plus the iCalendar REQUEST built for the sending mailbox (the organizer). */
export type InvitationMail = {
  mailboxId: string
  to: InvitationPerson[]
  subject: string
  text: string
  ics: (organizer: InvitationPerson) => string
}

/** The mail service refused the invitation (a disabled mailbox, an unverified domain, a suppressed address …). */
export class InvitationNotSent extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'InvitationNotSent'
  }
}

/** The mail side (the inbox, live): reading the holder's own mail and sending from their mailbox. */
export type ProposalMail = {
  /** The mail when it sits in this member's own personal mailbox; null otherwise (shared, someone else's, gone). */
  personalMail(userId: string, messageId: string): Promise<ProposalMailRef | null>
  /** Sends from the member's mailbox; throws InvitationNotSent when the mail service refuses. */
  sendInvitation(userId: string, mail: InvitationMail): Promise<void>
}

export type ProposalDeps = { calendar: CalendarDeps; proposals: ProposalStore; mail: ProposalMail }

export type ScanDeps = ProposalDeps & {
  chat: AppointmentChat
  /** The member's own time zone (what "15 Uhr" means when the mail says no zone). */
  timeZoneFor: (userId: string) => Promise<string>
}

const now = (d: ProposalDeps) => (d.calendar.now ? d.calendar.now() : new Date())
const newId = (d: ProposalDeps) => (d.calendar.newId ? d.calendar.newId() : randomUUID())
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const notFound = () => new CalendarError('not_found', 'No such proposal.')

/** The person deciding: a member of the company, never the agent. */
async function holderOf(d: ProposalDeps, actor: Actor): Promise<string> {
  if (actor.kind === 'agent') throw new CalendarError('forbidden', 'Only the person whose mail it is accepts or dismisses an appointment from it.')
  if (!(await d.calendar.roleOf(actor.userId))) throw new CalendarError('forbidden', 'Only people in the company have a calendar.')
  return actor.userId
}

function dto(row: ProposalRow, ref: ProposalMailRef): ProposalDto {
  const span = localSpan(row.startsAt, row.endsAt, row.timeZone, false)
  return {
    id: row.id,
    state: row.state,
    title: row.title,
    start: row.startsAt.toISOString(),
    end: row.endsAt.toISOString(),
    timeZone: row.timeZone,
    localStart: span.start,
    localEnd: span.end,
    location: row.location,
    call: row.call,
    attendees: row.attendees.map((g) => ({ ...g })),
    eventId: row.eventId,
    mail: { messageId: ref.message.id, mailboxId: ref.mailbox.id, subject: ref.message.subject, from: { ...ref.message.from } },
  }
}

/** The proposal with its mail, if it is this member's and the mail is still in their mailbox. */
async function visible(d: ProposalDeps, userId: string, row: ProposalRow | null): Promise<{ row: ProposalRow; ref: ProposalMailRef } | null> {
  if (!row || row.memberId !== userId) return null
  const ref = await d.mail.personalMail(userId, row.messageId)
  if (!ref || ref.mailbox.id !== row.mailboxId) return null
  return { row, ref }
}

async function ownProposal(d: ProposalDeps, userId: string, rawId: unknown) {
  if (typeof rawId !== 'string' || !UUID.test(rawId)) throw notFound()
  const found = await visible(d, userId, await d.proposals.get(rawId.toLowerCase()))
  if (!found) throw notFound()
  return found
}

// ── scanning (the job, off the request path) ──────────────────────────────────

export type ScanOutcome = 'filed' | 'none' | 'skipped' | 'exists'

/** Reads one received mail of the member's own inbox; an agreed appointment becomes an open proposal. */
export async function scanMail(d: ScanDeps, job: { userId: string; messageId: string }): Promise<ScanOutcome> {
  if (await d.proposals.forMessage(job.messageId)) return 'exists'
  const ref = await d.mail.personalMail(job.userId, job.messageId)
  if (!ref || ref.message.folder !== 'inbox') return 'skipped'
  const member = (await d.calendar.members()).find((m) => m.id === job.userId)
  if (!member) return 'skipped'
  const at = now(d)
  const found = await extractAppointment(d.chat, {
    userId: job.userId,
    mail: {
      subject: ref.message.subject,
      from: ref.message.from,
      to: ref.message.to,
      cc: ref.message.cc,
      receivedAt: ref.message.receivedAt,
      text: ref.message.textBody,
      html: ref.message.htmlBody,
    },
    reader: { name: member.name, addresses: [ref.mailbox.address, ...ref.mailbox.aliases], timeZone: await d.timeZoneFor(job.userId) },
    now: at,
  })
  if (!found) return 'none'
  const row: ProposalRow = {
    id: newId(d),
    memberId: job.userId,
    mailboxId: ref.mailbox.id,
    messageId: ref.message.id,
    state: 'open',
    ...found,
    eventId: null,
    createdAt: at,
    decidedAt: null,
  }
  if (!(await d.proposals.insert(row))) return 'exists'
  await d.calendar.audit({ type: 'calendar.proposal_filed', principalId: job.userId, payload: { id: row.id, messageId: row.messageId } })
  return 'filed'
}

// ── reading ───────────────────────────────────────────────────────────────────

/** The member's open proposals, soonest first (Calendar shows them). */
export async function openProposals(d: ProposalDeps, actor: Actor): Promise<ProposalDto[]> {
  const userId = await holderOf(d, actor)
  const out: ProposalDto[] = []
  for (const row of await d.proposals.open(userId)) {
    const found = await visible(d, userId, row)
    if (found) out.push(dto(found.row, found.ref))
  }
  return out
}

/** The proposal found in one mail (any state), for the reader; null when there is none or it isn't theirs. */
export async function proposalForMail(d: ProposalDeps, actor: Actor, messageId: string): Promise<ProposalDto | null> {
  const userId = await holderOf(d, actor)
  const found = await visible(d, userId, await d.proposals.forMessage(messageId))
  return found ? dto(found.row, found.ref) : null
}

// ── deciding ──────────────────────────────────────────────────────────────────

/** The event input a proposal stands for (what Accept creates when nothing was edited). */
export function proposalEventInput(p: Pick<ProposalRow, 'title' | 'startsAt' | 'endsAt' | 'timeZone' | 'location' | 'call' | 'attendees'>): EventInput {
  const span = localSpan(p.startsAt, p.endsAt, p.timeZone, false)
  return {
    title: p.title,
    allDay: false,
    start: span.start,
    end: span.end,
    timeZone: p.timeZone,
    // A call's link is where it happens; with a place too, the link goes in the notes.
    location: p.location ?? p.call,
    notes: p.location && p.call ? p.call : null,
    attendees: p.attendees.map((g) => (g.name ? { email: g.email, name: g.name } : { email: g.email })),
  }
}

const longDay = (wall: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${wall.slice(0, 10)}T00:00:00Z`))

/** The invitation's plain text (the calendar part is what calendar apps read). */
export function invitationText(e: EventDto, organizerName: string): string {
  const start = localOf(e.start, e.timeZone)
  const end = localOf(e.end, e.timeZone)
  const when =
    start.day === end.day
      ? `${longDay(start.day)}, ${start.time} – ${end.time} (${e.timeZone})`
      : `${longDay(start.day)}, ${start.time} – ${longDay(end.day)}, ${end.time} (${e.timeZone})`
  return [
    `${organizerName} invites you to: ${e.title}`,
    '',
    `When: ${when}`,
    ...(e.location ? [`Where: ${e.location}`] : []),
    ...(e.notes ? ['', e.notes] : []),
    '',
    'The invitation is attached; your calendar app can accept or decline it.',
  ].join('\n')
}

export type AcceptResult = { event: EventDto; invited: number }

/**
 * Accept: the event on the holder's calendar and the invitation to its guests
 * outside the company. `edited` = the event dialog's fields (Edit → Save).
 * Claimed first, so two accepts never both run; any failure undoes the event
 * and reopens the proposal.
 */
export async function acceptProposal(d: ProposalDeps, actor: Actor, rawId: unknown, edited?: EventInput): Promise<AcceptResult> {
  const userId = await holderOf(d, actor)
  const { row, ref } = await ownProposal(d, userId, rawId)
  if (row.state !== 'open' || !(await d.proposals.decide(row.id, 'accepted', now(d)))) {
    throw new CalendarError('invalid', 'This appointment was already accepted or dismissed.')
  }
  let event: EventDto | null = null
  try {
    event = await createEvent(d.calendar, actor, edited ?? proposalEventInput(row), { source: 'email_proposal', externalId: row.messageId })
    const guests = event.attendees.filter((a) => a.email !== null).map((a) => ({ name: a.name === a.email ? null : a.name, address: a.email! }))
    if (guests.length > 0) {
      const e = event
      const domain = ref.mailbox.address.slice(ref.mailbox.address.lastIndexOf('@') + 1)
      const stamp = now(d)
      await d.mail.sendInvitation(userId, {
        mailboxId: ref.mailbox.id,
        to: guests,
        subject: `Invitation: ${e.title}`,
        text: invitationText(e, e.ownerName),
        ics: (organizer) =>
          invitationIcs({
            uid: `${e.id}@${domain}`,
            stamp,
            start: new Date(e.start),
            end: new Date(e.end),
            summary: e.title,
            description: e.notes,
            location: e.location,
            organizer,
            attendees: guests,
          }),
      })
    }
    await d.proposals.setEvent(row.id, event.id)
    await d.calendar.audit({
      type: 'calendar.proposal_accepted',
      principalId: userId,
      payload: { id: row.id, eventId: event.id, invited: guests.length, edited: edited !== undefined },
    })
    return { event, invited: guests.length }
  } catch (err) {
    if (event) await deleteEvent(d.calendar, actor, event.id)
    await d.proposals.reopen(row.id)
    if (err instanceof InvitationNotSent) {
      throw new CalendarError('upstream', `The invitation couldn’t be sent, so nothing was added: ${err.message}`, { cause: err })
    }
    throw err
  }
}

/** Dismiss: closes it; nothing is added or sent. */
export async function dismissProposal(d: ProposalDeps, actor: Actor, rawId: unknown): Promise<void> {
  const userId = await holderOf(d, actor)
  const { row } = await ownProposal(d, userId, rawId)
  if (row.state !== 'open' || !(await d.proposals.decide(row.id, 'dismissed', now(d)))) {
    throw new CalendarError('invalid', 'This appointment was already accepted or dismissed.')
  }
  await d.calendar.audit({ type: 'calendar.proposal_dismissed', principalId: userId, payload: { id: row.id } })
}
