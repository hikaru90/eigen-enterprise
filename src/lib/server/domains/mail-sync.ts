import { MAIL_READY_STATES, type BoughtDomain } from '$lib/domains/contract'

/**
 * Bought domains become mail domains (plan/managed-domains.md DM5): with
 * receiving on, in managed mode, once active. Runs on the job-queue tick. The
 * control plane already makes a bought domain a mail domain while it is
 * `configuring`; this pass only makes sure, and changes nothing when the
 * domain is one already (addBought is idempotent).
 */

export type BoughtDomainSyncDeps = {
  /** The company's domains at the control plane. */
  list: () => Promise<BoughtDomain[]>
  /** Which mail this box uses (only managed mode adds them). */
  mode: () => Promise<'own' | 'managed' | null>
  /** Adds the domain as a mail domain with receiving on; `added: false` when it already is one. */
  addBought: (name: string) => Promise<{ added: boolean }>
}

/** Returns the names it added this pass. */
export async function syncBoughtDomains(deps: BoughtDomainSyncDeps): Promise<string[]> {
  if ((await deps.mode()) !== 'managed') return []
  const added: string[] = []
  for (const d of await deps.list()) {
    if (!MAIL_READY_STATES.includes(d.state)) continue
    if ((await deps.addBought(d.name)).added) added.push(d.name)
  }
  return added
}
