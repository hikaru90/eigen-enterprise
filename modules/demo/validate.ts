import { OWNER, type DemoDataset } from './types'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** Referential integrity of the dataset; [] when it is sound. The runner refuses to start otherwise. */
export function validateDataset(d: DemoDataset): string[] {
  const errors: string[] = []
  const people = new Set<string>([OWNER])
  const emails = new Set<string>()
  for (const t of d.teammates) {
    if (people.has(t.handle)) errors.push(`duplicate person handle "${t.handle}"`)
    people.add(t.handle)
    const domain = t.email.slice(t.email.lastIndexOf('@') + 1)
    if (domain !== d.emailDomain)
      errors.push(`teammate ${t.handle}: email ${t.email} is not on ${d.emailDomain}`)
    if (emails.has(t.email)) errors.push(`duplicate teammate email ${t.email}`)
    emails.add(t.email)
  }
  const companies = new Set(d.companies.map((c) => c.id))
  if (companies.size !== d.companies.length) errors.push('duplicate company id')

  for (const g of d.groups) {
    for (const m of g.members)
      if (!people.has(m)) errors.push(`group ${g.name}: unknown member "${m}"`)
  }

  const contactIds = new Set<string>()
  for (const c of d.contacts) {
    if (contactIds.has(c.id)) errors.push(`duplicate contact id ${c.id}`)
    contactIds.add(c.id)
    if (!companies.has(c.company)) errors.push(`contact ${c.id}: unknown company "${c.company}"`)
    if (!people.has(c.owner)) errors.push(`contact ${c.id}: unknown owner "${c.owner}"`)
    const days = c.logs.map((l) => l.day)
    if (days.some((day, i) => i > 0 && day < days[i - 1]!))
      errors.push(`contact ${c.id}: logs are not in date order`)
    if (days.some((day) => day > 0))
      errors.push(`contact ${c.id}: a logged contact lies in the future`)
  }

  for (const p of d.projects) {
    if (!people.has(p.lead)) errors.push(`project ${p.id}: unknown lead "${p.lead}"`)
    if (!companies.has(p.client)) errors.push(`project ${p.id}: unknown client "${p.client}"`)
    for (const t of p.tasks) {
      if (!people.has(t.assignee))
        errors.push(
          `project ${p.id}: task "${t.title}" is assigned to unknown person "${t.assignee}"`,
        )
    }
  }

  const channels = new Set(d.channels.map((c) => c.id))
  d.messages.forEach((m, i) => {
    if (!channels.has(m.channel)) errors.push(`message ${i}: unknown channel "${m.channel}"`)
    if (!people.has(m.author))
      errors.push(`message ${i} in ${m.channel}: unknown author "${m.author}"`)
  })

  d.events.forEach((e, i) => {
    const label = `event ${i} "${e.title}"`
    if (!people.has(e.organizer)) errors.push(`${label}: unknown organizer "${e.organizer}"`)
    for (const a of e.attendees) {
      if (!people.has(a)) errors.push(`${label}: unknown attendee "${a}"`)
      if (a === e.organizer) errors.push(`${label}: the organizer "${a}" is also a guest`)
    }
    if (!HHMM.test(e.start) || !HHMM.test(e.end)) errors.push(`${label}: times must be HH:mm`)
    else if (e.end <= e.start) errors.push(`${label}: ends before it starts`)
  })

  for (const doc of d.docs)
    if (!people.has(doc.author)) errors.push(`doc "${doc.name}": unknown author "${doc.author}"`)
  for (const m of d.memories) {
    if (!people.has(m.author)) errors.push(`memory "${m.title}": unknown author "${m.author}"`)
    if (m.company !== undefined && !companies.has(m.company))
      errors.push(`memory "${m.title}": unknown company "${m.company}"`)
  }
  const slugs = new Set<string>()
  for (const p of d.pages) {
    if (slugs.has(p.slug)) errors.push(`duplicate page slug "${p.slug}"`)
    slugs.add(p.slug)
  }
  return errors
}
