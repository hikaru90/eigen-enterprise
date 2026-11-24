import { describe, expect, it } from 'vitest'
import { boxWatchProbe, DEFAULT_WATCH, edgeCounts, judge, watch, type WatchSample } from './upgrade-watch.ts'

const healthy = (over: Partial<WatchSample> = {}): WatchSample => ({
  units: { 'ee-os-b.service': { active: 'active', restarts: 0 }, 'ee.service': { active: 'active', restarts: 1 } },
  edge: { total: 100, errors: 1 },
  queue: { overdue: 0, startedSince: 0 },
  ...over,
})
const L = { ...DEFAULT_WATCH, durationMs: 60_000, intervalMs: 10_000, queueStallMs: 30_000 }

describe('judge: what fails the watch', () => {
  it('a healthy core passes', () => {
    expect(judge(healthy(), healthy({ edge: { total: 400, errors: 5 } }), 20_000, L)).toBeNull()
  })
  it('a crash loop of the live os slot or of ee', () => {
    const now = healthy()
    now.units['ee-os-b.service'] = { active: 'active', restarts: 3 }
    expect(judge(healthy(), now, 10_000, L)).toBe('ee-os-b.service crash-looped (3 restarts since the cut-over)')
    const ee = healthy()
    ee.units['ee.service'] = { active: 'activating', restarts: 2 }
    expect(judge(healthy(), ee, 10_000, L)).toBe('ee.service is activating since the cut-over')
  })
  it('the edge 5xx rate over the threshold, once enough requests came in', () => {
    expect(judge(healthy(), healthy({ edge: { total: 110, errors: 9 } }), 10_000, L)).toBeNull() // 10 requests: too few to judge
    expect(judge(healthy(), healthy({ edge: { total: 140, errors: 11 } }), 10_000, L)).toBe('the edge answered 10 of 40 app requests with a 5xx since the cut-over (25%)')
  })
  it('counters that reset (Caddy restarted) count from zero', () => {
    expect(judge(healthy(), healthy({ edge: { total: 30, errors: 20 } }), 10_000, L)).toMatch(/20 of 30/)
  })
  it('a stalled job queue, only after the stall window', () => {
    const stalled = healthy({ queue: { overdue: 4, startedSince: 0 } })
    expect(judge(healthy(), stalled, 20_000, L)).toBeNull()
    expect(judge(healthy(), stalled, 30_000, L)).toBe('the job queue stalled: 4 job(s) overdue and none started since the cut-over')
    expect(judge(healthy(), healthy({ queue: { overdue: 4, startedSince: 2 } }), 30_000, L)).toBeNull()
  })
})

function clock() {
  let t = Date.parse('2026-11-24T10:00:00Z')
  return { now: () => new Date(t), sleep: async (ms: number) => void (t += ms) }
}

describe('watch', () => {
  it('holds for the whole window: null', async () => {
    let n = 0
    const why = await watch({ sample: async () => (n++, healthy()) }, L, clock())
    expect(why).toBeNull()
    expect(n).toBe(7) // the baseline + one sample every 10s for 60s
  })
  it('stops at the first failing sample with its reason', async () => {
    let n = 0
    const why = await watch({ sample: async () => (n++ === 2 ? healthy({ units: {} }) : healthy()) }, L, clock())
    expect(why).toBe('ee-os-b.service is gone')
    expect(n).toBe(3)
  })
  it('a probe that cannot read fails the watch (it cannot vouch for the release)', async () => {
    const why = await watch({ sample: async () => Promise.reject(new Error('psql: connection refused')) }, L, clock())
    expect(why).toBe('could not watch the new release: psql: connection refused')
  })
})

describe('edgeCounts: the app answers in Caddy metrics', () => {
  it('sums reverse_proxy counts on server ee, 5xx apart', () => {
    const m = [
      '# TYPE caddy_http_request_duration_seconds histogram',
      'caddy_http_request_duration_seconds_count{code="200",handler="reverse_proxy",method="GET",server="ee"} 90',
      'caddy_http_request_duration_seconds_count{code="502",handler="reverse_proxy",method="GET",server="ee"} 7',
      'caddy_http_request_duration_seconds_count{code="503",handler="reverse_proxy",method="POST",server="ee"} 3',
      'caddy_http_request_duration_seconds_count{code="500",handler="file_server",method="GET",server="ee"} 50',
      'caddy_http_request_duration_seconds_count{code="500",handler="reverse_proxy",method="GET",server="internal-os"} 50',
      'caddy_http_request_duration_seconds_sum{code="502",handler="reverse_proxy",method="GET",server="ee"} 1.5',
    ].join('\n')
    expect(edgeCounts(m)).toEqual({ total: 100, errors: 10 })
  })
})

describe('boxWatchProbe', () => {
  it('samples the one live os slot, ee, Caddy metrics and the job queue', async () => {
    const calls: string[] = []
    const probe = boxWatchProbe({
      run: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`)
        if (args[0] === 'is-active') return { code: 0, stdout: args[1] === 'ee-os-a.service' ? 'inactive\n' : 'active\n', stderr: '' }
        if (args[0] === 'show') return { code: 0, stdout: '0\n', stderr: '' }
        if (cmd === 'curl') return { code: 0, stdout: 'caddy_http_request_duration_seconds_count{code="200",handler="reverse_proxy",server="ee"} 5\n', stderr: '' }
        return { code: 0, stdout: '2 1\n', stderr: '' }
      },
    })
    expect(await probe.sample('2026-11-24T10:00:00.000Z')).toEqual({
      units: { 'ee-os-b.service': { active: 'active', restarts: 0 }, 'ee.service': { active: 'active', restarts: 0 } },
      edge: { total: 5, errors: 0 },
      queue: { overdue: 2, startedSince: 1 },
    })
    expect(calls.find((c) => c.startsWith('runuser'))).toContain("started_at >= '2026-11-24T10:00:00.000Z'::timestamptz")
  })
  it('refuses to guess with no or two live os slots', async () => {
    const probe = boxWatchProbe({ run: async () => ({ code: 0, stdout: 'active\n', stderr: '' }) })
    await expect(probe.sample('2026-11-24T10:00:00.000Z')).rejects.toThrow(/expected one live os slot after the cut-over, found 2/)
  })
})
