import type { PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import type { PickerCard } from '$lib/components/brand-picker/types'
import { getUserRole } from '$lib/server/auth/user-role'
import { pickerTree } from '$lib/server/brand/picker'
import { defaultBrandStore } from '../../../../modules/brand/store'

/**
 * The brand picker (plan/phase-brand-picker.md §3.3): drill down the
 * precompiled style index — genres → styles → variants — one level per URL
 * step (`?style=<node id>`). Every signed-in member may browse; only the owner
 * may choose (`canChoose`, enforced again by POST /api/brand/picker/choose).
 * Brand is a system module (always on): no activation step precedes the picker.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  const user = locals.user
  if (!user) redirect(302, '/login')

  const tree = pickerTree()
  const styleId = url.searchParams.get('style')
  const current = styleId === null ? null : tree.get(styleId)
  if (styleId !== null && current === null) error(404, `Unknown style "${styleId}"`)

  const toCard = (n: (typeof tree.nodes)[number]): PickerCard => {
    if (!n.preview) throw new Error(`picker node "${n.id}" has no preview`) // validated at load; narrows the type
    return {
      id: n.id,
      level: n.level,
      parentId: n.parentId,
      name: n.name,
      description: n.description,
      preview: n.preview,
    }
  }

  const activeSet = await defaultBrandStore().findActiveVisualSet()
  const activeNode = activeSet?.pickerNodeId ? tree.get(activeSet.pickerNodeId) : null

  return {
    canChoose: (await getUserRole(user.id)) === 'owner',
    current: current ? toCard(current) : null,
    trail: current ? tree.trail(current.id).map(toCard) : [],
    children: tree.children(current?.id ?? null).map(toCard),
    active: activeSet
      ? {
          name: activeSet.name,
          nodeId: activeNode ? activeNode.id : null,
          path: activeNode ? tree.trail(activeNode.id).map((n) => n.name) : [],
        }
      : null,
  }
}
