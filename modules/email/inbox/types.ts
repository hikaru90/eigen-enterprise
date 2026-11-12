/**
 * Mailboxes (plan/email-inbox.md): the addresses the company receives mail on.
 * A personal mailbox belongs to one member and only they can read it; a shared
 * mailbox (info@, hello@) is read by the members of one group.
 */

export const MAILBOX_KINDS = ['personal', 'shared'] as const
export type MailboxKind = (typeof MAILBOX_KINDS)[number]

export const FOLDERS = ['inbox', 'sent', 'spam', 'trash', 'archive'] as const
export type Folder = (typeof FOLDERS)[number]

/** Where a reader can move a mail (S4). Sent is filled by sending only. */
export const MOVE_TARGETS = ['inbox', 'archive', 'trash', 'spam'] as const satisfies readonly Folder[]
export type MoveTarget = (typeof MOVE_TARGETS)[number]

/** SES receipt verdicts (receipt.*Verdict.status). */
export const VERDICTS = ['PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED'] as const
export type Verdict = (typeof VERDICTS)[number]

const LOCAL_CHARS = /^[a-z0-9._+-]+$/
const BAD_DOTS = /^\.|\.$|\.\./

/** The part before the @, as the owner typed it: trimmed, lower-cased, RFC dot-atom subset. */
export function normalizeLocalPart(input: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = input.trim().toLowerCase()
  if (value === '') return { ok: false, message: 'Give the address a name before the @.' }
  if (value.length > 64) return { ok: false, message: 'Keep the part before the @ to 64 characters.' }
  if (!LOCAL_CHARS.test(value)) return { ok: false, message: 'Use only letters, digits and . _ + - before the @.' }
  if (BAD_DOTS.test(value)) {
    return { ok: false, message: 'An address can’t start or end with a dot, and can’t have two dots in a row.' }
  }
  return { ok: true, value }
}

const SPELLED: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }

/** One name as address words: German umlauts spelled out, other accents dropped, the rest split. */
function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => SPELLED[c]!)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * The prefill for a member's address: `firstname.lastname` from their profile
 * (the display name when first/last are missing). Only a suggestion — the owner
 * assigns the address. Null when nothing usable is left.
 */
export function suggestLocalPart(p: { firstName: string | null; lastName: string | null; name: string }): string | null {
  const fromProfile = [...words(p.firstName ?? ''), ...words(p.lastName ?? '')]
  const parts = fromProfile.length > 0 ? fromProfile : words(p.name)
  if (parts.length === 0) return null
  const out = normalizeLocalPart(parts.join('.').slice(0, 64).replace(/\.$/, ''))
  return out.ok ? out.value : null
}
