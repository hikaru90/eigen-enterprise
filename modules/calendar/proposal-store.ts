/**
 * Appointments found in mail (plan/calendar.md §7, K7; migration 0140): the
 * persistence seam (the DB store in production, the in-memory one in unit
 * tests). Who sees and decides what is ./proposals.ts's decision.
 */

export const PROPOSAL_STATES = ['open', 'accepted', 'dismissed'] as const
export type ProposalState = (typeof PROPOSAL_STATES)[number]

/** Someone outside the company the appointment is with (email lower case). */
export type ProposalGuest = { email: string; name: string | null }

export type ProposalRow = {
  id: string
  /** The mailbox holder. */
  memberId: string
  mailboxId: string
  /** The inbox mail it was found in. */
  messageId: string
  state: ProposalState
  title: string
  startsAt: Date
  endsAt: Date
  timeZone: string
  location: string | null
  /** How to join, as the mail says it (a link, a number). */
  call: string | null
  attendees: ProposalGuest[]
  /** The event made on accept. */
  eventId: string | null
  createdAt: Date
  decidedAt: Date | null
}

export type ProposalStore = {
  /** Files a proposal; false when the mail already has one (a retried scan). */
  insert(row: ProposalRow): Promise<boolean>
  get(id: string): Promise<ProposalRow | null>
  forMessage(messageId: string): Promise<ProposalRow | null>
  /** The member's open proposals, soonest first. */
  open(memberId: string): Promise<ProposalRow[]>
  /**
   * Moves an open proposal to accepted or dismissed (the claim: false when it
   * is no longer open, so two accepts never both run).
   */
  decide(id: string, state: Exclude<ProposalState, 'open'>, at: Date): Promise<boolean>
  /** Back to open (an accept whose event or invitation failed). */
  reopen(id: string): Promise<void>
  setEvent(id: string, eventId: string): Promise<void>
}

export function memoryProposalStore(): ProposalStore & { rows: Map<string, ProposalRow> } {
  const rows = new Map<string, ProposalRow>()
  const copy = (r: ProposalRow): ProposalRow => ({ ...r, attendees: r.attendees.map((g) => ({ ...g })) })
  return {
    rows,
    async insert(row) {
      if ([...rows.values()].some((r) => r.messageId === row.messageId)) return false
      rows.set(row.id, copy(row))
      return true
    },
    async get(id) {
      const r = rows.get(id)
      return r ? copy(r) : null
    },
    async forMessage(messageId) {
      const r = [...rows.values()].find((x) => x.messageId === messageId)
      return r ? copy(r) : null
    },
    async open(memberId) {
      return [...rows.values()]
        .filter((r) => r.memberId === memberId && r.state === 'open')
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .map(copy)
    },
    async decide(id, state, at) {
      const r = rows.get(id)
      if (!r || r.state !== 'open') return false
      rows.set(id, { ...r, state, decidedAt: at })
      return true
    },
    async reopen(id) {
      const r = rows.get(id)
      if (!r) throw new Error(`calendar proposal ${id} not found`)
      rows.set(id, { ...r, state: 'open', decidedAt: null, eventId: null })
    },
    async setEvent(id, eventId) {
      const r = rows.get(id)
      if (!r) throw new Error(`calendar proposal ${id} not found`)
      rows.set(id, { ...r, eventId })
    },
  }
}
