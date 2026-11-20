import type { EvalCompany } from './harness'
import type { CompanyFixture, DoesItem } from './types'
import { localDateOf, nextWeekdayDate } from './fixture/time'

/**
 * The gate's proof that each Does state check sees a task that WAS done:
 * performs every task's intended outcome directly — through the registry
 * tool where the brain can run it without an approval today, else through
 * the module service (what the UI calls) or, for mail and calls, the store
 * the service writes. Never used to grade the brain.
 */
export async function performDoesTask(item: DoesItem, company: EvalCompany, f: CompanyFixture): Promise<void> {
  const { seeded } = company
  const member = seeded.member
  const id = (fixtureId: string) => seeded.ids.get(fixtureId)!
  const tz = f.company.timeZone
  const s = item.state
  switch (s.check) {
    case 'calendar_event_created': {
      const { createEvent } = await import('../../modules/calendar/service')
      const { calendarDeps } = await import('../../modules/calendar/live')
      const date = nextWeekdayDate(new Date(), tz, s.dayOfWeek)
      const [h, m] = s.startLocal.split(':').map(Number) as [number, number]
      const end = `${String(h).padStart(2, '0')}:${String(m + 30).padStart(2, '0')}`
      await createEvent(await calendarDeps(), { kind: 'user', userId: member[s.owner] }, { title: 'Call', start: `${date}T${s.startLocal}`, end: `${date}T${end}`, timeZone: tz, allDay: false, attendees: [{ memberId: member[s.attendee] }] })
      return
    }
    case 'calendar_event_moved': {
      const { updateEvent } = await import('../../modules/calendar/service')
      const { calendarDeps } = await import('../../modules/calendar/live')
      const ev = f.events.find((e) => e.id === s.eventId)!
      const date = localDateOf(company.anchor, tz, ev.dayOffset)
      const [h] = s.startLocal.split(':').map(Number) as [number]
      await updateEvent(await calendarDeps(), { kind: 'user', userId: member[ev.owner] }, id(s.eventId), { start: `${date}T${s.startLocal}`, end: `${date}T${String(h + 1).padStart(2, '0')}:00`, timeZone: tz, allDay: false })
      return
    }
    case 'mail_reply_sent': {
      const { randomUUID } = await import('node:crypto')
      const { appSql, createScopedDrizzle } = await import('$lib/server/db')
      const { dbInboxStore } = await import('../../modules/email/inbox/db-store')
      const mail = f.mail.find((x) => x.id === s.inReplyToMailId)!
      const store = dbInboxStore(createScopedDrizzle(appSql))
      const original = await store.getMessage(id(mail.id))
      if (!original) throw new Error('oracle: the seeded mail is missing')
      const at = new Date()
      await store.insertMessage({ ...original, id: randomUUID(), folder: 'sent', messageId: `reply-${randomUUID()}@fjordlight.example`, inReplyTo: mail.messageId, references: [mail.messageId], from: original.to[0]!, to: [original.from], subject: `Re: ${mail.subject}`, textBody: 'Tuesday at 10:00 works for us.', snippet: 'Tuesday at 10:00', receivedAt: at, createdAt: at, verdicts: null })
      return
    }
    case 'channel_message_posted':
    case 'dm_message_posted': {
      const { postMessage } = await import('../../modules/messages/service')
      const { messagesDeps } = await import('../../modules/messages/live')
      const conv = id(s.check === 'channel_message_posted' ? s.channelId : s.dmId)
      await postMessage(await messagesDeps(), member[s.author], conv, 'Done.')
      return
    }
    // contacts.create / contacts.log_contact wait for owner approval when the brain calls them, so: the service.
    case 'contact_created': {
      const { createContact } = await import('../../modules/contacts/service')
      const { contactsDeps } = await import('../../modules/contacts/live')
      await createContact(await contactsDeps(), { kind: 'user', userId: member[s.owner] }, { name: s.name })
      return
    }
    case 'contact_logged': {
      const { logContact } = await import('../../modules/contacts/service')
      const { contactsDeps } = await import('../../modules/contacts/live')
      await logContact(await contactsDeps(), { kind: 'user', userId: member[item.asker] }, id(s.contactId), { on: localDateOf(new Date(), tz, 0), note: 'Talked about the contract.' })
      return
    }
    case 'task_assigned':
      await company.exec(item.asker, 'tasks.assign', { assignee_id: member[s.assignee], title: 'Roll out the login fix' })
      return
    case 'drive_file_created': {
      if (s.kind === 'pptx') {
        const { driveService } = await import('../../modules/drive')
        const { OFFICE_MIME } = await import('$lib/office/kinds')
        const { buildPptx } = await import('./fixture/pptx')
        await (await driveService()).upload({ kind: 'user', userId: member[s.owner] }, null, { name: 'Deck.pptx', bytes: buildPptx([{ title: 'Deck', bullets: ['x'] }]), mime: OFFICE_MIME.pptx })
      } else {
        // drive.create_document waits for owner approval when the brain calls it, so: the service.
        const { driveService } = await import('../../modules/drive')
        await (await driveService()).createDocument({ kind: 'user', userId: member[s.owner] }, null, 'md', 'Acme terms', '$40 per seat')
      }
      return
    }
    case 'drive_file_shared': {
      const { driveService } = await import('../../modules/drive')
      const file = f.drive.find((x) => x.id === s.fileId)!
      await (await driveService()).setGrants({ kind: 'user', userId: member[file.owner] }, 'file', id(s.fileId), [{ subject: { kind: 'user', userId: member[s.withMember] }, level: 'view' }])
      return
    }
    case 'call_started': {
      const { randomUUID } = await import('node:crypto')
      const { appSql, createScopedDrizzle } = await import('$lib/server/db')
      const { dbCallsStore } = await import('../../modules/calls/db-store')
      const callId = randomUUID()
      const at = new Date()
      const people = [s.startedBy, s.participant].map((k) => ({ callId, userId: member[k], invitedAt: at, joinedAt: null, leftAt: null, response: 'none' as const, transcribe: true }))
      await dbCallsStore(createScopedDrizzle(appSql)).insert({ call: { id: callId, roomName: `oracle-${callId}`, contextKind: 'meeting', contextId: null, title: 'Call', startedBy: member[s.startedBy], state: 'ringing', startedAt: at, endedAt: null, scheduledStart: null, scheduledEnd: null, externalUrl: null }, participants: people, guests: [], brainListens: [], brainShared: [] })
      return
    }
    case 'thought_captured': {
      const { withEvalDb } = await import('../harness/eval-context')
      const { queueCapture } = await import('$lib/server/capture/queue-capture')
      await withEvalDb(member[s.owner], () => queueCapture(member[s.owner], 'I prefer code reviews in the morning.', { source: 'eval', skipWorker: true }))
      return
    }
  }
}
