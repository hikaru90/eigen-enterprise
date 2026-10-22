import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import {
  EeClient,
  SubstrateError,
  SubstrateUnavailableError,
  type EeStatus,
} from '$lib/server/ee/client'
import { requireHuman } from '$lib/server/ee/human'
import { WEBSITE_MODULE_ID } from '../manifest'
import { AppUserError } from './contract'
import { defaultServiceStore, type Service, type ServiceStore } from './store'

/**
 * Per-app domains (plan/phase-website-apps-ux.md D-W2): which host serves which
 * app is decided on the app, never in a central hosting tab. Both tools are
 * human-only (D11): the agent reads text an attacker can influence, so it never
 * rewrites the server's routing on the strength of it.
 *
 * ee facts these checks lean on: `removeDomain` takes only a host (no owner
 * check — hence the ownership checks here), and re-adding an existing host
 * MOVES it (ee strips the old route). The owner check below is what keeps a
 * host belonging to the console, the company site or another app from being
 * taken over by this app's change.
 */

/** ee's verbs the domain tools use; a seam so tests fake ee without a socket. */
export type DomainEe = Pick<EeClient, 'status' | 'addDomain' | 'removeDomain'>

export type DomainToolDeps = { ee?: DomainEe; services?: ServiceStore }

/** The same host schema the hosting tools use (modules/website/hosting/tools.ts). */
const HOST = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
    'a host name like shop.example.com',
  )

const NAME = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'app name: lowercase letters, digits, dashes (2–31)')

const domainSetInput = z
  .object({
    name: NAME,
    host: HOST,
    /** The app's current address this one replaces. */
    replace: HOST.optional(),
  })
  .strict()
const domainRemoveInput = z.object({ name: NAME, host: HOST }).strict()

/** ee failures in plain words; the original stays in the server log and as `cause`. */
async function viaEe<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof AppUserError) throw err
    if (err instanceof SubstrateUnavailableError)
      throw new AppUserError(
        "Changing an address needs the server's deploy agent (ee). This copy of Eigen Enterprise isn't running on a server set up with ee.",
        { cause: err },
      )
    if (err instanceof SubstrateError) {
      console.error(`[website/apps] ee could not ${what}: ${err.status} ${err.message}`)
      throw new AppUserError(
        `The server's deploy agent could not ${what}. Try again; if it keeps happening, ask in the chat.`,
        { cause: err },
      )
    }
    throw err
  }
}

/** The website_services row as the store takes it (createdBy keeps the original). */
function sourceOf(s: Service, host: string | null) {
  return {
    name: s.name,
    kind: s.kind,
    repoFullName: s.repoFullName,
    branch: s.branch,
    repoId: s.repoId,
    authKind: s.authKind,
    host,
    autoDeploy: s.autoDeploy,
    createdBy: s.createdBy,
  }
}

export function createDomainTools(deps: DomainToolDeps = {}): ToolDescriptor[] {
  const ee: DomainEe = deps.ee ?? new EeClient()
  const services = deps.services ?? defaultServiceStore()

  async function mustService(name: string): Promise<Service> {
    const s = await services.get(name)
    if (!s) throw new AppUserError(`There is no app called ${name}.`)
    return s
  }

  const domainsOf = (status: EeStatus, name: string) =>
    status.routes.filter((r) => r.workload === name).map((r) => r.host)

  /** Whose host is this? A plain name for the error — never a silent takeover. */
  function hostOwner(host: string, status: EeStatus): string {
    if (host === status.settings.consoleHost) return 'this console'
    if (host === status.settings.publicHost) return 'the company site'
    const route = status.routes.find((r) => r.host === host)
    if (route && route.workload !== 'os') return `the app ${route.workload}`
    return 'Eigen Enterprise itself'
  }

  return [
    {
      name: 'website.app_domain_set',
      module: WEBSITE_MODULE_ID,
      summary:
        'Point a host at an app (human only): adds it, or with `replace` moves the app off its old address. Refuses a host the console, the company site or another app already serves.',
      auditClass: 'mutate',
      approvalRisk: 'public',
      activity: (input: z.infer<typeof domainSetInput>) =>
        input.replace
          ? `Changed ${input.name}'s address from ${input.replace} to ${input.host}`
          : `Pointed ${input.host} at ${input.name}`,
      inputSchema: domainSetInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'website.app_domain_set')
        const i = domainSetInput.parse(input)
        const replace = i.replace
        const service = await mustService(i.name)
        const status = await viaEe('read the server status', () => ee.status())

        const existing = status.routes.find((r) => r.host === i.host)
        if (existing && existing.workload !== i.name) {
          throw new AppUserError(
            `${i.host} already serves ${hostOwner(i.host, status)}. Pick another address for ${i.name}.`,
          )
        }
        if (replace) {
          const old = status.routes.find((r) => r.host === replace)
          if (!old || old.workload !== i.name) {
            throw new AppUserError(
              `${replace} is not an address of ${i.name}, so it can't be replaced here.`,
            )
          }
        }
        // Keep the working route until its replacement has been accepted and applied.
        const added = await viaEe(`point ${i.host} at ${i.name}`, () =>
          ee.addDomain({ host: i.host, workload: i.name, role: 'app', author }),
        )
        if (added.reconcileError) {
          throw new AppUserError(
            `The server could not apply ${i.host}. ${replace ? 'The previous address remains in place. ' : ''}Check Website settings for the server error.`,
          )
        }
        if (replace && replace !== i.host) {
          const removed = await viaEe(`move ${replace} off ${i.name}`, () =>
            ee.removeDomain({ host: replace, author }),
          )
          if (removed.reconcileError) {
            throw new AppUserError(
              `The new address was added, but the server could not finish removing ${replace}. Check Website settings for the server error.`,
            )
          }
        }

        // website_services.host is the address the app links to: follow the
        // change when it replaced that address (or there was none yet).
        if (service.kind === 'web' && (service.host === null || service.host === replace)) {
          await services.upsert(sourceOf(service, i.host))
        }

        const after = await viaEe('read the server status', () => ee.status())
        return { host: i.host, domains: domainsOf(after, i.name) }
      },
    },
    {
      name: 'website.app_domain_remove',
      module: WEBSITE_MODULE_ID,
      summary:
        "Remove one of an app's hosts (human only). A web app keeps at least one address: change it instead of removing it.",
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: (input: z.infer<typeof domainRemoveInput>) =>
        `Removed ${input.host} from ${input.name}`,
      inputSchema: domainRemoveInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = requireHuman(ctx, 'website.app_domain_remove')
        const i = domainRemoveInput.parse(input)
        const service = await mustService(i.name)
        const status = await viaEe('read the server status', () => ee.status())

        const route = status.routes.find((r) => r.host === i.host)
        if (!route || route.workload !== i.name) {
          throw new AppUserError(
            `${i.host} is not an address of ${i.name}, so there is nothing to remove here.`,
          )
        }
        const domains = domainsOf(status, i.name)
        // The database requires a web service to keep a host
        // (website_services_web_has_host); the owner changes the address
        // instead of removing the last one.
        if (service.kind === 'web' && domains.length <= 1) {
          throw new AppUserError('A web app needs one address; change it instead of removing it')
        }

        await viaEe(`remove ${i.host}`, () => ee.removeDomain({ host: i.host, author }))

        if (service.host === i.host) {
          await services.upsert(sourceOf(service, domains.find((h) => h !== i.host) ?? null))
        }

        const after = await viaEe('read the server status', () => ee.status())
        return { host: i.host, domains: domainsOf(after, i.name) }
      },
    },
  ]
}
