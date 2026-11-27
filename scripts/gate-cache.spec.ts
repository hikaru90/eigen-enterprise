import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The gate's content-keyed result cache (scripts/gate-cache.mjs via gate-step.sh --cache), end to
 * end in a throwaway repo with a fake step: the step appends to a counter file outside the repo,
 * so "ran" vs "cached" is observable.
 */
const here = import.meta.dirname

let repo: string
let counter: string
const baseEnv = () => {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'EE_GATE_NO_CACHE'])
    delete env[k]
  return env
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: baseEnv() }).trim()
}

function step(opts: { fail?: boolean; env?: Record<string, string>; name?: string } = {}) {
  return spawnSync(
    'bash',
    [
      'scripts/gate-step.sh',
      'ci',
      opts.name ?? 'test:unit',
      '--cache',
      '--',
      'bash',
      '-c',
      'echo ran >> "$COUNTER_FILE"; [ -z "$FAKE_FAIL" ]',
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...baseEnv(),
        EE_GATE_RUN: 'spec-run',
        COUNTER_FILE: counter,
        FAKE_FAIL: opts.fail ? '1' : '',
        ...opts.env,
      },
    },
  )
}

function runs(): number {
  try {
    return readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ee-gate-cache-'))
  repo = join(base, 'repo')
  counter = join(base, 'counter')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  for (const f of ['gate-step.sh', 'gate-cache.mjs', 'gate-times.mjs'])
    copyFileSync(join(here, f), join(repo, 'scripts', f))
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n.env\nnode_modules\n')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  mkdirSync(join(repo, 'plan'))
  writeFileSync(join(repo, 'plan', 'progress.md'), 'x\n')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
})

afterEach(() => {
  rmSync(join(repo, '..'), { recursive: true, force: true })
})

describe('gate step result cache', () => {
  it('same inputs give a hit, with a clear line', () => {
    expect(step().status).toBe(0)
    const second = step()
    expect(second.status).toBe(0)
    expect(second.stdout).toMatch(/cached: green on [0-9a-f]{12} at \d{4}-\d\d-\d\dT/)
    expect(runs()).toBe(1)
  })

  it('a new commit with the same content is still a hit (rebase / amend)', () => {
    step()
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'empty')
    step()
    expect(runs()).toBe(1)
  })

  it('a tracked (committed) change is a miss', () => {
    step()
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'two')
    step()
    expect(runs()).toBe(2)
  })

  it('a dirty edit is a miss', () => {
    step()
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    step()
    expect(runs()).toBe(2)
  })

  it('a staged-only edit is a miss', () => {
    step()
    writeFileSync(join(repo, 'a.txt'), 'staged\n')
    git('add', 'a.txt')
    step()
    expect(runs()).toBe(2)
  })

  it('an untracked non-ignored file is a miss; an ignored one is not', () => {
    step()
    writeFileSync(join(repo, 'ignored.txt'), 'x\n')
    step()
    expect(runs()).toBe(1)
    writeFileSync(join(repo, 'new.txt'), 'x\n')
    step()
    expect(runs()).toBe(2)
  })

  it('the gitignored .env and installed deps are inputs', () => {
    step()
    writeFileSync(join(repo, '.env'), 'A=1\n')
    step()
    expect(runs()).toBe(2)
    mkdirSync(join(repo, 'node_modules'))
    writeFileSync(join(repo, 'node_modules', '.package-lock.json'), '{}')
    step()
    expect(runs()).toBe(3)
  })

  it('config env vars are inputs; the run id is not', () => {
    step()
    step({ env: { EE_GATE_RUN: 'another-run' } })
    expect(runs()).toBe(1)
    step({ env: { DATABASE_URL: 'postgres://elsewhere' } })
    expect(runs()).toBe(2)
  })

  it('plan/** does not affect a non-lint step, but does affect lint', () => {
    step()
    step({ name: 'lint' })
    expect(runs()).toBe(2)
    writeFileSync(join(repo, 'plan', 'progress.md'), 'y\n')
    step()
    expect(runs()).toBe(2)
    step({ name: 'lint' })
    expect(runs()).toBe(3)
  })

  it('a failed step is never recorded', () => {
    const failed = step({ fail: true })
    expect(failed.status).not.toBe(0)
    expect(step({ fail: true }).status).not.toBe(0)
    expect(runs()).toBe(2)
    expect(readdirSync(join(repo, '.git', 'ee-gate'))).not.toContain('test-cache')
  })

  it('EE_GATE_NO_CACHE=1 forces a run', () => {
    step()
    const forced = step({ env: { EE_GATE_NO_CACHE: '1' } })
    expect(forced.status).toBe(0)
    expect(forced.stdout).toContain('cache off')
    expect(runs()).toBe(2)
  })

  it('does not touch the real index', () => {
    writeFileSync(join(repo, 'new.txt'), 'x\n')
    step()
    expect(git('status', '--porcelain')).toBe('?? new.txt')
  })

  it('--cache-extra is part of the key', () => {
    const extra = (x: string) =>
      spawnSync(
        'bash',
        [
          'scripts/gate-step.sh',
          'release',
          'upgrade-rehearsal',
          '--cache',
          '--cache-extra',
          x,
          '--',
          'bash',
          '-c',
          'echo ran >> "$COUNTER_FILE"',
        ],
        {
          cwd: repo,
          encoding: 'utf8',
          env: { ...baseEnv(), EE_GATE_RUN: 'r', COUNTER_FILE: counter },
        },
      )
    extra('v1.0.0 abc')
    extra('v1.0.0 abc')
    expect(runs()).toBe(1)
    extra('v1.0.0 abc\nv1.1.0 def')
    expect(runs()).toBe(2)
  })

  it('gate:times shows a cached step as cached, not 0s', () => {
    step()
    step()
    const rows = readFileSync(join(repo, '.git', 'ee-gate', 'timings.tsv'), 'utf8')
      .trim()
      .split('\n')
    expect(rows).toHaveLength(2)
    expect(rows[0].split('\t')[7] ?? '').toBe('')
    expect(rows[1].split('\t')[7]).toMatch(/^cached:[0-9a-f]{12}$/)
    const out = execFileSync('node', ['scripts/gate-times.mjs', '--brief'], {
      cwd: repo,
      encoding: 'utf8',
      env: baseEnv(),
    })
    expect(out).toMatch(/ci › test:unit\s+cached\s+green on [0-9a-f]{12}/)
    expect(out).toContain('1 cached')
  })

  it('--outer records no row on a miss (the command times itself), one on a hit', () => {
    const outer = () =>
      spawnSync(
        'bash',
        [
          'scripts/gate-step.sh',
          'release',
          'e2e',
          '--cache',
          '--outer',
          '--',
          'bash',
          '-c',
          'echo ran >> "$COUNTER_FILE"',
        ],
        {
          cwd: repo,
          encoding: 'utf8',
          env: { ...baseEnv(), EE_GATE_RUN: 'r', COUNTER_FILE: counter },
        },
      )
    expect(outer().status).toBe(0)
    let tsv = ''
    try {
      tsv = readFileSync(join(repo, '.git', 'ee-gate', 'timings.tsv'), 'utf8')
    } catch {
      /* no rows yet */
    }
    expect(tsv).toBe('')
    expect(outer().stdout).toContain('cached: green on')
    tsv = readFileSync(join(repo, '.git', 'ee-gate', 'timings.tsv'), 'utf8')
    expect(tsv.trim().split('\n')).toHaveLength(1)
    expect(runs()).toBe(1)
  })
})
