import { appKernel } from '$lib/server/boot'
import type { PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { bootstrapKernel } from '../../../../../../modules/index'

/**
 * Visual editor surface (phase-2d M6, V8). Owner/admin only: loads one visual
 * set (draft expected — writes are draft-only) through the kernel registry,
 * the same path MCP uses. All edits go through
 * POST /api/brand/visual-sets/[id]/update -> brand.visual_set_update.
 */
export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const setId = z.string().uuid().safeParse(event.params.setId)
  if (!setId.success) {
    error(400, 'setId must be a uuid')
  }
  const kernel = await appKernel()
  const set = (await kernel.registry.execute(
    'brand.visual_set_get',
    { setId: setId.data },
    {
      principal: { id: user.id, kind: 'human' as const, roles: ['admin'] },
      requestId: randomUUID(),
    },
  )) as {
    id: string
    status: string
    name: string
    seeds: Record<string, unknown> | null
    cssVars: Record<string, string>
    darkCssVars: Record<string, string> | null
    pins: Record<string, string>
  } | null

  if (!set) {
    error(404, 'Visual set not found')
  }
  return { set }
}
