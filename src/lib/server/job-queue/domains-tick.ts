/**
 * Managed domains on the global job-queue tick (plan/managed-domains.md DM5):
 * a domain the company bought becomes a mail domain with receiving on. Only on
 * boxes with EE_DOMAINS_* (managed boxes). A failure is logged loudly and
 * never stops the rest of the tick; the next pass retries.
 */
export async function tickManagedDomains(): Promise<void> {
  try {
    const { domainsFromEnv } = await import('$lib/server/domains/env')
    const config = domainsFromEnv()
    if (!config) return
    const [{ domainsClient }, { syncBoughtDomains }, { emailPlatform }] = await Promise.all([
      import('$lib/server/domains/client'),
      import('$lib/server/domains/mail-sync'),
      import('../../../../modules/email/platform/service'),
    ])
    const platform = emailPlatform()
    const added = await syncBoughtDomains({
      list: () => domainsClient(config).list(),
      mode: () => platform.owlery.mode(),
      addBought: (name) => platform.addBoughtDomain(name),
    })
    if (added.length > 0) console.info('[domains] bought domains added as mail domains', { added })
  } catch (err) {
    console.error('[domains] background tick failed', { message: err instanceof Error ? err.message : String(err) })
  }
}
