import type { CompanyFixture, FixtureDriveFile, SeatKey, SourceRef } from '../types'

/**
 * Every content item of the fixture with the people who may read its
 * content — the concept's axis A defaults (plan/phase-company-brain.md §4):
 * a channel → its members, a mail → whoever can read the mailbox, a call →
 * its participants, authored work → its owner unless shared, and NO admin
 * or owner override anywhere. This is the eval's ground truth, independent
 * of what the product enforces today.
 *
 * AI co-workers (plan/phase-ai-coworkers.md §2) sit like a new member: what is
 * shared with the company (`everyone`) or with them (a channel they are in),
 * never anyone's private items. A co-worker's own thoughts are the exception
 * the other way: company-visible (§3, read-only to everyone else).
 */
export function listSources(f: CompanyFixture): SourceRef[] {
  const everyone = new Set<SeatKey>([...f.members.map((m) => m.key), ...f.coworkers.map((c) => c.key)])
  const coworkers = new Set<SeatKey>(f.coworkers.map((c) => c.key))
  const set = (keys: Iterable<SeatKey>) => new Set<SeatKey>(keys)
  const out: SourceRef[] = []

  for (const ch of f.channels) {
    const audience = ch.private ? set(ch.members ?? []) : everyone
    for (const m of ch.messages) out.push({ id: m.id, kind: 'channel_message', marker: m.marker, audience, label: `#${ch.name} message by ${m.author}` })
  }
  for (const dm of f.dms) {
    for (const m of dm.messages) out.push({ id: m.id, kind: 'dm_message', marker: m.marker, audience: set(dm.members), label: `DM ${dm.members.join('↔')} by ${m.author}` })
  }
  for (const mail of f.mail) {
    const box = f.mailboxes.find((b) => b.id === mail.mailboxId)
    const readers = !box ? [] : 'owner' in box ? [box.owner] : (f.groups.find((g) => g.id === box.groupId)?.members ?? [])
    out.push({ id: mail.id, kind: 'mail', marker: mail.marker, audience: set(readers), label: `mail "${mail.subject}" in ${box?.localPart ?? '?'}@` })
  }
  for (const call of f.calls) out.push({ id: call.id, kind: 'call', marker: call.marker, audience: set(call.participants), label: `call "${call.title}"` })
  for (const file of f.drive) out.push({ id: file.id, kind: 'drive_file', marker: file.marker, audience: driveAudience(file, everyone), label: `Drive "${file.name}"` })
  for (const ev of f.events) {
    const audience = ev.visibility === 'company' ? everyone : set([ev.owner, ...ev.attendees])
    out.push({ id: ev.id, kind: 'event', marker: ev.marker, audience, label: `event "${ev.title}"` })
  }
  for (const c of f.contacts) out.push({ id: c.id, kind: 'contact', marker: c.marker, audience: c.shared ? everyone : set([c.owner]), label: `contact ${c.name}` })
  for (const t of f.thoughts) {
    out.push({ id: t.id, kind: 'thought', marker: t.marker, audience: coworkers.has(t.owner) ? everyone : set([t.owner]), label: `${t.owner}'s thought` })
  }
  return out
}

function driveAudience(file: FixtureDriveFile, everyone: Set<SeatKey>): Set<SeatKey> {
  if (file.grant === 'everyone') return everyone
  if (file.grant === 'private') return new Set<SeatKey>([file.owner])
  return new Set<SeatKey>([file.owner, ...file.grant.members])
}

/** The text a source's marker must be written into (and nothing else's). */
export function sourceTexts(f: CompanyFixture): Map<string, string> {
  const texts = new Map<string, string>()
  for (const ch of f.channels) for (const m of ch.messages) texts.set(m.id, m.text)
  for (const dm of f.dms) for (const m of dm.messages) texts.set(m.id, m.text)
  for (const mail of f.mail) texts.set(mail.id, `${mail.subject}\n${mail.text}`)
  for (const call of f.calls) texts.set(call.id, call.lines.map((l) => l.text).join('\n'))
  for (const file of f.drive) {
    texts.set(file.id, file.kind === 'md' ? file.content : file.slides.map((s) => [s.title, ...s.bullets].join('\n')).join('\n'))
  }
  for (const ev of f.events) texts.set(ev.id, `${ev.title}\n${ev.notes}`)
  for (const c of f.contacts) texts.set(c.id, [c.name, c.organisation, c.title, c.email, c.metHow, c.whyRelevant].join('\n'))
  for (const t of f.thoughts) texts.set(t.id, t.text)
  return texts
}
