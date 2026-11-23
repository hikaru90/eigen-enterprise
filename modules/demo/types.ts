/**
 * The demo company's dataset shape (plan/phase-demo-company.md DC1). Plain
 * data: people are referred to by handle ('owner' = whoever claimed the box),
 * dates as day offsets from the run day, so the demo always looks current.
 */

/** 'owner' is the person who claimed the company; every other handle is a teammate. */
export type PersonHandle = string
export const OWNER: PersonHandle = 'owner'

export type Teammate = {
  handle: PersonHandle
  firstName: string
  lastName: string
  email: string
  role: 'admin' | 'member'
  /** What they do at Northwind (shown in notes and messages, never an evaluation). */
  title: string
}

export type ClientCompany = {
  id: string
  name: string
  city: string
  /** What the company does, in a line. */
  about: string
}

export type Stage = 'next' | 'waiting' | 'keep_in_touch' | 'inbox'
export type Via = 'email' | 'phone' | 'linkedin' | 'meeting' | 'message' | 'other'

export type ContactLog = {
  /** Day offset from today (negative = past). */
  day: number
  via: Via
  howItWent: string
  stage?: Stage
  nextFollowUpDay?: number
  nextStep?: string
  latestStatus?: string
}

export type Contact = {
  id: string
  name: string
  title: string
  company: string
  email: string
  phone?: string
  tags: string[]
  /** Who at Northwind holds the contact (runs the logs as them). */
  owner: PersonHandle
  metHow: string
  whyRelevant: string
  stage: Stage
  nextFollowUpDay?: number
  nextStep?: string
  latestStatus?: string
  logs: ContactLog[]
}

export type ProjectTask = {
  title: string
  assignee: PersonHandle
  /** Due day offset from today. */
  dueDay: number
  done: boolean
  /** What the assignee needs to know (assigned tasks only). */
  context?: string
}

export type Project = {
  id: string
  label: string
  lead: PersonHandle
  client: string
  deadlineDay: number
  tasks: ProjectTask[]
}

/** A public channel: open to everyone in the company. */
export type Channel = {
  id: string
  name: string
  topic: string
}

export type Message = {
  channel: string
  author: PersonHandle
  body: string
}

export type CalendarEvent = {
  title: string
  organizer: PersonHandle
  attendees: PersonHandle[]
  /** 0 = this week, 1 = next week. */
  week: 0 | 1
  /** 1 = Monday … 5 = Friday. */
  weekday: 1 | 2 | 3 | 4 | 5
  start: string
  end: string
  location?: string
  notes?: string
}

export type DriveDoc = {
  name: string
  author: PersonHandle
  content: string
}

export type BrandVoice = {
  locale: string
  mission: string
  audience: string
  register: string
  toneAttributes: string[]
  lexicon: { term: string; kind: 'allowed' | 'banned' | 'required'; replacement?: string }[]
  glossary: { term: string; definition: string }[]
  /** Voice is stored exemplar-first: at least one good and one bad example. */
  examples: {
    contentType: string
    situation: string
    body: string
    label: 'good' | 'bad'
    rationale: string
  }[]
}

export type WebsitePage = {
  slug: string
  title: string
  body: string
}

/** A shared Memory note: what a camera could have observed, never an evaluation. */
export type MemoryNote = {
  title: string
  author: PersonHandle
  body: string
  /** The client the note is about, when it is about one. */
  company?: string
}

export type Group = { name: string; description: string; members: PersonHandle[] }

export type DemoDataset = {
  companyName: string
  /** Every teammate's email ends in @<emailDomain>; the "already seeded" marker. */
  emailDomain: string
  timeZone: string
  teammates: Teammate[]
  groups: Group[]
  companies: ClientCompany[]
  contacts: Contact[]
  projects: Project[]
  channels: Channel[]
  messages: Message[]
  events: CalendarEvent[]
  driveFolder: string
  docs: DriveDoc[]
  brand: BrandVoice
  pages: WebsitePage[]
  memories: MemoryNote[]
}
