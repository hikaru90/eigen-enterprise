import { SOURCE_LABEL } from './status'

/**
 * Sender reputation (plan/mail-reputation.md): Amazon SES's bounce and
 * complaint criteria applied to the company's own SES events, per company and
 * per slice (kind of mail, sender, flow / API key), plus Amazon's own verdict.
 * Pure: the service reads the ledger and Amazon's status and applies the result.
 * Numbers only — no addresses, no content (webmail is one slice, S5 privacy).
 */

/** Amazon's published lines (docs 2026-11-27); "watch" for complaints is ours (half the review line). */
export const REPUTATION_THRESHOLDS = {
  bounce: { watch: 0.02, review: 0.05, pause: 0.1 },
  complaint: { watch: 0.0005, review: 0.001, pause: 0.005 },
} as const

/** The representative volume (R1) and the volumes a rate is judged from (R2, R4). */
export const REPUTATION_WINDOW = { days: 30, mails: 2000 } as const
export const REPUTATION_VOLUME = { bounce: 100, complaint: 1000, slice: 50 } as const

export const LEDGER_KINDS = ['send', 'hard_bounce', 'complaint'] as const
export type LedgerKind = (typeof LEDGER_KINDS)[number]

/** One ledger row: a Send (its recipients), a hard bounce or a complaint (how many recipients it names). */
export type LedgerRow = {
  sesMessageId: string
  kind: LedgerKind
  recipients: number
  /** The mail's source (MailSource), or 'webmail' for personal mail. */
  origin: string
  /** The From address; null for webmail. */
  sender: string | null
  /** 'flow:<id>' or 'api_key:<id>', else null. */
  ref: string | null
}

/** What Amazon itself says (GetAccount / GetTenant), or null when it could not be read yet. */
export type AwsReputation =
  | { mode: 'own'; enforcement: 'HEALTHY' | 'PROBATION' | 'SHUTDOWN'; sendingEnabled: boolean }
  | { mode: 'managed'; sendingStatus: 'ENABLED' | 'REINSTATED' | 'DISABLED' }
  | null

export const REPUTATION_BANDS = ['unjudged', 'healthy', 'watch', 'held', 'paused'] as const
export type ReputationBand = (typeof REPUTATION_BANDS)[number]

export type Rates = {
  recipients: number
  bounces: number
  complaints: number
  bounceRate: number | null
  complaintRate: number | null
}

export type SliceDimension = 'origin' | 'sender' | 'ref'

export type ReputationSlice = Rates & {
  dimension: SliceDimension
  value: string
  band: 'watch' | 'held'
  reasons: string[]
}

export type ReputationState = {
  band: ReputationBand
  /** Every mail but system mail is refused (held or paused). */
  sendingHeld: boolean
  rates: Rates
  reasons: string[]
  aws: AwsReputation
  /** Delivery events reach the box; without them only Amazon's verdict counts. */
  tracking: boolean
  /** Flagged slices (watch or held), worst first. */
  slices: ReputationSlice[]
}

export type SendSlice = { origin: string; sender: string | null; ref: string | null }

const pct = (r: number) => `${(r * 100).toFixed(r < 0.01 ? 2 : 1)}%`

function ratesOf(
  sends: Map<string, LedgerRow>,
  events: LedgerRow[],
  include: (send: LedgerRow) => boolean,
): Rates {
  let recipients = 0
  for (const s of sends.values()) if (include(s)) recipients += s.recipients
  let bounces = 0
  let complaints = 0
  for (const e of events) {
    const send = sends.get(e.sesMessageId)
    if (!send || !include(send)) continue
    if (e.kind === 'hard_bounce') bounces += e.recipients
    else complaints += e.recipients
  }
  return {
    recipients,
    bounces,
    complaints,
    bounceRate: recipients > 0 ? bounces / recipients : null,
    complaintRate: recipients > 0 ? complaints / recipients : null,
  }
}

type Judgement = { band: 'unjudged' | 'healthy' | 'watch' | 'held'; reasons: string[] }

/** Rates against the thresholds, each judged only on enough recipients (R2). */
function judge(r: Rates, bounceVolume: number, subject: string): Judgement {
  const T = REPUTATION_THRESHOLDS
  const bounceJudged = r.recipients >= bounceVolume && r.bounceRate !== null
  const complaintJudged = r.recipients >= REPUTATION_VOLUME.complaint && r.complaintRate !== null
  if (!bounceJudged && !complaintJudged) return { band: 'unjudged', reasons: [] }
  const reasons: string[] = []
  let band: Judgement['band'] = 'healthy'
  const raise = (to: 'watch' | 'held') => {
    if (to === 'held' || band === 'healthy') band = to
  }
  if (bounceJudged) {
    const b = r.bounceRate!
    if (b >= T.bounce.review) {
      raise('held')
      reasons.push(
        `${pct(b)} of ${subject} bounced (${r.bounces} of ${r.recipients}). Amazon reviews an account from ${pct(T.bounce.review)} and may pause it from ${pct(T.bounce.pause)}.`,
      )
    } else if (b >= T.bounce.watch) {
      raise('watch')
      reasons.push(
        `${pct(b)} of ${subject} bounced (${r.bounces} of ${r.recipients}). Amazon recommends staying below ${pct(T.bounce.watch)}.`,
      )
    }
  }
  if (complaintJudged) {
    const c = r.complaintRate!
    if (c >= T.complaint.review) {
      raise('held')
      reasons.push(
        `${pct(c)} of ${subject} was marked as spam (${r.complaints} of ${r.recipients}). Amazon reviews an account from ${pct(T.complaint.review)} and may pause it from ${pct(T.complaint.pause)}.`,
      )
    } else if (c >= T.complaint.watch) {
      raise('watch')
      reasons.push(
        `${pct(c)} of ${subject} was marked as spam (${r.complaints} of ${r.recipients}). Amazon reviews an account from ${pct(T.complaint.review)}.`,
      )
    }
  }
  return { band, reasons }
}

/** Amazon's own verdict as a band (null = nothing to add). */
function awsJudgement(
  aws: AwsReputation,
): { band: 'watch' | 'held' | 'paused'; reason: string } | null {
  if (!aws) return null
  if (aws.mode === 'own') {
    if (aws.enforcement === 'SHUTDOWN') {
      return {
        band: 'paused',
        reason:
          'Amazon SES paused sending for your account because of bounces or complaints. Check the SES console › Reputation.',
      }
    }
    if (!aws.sendingEnabled)
      return {
        band: 'paused',
        reason:
          'Sending is switched off for your Amazon SES account in this region. Turn it back on in the SES console.',
      }
    if (aws.enforcement === 'PROBATION') {
      return {
        band: 'held',
        reason:
          'Amazon SES put your account under review because of bounces or complaints. Sending is on hold here until Amazon lifts the review (SES console › Reputation).',
      }
    }
    return null
  }
  if (aws.sendingStatus === 'DISABLED') {
    return {
      band: 'paused',
      reason:
        'Sending is paused because too many mails bounced or were marked as spam. Contact support.',
    }
  }
  if (aws.sendingStatus === 'REINSTATED') {
    return {
      band: 'watch',
      reason:
        'Amazon has open findings about this company’s mail; sending was allowed again. Keep the next mail clean.',
    }
  }
  return null
}

const BAND_RANK: Record<ReputationBand, number> = {
  unjudged: 0,
  healthy: 1,
  watch: 2,
  held: 3,
  paused: 4,
}

/** The whole picture from the ledger window (R1) and Amazon's verdict (R3, R4). */
export function evaluateReputation(
  rows: LedgerRow[],
  aws: AwsReputation,
  opts: { tracking?: boolean } = {},
): ReputationState {
  const sends = new Map<string, LedgerRow>()
  const events: LedgerRow[] = []
  for (const r of rows) {
    if (r.kind === 'send') sends.set(r.sesMessageId, r)
    else events.push(r)
  }
  const rates = ratesOf(sends, events, () => true)
  const own = judge(rates, REPUTATION_VOLUME.bounce, 'your recent mail')
  const amazon = awsJudgement(aws)
  let band: ReputationBand = own.band
  const reasons = [...own.reasons]
  if (amazon) {
    if (BAND_RANK[amazon.band] > BAND_RANK[band]) band = amazon.band
    reasons.unshift(amazon.reason)
  }

  const slices: ReputationSlice[] = []
  const seen = new Set<string>()
  for (const s of sends.values()) {
    for (const [dimension, value] of [
      ['origin', s.origin],
      ['sender', s.sender],
      ['ref', s.ref],
    ] as [SliceDimension, string | null][]) {
      if (!value || seen.has(`${dimension}\u0000${value}`)) continue
      seen.add(`${dimension}\u0000${value}`)
      const r = ratesOf(sends, events, (x) => x[dimension] === value)
      const j = judge(r, REPUTATION_VOLUME.slice, sliceSubject(dimension, value))
      if (j.band === 'watch' || j.band === 'held')
        slices.push({ ...r, dimension, value, band: j.band, reasons: j.reasons })
    }
  }
  slices.sort((a, b) =>
    a.band === b.band ? (b.bounceRate ?? 0) - (a.bounceRate ?? 0) : a.band === 'held' ? -1 : 1,
  )

  return {
    band,
    sendingHeld: band === 'held' || band === 'paused',
    rates,
    reasons,
    aws,
    tracking: opts.tracking ?? true,
    slices,
  }
}

const ORIGIN_LABEL: Record<string, string> = { ...SOURCE_LABEL, webmail: 'Personal mail' }

function sliceSubject(dimension: SliceDimension, value: string): string {
  if (dimension === 'sender') return `the mail from ${value}`
  if (dimension === 'ref')
    return value.startsWith('flow:') ? 'this flow’s mail' : 'the mail sent with this API key'
  return `the ${(ORIGIN_LABEL[value] ?? value).toLowerCase()} mail`
}

/** A slice in a person's words ("Flow", "hello@acme.com", "API key"). */
export function sliceLabel(dimension: SliceDimension, value: string): string {
  if (dimension === 'sender') return value
  if (dimension === 'ref') return value.startsWith('flow:') ? 'Flow' : 'API key'
  return ORIGIN_LABEL[value] ?? value
}

function heldSliceMessage(dimension: SliceDimension, value: string, reason: string): string {
  const who =
    dimension === 'ref'
      ? value.startsWith('flow:')
        ? 'This flow’s mail is on hold'
        : 'Mail sent with this API key is on hold'
      : dimension === 'sender'
        ? `Mail from ${value} is on hold`
        : `${ORIGIN_LABEL[value] ?? value} is on hold`
  return `${who}: ${reason} Clean the list it goes to, then an admin resumes sending under Email › Setup › Reputation.`
}

/**
 * Why this mail may not go out now (R5), or null. System mail (sign-in codes,
 * invites) always goes; Amazon refuses it itself when it paused the account.
 */
export function reputationRefusal(state: ReputationState, send: SendSlice): string | null {
  if (send.origin === 'system') return null
  if (state.sendingHeld) {
    const why = state.reasons[0] ?? 'Your sender reputation is below Amazon’s criteria.'
    if (state.band === 'paused') return why
    return `Sending is on hold to protect your sender reputation: ${why} Clean the list it went to, then an admin resumes sending under Email › Setup › Reputation.`
  }
  // Most specific first: the flow or API key, then the sender, then the kind of mail.
  for (const dimension of ['ref', 'sender', 'origin'] as const) {
    const value = send[dimension]
    if (!value) continue
    const slice = state.slices.find(
      (s) => s.band === 'held' && s.dimension === dimension && s.value === value,
    )
    if (slice) return heldSliceMessage(dimension, value, slice.reasons[0] ?? '')
  }
  return null
}
