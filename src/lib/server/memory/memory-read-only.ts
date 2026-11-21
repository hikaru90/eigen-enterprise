/**
 * A colleague's shared project or note is read-only for everyone but its owner
 * (plan/shared-memory-voice-agent-tools.md §1). Writes to one fail loud with
 * this error — the API answers 403, the registry permission_denied — instead
 * of a silent no-op or a misleading "not found".
 */
export class MemoryReadOnlyError extends Error {
  readonly ownerName: string

  constructor(kind: 'project' | 'note', ownerName: string) {
    super(`That ${kind} is ${ownerName}’s: it is read-only for you. Only its owner changes it.`)
    this.name = 'MemoryReadOnlyError'
    this.ownerName = ownerName
  }
}

export function isMemoryReadOnlyError(err: unknown): err is MemoryReadOnlyError {
  return err instanceof MemoryReadOnlyError
}
