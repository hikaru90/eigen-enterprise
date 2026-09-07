import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitCommitter, type GitExecRunner } from './vcs'

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
    const committer = new GitCommitter(runner)
    await expect(committer.commit('tool x by y')).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('throws on empty message without executing git', async () => {
    const { runner, calls } = okRunner('')
    const committer = new GitCommitter(runner)
    await expect(committer.commit('   ')).rejects.toThrow(/non-empty message/)
    expect(calls).toHaveLength(0)
  })

  it('parses the commit hash from git output', async () => {
    const { runner, calls } = okRunner('[main 1a2b3c4d] tool x by y\n 1 file changed, 2 insertions(+)')
    const committer = new GitCommitter(runner)
    await expect(committer.commit('tool x by y')).resolves.toBe('1a2b3c4d')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['git', 'commit', '-am', 'tool x by y'])
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
    const committer = new GitCommitter(runner)
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
    const committer = new GitCommitter(runner)
    await expect(committer.commit('tool x by y')).rejects.toThrow(/git commit failed/)
  })
})
