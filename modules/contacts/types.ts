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
