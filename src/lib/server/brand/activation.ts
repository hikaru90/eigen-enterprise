import { randomUUID } from 'node:crypto'
import { KernelError } from '$lib/kernel/errors'
import { bootstrapKernel } from '../../../../modules/index'

/**
 * Branding-module activation surface (phase-2d follow-up: the owner asked to
 * be informed BEFORE activation starts). The kernel module is self-seeded
 * active, so `kernel.module_activate` is reachable while `brand` itself is
 * still inactive; the activation is approval-gated (conversational yes), so
 * the first call halts with `approval_required` and the retry after the
 * owner's chat approval completes it — the same release pattern as
 * `brand.visual_set_activate`.
 */
function context(user: { id: string }) {
  return {
    principal: { id: user.id, kind: 'human' as const, roles: ['admin'] },
    requestId: randomUUID(),
  }
}

export async function brandModuleState(user: { id: string }): Promise<{ active: boolean }> {
  const kernel = bootstrapKernel()
  try {
    await kernel.registry.execute('brand.set_list', {}, context(user))
    return { active: true }
  } catch (err) {
    if (err instanceof KernelError && err.code === 'module_inactive') return { active: false }
    throw err
  }
}

export async function activateBrandModule(
  user: { id: string },
): Promise<{ activated: true } | { pendingApproval: true }> {
  const kernel = bootstrapKernel()
  try {
    await kernel.registry.execute('kernel.module_activate', { module_id: 'brand' }, context(user))
    return { activated: true }
  } catch (err) {
    if (err instanceof KernelError && err.code === 'approval_required') {
      return { pendingApproval: true }
    }
    throw err
  }
}
