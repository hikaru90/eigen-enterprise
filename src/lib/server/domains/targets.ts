import {
  SubstrateError,
  SubstrateUnavailableError,
  type EeClient,
  type EeStatus,
} from '$lib/server/ee/client'

/**
 * What a hostname shows on the company's server (plan/domains-one-claim.md,
 * "The model"; owner 2026-11-22): the console, the company website, an app,
 * calls, or nothing. The company owns its domains, so switching what a host
 * shows is an ordinary change — never a "conflict", never silent: every change
 * says what the host showed before.
 *
 * This is the domains module's rule, kept at kernel level because modules never
 * import each other: `domains.set_target` / `domains.remove`, the company
 * website page, `website.app_domain_set` / `_remove` and `website.app_deploy`
 * all go through these functions. ee stays the store (its company repo is
 * Caddy's source); nothing here copies it.
 */

export type Shows =
  | { kind: 'console' }
  | { kind: 'site' }
  | { kind: 'app'; app: string }
  | { kind: 'calls' }
  | { kind: 'nothing' }

/** What a person can point a host at (calls follows the console host; ee derives it). */
export type ShowsTarget = Exclude<Shows, { kind: 'calls' }>

/** ee's calls workload (ee/src/livekit.ts LIVEKIT_WORKLOAD). */
export const CALLS_WORKLOAD = 'livekit'

/** A plain sentence for the person (and for the agent to relay); detail stays in `cause`. */
export class HostTargetError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HostTargetError'
  }
}

export type TargetsEe = Pick<EeClient, 'status' | 'addDomain' | 'removeDomain'>

type HostState = Pick<EeStatus, 'settings' | 'routes'>

/** What ee serves on a host, read from its settings and routes (structure, never guessed). */
export function showsOf(status: HostState, host: string): Shows {
  const s = status.settings
  if (host === s.consoleHost) return { kind: 'console' }
  if (s.callsHost && host === s.callsHost) return { kind: 'calls' }
  if (s.publicHost && host === s.publicHost) return { kind: 'site' }
  const route = status.routes.find((r) => r.host === host)
  if (!route) return { kind: 'nothing' }
  if (route.workload === CALLS_WORKLOAD) return { kind: 'calls' }
  if (route.workload === 'os') {
    // ee gives eigenEnterprise only the console and the public host (ee/src/domains.ts).
    throw new Error(
      `ee routes ${host} to eigenEnterprise, but it is neither the console host nor the public website host`,
    )
  }
  return { kind: 'app', app: route.workload }
}

/** In words: "the console", "the company website", "the app shop", "calls", "nothing". */
export function describeShows(s: Shows): string {
  switch (s.kind) {
    case 'console':
      return 'the console'
    case 'site':
      return 'the company website'
    case 'app':
      return `the app ${s.app}`
    case 'calls':
      return 'calls'
    case 'nothing':
      return 'nothing'
  }
}

export function sameShows(a: Shows, b: Shows): boolean {
  return a.kind === b.kind && (a.kind !== 'app' || (b.kind === 'app' && a.app === b.app))
}

export type TargetChange = {
  host: string
  /** What the host shows now. */
  shows: Shows
  /** What it showed before this change. */
  before: Shows
  /** The workload ee says it replaced on this host (POST /v1/domains `replaced`); null otherwise. */
  replaced: string | null
  /** The site or console moved here: the host that stopped showing it; null otherwise. */
  moved: string | null
  /** ee accepted the change but could not apply it yet. */
  reconcileError: string | null
  /** False when the host already showed the target (no ee call was made). */
  changed: boolean
  /** One plain sentence: "eigenenterprise.app now shows the app shop instead of the company website." */
  message: string
}

function changeSentence(host: string, shows: Shows, before: Shows, moved: string | null): string {
  if (shows.kind === 'nothing') return `${host} no longer shows ${describeShows(before)}.`
  const instead = before.kind === 'nothing' ? '' : ` instead of ${describeShows(before)}`
  const away = moved ? ` ${moved} no longer shows it.` : ''
  return `${host} now shows ${describeShows(shows)}${instead}.${away}`
}

/**
 * The checks a change must pass before anything is touched (a deploy runs them
 * before it builds): what the host shows now, and the host the site or console
 * moves away from. Throws HostTargetError for what ee cannot do.
 */
export function planTarget(
  status: HostState,
  host: string,
  shows: ShowsTarget,
): { before: Shows; moved: string | null } {
  const before = showsOf(status, host)
  if (sameShows(before, shows)) return { before, moved: null }
  if (before.kind === 'console') {
    throw new HostTargetError(
      `${host} shows the console. Give the console another address first, then ${host} can show something else.`,
    )
  }
  if (before.kind === 'calls') {
    throw new HostTargetError(
      `${host} is the calls address: it follows the console address and cannot show anything else.`,
    )
  }
  if (shows.kind === 'nothing') return { before, moved: null }
  const s = status.settings
  const moved =
    shows.kind === 'site'
      ? s.publicHost && s.publicHost !== host
        ? s.publicHost
        : null
      : shows.kind === 'console'
        ? s.consoleHost
        : null
  return { before, moved }
}

/** ee failures in plain words; the original stays in the server log and as `cause`. */
async function viaEe<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) {
      throw new HostTargetError(
        "Changing an address needs the server's deploy agent (ee). This copy of Eigen Enterprise isn't running on a server set up with ee.",
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

/** ee's status, its failures in the same plain words as a change. */
export function readStatus(ee: Pick<EeClient, 'status'>): Promise<EeStatus> {
  return viaEe('read the server status', () => ee.status())
}

const roleOf = (shows: Exclude<ShowsTarget, { kind: 'nothing' }>) =>
  shows.kind === 'console' ? 'console' : shows.kind === 'site' ? 'public' : 'app'

/** Point a host at what it should show (or at nothing). Returns what changed, in words. */
export async function setTarget(
  ee: TargetsEe,
  i: { host: string; shows: ShowsTarget; author: string },
): Promise<TargetChange> {
  const status = await readStatus(ee)
  const { before, moved } = planTarget(status, i.host, i.shows)
  if (sameShows(before, i.shows)) {
    return {
      host: i.host,
      shows: before,
      before,
      replaced: null,
      moved: null,
      reconcileError: null,
      changed: false,
      message: `${i.host} already shows ${describeShows(before)}.`,
    }
  }
  if (i.shows.kind === 'nothing') return remove(ee, i.host, before, i.author)
  const shows = i.shows
  const out = await viaEe(`point ${i.host} at ${describeShows(shows)}`, () =>
    ee.addDomain({
      host: i.host,
      workload: shows.kind === 'app' ? shows.app : 'os',
      role: roleOf(shows),
      author: i.author,
    }),
  )
  return {
    host: i.host,
    shows,
    before,
    replaced: out.replaced,
    moved,
    reconcileError: out.reconcileError,
    changed: true,
    message: changeSentence(i.host, shows, before, moved),
  }
}

/**
 * Take a host off the server. With `expect`, only when the host shows exactly
 * that (an app removes only its own address).
 */
export async function removeTarget(
  ee: TargetsEe,
  i: { host: string; author: string; expect?: Shows },
): Promise<TargetChange> {
  const status = await readStatus(ee)
  const before = showsOf(status, i.host)
  if (i.expect && !sameShows(before, i.expect)) {
    throw new HostTargetError(
      `${i.host} shows ${describeShows(before)}, not ${describeShows(i.expect)}, so it is not removed here.`,
    )
  }
  if (before.kind === 'nothing') {
    throw new HostTargetError(`${i.host} shows nothing on this server; there is nothing to remove.`)
  }
  planTarget(status, i.host, { kind: 'nothing' })
  return remove(ee, i.host, before, i.author)
}

async function remove(
  ee: TargetsEe,
  host: string,
  before: Shows,
  author: string,
): Promise<TargetChange> {
  const out = await viaEe(`remove ${host}`, () => ee.removeDomain({ host, author }))
  const shows: Shows = { kind: 'nothing' }
  return {
    host,
    shows,
    before,
    replaced: null,
    moved: null,
    reconcileError: out.reconcileError,
    changed: true,
    message: changeSentence(host, shows, before, null),
  }
}
