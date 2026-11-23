/**
 * North-star eval (plan/phase-company-brain.md §9, milestone CB0): the shapes
 * shared by the fixture, the suites, the graders and the report. Pure types +
 * constants — importing this never touches the DB or a model.
 */

/** The four concept layers of plan/phase-company-brain.md §2; every suite item names the one it tests. */
export const LAYERS = ['act', 'happen', 'understand', 'initiate'] as const
export type Layer = (typeof LAYERS)[number]

export const SUITES = ['knows', 'does', 'keeps'] as const
export type SuiteName = (typeof SUITES)[number]

export type MemberKey = 'martin' | 'ony' | 'priya' | 'jonas'
export const MEMBER_KEYS: readonly MemberKey[] = ['martin', 'ony', 'priya', 'jonas']

/** The fixture's AI co-workers (plan/phase-ai-coworkers.md, C8): seats of their own, never a person. */
export type CoworkerKey = 'marketing' | 'gtm' | 'designer'
export const COWORKER_KEYS: readonly CoworkerKey[] = ['marketing', 'gtm', 'designer']

/** Anyone with a seat who reads the company: a person or an AI co-worker. */
export type SeatKey = MemberKey | CoworkerKey
export const isCoworkerKey = (k: SeatKey): k is CoworkerKey => (COWORKER_KEYS as readonly string[]).includes(k)

/**
 * Who may see a source's CONTENT (axis A of §4). `everyone` = all members;
 * `members` = exactly these. Activity about the source (axis B) is not
 * governed here — the eval only protects content, through its marker.
 */
export type Audience = { kind: 'everyone' } | { kind: 'members'; members: SeatKey[] }

/**
 * Every piece of seeded content carries one `marker`: a unique, unguessable
 * reference code written into its text (a PO number, a ticket id …). Seeing
 * the marker in a tool result or answer is PROVENANCE — that exact content
 * reached the asker — not a judgement about meaning. Paraphrased leaks are
 * the judge's job (real-model mode).
 */
export type SourceBase = { id: string; marker: string }

export type FixtureMember = {
  key: MemberKey
  id: string
  name: string
  firstName: string
  lastName: string
  email: string
  role: 'owner' | 'admin' | 'member'
  /** Job title, stated in the handbook (members have no title field). */
  title: string
}

export type ChannelMessage = SourceBase & { author: MemberKey; text: string; minutesAgo: number }

export type FixtureChannel = {
  id: string
  name: string
  topic: string
  private: boolean
  /** Private channels only: who is in it (the creator first, a person). Co-workers may be members. */
  members?: SeatKey[]
  messages: ChannelMessage[]
}

export type FixtureDm = { id: string; members: [MemberKey, MemberKey]; messages: ChannelMessage[] }

export type FixtureGroup = { id: string; name: string; members: MemberKey[] }

/** A shared mailbox (read by one group) or a person's personal one (read by them alone). */
export type FixtureMailbox = { id: string; localPart: string; displayName: string } & ({ groupId: string } | { owner: MemberKey })

export type FixtureMail = SourceBase & {
  mailboxId: string
  from: { name: string; address: string }
  subject: string
  text: string
  minutesAgo: number
  messageId: string
}

export type TranscriptLine = { speaker: MemberKey | { guest: string }; text: string }

export type FixtureCall = SourceBase & {
  title: string
  startedBy: MemberKey
  participants: MemberKey[]
  guestEmails: string[]
  minutesAgo: number
  durationMinutes: number
  lines: TranscriptLine[]
}

export type DriveGrant = 'everyone' | 'private' | { members: MemberKey[] }

export type Slide = { title: string; bullets: string[] }

export type FixtureDriveFile = SourceBase & {
  owner: MemberKey
  name: string
  grant: DriveGrant
} & ({ kind: 'md'; content: string } | { kind: 'pptx'; slides: Slide[] })

export type FixtureEvent = SourceBase & {
  owner: MemberKey
  title: string
  notes: string
  /** Whole days from the fixture anchor's date (may be negative), local time in the company zone. */
  dayOffset: number
  start: string
  end: string
  attendees: MemberKey[]
  visibility: 'company' | 'busy' | 'private'
}

export type FixtureContact = SourceBase & {
  owner: MemberKey
  name: string
  organisation: string
  title: string
  email: string
  metHow: string
  whyRelevant: string
  shared: boolean
}

/** A person's thought is theirs alone; a co-worker's is company-visible (read-only to the others). */
export type FixtureThought = SourceBase & { owner: SeatKey; text: string; sensitive: boolean }

/**
 * An AI co-worker of the seeded company, created from a COWORKER_TEMPLATES role
 * card ($lib/server/coworkers/templates.ts) with its own pool model. `name`
 * makes its @handle (the service derives the slug from it).
 */
export type FixtureCoworker = {
  key: CoworkerKey
  /** The user id it is created with (fixed, so the seeded company is reproducible). */
  id: string
  name: string
  templateId: 'marketing-manager' | 'go-to-market-manager' | 'designer'
  /** A chat model of the curated pool; the three differ on purpose (§1). */
  modelId: string
  reportsTo: SeatKey
}

export type CompanyFixture = {
  company: { name: string; domain: string; timeZone: string }
  members: FixtureMember[]
  coworkers: FixtureCoworker[]
  groups: FixtureGroup[]
  channels: FixtureChannel[]
  dms: FixtureDm[]
  mailboxes: FixtureMailbox[]
  mail: FixtureMail[]
  calls: FixtureCall[]
  drive: FixtureDriveFile[]
  events: FixtureEvent[]
  contacts: FixtureContact[]
  thoughts: FixtureThought[]
}

/** Any seeded content, with who may read it (derived, see fixture/audience.ts). */
export type SourceKind = 'channel_message' | 'dm_message' | 'mail' | 'call' | 'drive_file' | 'event' | 'contact' | 'thought'
export type SourceRef = { id: string; kind: SourceKind; marker: string; audience: Set<SeatKey>; label: string }

// ── Suites ────────────────────────────────────────────────────────────────

type ItemBase = {
  id: string
  layer: Layer
  /** Short tag of the concept under test (e.g. "acts-as-person", "content-dial"). */
  concept: string
  asker: MemberKey
  prompt: string
}

/**
 * Knows: graded by a closed-set judge (correct | partial | incorrect |
 * no_answer, plus cited yes/no) against `gold`; `sources` are the fixture
 * sources the answer must come from (their markers make reachability
 * checkable without a model). Placeholders `{name}` in prompt/gold are
 * filled from the seeded fixture's facts (fixture/facts.ts).
 */
export type KnowsItem = ItemBase & { suite: 'knows'; gold: string; sources: string[] }

/**
 * Does: graded on resulting state by a named structural check (no model:
 * which rows exist after the turn), plus — when the task produces text —
 * a closed-set judge on `contentCriterion`.
 */
export type StateCheck =
  | { check: 'calendar_event_created'; owner: MemberKey; attendee: MemberKey; dayOfWeek: number; startLocal: string }
  | { check: 'calendar_event_moved'; eventId: string; startLocal: string }
  | { check: 'mail_reply_sent'; inReplyToMailId: string }
  | { check: 'channel_message_posted'; channelId: string; author: MemberKey }
  | { check: 'dm_message_posted'; dmId: string; author: MemberKey }
  | { check: 'contact_created'; owner: MemberKey; name: string }
  | { check: 'contact_logged'; contactId: string }
  | { check: 'task_assigned'; assignee: MemberKey }
  | { check: 'drive_file_created'; owner: MemberKey; kind: 'any' | 'pptx' }
  | { check: 'drive_file_shared'; fileId: string; withMember: MemberKey }
  | { check: 'call_started'; startedBy: MemberKey; participant: MemberKey }
  | { check: 'thought_captured'; owner: MemberKey }

export type DoesItem = ItemBase & { suite: 'does'; state: StateCheck; contentCriterion?: string }

/** Keeps/leak: the asker must never receive the content of `protects` (none of these is theirs to read). */
export type LeakItem = ItemBase & { suite: 'keeps'; kind: 'leak'; protects: string[] }
/** Keeps/judgment: an answer about `about` may hold observations only (closed-set judge). */
export type JudgmentItem = ItemBase & { suite: 'keeps'; kind: 'judgment'; about: MemberKey }
export type KeepsItem = LeakItem | JudgmentItem

export type SuiteItem = KnowsItem | DoesItem | KeepsItem
