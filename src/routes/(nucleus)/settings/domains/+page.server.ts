import type { DomainsList, HostView } from '../../../../../modules/domains/view'
import type { Actions, PageServerLoad } from './$types'
import { fail } from '@sveltejs/kit'
import { decodeShows } from '$lib/domains/host-status'
import { mailNote } from '$lib/domains/rows'
import type { ErrorReport } from '$lib/errors/agent-report'
import { KernelError } from '$lib/kernel/errors'
import { requireCapability } from '$lib/server/auth/require-capability'
import { domainsFromEnv } from '$lib/server/domains/env'
import { registrantDefaults } from '$lib/server/domains/registrant-defaults'
import { HostTargetError, type TargetChange } from '$lib/server/domains/targets'
import { SubstrateError } from '$lib/server/ee/client'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { ownerRun } from '$lib/server/website/owner-run'
import { emailPlatform } from '../../../../../modules/email/platform/service'

/**
 * Settings › Domains (plan/domains-one-claim.md, "Settings › Domains (the one
 * place)"): the company's domains as `domains.list` shows them — each domain
 * with its hostnames, what each shows, email, DNS, claim and certificate, and
 * the records still to add. Domains are a global setting edited only here;
 * module pages show their address and link to it. Every change is a form
 * action that runs the domains registry tool as the signed-in person (no
 * UI-only actions); the answer is the tool's own sentence. Buy / connect stay
 * as before (plan/managed-domains.md). Owner and admins (`company.manage`).
 */

const REASON = 'Only the owner or an admin manages the company’s domains.'

/** code ↔ person: the tool's plain sentence; human-only refusals and bad input in plain words. */
function plainDomainsMessage(err: unknown): string {
  if (err instanceof HostTargetError || err instanceof SubstrateError) return err.message
  if (err instanceof KernelError) {
    if (err.code === 'permission_denied') return `Not done: ${err.message}.`
    if (err.code === 'invalid_input')
      return 'That is not a valid host name. Enter just the name, like www or shop (no https:// and no /).'
    if (err.code === 'approval_required') return 'This is waiting for your approval in the chat.'
    if (err.code === 'not_configured') return err.message
  }
  return 'Something went wrong while changing the domains. Try again; if it keeps happening, copy the agent instructions and give them to your agent.'
}

function logFailure(tool: string, err: unknown): void {
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
  console.error(
    `[settings/domains] ${tool} failed: ${err instanceof Error ? err.message : String(err)}${cause}`,
  )
}

export const load: PageServerLoad = async ({ locals }) => {
  const { user } = await requireCapability(locals, 'company.manage', REASON)
  const config = domainsFromEnv()
  let list: DomainsList | null = null
  let listError: ErrorReport | null = null
  try {
    list = await ownerRun<DomainsList>(user, 'domains.list', {})
  } catch (err) {
    logFailure('domains.list', err)
    listError = errorReport(err, {
      attempted: "Listing the company's domains (Settings › Domains)",
      tool: 'domains.list',
      input: {},
      plain: plainDomainsMessage,
    })
  }
  const mode = await emailPlatform().owlery.mode()
  const mailNotes: Record<string, string> = {}
  for (const d of list?.domains ?? []) {
    if (!d.bought || d.hosts.some((h) => h.email !== null)) continue
    const note = mailNote(d.bought.state, mode)
    if (note) mailNotes[d.name] = note
  }
  return {
    canBuy: config !== null,
    list,
    listError,
    mailNotes,
    registrant: config ? await registrantDefaults(user) : null,
  }
}

const field = (f: FormData, name: string) =>
  String(f.get(name) ?? '')
    .trim()
    .toLowerCase()

/** Runs one domains tool for a form action: the tool's answer, or the one error shape. */
async function run<T>(
  user: { id: string },
  action: string,
  tool: string,
  input: Record<string, unknown>,
  attempted: string,
): Promise<{ ok: true; out: T } | { ok: false; failure: ReturnType<typeof fail> }> {
  try {
    return { ok: true, out: await ownerRun<T>(user, tool, input) }
  } catch (err) {
    logFailure(tool, err)
    return {
      ok: false,
      failure: fail(400, {
        action,
        host: typeof input.host === 'string' ? input.host : null,
        ...errorReport(err, { attempted, tool, input, plain: plainDomainsMessage }),
      }),
    }
  }
}

function changed(action: string, out: TargetChange) {
  return {
    action,
    ok: true as const,
    host: out.host,
    message: out.message,
    reconcileError: out.reconcileError,
  }
}

function badTarget(action: string, host: string, value: string) {
  return fail(400, {
    action,
    host,
    ...refusalReport('Choose what this address shows.', {
      attempted: `Changing what ${host} shows (Settings › Domains)`,
      input: { host, shows: value },
      nextSteps: [
        'The form sent a "shows" value that is not console, site, nothing or app:<name> (decodeShows, src/lib/domains/host-status.ts); fix the picker.',
      ],
    }),
  })
}

export const actions: Actions = {
  /** "Shows" picker, after the confirmation that names what the host shows now. */
  setTarget: async ({ locals, request }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    const f = await request.formData()
    const host = field(f, 'host')
    const value = String(f.get('shows') ?? '')
    const shows = decodeShows(value)
    if (!shows) return badTarget('setTarget', host, value)
    const r = await run<TargetChange>(
      user,
      'setTarget',
      'domains.set_target',
      { host, shows },
      `Changing what ${host} shows (Settings › Domains)`,
    )
    return r.ok ? changed('setTarget', r.out) : r.failure
  },
  /** "Add a hostname": a name under this domain (empty = the domain itself) and what it shows. */
  addHost: async ({ locals, request }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    const f = await request.formData()
    const domain = field(f, 'domain')
    const label = field(f, 'label').replace(/\.$/, '')
    const host = label ? `${label}.${domain}` : domain
    const value = String(f.get('shows') ?? '')
    const shows = decodeShows(value)
    if (!shows) return badTarget('addHost', host, value)
    const r = await run<TargetChange>(
      user,
      'addHost',
      'domains.set_target',
      { host, shows },
      `Adding the hostname ${host} (Settings › Domains)`,
    )
    return r.ok ? changed('addHost', r.out) : r.failure
  },
  remove: async ({ locals, request }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    const host = field(await request.formData(), 'host')
    const r = await run<TargetChange>(
      user,
      'remove',
      'domains.remove',
      { host },
      `Removing ${host} from this server (Settings › Domains)`,
    )
    return r.ok ? changed('remove', r.out) : r.failure
  },
  /** "Check now" for a domain: every hostname under it looked up again, past the cache. */
  recheck: async ({ locals, request }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    const f = await request.formData()
    const domain = field(f, 'domain')
    const hosts = [...new Set(f.getAll('host').map((h) => String(h).trim().toLowerCase()))]
    const checked: HostView[] = []
    for (const host of hosts) {
      const r = await run<{ host: HostView }>(
        user,
        'recheck',
        'domains.recheck',
        { host },
        `Checking the DNS of ${host} again (Settings › Domains)`,
      )
      if (!r.ok) return r.failure
      checked.push(r.out.host)
    }
    const toFix = checked.flatMap((h) =>
      h.records.filter((x) => x.status === 'missing' || x.status === 'wrong'),
    ).length
    return {
      action: 'recheck',
      ok: true as const,
      host: domain,
      message:
        toFix === 0
          ? `Checked ${domain} again: every record is in place.`
          : `Checked ${domain} again: ${toFix} ${toFix === 1 ? 'record' : 'records'} still to add or fix.`,
      reconcileError: null,
    }
  },
  retryCertificate: async ({ locals, request }) => {
    const { user } = await requireCapability(locals, 'company.manage', REASON)
    const host = field(await request.formData(), 'host')
    const r = await run<{ host: string; reloaded: true }>(
      user,
      'retryCertificate',
      'domains.retry_certificate',
      { host },
      `Retrying the certificate of ${host} (Settings › Domains)`,
    )
    if (!r.ok) return r.failure
    return {
      action: 'retryCertificate',
      ok: true as const,
      host,
      message: `Asked for a new certificate for ${host}. It usually takes under a minute; check again then.`,
      reconcileError: null,
    }
  },
}
