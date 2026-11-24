import { describe, expect, it } from 'vitest'
import type { UpgradeInfo, UpgradeOutcome } from '$lib/server/ee/client'
import { updateNotice } from './update-notice'

const info = (lastOutcome: UpgradeOutcome | null): UpgradeInfo => ({ installed: null, managed: false, source: null, job: null, lastOutcome })
const base: UpgradeOutcome = { release: 'eigenenterprise-0.5.41-aaaaaaaaaaaa', from: null, step: 'done', ok: true, reason: null, rolledBack: false }

describe('updateNotice (Overview → Needs you, the owner)', () => {
  it('nothing while the newest update held, or none was recorded', () => {
    expect(updateNotice(info(null))).toBeNull()
    expect(updateNotice(info(base))).toBeNull()
  })
  it('a rolled-back update says so, with why', () => {
    expect(updateNotice(info({ ...base, ok: false, step: 'rolling-back', rolledBack: true, reason: 'the job queue stalled' }))).toEqual({
      kind: 'rolled-back',
      text: 'The update to 0.5.41 was rolled back: the job queue stalled',
      href: '/settings/updates',
    })
  })
  it('a failed or refused update says why', () => {
    expect(updateNotice(info({ ...base, ok: false, step: 'backup', reason: 'upgrade stopped, nothing changed: the off-box backup failed: 403' }))).toEqual({
      kind: 'failed',
      text: 'The update to 0.5.41 failed: upgrade stopped, nothing changed: the off-box backup failed: 403',
      href: '/settings/updates',
    })
  })
})
