import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

export type VcsCommitter = {
  /**
   * Commit current working-tree changes with the given message.
   * Returns the commit hash, or null when there was nothing to commit
   * (or autocommit is disabled via EE_VCS_AUTOCOMMIT=0).
   * Only exists when EE_VCS_REPO_DIR names the repository (vcsCommitterFromEnv).
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

function requireAbsolute(repoDir: string): string {
  if (!isAbsolute(repoDir)) {
    throw new Error(`the kernel's git repository must be an absolute path, got ${JSON.stringify(repoDir)}`)
  }
  return repoDir
}

/**
 * Commits into one named repository (`git -C <repoDir>`), never the directory
 * the process happens to run in: a process started inside a source checkout
 * (the e2e harness's `vite dev`, a test) must not commit the developer's
 * uncommitted work as "tool … by …".
 */
export class GitCommitter implements VcsCommitter {
  private readonly repoDir: string

  constructor(
    repoDir: string,
    private readonly run: GitExecRunner = realGitRunner,
  ) {
    this.repoDir = requireAbsolute(repoDir)
  }

  async commit(message: string): Promise<string | null> {
    if (process.env.EE_VCS_AUTOCOMMIT === '0') return null
    if (message.trim().length === 0) {
      throw new Error('git commit requires a non-empty message')
    }

    let stdout: string
    let stderr: string
    try {
      const result = await this.run('git', ['-C', this.repoDir, 'commit', '-am', message])
      stdout = result.stdout
      stderr = result.stderr
    } catch (err) {
      const output = err as { stdout?: unknown; stderr?: unknown; message?: string }
      const combined = `${String(output.stdout ?? '')}\n${String(output.stderr ?? '')}`
      if (combined.includes('nothing to commit')) return null
      throw new Error(`git commit failed: ${output.message ?? String(err)}`, { cause: err })
    }

    const output = `${stdout}\n${stderr}`
    if (output.includes('nothing to commit')) return null
    return parseCommitHash(stdout)
  }
}

/**
 * The kernel's committer: opt-in. Without `EE_VCS_REPO_DIR` mutating tools are
 * not committed (the audit trail is kernel_events; under ee the company repo
 * is committed by ee itself).
 */
export function vcsCommitterFromEnv(
  env: Record<string, string | undefined>,
  run: GitExecRunner = realGitRunner,
): VcsCommitter | null {
  const repoDir = env.EE_VCS_REPO_DIR
  if (repoDir === undefined) return null
  return new GitCommitter(repoDir, run)
}
