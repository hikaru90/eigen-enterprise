import type { HubContributionV1 } from './contract'
import type { OutboxEntry } from './store'
import type { ShareWorkerDeps } from './worker'
import { ContributeError } from '../errors'
import { parseId } from '../service'
import { payloadHash, toHubPayload } from './payload'
import { withdrawEverything } from './worker'

/**
 * What people see and decide about sharing (plan §4.3, §5): the owner's
 * Settings card (on/off, withdraw everything, where sending stands) and, on
 * the local board, each proposal's sharing state for the owner/admins with
 * "Show what was sent" and "Don't share".
 */

export type ShareDeps = ShareWorkerDeps & {
  /** Whether the company's AI provider is ready (the scrub runs on it). */
  providerReady: () => Promise<boolean>
}

/** Waiting · Shared · Not shared · Failed (reason). */
export const SHARE_ITEM_STATES = ['waiting', 'shared', 'not_shared', 'failed'] as const
export type ShareItemState = (typeof SHARE_ITEM_STATES)[number]

export type ShareItemView = {
  state: ShareItemState
  /** Why it failed, or why it is still waiting. */
  error: string | null
  /** Not shared, but the hub still has it until the queued DELETE goes through. */
  withdrawing: boolean
}

export function itemView(e: OutboxEntry | null | undefined): ShareItemView {
  if (!e) return { state: 'not_shared', error: null, withdrawing: false }
  switch (e.state) {
    case 'pending':
    case 'scrubbed':
      return { state: 'waiting', error: e.lastError, withdrawing: false }
    case 'sent':
      return { state: 'shared', error: null, withdrawing: false }
    case 'failed':
      return { state: 'failed', error: e.lastError, withdrawing: false }
    case 'excluded':
      return { state: 'not_shared', error: e.lastError, withdrawing: e.lastSentHash !== null }
  }
}

/** Each proposal's sharing state, for the board (owner/admins only — the caller decides). */
export async function sharingStates(d: Pick<ShareDeps, 'share'>, ids: readonly string[]): Promise<Record<string, ShareItemView>> {
  const entries = await d.share.entries(ids)
  return Object.fromEntries(ids.map((id) => [id, itemView(entries.get(id))]))
}

export type ShareStatusView = {
  enabled: boolean
  /** null when CONTRIBUTE_HUB_URL is set and valid; otherwise why nothing can be sent. */
  notConfigured: string | null
  revoked: { at: string; message: string | null } | null
  providerReady: boolean
  waiting: number
  sent: number
  failed: number
  withdrawing: number
  /** The newest problem: a proposal's last error, or the install's (registration, key). */
  lastError: { message: string; at: string } | null
}

export async function shareStatus(d: ShareDeps): Promise<ShareStatusView> {
  const [settings, counts, providerReady] = await Promise.all([d.share.settings(), d.share.counts(), d.providerReady()])
  const config = d.hub()
  const installError = settings.lastError && !settings.revokedAt ? { message: settings.lastError, at: settings.updatedAt } : null
  const newest = [installError, counts.lastError].filter((x) => x !== null).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null
  return {
    enabled: settings.enabled,
    notConfigured: config.ok ? null : config.message,
    revoked: settings.revokedAt ? { at: settings.revokedAt.toISOString(), message: settings.lastError } : null,
    providerReady,
    waiting: counts.waiting,
    sent: counts.sent,
    failed: counts.failed,
    withdrawing: counts.withdrawing,
    lastError: newest ? { message: newest.message, at: newest.at.toISOString() } : null,
  }
}

export type ShareOwner = { id: string; isOwner: boolean }

/**
 * Owner only. On: new proposals are shared from now on (no backfill of what
 * was proposed while it was off). Off: nothing more is sent; with `withdraw`
 * everything already sent is deleted from the central board — sharing is off
 * either way, and a failed deletion throws with the hub's reason.
 */
export async function setSharing(d: ShareDeps, actor: ShareOwner, input: { enabled: boolean; withdraw: boolean }): Promise<void> {
  if (!actor.isOwner) throw new ContributeError('forbidden', 'only the owner decides whether proposals are shared')
  if (input.enabled && input.withdraw) throw new ContributeError('invalid', 'withdraw goes with turning sharing off')
  await d.share.setEnabled(input.enabled, d.now())
  if (input.withdraw) {
    try {
      await withdrawEverything(d)
    } catch (err) {
      throw new ContributeError('upstream', `Sharing is off. ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export type BoardManager = { id: string; canManage: boolean }

const manager = (actor: BoardManager) => {
  if (!actor.canManage) throw new ContributeError('forbidden', 'only the owner and admins see and change sharing')
}

/** "Don't share": never sent, or withdrawn from the central board if it was. */
export async function dontShare(d: ShareDeps, actor: BoardManager, rawId: unknown): Promise<ShareItemView> {
  manager(actor)
  const id = parseId(rawId)
  if (!(await d.contributions.get(id))) throw new ContributeError('not_found', 'proposal not found')
  await d.share.exclude(id, d.now())
  return itemView(await d.share.entry(id))
}

export type SentView = {
  sharing: ShareItemView
  /** The payload for this proposal as built from its current state; null before the scrub. */
  payload: HubContributionV1 | null
  /** true: exactly what the central board has; false: what the next send carries. */
  isOnHub: boolean
  sentAt: string | null
}

/** "Show what was sent": the exact payload, never the title or a name. */
export async function sentPayload(d: ShareDeps, actor: BoardManager, rawId: unknown): Promise<SentView> {
  manager(actor)
  const id = parseId(rawId)
  const c = await d.contributions.get(id)
  if (!c) throw new ContributeError('not_found', 'proposal not found')
  const e = await d.share.entry(id)
  const payload = e?.summary && e.language ? toHubPayload(c, { summary: e.summary, language: e.language }, d.appVersion) : null
  return {
    sharing: itemView(e),
    payload,
    isOnHub: payload !== null && e?.lastSentHash === payloadHash(payload),
    sentAt: e?.sentAt ? e.sentAt.toISOString() : null,
  }
}
