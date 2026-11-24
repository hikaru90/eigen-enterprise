import { KernelError } from '$lib/kernel/errors'
import { PublishPortError } from './publish/port'

/**
 * The box's publish client is stream C's port (./publish/port.ts, copied
 * verbatim on this branch so the merge is identical). This file maps its
 * errors 1:1 to kernel errors, so every modules.* tool answers with a
 * registry code and the hub's own sentence.
 */
export {
  HUB_NOT_CONFIGURED_SENTENCE,
  HUB_UNAVAILABLE_SENTENCE,
  PublishPortError,
  type PublishOutcome,
  type PublishPort,
  type PublishRequest,
  type RunReport,
} from './publish/port'

export function hubKernelError(err: unknown, moduleId: string): unknown {
  if (!(err instanceof PublishPortError)) return err
  const details = { module: moduleId, status: err.status, problems: err.problems, reason: err.reason }
  switch (err.code) {
    case 'hub_unavailable':
      return new KernelError('hub_unavailable', err.message, details)
    case 'hub_refused':
    case 'hub_not_found':
      return new KernelError('invalid_input', err.message, details)
    case 'hub_revoked':
      return new KernelError('permission_denied', err.message, details)
  }
}
