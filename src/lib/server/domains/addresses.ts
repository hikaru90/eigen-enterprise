import type { DomainsList } from '../../../../modules/domains/view'
import { hostReadiness, type Address, type Shows } from '$lib/domains/host-status'
import type { ErrorReport } from '$lib/errors/agent-report'
import { errorReport } from '$lib/server/errors/report'
import { ownerRun } from '$lib/server/website/owner-run'

/**
 * A module page's own addresses (plan/domains-one-claim.md: "module pages only
 * show and link"): the hostnames that show this thing, each with its status,
 * read from `domains.list` — the company website, an app, Email. Changing
 * them is Settings › Domains' job; this only reads.
 */

export type { Address }

export type Addresses = { addresses: Address[]; addressesError: ErrorReport | null }

export async function addressesShowing(
  user: { id: string },
  what: string,
  matches: (shows: Shows, host: string) => boolean,
): Promise<Addresses> {
  let list: DomainsList
  try {
    list = await ownerRun<DomainsList>(user, 'domains.list', {})
  } catch (err) {
    console.error(
      `[domains] reading the addresses of ${what} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return {
      addresses: [],
      addressesError: errorReport(err, {
        attempted: `Reading the addresses of ${what}`,
        tool: 'domains.list',
        input: {},
        plain: () =>
          'The addresses could not be read just now. Settings › Domains shows them with the reason.',
      }),
    }
  }
  const addresses = list.domains
    .flatMap((d) => d.hosts)
    .filter((h) => matches(h.shows, h.host))
    .map((h) => {
      const r = hostReadiness(h)
      return { host: h.host, label: r.label, on: r.tone === 'ok' }
    })
  // ee's status is the source of what a host shows: without it the list above is incomplete.
  const server = list.errors.find((e) => e.source === 'server') ?? null
  return {
    addresses,
    addressesError: server ? { error: server.error, agent: server.agent } : null,
  }
}
