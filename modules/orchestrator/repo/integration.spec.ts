import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InMemoryEventSink } from '$lib/kernel/events'
import { createRepoEngine, type RepoEngine } from './index'

const run = promisify(execFile)

function hasGit(): boolean {
  return spawnSync('git', ['--version']).status === 0
}

describe.skipIf(!hasGit())('repo tools integration (real temp git repo)', () => {
  const sink = new InMemoryEventSink()
  let root: string
  // The real verify gate needs the full project toolchain (covered hermetically
  // in tools.spec); this fixture pins the real git mechanics instead.
  let engine: RepoEngine

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ee-repo-int-'))
    engine = createRepoEngine({
      eventSink: sink,
      baseCwd: root,
      verify: async () => ({ green: true, vitestExit: 0, checkExit: 0, summary: 'fixture gate' }),
    })
    await run('git', ['init', '-b', 'main', '.'], { cwd: root })
    await run('git', ['config', 'user.email', 'fixture@eigen'], { cwd: root })
    await run('git', ['config', 'user.name', 'fixture'], { cwd: root })
    await writeFile(path.join(root, 'README.md'), '# fixture\n', 'utf8')
    await run('git', ['add', 'README.md'], { cwd: root })
    await run('git', ['commit', '-m', 'fixture: seed'], { cwd: root })
  }, 30_000)

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  it('worktree_create → write_file → run → merge lands the agent branch on the instance repo', async () => {
    const created = await engine.worktreeCreate('agent-int')
    expect(created.created).toBe(true)
    expect(created.branch).toMatch(/^wt\/agent-[0-9a-f]{8}$/)

    await engine.writeFile('agent-int', created.path, 'scripts/hello.mjs', 'console.log("hello")\n')

    const ran = await engine.run('agent-int', created.path, 'node scripts/hello.mjs')
    expect(ran.exitCode).toBe(0)
    expect(ran.stdout.trim()).toBe('hello')

    const merge = await engine.merge('agent-int', created.path, '[feature] fixture hello script')
    expect(merge).toMatchObject({ verified: true, committed: true, merged: true })
    expect(merge.commitSubject).toContain('fixture hello script')

    // the branch landed on the instance repo (merge subject) and was cleaned up
    const log = await run('git', ['log', '-1', '--format=%s'], { cwd: root })
    expect(log.stdout.trim()).toBe(merge.commitSubject)
    const branches = await run('git', ['branch', '--list', created.branch], { cwd: root })
    expect(branches.stdout).not.toContain(created.branch.slice('wt/'.length))
    const worktrees = await run('git', ['worktree', 'list', '--porcelain'], { cwd: root })
    expect(worktrees.stdout).not.toContain('ee-agent-')
    expect(sink.events.map((event) => event.type)).toContain('repo.merged')

    // after a merge, the same principal gets a FRESH worktree (slot released)
    const next = await engine.worktreeCreate('agent-int')
    expect(next.created).toBe(true)
    expect(next.path).not.toBe(created.path)
  }, 60_000)
})
