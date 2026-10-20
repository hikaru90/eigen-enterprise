import path from 'node:path'
import { KernelError } from '$lib/kernel/errors'

/**
 * Worktree-subpath safety for repo.read_file / repo.write_file: the resolved
 * path must stay inside the worktree, and secret material (.env*, *.key,
 * *.pem) is blocked for reads AND writes — reading it is exfiltration.
 */

/** Any path segment starting `.env`, or a `.key`/`.pem` file — at any depth. */
export function isSecretPath(resolvedPath: string): boolean {
  const segments = resolvedPath.split(path.sep)
  const basename = segments.at(-1) ?? ''
  return (
    segments.some((segment) => segment.startsWith('.env')) ||
    basename.endsWith('.key') ||
    basename.endsWith('.pem')
  )
}

/**
 * Resolve `subPath` against `worktreePath` and fail loud unless it stays
 * strictly inside the worktree (no `..` escapes, no absolute paths outside).
 */
export function resolveInsideWorktree(worktreePath: string, subPath: string): string {
  if (subPath.trim() === '') {
    throw new KernelError('invalid_input', 'a file path is required (worktree-relative)')
  }
  const resolved = path.resolve(worktreePath, subPath)
  const root = path.resolve(worktreePath)
  if (resolved === root) {
    throw new KernelError('invalid_input', 'a file path is required (worktree-relative)')
  }
  if (!resolved.startsWith(root + path.sep)) {
    throw new KernelError('invalid_input', `path escapes the worktree: "${subPath}"`)
  }
  return resolved
}

/**
 * Full guard for read/write file tools: escape checks + secret-path checks.
 * Returns the resolved absolute path.
 */
export function assertSafeSubpath(worktreePath: string, subPath: string, mode: 'read' | 'write'): string {
  const resolved = resolveInsideWorktree(worktreePath, subPath)
  if (isSecretPath(resolved)) {
    throw new KernelError(
      'invalid_input',
      `refusing to ${mode} secret material (.env*, *.key, *.pem): "${subPath}"`,
    )
  }
  return resolved
}
