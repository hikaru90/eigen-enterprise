import type { CompanyFixture, CoworkerKey, MemberKey, SeatKey } from '../types'
import { createHash, randomUUID } from 'node:crypto'
import { coworkerPrincipal } from '$lib/kernel/principals'
import type { KernelRegistry } from '$lib/kernel/registry'
import { OFFICE_MIME } from '$lib/office/kinds'
import { enrichQueuedThought } from '$lib/server/capture/enrich-queued-thought'
import { queueCapture } from '$lib/server/capture/queue-capture'
import { coworkerAgentId, coworkerDeps, createCoworker } from '$lib/server/coworkers'
import { appSql, createScopedDrizzle } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { mailDomains } from '$lib/server/db/email.schema'
import { groupDeps } from '$lib/server/members'
import { createGroup } from '$lib/server/members/groups'
import { calendarDeps } from '../../../modules/calendar/live'
import { createEvent } from '../../../modules/calendar/service'
import { dbCallsStore } from '../../../modules/calls/db-store'
import { guestIdentity } from '../../../modules/calls/state'
import { dbTranscriptStore } from '../../../modules/calls/transcript-db-store'
import { contactsDeps } from '../../../modules/contacts/live'
import { createContact } from '../../../modules/contacts/service'
import { driveService } from '../../../modules/drive'
import { dbInboxStore } from '../../../modules/email/inbox/db-store'
import { inboxDeps } from '../../../modules/email/inbox/live'
import { assignPersonalMailbox, createSharedMailbox } from '../../../modules/email/inbox/service'
import { messagesDeps } from '../../../modules/messages/live'
import { createChannel, openDm, postMessage } from '../../../modules/messages/service'
import { withEvalDb } from '../../harness/eval-context'
import { buildPptx } from './pptx'
import { localDateOf } from './time'

/**
 * Seeds the fixture into an EMPTY eval database (db.ts recreates it) through
 * the real services wherever one exists, so the fixture follows the product
 * as it changes. Direct writes, each because no service can do it here:
 *
 * - `user` rows — members join only by invite + emailed sign-in code;
 * - `mail_domains` — a domain is added through Amazon SES (Owlery);
 * - received mail — arrives only as an SES receipt + raw S3 object, so it is
 *   written through the inbox store (`insertMessage`), the layer ingest uses;
 * - the call and its transcript — a call needs LiveKit and transcripts need
 *   speech-to-text, so they are written through the calls and transcript
 *   stores the service itself uses.
 *
 * Everything else — the AI co-workers (the coworkers service), groups,
 * channels, DMs, messages, the mailboxes, Drive files and their sharing,
 * calendar events, contacts, thoughts — goes through the module services
 * (a person's thoughts through Memory's capture queue; a co-worker's through
 * memory.capture_thought as the co-worker, the way it captures in a turn).
 */

export type SeededIds = {
  member: Record<MemberKey, string>
  coworker: Record<CoworkerKey, string>
  /** Every seat's user id: people and co-workers. */
  seat: Record<SeatKey, string>
  /** fixture id → product id (conversations, mailboxes, groups, messages, mail, calls, files, events, contacts, thoughts). */
  ids: Map<string, string>
}

export type SeedOptions = {
  anchor: Date
  /** Run Memory's enrichment (embeddings + extraction; needs a model) so retrieval by meaning works. */
  enrichThoughts: boolean
  /** The booted kernel's registry: co-workers capture their thoughts through it, as themselves. */
  registry: Pick<KernelRegistry, 'execute'>
}

const minutesBefore = (anchor: Date, minutes: number) => new Date(anchor.getTime() - minutes * 60_000)

export async function seedCompany(f: CompanyFixture, opts: SeedOptions): Promise<SeededIds> {
  const { anchor } = opts
  const member = Object.fromEntries(f.members.map((m) => [m.key, m.id])) as Record<MemberKey, string>
  const coworker = Object.fromEntries(f.coworkers.map((c) => [c.key, c.id])) as Record<CoworkerKey, string>
  const seat: Record<SeatKey, string> = { ...member, ...coworker }
  const ids = new Map<string, string>()
  const put = (fixtureId: string, productId: string) => {
    if (ids.has(fixtureId)) throw new Error(`seed: ${fixtureId} seeded twice`)
    ids.set(fixtureId, productId)
  }
  const owner = f.members.find((m) => m.role === 'owner')
  if (!owner) throw new Error('seed: the fixture has no owner')

  // ── members (direct: no service creates a user) ──
  await authDb.insert(user).values(
    f.members.map((m, i) => ({
      id: m.id,
      name: m.name,
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email,
      emailVerified: true,
      onboardingCompleted: true,
      role: m.role,
      accountKind: 'production' as const,
      createdAt: minutesBefore(anchor, 90 * 24 * 60 - i),
    })),
  )

  // ── AI co-workers (service: user row kind coworker + role card + seat in the org chart), managers first ──
  const cw = { ...coworkerDeps(), now: () => minutesBefore(anchor, 60 * 24 * 60) }
  for (const c of f.coworkers) {
    const view = await createCoworker(
      { id: owner.id, role: 'owner', kind: 'person' },
      { templateId: c.templateId, name: c.name, modelId: c.modelId, reportsToUserId: seat[c.reportsTo] },
      { ...cw, newId: () => c.id },
    )
    if (view.id !== c.id) throw new Error(`seed: co-worker ${c.key} was created as ${view.id}, not ${c.id}`)
  }

  // ── groups (service; the company data repo) ──
  const groups = await groupDeps()
  for (const g of f.groups) {
    const view = await createGroup({ id: owner.id, role: 'owner' }, { name: g.name, memberIds: g.members.map((k) => member[k]) }, groups)
    put(g.id, view.id)
  }

  // ── channels, DMs, messages (service, with the clock set to each message's time) ──
  const live = await messagesDeps()
  let clock = anchor
  const msgs = { ...live, now: () => clock }
  for (const ch of f.channels) {
    const creator = ch.private ? ch.members![0]! : 'martin'
    const others = ch.private ? ch.members!.slice(1).map((k) => seat[k]) : undefined
    clock = minutesBefore(anchor, 30 * 24 * 60)
    const conv = await createChannel(msgs, seat[creator], { name: ch.name, topic: ch.topic, private: ch.private, ...(others ? { userIds: others } : {}) })
    put(ch.id, conv.id)
    for (const m of ch.messages) {
      clock = minutesBefore(anchor, m.minutesAgo)
      put(m.id, (await postMessage(msgs, member[m.author], conv.id, m.text)).id)
    }
  }
  for (const dm of f.dms) {
    clock = minutesBefore(anchor, 30 * 24 * 60)
    const conv = await openDm(msgs, member[dm.members[0]], [member[dm.members[1]]])
    put(dm.id, conv.id)
    for (const m of dm.messages) {
      clock = minutesBefore(anchor, m.minutesAgo)
      put(m.id, (await postMessage(msgs, member[m.author], conv.id, m.text)).id)
    }
  }

  // ── mail: domain (direct), mailbox (service), received mail (inbox store) ──
  const db = createScopedDrizzle(appSql)
  const [domain] = await db
    .insert(mailDomains)
    .values({ name: f.company.domain, region: 'eu-central-1', status: 'SUCCESS', dkimSelector: 'eval', dkimStatus: 'SUCCESS', receiving: true, isVerifying: false, createdBy: owner.id })
    .returning({ id: mailDomains.id })
  if (!domain) throw new Error('seed: mail domain insert returned nothing')
  const inbox = { ...(await inboxDeps()), domains: async () => [{ id: domain.id, name: f.company.domain }] }
  for (const box of f.mailboxes) {
    if ('owner' in box) {
      const view = await assignPersonalMailbox(inbox, owner.id, { memberId: member[box.owner], localPart: box.localPart, domainId: domain.id, displayName: box.displayName })
      put(box.id, view.id)
      continue
    }
    const groupId = ids.get(box.groupId)
    if (!groupId) throw new Error(`seed: mailbox ${box.id} names unseeded group ${box.groupId}`)
    const view = await createSharedMailbox(inbox, owner.id, { groupId, localPart: box.localPart, domainId: domain.id, displayName: box.displayName })
    put(box.id, view.id)
  }
  const inboxStore = dbInboxStore(db)
  for (const mail of f.mail) {
    const box = f.mailboxes.find((b) => b.id === mail.mailboxId)!
    const at = minutesBefore(anchor, mail.minutesAgo)
    const id = randomUUID()
    await inboxStore.insertMessage({
      id,
      mailboxId: ids.get(box.id)!,
      folder: 'inbox',
      threadId: randomUUID(),
      messageId: mail.messageId,
      sesMessageId: null,
      inReplyTo: null,
      references: [],
      from: mail.from,
      to: [{ name: box.displayName, address: `${box.localPart}@${f.company.domain}` }],
      cc: [],
      bcc: [],
      subject: mail.subject,
      snippet: mail.text.slice(0, 140),
      textBody: mail.text,
      htmlBody: null,
      receivedAt: at,
      readAt: null,
      starred: false,
      verdicts: { spam: 'PASS', virus: 'PASS', spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
      rawS3Key: null,
      sizeBytes: new TextEncoder().encode(mail.text).byteLength,
      createdAt: at,
    })
    put(mail.id, id)
  }

  // ── calls + transcripts (the stores the calls service uses) ──
  const calls = dbCallsStore(db)
  const transcripts = dbTranscriptStore(db)
  for (const call of f.calls) {
    const id = randomUUID()
    const startedAt = minutesBefore(anchor, call.minutesAgo)
    const endedAt = new Date(startedAt.getTime() + call.durationMinutes * 60_000)
    const guests = call.guestEmails.map((email) => ({
      id: randomUUID(),
      callId: id,
      email,
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      invitedBy: member[call.startedBy],
      invitedAt: startedAt,
      displayName: null as string | null,
      revokedAt: null,
    }))
    const guestByName = new Map<string, string>()
    const participants = [
      ...call.participants.map((k) => ({ callId: id, userId: member[k], invitedAt: startedAt, joinedAt: startedAt, leftAt: endedAt, response: 'accepted' as const, transcribe: true })),
      ...guests.map((g) => ({ callId: id, userId: guestIdentity(g.id), invitedAt: startedAt, joinedAt: startedAt, leftAt: endedAt, response: 'accepted' as const, transcribe: true })),
    ]
    for (const l of call.lines) {
      if (typeof l.speaker === 'object' && !guestByName.has(l.speaker.guest)) {
        const g = guests[guestByName.size]
        if (!g) throw new Error(`seed: call ${call.id} has more guest speakers than guests`)
        g.displayName = l.speaker.guest
        guestByName.set(l.speaker.guest, g.id)
      }
    }
    const inserted = await calls.insert({
      call: { id, roomName: `eval-${id}`, contextKind: 'meeting', contextId: null, title: call.title, startedBy: member[call.startedBy], state: 'ended', startedAt, endedAt, scheduledStart: startedAt, scheduledEnd: endedAt, externalUrl: null },
      participants,
      guests,
      brainListens: [],
      brainShared: [],
    })
    if (!inserted.ok) throw new Error(`seed: call ${call.id} was refused by the store`)
    const step = (call.durationMinutes * 60_000) / call.lines.length
    for (const [i, l] of call.lines.entries()) {
      const from = new Date(startedAt.getTime() + i * step)
      const speaker = typeof l.speaker === 'string'
        ? { speakerId: member[l.speaker], speakerKind: 'member' as const, speakerName: f.members.find((m) => m.key === l.speaker)!.name }
        : { speakerId: guestIdentity(guestByName.get(l.speaker.guest)!), speakerKind: 'guest' as const, speakerName: l.speaker.guest }
      await transcripts.add({ callId: id, ...speaker, startedAt: from, endedAt: new Date(from.getTime() + step - 1000), text: l.text })
    }
    put(call.id, id)
  }

  // ── Drive (service: upload + sharing) ──
  const drive = await driveService()
  for (const file of f.drive) {
    const actor = { kind: 'user' as const, userId: member[file.owner] }
    const bytes = file.kind === 'md' ? new TextEncoder().encode(file.content) : buildPptx(file.slides)
    const mime = file.kind === 'md' ? 'text/markdown' : OFFICE_MIME.pptx
    const view = await drive.upload(actor, null, { name: file.name, bytes, mime }, 'fail')
    if (file.grant === 'everyone') await drive.setGrants(actor, 'file', view.id, [{ subject: { kind: 'company' }, level: 'view' }])
    else if (file.grant !== 'private') {
      await drive.setGrants(actor, 'file', view.id, file.grant.members.map((k) => ({ subject: { kind: 'user' as const, userId: member[k] }, level: 'view' as const })))
    }
    put(file.id, view.id)
  }

  // ── calendar (service) ──
  const cal = await calendarDeps()
  for (const ev of f.events) {
    const date = localDateOf(anchor, f.company.timeZone, ev.dayOffset)
    const dto = await createEvent(cal, { kind: 'user', userId: member[ev.owner] }, {
      title: ev.title,
      notes: ev.notes,
      location: '',
      allDay: false,
      start: `${date}T${ev.start}`,
      end: `${date}T${ev.end}`,
      timeZone: f.company.timeZone,
      visibility: ev.visibility,
      status: 'confirmed',
      rrule: null,
      attendees: ev.attendees.map((k) => ({ memberId: member[k] })),
      callId: null,
    })
    put(ev.id, dto.id)
  }

  // ── contacts (service) ──
  const contacts = await contactsDeps()
  for (const c of f.contacts) {
    const dto = await createContact(
      contacts,
      { kind: 'user', userId: member[c.owner] },
      { name: c.name, organisation: c.organisation, title: c.title, channels: [{ type: 'email', value: c.email }], metHow: c.metHow, whyRelevant: c.whyRelevant, ownerId: member[c.owner] },
      { shared: c.shared, today: localDateOf(anchor, f.company.timeZone, -14) },
    )
    put(c.id, dto.id)
  }

  // ── thoughts (a person's: Memory's capture queue, under their row-level security; a co-worker's: its own capture tool) ──
  for (const [i, t] of f.thoughts.entries()) {
    const ownerId = seat[t.owner]
    const cwKey = f.coworkers.find((c) => c.key === t.owner)?.key
    if (cwKey) {
      const out = (await opts.registry.execute('memory.capture_thought', { raw: t.text }, {
        principal: coworkerPrincipal(ownerId, coworkerAgentId(ownerId)),
        requestId: randomUUID(),
      })) as { thoughtId?: unknown }
      if (typeof out.thoughtId !== 'string') throw new Error(`seed: ${t.id} was captured without a thought id`)
      const thoughtId = out.thoughtId
      if (opts.enrichThoughts) await withEvalDb(ownerId, () => enrichQueuedThought(ownerId, thoughtId, {}))
      put(t.id, thoughtId)
      continue
    }
    const thoughtId = await withEvalDb(ownerId, async () => {
      const queued = await queueCapture(ownerId, t.text, { source: 'eval', skipWorker: true, capturedAt: minutesBefore(anchor, (i + 1) * 6 * 60) })
      if (opts.enrichThoughts) await enrichQueuedThought(ownerId, queued.thoughtId, {})
      return queued.thoughtId
    })
    put(t.id, thoughtId)
  }

  return { member, coworker, seat, ids }
}
