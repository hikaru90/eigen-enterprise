import { describe, expect, it } from 'vitest'
import { defaultSchedule, renderBackupService, renderBackupTimer } from './timer.ts'

describe('nightly backup timer', () => {
  it('fires daily at the configured UTC minute, catches up after downtime, and runs `ee backup --scheduled`', () => {
    const t = renderBackupTimer({ hour: 3, minute: 7 })
    expect(t).toContain('OnCalendar=*-*-* 03:07:00 UTC')
    expect(t).toContain('Persistent=true')
    expect(t).toContain('WantedBy=timers.target')
    const s = renderBackupService('/opt/ee/runtimes/node-22/bin/node')
    expect(s).toContain('Type=oneshot')
    expect(s).toContain('ExecStart=/opt/ee/runtimes/node-22/bin/node /opt/ee/ee.mjs backup --scheduled')
  })
  it('the default schedule is 03:xx with a randomized minute', () => {
    const minutes = new Set(Array.from({ length: 50 }, () => defaultSchedule()).map((s) => (expect(s.hour).toBe(3), s.minute)))
    expect(minutes.size).toBeGreaterThan(5)
    for (const m of minutes) expect(m >= 0 && m < 60).toBe(true)
  })
})
