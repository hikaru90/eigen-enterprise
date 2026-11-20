import type { CompanyFixture, MemberKey } from '../types'
import { listSources, sourceTexts } from './audience'

/**
 * Structural validity of a fixture (no model): unique ids and markers, each
 * marker written into its own text and nobody else's, every referenced
 * person/group/mailbox exists, authors sit inside their conversation.
 * Returns every problem found; [] = valid.
 */
export function validateFixture(f: CompanyFixture): string[] {
  const errors: string[] = []
  const keys = new Set<MemberKey>(f.members.map((m) => m.key))
  const known = (where: string, k: MemberKey) => {
    if (!keys.has(k)) errors.push(`${where}: unknown member ${k}`)
  }

  const owners = f.members.filter((m) => m.role === 'owner').length
  if (owners !== 1) errors.push(`exactly one owner is required, found ${owners}`)
  for (const field of ['id', 'email', 'key'] as const) {
    const seen = new Set<string>()
    for (const m of f.members) {
      if (seen.has(m[field])) errors.push(`duplicate member ${field} ${m[field]}`)
      seen.add(m[field])
    }
  }

  const ids = [
    ...f.channels.map((c) => c.id),
    ...f.dms.map((d) => d.id),
    ...f.groups.map((g) => g.id),
    ...f.mailboxes.map((b) => b.id),
    ...listSources(f).map((s) => s.id),
  ]
  const seenIds = new Set<string>()
  for (const id of ids) {
    if (seenIds.has(id)) errors.push(`duplicate id ${id}`)
    seenIds.add(id)
  }

  const sources = listSources(f)
  const texts = sourceTexts(f)
  const seenMarkers = new Map<string, string>()
  for (const s of sources) {
    const prior = seenMarkers.get(s.marker)
    if (prior) errors.push(`duplicate marker ${s.marker} (${prior}, ${s.id})`)
    seenMarkers.set(s.marker, s.id)
    if (!(texts.get(s.id) ?? '').includes(s.marker)) errors.push(`${s.id}: marker ${s.marker} is not in its own text`)
  }
  for (const s of sources) {
    for (const [otherId, text] of texts) {
      if (otherId !== s.id && text.includes(s.marker)) errors.push(`marker ${s.marker} (${s.id}) also appears in ${otherId}`)
    }
  }

  for (const g of f.groups) for (const k of g.members) known(g.id, k)
  for (const ch of f.channels) {
    if (ch.private && (!ch.members || ch.members.length === 0)) errors.push(`${ch.id}: a private channel needs members`)
    if (!ch.private && ch.members) errors.push(`${ch.id}: a public channel lists no members`)
    for (const k of ch.members ?? []) known(ch.id, k)
    for (const m of ch.messages) {
      known(m.id, m.author)
      if (ch.private && !ch.members?.includes(m.author)) errors.push(`${ch.id}: author ${m.author} is not in the channel`)
    }
  }
  for (const dm of f.dms) {
    if (dm.members[0] === dm.members[1]) errors.push(`${dm.id}: a DM needs two different people`)
    for (const k of dm.members) known(dm.id, k)
    for (const m of dm.messages) if (!dm.members.includes(m.author)) errors.push(`${dm.id}: author ${m.author} is not in the DM`)
  }
  for (const b of f.mailboxes) if (!f.groups.some((g) => g.id === b.groupId)) errors.push(`${b.id}: unknown group ${b.groupId}`)
  for (const mail of f.mail) if (!f.mailboxes.some((b) => b.id === mail.mailboxId)) errors.push(`${mail.id}: unknown mailbox ${mail.mailboxId}`)
  for (const call of f.calls) {
    for (const k of call.participants) known(call.id, k)
    if (!call.participants.includes(call.startedBy)) errors.push(`${call.id}: startedBy ${call.startedBy} is not a participant`)
    for (const l of call.lines) if (typeof l.speaker === 'string' && !call.participants.includes(l.speaker)) errors.push(`${call.id}: speaker ${l.speaker} is not a participant`)
  }
  for (const file of f.drive) {
    known(file.id, file.owner)
    if (typeof file.grant === 'object') for (const k of file.grant.members) known(file.id, k)
  }
  for (const ev of f.events) {
    known(ev.id, ev.owner)
    for (const k of ev.attendees) {
      known(ev.id, k)
      if (k === ev.owner) errors.push(`${ev.id}: the owner is not their own attendee`)
    }
  }
  for (const c of f.contacts) known(c.id, c.owner)
  for (const t of f.thoughts) known(t.id, t.owner)
  return errors
}
