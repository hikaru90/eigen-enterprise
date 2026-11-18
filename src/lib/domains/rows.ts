import { MAIL_READY_STATES, type BoughtDomain, type DomainState } from './contract'

/** A mail domain as Settings › Domains shows it. */
export type MailDomainSummary = { id: string; name: string; status: string; sendable: boolean; receiving: boolean }

/** One row of Settings › Domains: bought through eigenEnterprise, or connected from the company's own DNS. */
export type DomainRowView = {
  name: string
  source: 'bought' | 'connected'
  /** Bought only: the control plane's state, its error, renewal date and switch. */
  state: DomainState | null
  error: string | null
  renewsAt: string | null
  autoRenew: boolean | null
  /** The mail domain (sending and receiving), when it is one. */
  mail: MailDomainSummary | null
  /** Plain words when a bought domain isn't a mail domain (yet). */
  mailNote: string | null
}

/**
 * Settings › Domains: the bought domains first (as the control plane lists
 * them), then the mail domains the company connected from its own DNS.
 */
export function domainRows(
  bought: BoughtDomain[],
  mail: MailDomainSummary[],
  mode: 'own' | 'managed' | null,
): DomainRowView[] {
  const byName = new Map(mail.map((m) => [m.name, m]))
  const rows: DomainRowView[] = bought.map((b) => {
    const m = byName.get(b.name) ?? null
    return {
      name: b.name,
      source: 'bought',
      state: b.state,
      error: b.error,
      renewsAt: b.renewsAt,
      autoRenew: b.autoRenew,
      mail: m,
      mailNote: m ? null : mailNote(b.state, mode),
    }
  })
  const boughtNames = new Set(bought.map((b) => b.name))
  for (const m of mail) {
    if (boughtNames.has(m.name)) continue
    rows.push({ name: m.name, source: 'connected', state: null, error: null, renewsAt: null, autoRenew: null, mail: m, mailNote: null })
  }
  return rows
}

function mailNote(state: DomainState, mode: 'own' | 'managed' | null): string | null {
  if (state === 'failed') return null
  if (mode === 'own') return 'This server sends with your own Amazon SES. To send from this domain, add it under Email › Setup.'
  if (mode === null) return 'Email isn’t set up on this server yet.'
  return state === 'configuring' || MAIL_READY_STATES.includes(state) ? 'Becoming a mail domain (within a minute).' : null
}
