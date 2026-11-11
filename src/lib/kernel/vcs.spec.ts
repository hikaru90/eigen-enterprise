import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitCommitter, type GitExecRunner, vcsCommitterFromEnv } from './vcs'

const REPO = '/srv/company-repo'

function okRunner(stdout: string): { runner: GitExecRunner; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    runner: async (file, args) => {
      calls.push([file, ...args])
      return { stdout, stderr: '' }
    },
  }
}

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe('GitCommitter', () => {
  it('returns null without executing git when EE_VCS_AUTOCOMMIT=0', async () => {
    vi.stubEnv('EE_VCS_AUTOCOMMIT', '0')
    const { runner, calls } = okRunner('')
    const committer = new GitCommitter(REPO, runner)
    await expect(committer.commit('tool x by y')).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('throws on empty message without executing git', async () => {
    const { runner, calls } = okRunner('')
    const committer = new GitCommitter(REPO, runner)
    await expect(committer.commit('   ')).rejects.toThrow(/non-empty message/)
    expect(calls).toHaveLength(0)
  })

  it('commits in its own repository, never in the directory the process runs in', async () => {
    const { runner, calls } = okRunner('[main 1a2b3c4d] tool x by y\n 1 file changed, 2 insertions(+)')
    const committer = new GitCommitter(REPO, runner)
    await expect(committer.commit('tool x by y')).resolves.toBe('1a2b3c4d')
    expect(calls).toEqual([['git', '-C', REPO, 'commit', '-am', 'tool x by y']])
  })

  it('refuses a relative repository path (it would resolve against the working directory)', () => {
    expect(() => new GitCommitter('.', okRunner('').runner)).toThrow(/absolute path/)
    expect(() => new GitCommitter('', okRunner('').runner)).toThrow(/absolute path/)
  })

  it('returns null when git reports nothing to commit', async () => {
    const calls: string[][] = []
    const runner: GitExecRunner = async (file, args) => {
      calls.push([file, ...args])
      throw Object.assign(new Error('git exited with code 1'), {
        stdout: 'On branch main\nnothing to commit, working tree clean',
        stderr: '',
      })
    }
    const committer = new GitCommitter(REPO, runner)
    await expect(committer.commit('tool x by y')).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('throws on other git failures', async () => {
    const runner: GitExecRunner = async () => {
      throw Object.assign(new Error('git exited with code 128'), {
        stdout: '',
        stderr: 'fatal: not a git repository',
      })
    }
    const committer = new GitCommitter(REPO, runner)
    await expect(committer.commit('tool x by y')).rejects.toThrow(/git commit failed/)
  })
})

describe('vcsCommitterFromEnv', () => {
  it('is off unless a repository is named: a process in a source checkout (e2e harness, tests) never commits it', () => {
    expect(vcsCommitterFromEnv({})).toBeNull()
  })

  it('commits into EE_VCS_REPO_DIR when it is set', async () => {
    const { runner, calls } = okRunner('[main abcdef1] tool x by y')
    const committer = vcsCommitterFromEnv({ EE_VCS_REPO_DIR: REPO }, runner)
    expect(committer).toBeInstanceOf(GitCommitter)
    await committer?.commit('tool x by y')
    expect(calls[0]?.slice(0, 3)).toEqual(['git', '-C', REPO])
  })

  it('fails loud on a relative EE_VCS_REPO_DIR', () => {
    expect(() => vcsCommitterFromEnv({ EE_VCS_REPO_DIR: 'repo' })).toThrow(/absolute path/)
  })
})
