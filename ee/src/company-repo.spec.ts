import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CompanyRepo } from './company-repo.ts'
import { RealSystem } from './system.ts'

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const tracked = (d: string) => execFileSync('git', ['-C', d, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)

describe('CompanyRepo: git mirrors under sources/ are never part of the desired state', () => {
  it('a commit leaves sources/ untracked, and untracks mirrors an older commit picked up', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ee-company-'))
    const repo = new CompanyRepo(new RealSystem(), dir)
    await repo.init()
    await repo.commit('first', 'owner:test', (s) => s)
    // An older ee committed a mirror into the company repo (the bug).
    mkdirSync(join(dir, 'sources/gh-app.git/refs/remotes/origin'), { recursive: true })
    writeFileSync(join(dir, 'sources/gh-app.git/refs/remotes/origin/main'), 'f'.repeat(40) + '\n')
    execFileSync('git', ['-C', dir, 'add', '-f', 'sources'])
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'old ee', '--author', 'ee <ee@ee.local>'])
    expect(tracked(dir).some((f) => f.startsWith('sources/'))).toBe(true)

    await repo.commit('settings', 'owner:test', (s) => ({ ...s, settings: { ...s.settings, consoleHost: 'os.test' } }))

    expect(tracked(dir).filter((f) => f.startsWith('sources/'))).toEqual([])
    // The mirror itself is untouched on disk: ee still builds from it.
    expect(execFileSync('cat', [join(dir, 'sources/gh-app.git/refs/remotes/origin/main')], { encoding: 'utf8' }).trim()).toBe('f'.repeat(40))
  })
})

describe('CompanyRepo: host ports', () => {
  it('refuses a commit where two workloads hold the same host port, and nothing is written', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ee-company-'))
    const repo = new CompanyRepo(new RealSystem(), dir)
    await repo.init()
    const source = { kind: 'release' as const, tarball: '/r/lk.tgz', sha256: 'a'.repeat(64) }
    const lk = (name: string) => ({ name, tier: 'system' as const, source, ports: [{ port: 7882, proto: 'udp' as const }] })
    const first = await repo.commit('one', 'owner:test', (s) => ({ ...s, workloads: [lk('livekit')] as never }))
    await expect(
      repo.commit('two', 'owner:test', (s) => ({ ...s, workloads: [...s.workloads, lk('livekit-two')] as never })),
    ).rejects.toThrow(/udp\/7882 is held by both livekit and livekit-two/)
    expect(await repo.head()).toBe(first)
  })
})
