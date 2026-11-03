import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fresh temp dir per test (git repos are real; nothing is shared). */
export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `gitstore-${label}-`))
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ext',
      GIT_AUTHOR_EMAIL: 'ext@example.com',
      GIT_COMMITTER_NAME: 'Ext',
      GIT_COMMITTER_EMAIL: 'ext@example.com',
    },
  }).trim()
}
