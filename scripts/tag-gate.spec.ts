import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The pre-push hook's release gate (plan/phase-upgrades.md §8 U1), in a
 * throwaway repo with stub gates: ci-gate.sh and tag-gate.sh record that they
 * ran and stamp HEAD, as the real ones do when green.
 */
const hook = join(import.meta.dirname, '..', '.githooks', 'pre-push')
const zero = '0'.repeat(40)

let repo: string
const env = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_WORK_TREE: undefined,
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim()
}

function stub(name: string, stamp: string, exit = 0) {
  const file = join(repo, 'scripts', name)
  writeFileSync(
    file,
    `#!/usr/bin/env bash\necho ran >> "$(git rev-parse --git-common-dir)/${name}.calls"\n` +
      (exit === 0
        ? `mkdir -p "$(git rev-parse --git-common-dir)/ee-gate"; git rev-parse HEAD > "$(git rev-parse --git-common-dir)/ee-gate/${stamp}"\n`
        : `exit ${exit}\n`),
  )
  chmodSync(file, 0o755)
}

function calls(name: string): number {
  try {
    return readFileSync(join(repo, '.git', `${name}.calls`), 'utf8')
      .trim()
      .split('\n').length
  } catch {
    return 0
  }
}

function prePush(lines: string[]) {
  return spawnSync(
    'bash',
    [join(repo, '.githooks', 'pre-push'), 'origin', 'git@example.invalid:x.git'],
    {
      cwd: repo,
      env,
      input: lines.map((l) => `${l}\n`).join(''),
      encoding: 'utf8',
    },
  )
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'tag-gate-spec-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'spec@example.invalid')
  git('config', 'user.name', 'spec')
  mkdirSync(join(repo, 'scripts'))
  mkdirSync(join(repo, '.githooks'))
  copyFileSync(hook, join(repo, '.githooks', 'pre-push'))
  stub('ci-gate.sh', 'passed')
  stub('tag-gate.sh', 'tag-passed')
  git('add', '.')
  git('commit', '-q', '-m', 'one')
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('pre-push: release tags need the release gate', () => {
  it('a branch push never runs the release gate', () => {
    const head = git('rev-parse', 'HEAD')
    const r = prePush([`refs/heads/main ${head} refs/heads/main ${zero}`])
    expect(r.status, r.stderr).toBe(0)
    expect(calls('ci-gate.sh')).toBe(1)
    expect(calls('tag-gate.sh')).toBe(0)
  })

  it('a v* tag on HEAD runs the release gate once, then is let through on its stamp', () => {
    git('tag', '-a', 'v1.0.0', '-m', 'release')
    const tagObject = git('rev-parse', 'v1.0.0')
    const line = `refs/tags/v1.0.0 ${tagObject} refs/tags/v1.0.0 ${zero}`
    expect(prePush([line]).status).toBe(0)
    expect(calls('tag-gate.sh')).toBe(1)
    expect(prePush([line]).status).toBe(0)
    expect(calls('tag-gate.sh')).toBe(1)
  })

  it('a red release gate refuses the push', () => {
    stub('tag-gate.sh', 'tag-passed', 1)
    git('tag', 'v1.0.0')
    const r = prePush([`refs/tags/v1.0.0 ${git('rev-parse', 'HEAD')} refs/tags/v1.0.0 ${zero}`])
    expect(r.status).not.toBe(0)
  })

  it('a v* tag on another commit is refused: the gate runs on HEAD only', () => {
    git('tag', 'v1.0.0')
    git('commit', '-q', '--allow-empty', '-m', 'two')
    const r = prePush([`refs/tags/v1.0.0 ${git('rev-parse', 'v1.0.0')} refs/tags/v1.0.0 ${zero}`])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('not HEAD')
    expect(calls('tag-gate.sh')).toBe(0)
  })

  it('a stamp for an older commit does not cover a new tag', () => {
    git('tag', 'v1.0.0')
    expect(
      prePush([`refs/tags/v1.0.0 ${git('rev-parse', 'HEAD')} refs/tags/v1.0.0 ${zero}`]).status,
    ).toBe(0)
    git('commit', '-q', '--allow-empty', '-m', 'two')
    git('tag', 'v1.0.1')
    expect(
      prePush([`refs/tags/v1.0.1 ${git('rev-parse', 'HEAD')} refs/tags/v1.0.1 ${zero}`]).status,
    ).toBe(0)
    expect(calls('tag-gate.sh')).toBe(2)
  })

  it('other tags and tag deletions are not release pushes', () => {
    git('tag', 'channels')
    expect(
      prePush([`refs/tags/channels ${git('rev-parse', 'HEAD')} refs/tags/channels ${zero}`]).status,
    ).toBe(0)
    expect(prePush([`(delete) ${zero} refs/tags/v0.9.0 ${git('rev-parse', 'HEAD')}`]).status).toBe(
      0,
    )
    expect(calls('tag-gate.sh')).toBe(0)
  })
})
