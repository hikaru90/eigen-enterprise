import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export interface VcsCommitter {
  /**
   * Commit current working-tree changes with the given message.
   * Returns the commit hash, or null when there was nothing to commit
   * (or autocommit is disabled via EE_VCS_AUTOCOMMIT=0).
   */
  commit(message: string): Promise<string | null>
}

/** execFile-like runner, injectable for tests. */
export type GitExecRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>

const realGitRunner: GitExecRunner = (file, args) => promisify(execFile)(file, args)

function parseCommitHash(stdout: string): string {
  const match = /\[[^\s]+ ([0-9a-f]{7,40})\]/.exec(stdout)
  if (!match) {
    throw new Error(`git commit succeeded but no commit hash found in output: ${stdout.trim()}`)
  }
  return match[1]
}

export class GitCommitter implements VcsCommitter {
  constructor(private readonly run: GitExecRunner = realGitRunner) {}

  async commit(message: string): Promise<string | null> {
    if (process.env.EE_VCS_AUTOCOMMIT === '0') return null
    if (message.trim().length === 0) {
      throw new Error('git commit requires a non-empty message')
    }

    let stdout: string
    let stderr: string
    try {
      const result = await this.run('git', ['commit', '-am', message])
      stdout = result.stdout
      stderr = result.stderr
    } catch (err) {
      const output = err as { stdout?: unknown; stderr?: unknown; message?: string }
      const combined = `${String(output.stdout ?? '')}\n${String(output.stderr ?? '')}`
      if (combined.includes('nothing to commit')) return null
      throw new Error(`git commit failed: ${output.message ?? String(err)}`)
    }

    const output = `${stdout}\n${stderr}`
    if (output.includes('nothing to commit')) return null
    return parseCommitHash(stdout)
  }
}
