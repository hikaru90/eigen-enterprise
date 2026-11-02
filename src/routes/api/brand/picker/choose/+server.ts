import type { RequestHandler } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { z } from 'zod'
import { getUserRole } from '$lib/server/auth/user-role'
import { pickerTree } from '$lib/server/brand/picker'
import { executeBrandTool, parseJsonBody } from '../../handler'

/**
 * "Choose this style" (plan/phase-brand-picker.md §3.3): the owner's click makes
 * a final-level picker node the company's active visual set. Owner-only, fail
 * closed — admins and members browse the picker but cannot choose. Not
 * approval-gated: the click is the owner's own human action (D11 precedent);
 * brand.picker_choose re-checks owner + human in the kernel.
 */
const bodySchema = z.object({ nodeId: z.string().min(1) })

export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) redirect(302, '/login')
  if ((await getUserRole(user.id)) !== 'owner') error(403, 'Only the owner can choose the company style')
  const body = bodySchema.safeParse(await parseJsonBody(event.request))
  if (!body.success) error(400, 'nodeId is required')
  const node = pickerTree().get(body.data.nodeId)
  if (!node) error(404, `Unknown style "${body.data.nodeId}"`)
  if (node.level !== 'variant') error(400, `"${node.name}" is not a final style — open it and choose one of its variants`)
  return executeBrandTool('brand.picker_choose', { nodeId: node.id }, user, ['owner', 'admin'])
}
