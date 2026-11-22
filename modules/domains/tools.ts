import { z } from 'zod'
import { hostnameSchema } from '$lib/domains/hostname'
import type { ToolDescriptor } from '$lib/kernel/types'
import {
  HostTargetError,
  removeTarget,
  setTarget,
  type ShowsTarget,
  type TargetChange,
} from '$lib/server/domains/targets'
import {
  EeClient,
  SubstrateError,
  SubstrateUnavailableError,
  type EeStatus,
} from '$lib/server/ee/client'
import { requireHuman } from '$lib/server/ee/human'
import { cachedResolver, nodeResolver, observe, type CachedResolver } from './dns'
import { DOMAINS_MODULE_ID } from './manifest'
import {
  groupDomains,
  planHosts,
  type DomainsList,
  type HostView,
  type MailDomain,
  type PlannedHost,
} from './view'

/**
 * The domains module's hands (plan/domains-one-claim.md D2). Reads are open to
 * the agent; changing what a host shows, removing it and retrying its
 * certificate change the server, so they are a human's own act (D11,
 * requireHuman) — exactly the rule `substrate.*` keeps.
 */

export type DomainsEe = Pick<EeClient, 'status' | 'addDomain' | 'removeDomain' | 'retryCertificate'>

export type DomainsToolDeps = {
  ee?: DomainsEe
  /** The email platform's mail domains (wired by the composition root: modules never import each other). */
  mail: () => Promise<MailDomain[]>
  /** Names of the domains bought through eigenEnterprise; [] when this box has no domains service. */
  bought: () => Promise<string[]>
  resolver?: CachedResolver
}

/** One minute: "Check now" (domains.recheck) forgets a host's answers before that. */
const DNS_TTL_MS = 60_000
let sharedResolver: CachedResolver | null = null
const liveResolver = () => (sharedResolver ??= cachedResolver(nodeResolver(), DNS_TTL_MS, Date.now))

const WHERE = 'Settings › Domains'

const showsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('console') }).strict(),
  z.object({ kind: z.literal('site') }).strict(),
  z
    .object({
      kind: z.literal('app'),
      app: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'an app name'),
    })
    .strict(),
  z.object({ kind: z.literal('nothing') }).strict(),
])
const setTargetInput = z.object({ host: hostnameSchema, shows: showsSchema }).strict()
const hostInput = z.object({ host: hostnameSchema }).strict()

/** HostTargetError and ee failures as the plain sentence the person reads. */
async function plain<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof HostTargetError) throw err
    if (err instanceof SubstrateUnavailableError) {
      throw new HostTargetError(
        "This needs the server's deploy agent (ee). This copy of Eigen Enterprise isn't running on a server set up with ee.",
        { cause: err },
      )
    }
    if (err instanceof SubstrateError) {
      console.error(`[domains] ee could not ${what}: ${err.status} ${err.message}`)
      throw new HostTargetError(
        err.status < 500
          ? `The server did not ${what}: ${err.message}.`
          : `The server's deploy agent could not ${what}. Try again; if it keeps happening, ask in the chat.`,
        { cause: err },
      )
    }
    throw err
  }
}

export function createDomainsTools(deps: DomainsToolDeps): ToolDescriptor[] {
  const ee: DomainsEe = deps.ee ?? new EeClient()
  const resolver = () => deps.resolver ?? liveResolver()

  /** ee's status, or the explicit "not under ee" state (only that becomes managed:false). */
  async function eeStatus(): Promise<{ status: EeStatus | null; reason: string | null }> {
    try {
      return { status: await ee.status(), reason: null }
    } catch (err) {
      if (err instanceof SubstrateUnavailableError) return { status: null, reason: err.message }
      return plain('read the server status', () => Promise.reject(err))
    }
  }

  async function planned(): Promise<{
    hosts: PlannedHost[]
    managed: boolean
    reason: string | null
  }> {
    const [{ status, reason }, mail] = await Promise.all([eeStatus(), deps.mail()])
    return { hosts: planHosts({ status, mail }), managed: status !== null, reason }
  }

  const observed = async (h: PlannedHost): Promise<HostView> => {
    const { expected, ...rest } = h
    return { ...rest, records: await observe(expected, resolver()) }
  }

  return [
    {
      name: 'domains.list',
      module: DOMAINS_MODULE_ID,
      summary:
        "The company's domains: each domain (bought or connected) with its hostnames, what each shows (console, company website, an app, calls or nothing), its email use, the DNS records it needs with what live DNS returns (ok, missing, wrong, lookup_failed), its claim on a managed box and its certificate. managed:false when not running under ee.",
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['admin', 'agent'] },
      handler: async (): Promise<DomainsList> => {
        const [{ hosts, managed, reason }, bought] = await Promise.all([planned(), deps.bought()])
        const views = await Promise.all(hosts.map(observed))
        return { managed, reason, domains: groupDomains(views, bought) }
      },
    },
    {
      name: 'domains.set_target',
      module: DOMAINS_MODULE_ID,
      summary:
        'Set what a hostname shows on this server (human only): the console, the company website (site), an app, or nothing. The host switches from whatever it showed before; the answer says what that was.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof setTargetInput>, output: unknown) =>
        (output as TargetChange | undefined)?.message ?? `Changed what ${input.host} shows`,
      inputSchema: setTargetInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'domains.set_target', WHERE)
        const i = setTargetInput.parse(input)
        return setTarget(ee, { host: i.host, shows: i.shows as ShowsTarget, author })
      },
    },
    {
      name: 'domains.remove',
      module: DOMAINS_MODULE_ID,
      summary:
        'Take a hostname off this server (human only); the answer says what it no longer shows. The console and calls addresses cannot be removed.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof hostInput>, output: unknown) =>
        (output as TargetChange | undefined)?.message ?? `Removed ${input.host} from this server`,
      inputSchema: hostInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'domains.remove', WHERE)
        return removeTarget(ee, { host: hostInput.parse(input).host, author })
      },
    },
    {
      name: 'domains.recheck',
      module: DOMAINS_MODULE_ID,
      summary:
        'Look up a hostname\'s DNS records again now ("Check now"), past the one-minute cache; returns that host as domains.list shows it.',
      auditClass: 'read',
      inputSchema: hostInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input): Promise<{ host: HostView }> => {
        const { host } = hostInput.parse(input)
        const found = (await planned()).hosts.find((h) => h.host === host)
        if (!found) throw new HostTargetError(`${host} is not one of this company's hostnames.`)
        const r = resolver()
        for (const name of new Set([host, ...found.expected.map((e) => e.name)])) r.forget(name)
        return { host: await observed(found) }
      },
    },
    {
      name: 'domains.retry_certificate',
      module: DOMAINS_MODULE_ID,
      summary:
        "Ask the server to try a hostname's certificate again now (human only), ending a waiting period after a failed attempt.",
      auditClass: 'mutate',
      activity: (input: z.infer<typeof hostInput>) =>
        `Asked for a new certificate for ${input.host}`,
      inputSchema: hostInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'domains.retry_certificate', WHERE)
        const { host } = hostInput.parse(input)
        return plain(`retry the certificate of ${host}`, () => ee.retryCertificate(host, author))
      },
    },
  ]
}
