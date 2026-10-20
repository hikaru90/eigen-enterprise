import { appKernel } from '$lib/server/boot'
import type { PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { brandModuleState } from '$lib/server/brand/activation'
import { bootstrapKernel } from '../../../../modules/index'

/**
 * Selection wizard surface (phase-2d M4, V7). Owner/admin only: loads the
 * static corpus (clusters + card summaries) and the existing visual sets
 * through the kernel registry — the same path MCP uses. When the brand module
 * is inactive the load returns a notice flag instead of failing: the owner
 * sees the activation notice BEFORE anything starts (owner directive).
 */
export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const { active } = await brandModuleState(user)
  if (!active) return { needsModuleActivation: true as const, corpus: null, drafts: null }

  const kernel = await appKernel()
  const context = {
    principal: { id: user.id, kind: 'human' as const, roles: ['admin'] },
    requestId: randomUUID(),
  }

  const corpus = (await kernel.registry.execute('brand.corpus_list', {}, context)) as {
    builtAt: string
    itemCount: number
    clusters: {
      id: string
      name: string
      memberIds: string[]
      adjacentClusterIds: string[]
      adjacentClusters: { id: string; name: string }[]
    }[]
    items: {
      id: string
      name: string
      provenanceSource: string
      cssVars: Record<string, string>
      darkCssVars?: Record<string, string>
    }[]
  }
  const drafts = (await kernel.registry.execute('brand.visual_set_list', {}, context)) as {
    id: string
    status: string
    name: string
    sourceItemId: string | null
    pickedItemIds: string[]
  }[]

  return { needsModuleActivation: false as const, corpus, drafts }
}
