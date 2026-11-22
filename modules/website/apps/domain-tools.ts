import { z } from 'zod'
import { hostnameSchema } from '$lib/domains/hostname'
import type { ToolDescriptor } from '$lib/kernel/types'
import {
  describeShows,
  HostTargetError,
  readStatus,
  removeTarget,
  sameShows,
  setTarget,
  showsOf,
  type Shows,
} from '$lib/server/domains/targets'
import { EeClient, type EeStatus } from '$lib/server/ee/client'
import { requireHuman } from '$lib/server/ee/human'
import { WEBSITE_MODULE_ID } from '../manifest'
import { AppUserError } from './contract'
import { defaultServiceStore, type Service, type ServiceStore } from './store'

/**
 * Per-app domains (plan/phase-website-apps-ux.md D-W2), now thin calls to the
 * domains module's one rule (plan/domains-one-claim.md D2,
 * `$lib/server/domains/targets`): pointing a host at an app switches it from
 * whatever it showed before — and says so. Both tools stay human-only (D11)
 * and keep their names so agents and the CLI keep working; Settings › Domains
 * (domains.set_target) is the place a person changes addresses.
 */

/** ee's verbs the domain tools use; a seam so tests fake ee without a socket. */
export type DomainEe = Pick<EeClient, 'status' | 'addDomain' | 'removeDomain'>

export type DomainToolDeps = { ee?: DomainEe; services?: ServiceStore }

const NAME = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'app name: lowercase letters, digits, dashes (2–31)')

const domainSetInput = z
  .object({
    name: NAME,
    host: hostnameSchema,
    /** The app's current address this one replaces. */
    replace: hostnameSchema.optional(),
  })
  .strict()
const domainRemoveInput = z.object({ name: NAME, host: hostnameSchema }).strict()

/** The shared rule's plain sentence as the app pages' error (plainAppMessage reads AppUserError). */
async function asAppError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof HostTargetError) throw new AppUserError(err.message, { cause: err })
    throw err
  }
}

export type AppDomainResult = {
  host: string
  domains: string[]
  /** What changed, in plain words ("x now shows the app shop instead of the company website."). */
  message: string
}

export function createDomainTools(deps: DomainToolDeps = {}): ToolDescriptor[] {
  const ee: DomainEe = deps.ee ?? new EeClient()
  const services = deps.services ?? defaultServiceStore()

  async function mustService(name: string): Promise<Service> {
    const s = await services.get(name)
    if (!s) throw new AppUserError(`There is no app called ${name}.`)
    return s
  }

  const status = () => asAppError(() => readStatus(ee))

  const domainsOf = (s: EeStatus, name: string) =>
    s.routes.filter((r) => r.workload === name).map((r) => r.host)

  return [
    {
      name: 'website.app_domain_set',
      module: WEBSITE_MODULE_ID,
      summary:
        'Point a host at an app (human only): adds it, or with `replace` moves the app off its old address. A host that showed something else (the company website, another app) switches to this app, and the answer says what it showed before. The console and calls addresses cannot be taken.',
      auditClass: 'mutate',
      approvalRisk: 'public',
      activity: (input: z.infer<typeof domainSetInput>, output: unknown) =>
        (output as AppDomainResult | undefined)?.message ??
        (input.replace
          ? `Changed ${input.name}'s address from ${input.replace} to ${input.host}`
          : `Pointed ${input.host} at ${input.name}`),
      inputSchema: domainSetInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input): Promise<AppDomainResult> => {
        const author = requireHuman(ctx, 'website.app_domain_set')
        const i = domainSetInput.parse(input)
        const replace = i.replace
        await mustService(i.name)
        const app: Shows = { kind: 'app', app: i.name }
        if (replace) {
          // Only the app's own address is replaced here — checked before anything changes.
          const old = showsOf(await status(), replace)
          if (!sameShows(old, app)) {
            throw new AppUserError(
              `${replace} is not an address of ${i.name} (it shows ${describeShows(old)}), so it can't be replaced here.`,
            )
          }
        }
        // Keep the working route until its replacement has been accepted and applied.
        const added = await asAppError(() => setTarget(ee, { host: i.host, shows: app, author }))
        if (added.reconcileError) {
          throw new AppUserError(
            `The server could not apply ${i.host}. ${replace ? 'The previous address remains in place. ' : ''}Check Website settings for the server error.`,
          )
        }
        let message = added.message
        if (replace && replace !== i.host) {
          const removed = await asAppError(() =>
            removeTarget(ee, { host: replace, author, expect: app }),
          )
          if (removed.reconcileError) {
            throw new AppUserError(
              `The new address was added, but the server could not finish removing ${replace}. Check Website settings for the server error.`,
            )
          }
          message = `${message} ${removed.message}`
        }
        return { host: i.host, domains: domainsOf(await status(), i.name), message }
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
      handler: async (ctx, input): Promise<AppDomainResult> => {
        const author = requireHuman(ctx, 'website.app_domain_remove')
        const i = domainRemoveInput.parse(input)
        const service = await mustService(i.name)
        const domains = domainsOf(await status(), i.name)
        // A web app without an address is unreachable: the owner changes it instead.
        if (service.kind === 'web' && domains.includes(i.host) && domains.length <= 1) {
          throw new AppUserError('A web app needs one address; change it instead of removing it')
        }
        const removed = await asAppError(() =>
          removeTarget(ee, { host: i.host, author, expect: { kind: 'app', app: i.name } }),
        )
        return {
          host: i.host,
          domains: domainsOf(await status(), i.name),
          message: removed.message,
        }
      },
    },
  ]
}
