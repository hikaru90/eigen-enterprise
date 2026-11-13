import type { ContributeStore } from '../store'
import type { HubConfig, HubResponse, HubTransport } from './hub'
import type { InstallKey, InstallKeyStore } from './identity'
import type { ScrubResult } from './scrub'
import type { OutboxEntry, ShareSettings, ShareStore } from './store'
import { isLlmNotConfiguredError } from '$lib/server/llm/errors'
import { HUB_PATHS, hubRegisterV1 } from './contract'
import { classifyHub, hubError, networkError, signedRequest } from './hub'
import { generateInstallKey } from './identity'
import { payloadBody, payloadHash, toHubPayload } from './payload'
import { ScrubFailedError } from './scrub'

/**
 * The sharing worker on the global job-queue tick (plan §5): claims due
 * outbox rows (SKIP LOCKED, 20 at a time), scrubs the pending ones on the
 * company's AI provider, and PUTs the signed payload — only when its hash
 * changed since the last send. Excluded rows still on the hub get their
 * DELETE. Network/5xx/429 back off 1 min doubling to 6 h with no attempt
 * limit (offline boxes catch up); other refusals are `failed`, not retried;
 * 401/403 means the hub refused this install: revoked, visible in Settings,
 * nothing more is sent. A failure here never touches a local proposal.
 */

export const SHARE_BATCH = 20
export const SHARE_LEASE_MS = 5 * 60_000
export const BACKOFF_BASE_MS = 60_000
export const BACKOFF_CAP_MS = 6 * 60 * 60_000

export const NO_PROVIDER_MESSAGE = 'No AI provider: the owner connects one under Settings → AI provider, then waiting proposals are shared.'
export const REVOKED_MESSAGE = 'The central board refused this install (HTTP {status}). Nothing more is sent.'

/** Delay before the n-th retry (n ≥ 1): 1 min, 2, 4 … capped at 6 h. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS)
}

export type ShareWorkerDeps = {
  share: ShareStore
  contributions: Pick<ContributeStore, 'get'>
  keys: InstallKeyStore
  hub: () => HubConfig
  transport: (origin: string) => HubTransport
  /** The scrub on the company's AI provider (scrub.ts behind the gateway). */
  scrub: (title: string) => Promise<ScrubResult>
  appVersion: string
  now: () => Date
  newKey?: () => InstallKey
}

export type ShareTickResult = {
  skipped: 'off' | 'revoked' | 'not_configured' | 'nothing_due' | 'not_registered' | null
  claimed: number
  sent: number
  unchanged: number
  withdrawn: number
  retried: number
  failed: number
}

const empty = (skipped: ShareTickResult['skipped']): ShareTickResult => ({ skipped, claimed: 0, sent: 0, unchanged: 0, withdrawn: 0, retried: 0, failed: 0 })

const revokedMessage = (status: number) => REVOKED_MESSAGE.replace('{status}', String(status))

/** Thrown when the install's identity is inconsistent (fail loud, never re-made silently). */
export class ShareIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShareIdentityError'
  }
}

/** The install's key, made (and its id stored) on first use. */
export async function installKey(d: Pick<ShareWorkerDeps, 'share' | 'keys' | 'now' | 'newKey'>, settings: ShareSettings): Promise<InstallKey> {
  let key = await d.keys.load()
  if (!key) {
    if (settings.installId) {
      throw new ShareIdentityError(
        `This install is registered as ${settings.installId} but its signing key is missing from the server's key directory; sharing stops until it is restored.`,
      )
    }
    key = (d.newKey ?? generateInstallKey)()
    await d.keys.save(key)
  }
  if (settings.installId && settings.installId !== key.installId) {
    throw new ShareIdentityError(`The stored install id ${settings.installId} does not match the server's signing key (${key.installId}).`)
  }
  if (!settings.installId) await d.share.setInstallId(key.installId, d.now())
  return key
}

/** Register with the hub when not yet registered. Returns the key, or null when sending must wait (the reason is stored). */
async function ensureRegistered(d: ShareWorkerDeps, settings: ShareSettings, hub: HubTransport): Promise<InstallKey | null> {
  let key: InstallKey
  try {
    key = await installKey(d, settings)
  } catch (err) {
    await d.share.setLastError(err instanceof Error ? err.message : String(err), d.now())
    return null
  }
  if (settings.registeredAt) return key
  const at = d.now()
  const body = JSON.stringify(hubRegisterV1.parse({ v: 1, install_id: key.installId, public_key: key.publicKey, app_version: d.appVersion }))
  let res: HubResponse
  try {
    res = await hub(signedRequest(key, 'POST', HUB_PATHS.register, body, at))
  } catch (err) {
    await d.share.setLastError(networkError(err), at)
    return null
  }
  const outcome = classifyHub(res.status)
  if (outcome === 'ok') {
    await d.share.setRegistered(at, at)
    return key
  }
  if (outcome === 'revoked') await d.share.setRevoked(at, revokedMessage(res.status))
  else await d.share.setLastError(`Registering with the central board failed. ${hubError(res)}`, at)
  return null
}

type RowResult = 'sent' | 'unchanged' | 'withdrawn' | 'retried' | 'failed' | 'revoked' | 'gone'

export async function runShareTick(d: ShareWorkerDeps): Promise<ShareTickResult> {
  const settings = await d.share.settings()
  if (!settings.enabled) return empty('off')
  if (settings.revokedAt) return empty('revoked')
  const config = d.hub()
  if (!config.ok) return empty('not_configured')
  if (!(await d.share.hasDue(d.now()))) return empty('nothing_due')
  const hub = d.transport(config.url)
  const key = await ensureRegistered(d, settings, hub)
  if (!key) return empty((await d.share.settings()).revokedAt ? 'revoked' : 'not_registered')

  const now = d.now()
  const rows = await d.share.claimDue(now, SHARE_BATCH, new Date(now.getTime() + SHARE_LEASE_MS))
  const out = empty(null)
  out.claimed = rows.length
  for (const row of rows) {
    const r = await processRow(d, hub, key, row)
    if (r === 'revoked') break
    if (r !== 'gone') out[r]++
  }
  return out
}

async function retry(d: ShareWorkerDeps, row: OutboxEntry, error: string): Promise<'retried'> {
  const attempts = row.attempts + 1
  const at = d.now()
  await d.share.markRetry(row.contributionId, error, attempts, new Date(at.getTime() + backoffMs(attempts)), at)
  return 'retried'
}

async function processRow(d: ShareWorkerDeps, hub: HubTransport, key: InstallKey, row: OutboxEntry): Promise<RowResult> {
  const id = row.contributionId
  const c = await d.contributions.get(id)
  if (!c) return 'gone'

  if (row.state === 'excluded') {
    let res: HubResponse
    try {
      res = await hub(signedRequest(key, 'DELETE', HUB_PATHS.contribution(id), '', d.now()))
    } catch (err) {
      return retry(d, row, networkError(err))
    }
    const outcome = res.status === 404 ? 'ok' : classifyHub(res.status)
    if (outcome === 'ok') {
      await d.share.markWithdrawn(id, d.now())
      return 'withdrawn'
    }
    if (outcome === 'revoked') {
      await d.share.setRevoked(d.now(), revokedMessage(res.status))
      return 'revoked'
    }
    // Still on the hub: keep trying (a refusal at the 6 h cap), never claim it is gone.
    if (outcome === 'refused') {
      const at = d.now()
      await d.share.markRetry(id, `Withdrawing failed. ${hubError(res)}`, row.attempts + 1, new Date(at.getTime() + BACKOFF_CAP_MS), at)
      return 'retried'
    }
    return retry(d, row, hubError(res))
  }

  let scrubbed = row.summary && row.language ? { summary: row.summary, language: row.language } : null
  if (!scrubbed) {
    try {
      const s = await d.scrub(c.title)
      scrubbed = { summary: s.summary, language: s.language }
    } catch (err) {
      if (isLlmNotConfiguredError(err)) return retry(d, row, NO_PROVIDER_MESSAGE)
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof ScrubFailedError) {
        await d.share.markFailed(id, message, d.now())
        return 'failed'
      }
      return retry(d, row, `The scrub failed: ${message}`.slice(0, 400))
    }
    await d.share.saveScrub(id, scrubbed)
  }

  let payload
  try {
    payload = toHubPayload(c, scrubbed, d.appVersion)
  } catch (err) {
    await d.share.markFailed(id, `The payload broke the contract: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400), d.now())
    return 'failed'
  }
  const hash = payloadHash(payload)
  if (hash === row.lastSentHash) {
    await d.share.markSent(id, hash, d.now(), row.updatedAt)
    return 'unchanged'
  }
  let res: HubResponse
  try {
    res = await hub(signedRequest(key, 'PUT', HUB_PATHS.contribution(id), payloadBody(payload), d.now()))
  } catch (err) {
    return retry(d, row, networkError(err))
  }
  const outcome = classifyHub(res.status)
  if (outcome === 'ok') {
    await d.share.markSent(id, hash, d.now(), row.updatedAt)
    return 'sent'
  }
  if (outcome === 'revoked') {
    await d.share.setRevoked(d.now(), revokedMessage(res.status))
    return 'revoked'
  }
  if (outcome === 'retry') return retry(d, row, hubError(res))
  await d.share.markFailed(id, hubError(res), d.now())
  return 'failed'
}

/**
 * Turning sharing off with "delete it from the central board": DELETE the
 * whole install, then every row is excluded and the install registers again
 * if sharing is switched back on. Throws with the reason when the hub could
 * not be reached or refused (nothing local changes then).
 */
export async function withdrawEverything(d: ShareWorkerDeps): Promise<void> {
  const settings = await d.share.settings()
  const at = d.now()
  if (!settings.installId || !settings.registeredAt) {
    await d.share.withdrawAll(at)
    return
  }
  const config = d.hub()
  if (!config.ok) throw new Error(config.message)
  const key = await installKey(d, settings)
  let res: HubResponse
  try {
    res = await d.transport(config.url)(signedRequest(key, 'DELETE', HUB_PATHS.install(key.installId), '', at))
  } catch (err) {
    throw new Error(networkError(err), { cause: err })
  }
  if (res.status === 404 || classifyHub(res.status) === 'ok') {
    await d.share.withdrawAll(at)
    await d.share.setRegistered(null, at)
    return
  }
  if (classifyHub(res.status) === 'revoked') await d.share.setRevoked(at, revokedMessage(res.status))
  throw new Error(`Deleting from the central board failed. ${hubError(res)}`)
}
