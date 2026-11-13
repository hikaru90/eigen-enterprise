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
  /** "How it went" on a logged contact. */
  logNote: 2000,
  channelValue: 300,
  channels: 20,
  tag: 40,
  tags: 20,
} as const

/** "Follow up next" lists what is due and what comes up within this many days. */
export const FOLLOW_UP_WINDOW_DAYS = 14

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
