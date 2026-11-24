import { describe, expect, it } from 'vitest'
import {
  formatReport,
  pickPreviousRelease,
  planRehearsal,
  preStartForRehearsal,
  rehearsalDatabaseName,
  rehearsalDatabaseUrl,
  runSteps,
  smokeFailures,
  smokeRegressions,
} from './upgrade-rehearsal-lib.mjs'

describe('pickPreviousRelease (the newest stable v* tag behind HEAD)', () => {
  it('picks the highest version by semver, not by how git lists the tags', () => {
    expect(pickPreviousRelease({ merged: ['v0.5.9', 'v0.5.38', 'v0.5.10'], atHead: [] })).toBe(
      'v0.5.38',
    )
  })

  it('skips a tag on HEAD itself: when a tag is pushed, the release before it is the previous one', () => {
    expect(pickPreviousRelease({ merged: ['v0.5.38', 'v0.5.39'], atHead: ['v0.5.39'] })).toBe(
      'v0.5.38',
    )
  })

  it('ignores pre-releases and anything that is not vMAJOR.MINOR.PATCH', () => {
    expect(
      pickPreviousRelease({
        merged: ['v0.6.0-rc.1', 'v0.5.2', 'vnext', 'release-1', 'v0.5'],
        atHead: [],
      }),
    ).toBe('v0.5.2')
  })

  it('fails loud when HEAD has no released ancestor', () => {
    expect(() => pickPreviousRelease({ merged: ['v0.6.0-rc.1'], atHead: [] })).toThrow(
      /no stable v\* release tag is an ancestor of HEAD/,
    )
  })
})

describe('rehearsal database', () => {
  it('a unique plain name per run', () => {
    const a = rehearsalDatabaseName({ now: new Date('2026-11-24T10:00:00Z'), random: 'ab12cd' })
    expect(a).toMatch(/^ee_rehearsal_[a-z0-9_]+$/)
    expect(a).not.toBe(
      rehearsalDatabaseName({ now: new Date('2026-11-24T10:00:00Z'), random: 'ff00ee' }),
    )
  })

  it('points the test DB URL at the throwaway database', () => {
    expect(
      rehearsalDatabaseUrl('postgres://eigen:eigen@localhost:5433/eigen', 'ee_rehearsal_x'),
    ).toBe('postgres://eigen:eigen@localhost:5433/ee_rehearsal_x')
  })

  it('refuses anything but the local test Postgres (it creates and drops databases)', () => {
    expect(() =>
      rehearsalDatabaseUrl('postgres://u:p@db.example.com:5432/os', 'ee_rehearsal_x'),
    ).toThrow(/local test Postgres/)
    expect(() => rehearsalDatabaseUrl('', 'ee_rehearsal_x')).toThrow(/DATABASE_URL/)
    expect(() => rehearsalDatabaseUrl('postgres://u:p@localhost:5433/eigen', 'x; drop')).toThrow(
      /plain database name/,
    )
  })
})

describe('preStartForRehearsal (what a box runs before green starts)', () => {
  const eeJson = {
    preStart: [
      ['node', 'scripts/ensure-extensions.mjs'],
      ['node', 'scripts/migrate.mjs'],
      ['node', 'scripts/bootstrap-production-ops.mjs'],
    ],
  }

  it("runs the release's own preStart, minus the production-only ops bootstrap", () => {
    expect(preStartForRehearsal(eeJson)).toEqual({
      run: ['scripts/ensure-extensions.mjs', 'scripts/migrate.mjs'],
      skipped: ['scripts/bootstrap-production-ops.mjs'],
    })
  })

  it('refuses a preStart it cannot read, rather than guessing', () => {
    expect(() => preStartForRehearsal({})).toThrow(/preStart/)
    expect(() => preStartForRehearsal({ preStart: [['bash', 'x.sh']] })).toThrow(/node scripts/)
    expect(() =>
      preStartForRehearsal({ preStart: [['node', 'scripts/ensure-extensions.mjs']] }),
    ).toThrow(/migrate\.mjs/)
  })
})

describe('runSteps (fail fast, always clean up)', () => {
  it('runs every step in order and reports each green', async () => {
    const order: string[] = []
    const report = await runSteps(
      [
        { name: 'one', run: async () => (order.push('one'), 'first') },
        { name: 'two', run: async () => (order.push('two'), undefined) },
      ],
      { cleanup: async () => (order.push('cleanup'), 'dropped'), clock: () => 0 },
    )
    expect(order).toEqual(['one', 'two', 'cleanup'])
    expect(report.ok).toBe(true)
    expect(report.steps.map((s) => [s.name, s.status, s.detail])).toEqual([
      ['one', 'ok', 'first'],
      ['two', 'ok', ''],
    ])
    expect(report.cleanup).toMatchObject({ status: 'ok', detail: 'dropped' })
  })

  it('stops at the first failure, marks the rest not run, and still cleans up', async () => {
    let cleaned = false
    const report = await runSteps(
      [
        { name: 'one', run: async () => 'fine' },
        {
          name: 'two',
          run: async () => {
            throw new Error('boom')
          },
        },
        { name: 'three', run: async () => 'never' },
      ],
      { cleanup: async () => ((cleaned = true), 'dropped'), clock: () => 0 },
    )
    expect(cleaned).toBe(true)
    expect(report.ok).toBe(false)
    expect(report.steps.map((s) => s.status)).toEqual(['ok', 'failed', 'not run'])
    expect(report.steps[1]!.error).toBe('boom')
  })

  it('a failed cleanup fails the rehearsal even when every step was green', async () => {
    const report = await runSteps([{ name: 'one', run: async () => 'fine' }], {
      cleanup: async () => {
        throw new Error('database is in use')
      },
      clock: () => 0,
    })
    expect(report.ok).toBe(false)
    expect(report.cleanup).toMatchObject({ status: 'failed', error: 'database is in use' })
  })
})

describe('smokeFailures', () => {
  it('names each failing tool with its error', () => {
    expect(
      smokeFailures([
        { tool: 'contacts.list', ok: true, summary: '25 items' },
        { tool: 'memory.list_tasks', ok: false, error: 'column "x" does not exist' },
      ]),
    ).toEqual(['memory.list_tasks: column "x" does not exist'])
  })

  it('an empty smoke is a failure, not a pass', () => {
    expect(smokeFailures([])).toEqual(['the smoke ran no tools'])
  })
})

describe('smokeRegressions (the old app on the new schema against its own baseline)', () => {
  const baseline = [
    { tool: 'contacts.list', ok: true, summary: 'contacts[25] tags[6]' },
    { tool: 'members.list', ok: true, summary: 'invites[0] members[6]' },
  ]

  it('none when every read still works and returns what it did before', () => {
    expect(smokeRegressions(baseline, baseline)).toEqual([])
  })

  it('a read that now fails, or returns a different shape or count, is a regression', () => {
    expect(
      smokeRegressions(baseline, [
        { tool: 'contacts.list', ok: true, summary: 'contacts[0] tags[6]' },
        { tool: 'members.list', ok: false, error: 'relation "member" does not exist' },
      ]),
    ).toEqual([
      'contacts.list: returned "contacts[0] tags[6]", before the migrations "contacts[25] tags[6]"',
      'members.list: relation "member" does not exist',
    ])
  })

  it('a read missing from either run is a regression, never silently skipped', () => {
    expect(smokeRegressions(baseline, [baseline[0]!])).toEqual([
      'members.list: did not run after the migrations',
    ])
  })
})

describe('planRehearsal (the rehearsal wired to fakes)', () => {
  type Smoke = { tool: string; ok: boolean; summary?: string; error?: string }
  const green: Smoke[] = [{ tool: 'contacts.list', ok: true, summary: 'contacts[25]' }]

  function fakes(over: { seed?: () => Promise<string>; after?: Smoke[]; baseline?: Smoke[] } = {}) {
    const calls: string[] = []
    const deps = {
      previousRelease: async () => (
        calls.push('pick'),
        { tag: 'v0.5.38', sha: '10857f40abcdef0123' }
      ),
      createDatabase: async () => (calls.push('create db'), 'ee_rehearsal_x'),
      dropDatabase: async () => (calls.push('drop db'), 'dropped ee_rehearsal_x'),
      checkoutRelease: async (tag: string) => (calls.push(`checkout ${tag}`), `/tmp/x (${tag})`),
      preStart: async (side: 'previous' | 'this') => (
        calls.push(`preStart ${side}`),
        { run: ['scripts/migrate.mjs'], skipped: ['scripts/bootstrap-production-ops.mjs'] }
      ),
      seed: over.seed ?? (async () => (calls.push('seed'), 'Northwind Studio')),
      smoke: async (label: 'baseline' | 'after') => (
        calls.push(`smoke ${label}`),
        label === 'baseline' ? (over.baseline ?? green) : (over.after ?? green)
      ),
      removeWorkdir: async () => (calls.push('rm workdir'), 'removed /tmp/x'),
    }
    return { deps, calls }
  }

  async function run(f: ReturnType<typeof fakes>) {
    const { steps, cleanup } = planRehearsal(f.deps)
    return runSteps(steps, { cleanup, clock: () => 0 })
  }

  it('previous schema → seed → baseline smoke → this tree’s migrations → smoke again, then drops everything', async () => {
    const f = fakes()
    const report = await run(f)
    expect(f.calls).toEqual([
      'pick',
      'create db',
      'checkout v0.5.38',
      'preStart previous',
      'seed',
      'smoke baseline',
      'preStart this',
      'smoke after',
      'drop db',
      'rm workdir',
    ])
    expect(report.ok).toBe(true)
    expect(report.steps[0]!.detail).toBe('v0.5.38 (10857f40abcd)')
    expect(report.steps[3]!.detail).toBe('migrate.mjs (skipped: bootstrap-production-ops.mjs)')
  })

  it('a failed seed stops the run before any migration, and the database is still dropped', async () => {
    const f = fakes({
      seed: async () => {
        throw new Error('demo.seed_company: already seeded')
      },
    })
    const report = await run(f)
    expect(report.ok).toBe(false)
    expect(f.calls).not.toContain('preStart this')
    expect(f.calls.slice(-2)).toEqual(['drop db', 'rm workdir'])
    expect(report.steps.find((s) => s.status === 'failed')).toMatchObject({
      name: 'demo seed (previous release code)',
      error: 'demo.seed_company: already seeded',
    })
  })

  it('a smoke that fails on the old schema is the smoke’s bug: the migrations never run', async () => {
    const f = fakes({ baseline: [{ tool: 'drive.read', ok: false, error: 'nothing to read' }] })
    const report = await run(f)
    expect(f.calls).not.toContain('preStart this')
    expect(report.steps[5]!.error).toMatch(/already fails on v0\.5\.38's own schema/)
    expect(report.steps[5]!.error).toContain('drive.read: nothing to read')
  })

  it('the old app breaking on the new schema names the release, the tool and the error', async () => {
    const f = fakes({
      after: [{ tool: 'contacts.list', ok: false, error: 'column "company" does not exist' }],
    })
    const report = await run(f)
    expect(report.ok).toBe(false)
    const last = report.steps[report.steps.length - 1]!
    expect(last.name).toBe('previous release read smoke on the new schema')
    expect(last.error).toBe(
      'v0.5.38 breaks on this tree\'s schema (blue/green would fail):\ncontacts.list: column "company" does not exist',
    )
  })

  it('cleanup tries both the database and the workdir, and reports a failure of either', async () => {
    const f = fakes()
    f.deps.dropDatabase = async () => {
      throw new Error('could not drop ee_rehearsal_x')
    }
    const report = await run(f)
    expect(f.calls).toContain('rm workdir')
    expect(report.ok).toBe(false)
    expect(report.cleanup.error).toBe('could not drop ee_rehearsal_x')
  })
})

describe('formatReport', () => {
  it('a numbered step list, the failure with its error, cleanup, and the verdict', () => {
    const text = formatReport({
      ok: false,
      steps: [
        { name: 'previous release', status: 'ok', detail: 'v0.5.38', ms: 12 },
        { name: 'demo seed', status: 'failed', detail: '', error: 'members.list: boom', ms: 3400 },
        { name: 'smoke', status: 'not run', detail: '', ms: 0 },
      ],
      cleanup: { name: 'cleanup', status: 'ok', detail: 'dropped ee_rehearsal_x', ms: 40 },
    })
    expect(text).toContain('1. previous release — ok (12 ms): v0.5.38')
    expect(text).toContain('2. demo seed — FAILED (3.4 s)')
    expect(text).toContain('members.list: boom')
    expect(text).toContain('3. smoke — not run')
    expect(text).toContain('cleanup — ok')
    expect(text).toMatch(/upgrade rehearsal: FAILED at "demo seed"/)
  })

  it('green says so', () => {
    const text = formatReport({
      ok: true,
      steps: [{ name: 'a', status: 'ok', detail: '', ms: 1 }],
      cleanup: { name: 'cleanup', status: 'ok', detail: '', ms: 1 },
    })
    expect(text).toMatch(/upgrade rehearsal: GREEN/)
  })
})
