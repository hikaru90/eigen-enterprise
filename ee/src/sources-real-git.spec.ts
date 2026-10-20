import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchSource } from './sources.ts'
import { RealSystem } from './system.ts'
import { PATHS } from './paths.ts'

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('fetchSource against real git', () => {
  it('fetching the same branch again keeps it (repeat deploys never lose the ref)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ee-src-'))
    const origin = join(dir, 'origin')
    execFileSync('git', ['init', '-q', '-b', 'main', origin])
    execFileSync('git', ['-C', origin, 'commit', '-q', '--allow-empty', '-m', 'one', '--author', 't <t@t>'], { env: { ...process.env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    const company = join(dir, 'company')
    ;(PATHS as { company: string }).company = company
    execFileSync('mkdir', ['-p', join(company, 'sources')])
    const sys = new RealSystem()
    // https-only for unauthenticated fetches; a file:// origin stands in via insteadOf.
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.${origin}.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/t/app'
    const input = { name: 'gh-app', url: 'https://github.com/t/app', ref: 'main' }
    const first = await fetchSource(sys, input)
    const second = await fetchSource(sys, input)
    const third = await fetchSource(sys, input)
    expect(first).toMatch(/^[0-9a-f]{40}$/)
    expect([second, third]).toEqual([first, first])
  })
})
