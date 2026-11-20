import type { SeededIds } from './fixture/seed'
import type { CompanyFixture, StateCheck } from './types'
import { localDateOf, nextWeekdayDate, zonedToUtc } from './fixture/time'

/**
 * Does: what a task left behind, read straight from the eval database
 * (operator connection — the check sees everything, the brain did not).
 * Structure only: which rows exist since the turn started, with which
 * owner / attendee / time. `evidence` is the text the task produced, for
 * the content judge.
 */
export type StateResult = { done: boolean; evidence: string | null; note: string }

type Ctx = { f: CompanyFixture; seeded: SeededIds; since: Date; anchor: Date }

/** "Since the turn started" by the DATABASE's clock: rows are stamped by it, and a container clock drifts from the host's. */
export async function dbNow(): Promise<Date> {
  const { appSql } = await import('$lib/server/db')
  const [row] = await appSql<{ now: Date }[]>`select now() as now`
  if (!row) throw new Error('select now() returned nothing')
  return new Date(row.now)
}

export async function checkState(check: StateCheck, ctx: Ctx): Promise<StateResult> {
  const { appSql: sql } = await import('$lib/server/db')
  const { f, seeded, since } = ctx
  const id = (fixtureId: string) => {
    const v = seeded.ids.get(fixtureId)
    if (!v) throw new Error(`state check: ${fixtureId} was not seeded`)
    return v
  }
  const tz = f.company.timeZone
  const result = (rows: Array<{ evidence?: string | null }>, note: string): StateResult => ({ done: rows.length > 0, evidence: rows.map((r) => r.evidence ?? '').join('\n---\n') || null, note })

  switch (check.check) {
    case 'calendar_event_created': {
      const today = localDateOf(new Date(), tz, 0)
      const dates = [nextWeekdayDate(new Date(), tz, check.dayOfWeek)]
      if (new Date(`${today}T12:00:00Z`).getUTCDay() === check.dayOfWeek) dates.unshift(today)
      const starts = new Set(dates.map((d) => zonedToUtc(d, check.startLocal, tz).getTime()))
      const rows = await sql<{ evidence: string; starts_at: Date }[]>`
        select e.title as evidence, e.starts_at from calendar_events e
        join calendar_attendees a on a.event_id = e.id and a.member_id = ${seeded.member[check.attendee]}
        where e.owner_id = ${seeded.member[check.owner]} and e.created_at >= ${since.toISOString()}::timestamptz`
      return result(rows.filter((r) => starts.has(new Date(r.starts_at).getTime())),`event owned by ${check.owner} with ${check.attendee} at ${check.startLocal} on ${dates.join(' or ')}`)
    }
    case 'calendar_event_moved': {
      const ev = f.events.find((e) => e.id === check.eventId)!
      const start = zonedToUtc(localDateOf(ctx.anchor, tz, ev.dayOffset), check.startLocal, tz)
      const rows = await sql<{ evidence: string }[]>`select title as evidence from calendar_events where id = ${id(check.eventId)} and starts_at = ${start.toISOString()}::timestamptz`
      return result(rows, `${check.eventId} starts at ${check.startLocal}`)
    }
    case 'mail_reply_sent': {
      const mail = f.mail.find((m) => m.id === check.inReplyToMailId)!
      const rows = await sql<{ evidence: string }[]>`select coalesce(text_body, snippet) as evidence from inbox_messages where in_reply_to = ${mail.messageId} and folder = 'sent' and created_at >= ${since.toISOString()}::timestamptz`
      return result(rows, `a sent reply to ${mail.id}`)
    }
    case 'channel_message_posted':
    case 'dm_message_posted': {
      const conv = id(check.check === 'channel_message_posted' ? check.channelId : check.dmId)
      const rows = await sql<{ evidence: string }[]>`select body as evidence from messages where conversation_id = ${conv} and author_id = ${seeded.member[check.author]} and created_at >= ${since.toISOString()}::timestamptz and deleted_at is null`
      return result(rows, `a message by ${check.author}`)
    }
    case 'contact_created': {
      const rows = await sql<{ evidence: string }[]>`select name as evidence from contacts where name = ${check.name} and created_by = ${seeded.member[check.owner]} and created_at >= ${since.toISOString()}::timestamptz`
      return result(rows, `contact ${check.name} created by ${check.owner}`)
    }
    case 'contact_logged': {
      const rows = await sql<{ evidence: string }[]>`select coalesce(note, '') as evidence from contact_log_entries where contact_id = ${id(check.contactId)} and created_at >= ${since.toISOString()}::timestamptz`
      return result(rows, `a log entry on ${check.contactId}`)
    }
    case 'task_assigned': {
      const rows = await sql<{ evidence: string }[]>`select title as evidence from assigned_tasks where assignee_id = ${seeded.member[check.assignee]} and created_at >= ${since.toISOString()}::timestamptz`
      return result(rows, `a task assigned to ${check.assignee}`)
    }
    case 'drive_file_created': {
      const { OFFICE_MIME } = await import('$lib/office/kinds')
      const rows = await sql<{ id: string; name: string; mime: string | null }[]>`select id, name, mime from drive_file where owner_id = ${seeded.member[check.owner]} and created_at >= ${since.toISOString()}::timestamptz and trashed_at is null`
      const hits = check.kind === 'pptx' ? rows.filter((r) => r.mime === OFFICE_MIME.pptx) : rows
      const evidence: Array<{ evidence: string }> = []
      for (const r of hits) evidence.push({ evidence: `${r.name}\n${await fileText(r.id, seeded.member[check.owner])}` })
      return result(evidence, `a ${check.kind === 'pptx' ? '.pptx ' : ''}file created by ${check.owner}`)
    }
    case 'drive_file_shared': {
      const rows = await sql<{ evidence: string }[]>`select level as evidence from access_grant where resource_id = ${id(check.fileId)} and subject_kind = 'user' and subject_user_id = ${seeded.member[check.withMember]} and created_at >= ${since.toISOString()}::timestamptz`
      return result(rows, `${check.fileId} shared with ${check.withMember}`)
    }
    case 'call_started': {
      const rows = await sql<{ evidence: string }[]>`
        select c.title as evidence from call c join call_participant p on p.call_id = c.id and p.user_id = ${seeded.member[check.participant]}
        where c.started_by = ${seeded.member[check.startedBy]} and c.started_at >= ${since.toISOString()}::timestamptz`
      return result(rows, `a call by ${check.startedBy} with ${check.participant}`)
    }
    case 'thought_captured': {
      const rows = await sql<{ evidence: string }[]>`select '(a thought)' as evidence from thought where user_id = ${seeded.member[check.owner]} and created_at >= ${since.toISOString()}::timestamptz`
      return result(rows, `a thought of ${check.owner}`)
    }
  }
}

/** A Drive file's text for the content judge: the product's own text, or a deck's slide text read here. */
async function fileText(fileId: string, ownerId: string): Promise<string> {
  const { driveService } = await import('../../modules/drive')
  const drive = await driveService()
  const actor = { kind: 'user' as const, userId: ownerId }
  const { OfficeNotSupportedError } = await import('$lib/office/kinds')
  try {
    return (await drive.readText(actor, fileId)).content
  } catch (err) {
    // Only the case the product cannot read yet (a deck); anything else fails loud.
    const cause = err instanceof Error ? err.cause : undefined
    if (!(cause instanceof OfficeNotSupportedError) || cause.kind !== 'pptx') throw err
    const { readPackage } = await import('$lib/office/ooxml/package')
    const { bytes } = await drive.readFile(actor, fileId)
    const pkg = readPackage(bytes)
    return pkg
      .partNames()
      .filter((p) => p.startsWith('/ppt/slides/slide'))
      .map((p) => [...pkg.xml(p).getElementsByTagName('a:t')].map((t) => t.textContent ?? '').join(' '))
      .join('\n')
  }
}
