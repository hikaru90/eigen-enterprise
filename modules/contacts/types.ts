/**
 * Contacts' vocabulary, shared by client and server (pure — no server imports).
 * Channel types are the values the service accepts (migration 0124 stores
 * channels as a JSON array the service validates).
 */

export const CHANNEL_TYPES = ['email', 'phone', 'linkedin', 'website', 'other'] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

export const CHANNEL_LABELS: Record<ChannelType, string> = {
  email: 'Email',
  phone: 'Phone',
  linkedin: 'LinkedIn',
  website: 'Website',
  other: 'Other',
}

/** One way to reach a person: an email address, a phone number, a LinkedIn profile, … */
export type Channel = { type: ChannelType; value: string }

/** Why a person matters, offered on every contact; people add their own tags beside these. */
export const DEFAULT_TAGS = ['partner', 'customer', 'funder', 'investor', 'production'] as const

/** The longest values accepted (after trimming); the DB checks the same bounds. */
export const CONTACT_LIMITS = {
  name: 200,
  organisation: 200,
  title: 200,
  metHow: 1000,
  whyRelevant: 2000,
  nextStep: 500,
  /** "Latest status" in the pipeline. */
  latestStatus: 500,
  /** "How it went" on a logged contact. */
  logNote: 2000,
  channelValue: 300,
  channels: 20,
  tag: 40,
  tags: 20,
} as const

/** "Follow up next" lists what is due and what comes up within this many days. */
export const FOLLOW_UP_WINDOW_DAYS = 14

// ── The pipeline (Contribute 8c6a0cb7), worked the Getting Things Done way ─────

/**
 * The list a contact sits in — one at a time, set by a person (or an explicit
 * tool call / "Log a contact"), never read out of text. In the order the
 * pipeline shows them (Ony's 1–4):
 * - next: the ball is in our court — a concrete next step we own (GTD next actions; "Wir sind dran");
 * - waiting: we wait on their reply, since a day (GTD waiting for; "Warten auf Antwort");
 * - keep_in_touch: nothing open — check in on the tickler day (GTD tickler; "Im Loop halten");
 * - inbox: not contacted yet, not processed (GTD inbox; "Noch nicht angeschrieben").
 */
export const PIPELINE_STAGES = ['next', 'waiting', 'keep_in_touch', 'inbox'] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

export const STAGE_INFO: Record<PipelineStage, { label: string; gtd: string; hint: string; dateLabel: string }> = {
  next: {
    label: 'Our move',
    gtd: 'Next actions',
    hint: 'The ball is in our court: each one has a concrete next step and someone on our side who does it.',
    dateLabel: 'Due',
  },
  waiting: {
    label: 'Waiting for a reply',
    gtd: 'Waiting for',
    hint: 'We wrote; they answer next. Chase the ones that have waited too long.',
    dateLabel: 'Chase on',
  },
  keep_in_touch: {
    label: 'Keep in the loop',
    gtd: 'Tickler',
    hint: 'Nothing open right now — check in with them on the tickler day.',
    dateLabel: 'Check in on',
  },
  inbox: {
    label: 'Not contacted yet',
    gtd: 'Inbox',
    hint: 'Not processed yet: decide the first step and who does it, then move them on.',
    dateLabel: 'Due',
  },
}

/** How we are in touch with someone (the pipeline's "via"). */
export const VIA_TYPES = ['email', 'phone', 'linkedin', 'meeting', 'message', 'other'] as const
export type Via = (typeof VIA_TYPES)[number]

export const VIA_LABELS: Record<Via, string> = {
  email: 'Email',
  phone: 'Phone',
  linkedin: 'LinkedIn',
  meeting: 'Meeting',
  message: 'Message',
  other: 'Other',
}

/** The weekly review flags a reply we have waited on for longer than this many days. */
export const WAITING_REVIEW_DAYS = 7

/** One contact as a person (or the agent) sees it. Dates are `YYYY-MM-DD` days. */
export type ContactDto = {
  id: string
  name: string
  organisation: string | null
  /** Role or job title. */
  title: string | null
  channels: Channel[]
  /** Where or how you met. */
  metHow: string | null
  whyRelevant: string | null
  tags: string[]
  lastContactedOn: string | null
  nextFollowUpOn: string | null
  nextStep: string | null
  /** The pipeline list it sits in. */
  stage: PipelineStage
  /** Who on our side holds the contact (a member's user id), and their name. */
  ownerId: string | null
  ownerName: string | null
  /** How we are in touch. */
  via: Via | null
  /** Where things stand, in a line. */
  latestStatus: string | null
  /** Waiting for their reply since (set exactly while stage = waiting). */
  waitingSince: string | null
  /** false = private to its creator (plus the company owner and admins). */
  shared: boolean
  /** The viewer added it. */
  own: boolean
  /** Who added it, in words ("Ana Lind", "the agent"). */
  createdByName: string
  /** The viewer may share/unshare and delete it (its creator, the owner, admins). */
  canManage: boolean
  createdAt: string
  updatedAt: string
}

export type FollowUpDue = 'overdue' | 'today' | 'upcoming'

/** A contact in "Follow up next": its follow-up day relative to today. */
export type FollowUpDto = ContactDto & { nextFollowUpOn: string; due: FollowUpDue; daysFromToday: number }

/** What the weekly review notices about one contact in the pipeline. */
export type PipelineReview = {
  /** Days from today to its follow-up / tickler day (negative = past), or null when it has none. */
  daysFromToday: number | null
  /** Its follow-up / tickler day has passed. */
  overdue: boolean
  /** Days we have been waiting on their reply (waiting only). */
  daysWaiting: number | null
  /** Waiting longer than WAITING_REVIEW_DAYS. */
  staleWaiting: boolean
  /** "Our move" without a concrete next step written down. */
  missingNextStep: boolean
  /** Any of the above (or still in the inbox): the weekly review looks at it. */
  needsReview: boolean
}

export type PipelineItem = ContactDto & { review: PipelineReview }

export type PipelineGroup = { stage: PipelineStage; items: PipelineItem[] }

/** The pipeline: every contact the viewer sees, in its list, with what the weekly review should look at. */
export type Pipeline = {
  today: string
  groups: PipelineGroup[]
  review: { waitingTooLong: number; overdue: number; nextWithoutStep: number; inbox: number; waitingDays: number }
  /** The people who can hold a contact (company members), by name. */
  people: Array<{ id: string; name: string }>
}

/** Who can see a contact, said plainly (the list, the detail page and the agent all use this). */
export function visibilityText(c: Pick<ContactDto, 'shared' | 'own' | 'createdByName'>): string {
  if (c.shared) return 'Shared with the company: everyone in the company can see and update it.'
  if (c.own) return 'Private: only you, the company owner and admins can see it.'
  return `Private to ${c.createdByName}: only they, the company owner and admins can see it.`
}

/** "in 3 days", "today", "2 days ago" — for a follow-up or last-contacted day. */
export function relativeDays(days: number): string {
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return days > 0 ? `in ${days} days` : `${-days} days ago`
}

/** The day (`YYYY-MM-DD`) it is at `at` in an IANA time zone. */
export function dayIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** Where a channel opens (mail, a call, the profile) — or null when its value isn't something to open. */
export function channelHref(c: Channel): string | null {
  if (c.type === 'email') return `mailto:${c.value}`
  if (c.type === 'phone') {
    const number = c.value.replace(/[^\d+]/g, '')
    return number === '' ? null : `tel:${number}`
  }
  return /^https?:\/\//i.test(c.value) ? c.value : null
}

// ── "Tell me about them": the AI's reading of what a person said ───────────────

/** The longest description (typed or dictated) the AI reads in one go. */
export const DESCRIBE_TEXT_MAX = 8000

export const EXTRACT_MODES = ['contact', 'log'] as const
export type ExtractMode = (typeof EXTRACT_MODES)[number]

/**
 * What the AI picked out of a free description of a person, for the contact
 * form to prefill. null / empty = not said. Nothing here is saved: the
 * person reviews the form and presses Save.
 */
export type ContactDraft = {
  name: string | null
  organisation: string | null
  title: string | null
  channels: Channel[]
  metHow: string | null
  whyRelevant: string | null
  /** Only tags the form offers (the default ones and the ones in use). */
  tags: string[]
  lastContactedOn: string | null
  nextFollowUpOn: string | null
  nextStep: string | null
}

/** What the AI picked out of "we spoke today, next I'll…", for "Log a contact". */
export type LogDraft = {
  on: string | null
  /** How it went, in the person's own words. */
  note: string | null
  nextFollowUpOn: string | null
  nextStep: string | null
}

export type DraftFor<M extends ExtractMode> = M extends 'contact' ? ContactDraft : LogDraft

// ── Contact history ("Kontaktverlauf") ────────────────────────────────────────

/** A follow-up: when and what (either may be missing). */
export type FollowUpStep = { on: string | null; step: string | null }

/**
 * One thing in a contact's history. `day` (`YYYY-MM-DD`, the viewer's day) and
 * `at` (ISO) order the timeline: newest day first, then newest first.
 */
export type HistoryItem =
  | { kind: 'added'; id: string; day: string; at: string; by: string }
  | {
      kind: 'logged'
      id: string
      day: string
      at: string
      by: string
      note: string | null
      /** The follow-up this contact answered (null: none was set). */
      answered: FollowUpStep | null
      /** The follow-up it set (null: nothing next). */
      next: FollowUpStep | null
    }
  | {
      kind: 'mail'
      id: string
      day: string
      at: string
      /** Received from them, or sent to them. */
      direction: 'received' | 'sent'
      /** A mailbox you read (its address), or the company's own sending (admins only). */
      via: { kind: 'mailbox'; address: string } | { kind: 'company'; status: string }
      subject: string
      snippet: string | null
      /** Where to open it: the Inbox reader or Email › Logs. */
      href: string
    }

/** The newest mails the history shows per source (your mailboxes, company mail). */
export const HISTORY_MAIL_LIMIT = 50

// ── Import (vCard, CSV) ───────────────────────────────────────────────────────

/** The most contacts one import adds. */
export const IMPORT_MAX = 500

/** One person read from a file, before the service checks it (nothing saved). */
export type ImportCandidate = {
  name: string
  organisation: string | null
  title: string | null
  channels: Channel[]
  metHow: string | null
  whyRelevant: string | null
  tags: string[]
}

/** The preview of one candidate: new (importable), already known by email, or not importable as it is. */
export type ImportPreviewRow =
  | { index: number; status: 'new'; contact: ImportCandidate }
  | {
      index: number
      status: 'duplicate'
      contact: ImportCandidate
      email: string
      /** The contact you already see with that email, or null when an earlier row of the file has it. */
      existing: { id: string; name: string } | null
    }
  | { index: number; status: 'invalid'; name: string; error: string }

export type ImportPreview = { rows: ImportPreviewRow[]; counts: { new: number; duplicate: number; invalid: number } }
