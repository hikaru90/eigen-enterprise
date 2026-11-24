import type { UpgradeInfo } from '$lib/server/ee/client'

/**
 * A failed update is the owner's to look at (plan/phase-upgrades.md §6.4 step 7): Overview →
 * Needs you shows how the newest update ended while it did not hold — refused, failed, or rolled
 * back to the release before — until a later update ends well.
 */

export type UpdateNotice = { kind: 'failed' | 'rolled-back'; text: string; href: '/settings/updates' }

const VERSION = /^eigenenterprise-(\d+\.\d+\.\d+)-/

export function updateNotice(info: UpgradeInfo): UpdateNotice | null {
  const o = info.lastOutcome
  if (!o || o.ok) return null
  const version = VERSION.exec(o.release)?.[1] ?? o.release
  const why = o.reason ?? 'no reason was recorded'
  return o.rolledBack
    ? { kind: 'rolled-back', text: `The update to ${version} was rolled back: ${why}`, href: '/settings/updates' }
    : { kind: 'failed', text: `The update to ${version} failed: ${why}`, href: '/settings/updates' }
}
