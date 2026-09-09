import { KernelError } from '$lib/kernel/errors'

/**
 * The repo.run command allowlist — pinned here AND in allowlist.spec.ts.
 * Token-structured matching only: no prefix heuristics, no shell, no excuses.
 */
export const COMMAND_ALLOWLIST: readonly string[] = [
  'npm test',
  'npm run check',
  'npm run lint',
  'npm run db:migrate',
  'npx vitest run <args…>',
  'git add <paths…>',
  'git commit -m <message…>',
  'git status',
  'git diff',
  'git log',
  'mkdir <paths…>',
  'cp <paths…>',
  'mv <paths…>',
  'node scripts/<path> [args…]',
]

/** Characters that make a command a shell pipeline/expansion — rejected outright. */
const SHELL_METACHARS = /[;&|`$()<>\n\r'"\\]/

/** One safe token: word chars, path separators, @ = - and dots. */
const SAFE_ARG = /^[\w./@=-]+$/

/** How the engine must further validate an entry's arguments. */
export type ArgKind = 'exact' | 'vitest-args' | 'git-paths' | 'commit-message' | 'fs-paths' | 'node-script'

export type ParsedCommand = {
  cmd: string
  args: string[]
  kind: ArgKind
}

type Entry = {
  prefix: readonly string[]
  kind: ArgKind
}

const EXACT_ENTRIES: Entry[] = [
  { prefix: ['npm', 'test'], kind: 'exact' },
  { prefix: ['npm', 'run', 'check'], kind: 'exact' },
  { prefix: ['npm', 'run', 'lint'], kind: 'exact' },
  { prefix: ['npm', 'run', 'db:migrate'], kind: 'exact' },
  { prefix: ['git', 'status'], kind: 'exact' },
  { prefix: ['git', 'diff'], kind: 'exact' },
  { prefix: ['git', 'log'], kind: 'exact' },
]

const ARG_ENTRIES: Entry[] = [
  { prefix: ['npx', 'vitest', 'run'], kind: 'vitest-args' },
  { prefix: ['git', 'add'], kind: 'git-paths' },
  { prefix: ['git', 'commit', '-m'], kind: 'commit-message' },
  { prefix: ['mkdir'], kind: 'fs-paths' },
  { prefix: ['cp'], kind: 'fs-paths' },
  { prefix: ['mv'], kind: 'fs-paths' },
  { prefix: ['node'], kind: 'node-script' },
]

function notAllowed(command: string): KernelError {
  return new KernelError(
    'invalid_input',
    `command not in the repo.run allowlist: "${command}". Allowlist: ${COMMAND_ALLOWLIST.join('; ')}`,
  )
}

function assertSafeToken(token: string, where: string): void {
  if (!SAFE_ARG.test(token) || token.split('/').includes('..')) {
    throw new KernelError('invalid_input', `unsafe ${where} argument: "${token}"`)
  }
}

/**
 * Parse a repo.run command against the allowlist. Token-structured: the whole
 * string must be free of shell metacharacters, then the leading tokens must
 * exactly equal an entry's prefix and the remaining tokens satisfy that
 * entry's argument rule. Throws loud KernelError('invalid_input') on anything
 * else. The caller spawns WITHOUT a shell, so these tokens go to execve as-is.
 */
export function parseAllowlistedCommand(command: string): ParsedCommand {
  if (SHELL_METACHARS.test(command)) {
    throw notAllowed(command)
  }
  const tokens = command.trim().split(/\s+/).filter((token) => token !== '')
  if (tokens.length === 0) {
    throw notAllowed(command)
  }

  for (const entry of EXACT_ENTRIES) {
    if (entry.prefix.length === tokens.length && entry.prefix.every((t, i) => t === tokens[i])) {
      return { cmd: entry.prefix[0]!, args: tokens.slice(1), kind: 'exact' }
    }
  }

  for (const entry of ARG_ENTRIES) {
    if (entry.prefix.length < tokens.length && entry.prefix.every((t, i) => t === tokens[i])) {
      const rest = tokens.slice(entry.prefix.length)
      validateArgs(entry.kind, rest)
      return { cmd: entry.prefix[0]!, args: tokens.slice(1), kind: entry.kind }
    }
  }

  throw notAllowed(command)
}

function validateArgs(kind: ArgKind, rest: readonly string[]): void {
  switch (kind) {
    case 'exact':
      return
    case 'vitest-args':
      for (const token of rest) assertSafeToken(token, 'vitest')
      return
    case 'git-paths':
      for (const token of rest) {
        if (token.startsWith('-') || token.startsWith('/')) {
          throw new KernelError('invalid_input', `git add takes repo-relative paths only, got: "${token}"`)
        }
        assertSafeToken(token, 'git add')
      }
      return
    case 'commit-message': {
      for (const token of rest) {
        if (token.startsWith('-')) {
          throw new KernelError('invalid_input', `git commit message tokens cannot be flags: "${token}"`)
        }
      }
      return
    }
    case 'fs-paths':
      for (const token of rest) {
        if (token.startsWith('-') || token.startsWith('/')) {
          throw new KernelError('invalid_input', `fs command takes worktree-relative paths only, got: "${token}"`)
        }
        assertSafeToken(token, 'fs')
      }
      return
    case 'node-script': {
      const [script, ...args] = rest
      if (script === undefined || !script.startsWith('scripts/')) {
        throw new KernelError(
          'invalid_input',
          `node entry of the repo.run allowlist runs scripts under scripts/ only, got: "${script ?? ''}"`,
        )
      }
      assertSafeToken(script, 'node script')
      for (const token of args) assertSafeToken(token, 'node')
      return
    }
  }
}
