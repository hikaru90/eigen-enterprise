import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { defaultRoadmapStore, type RoadmapItem, type RoadmapStore } from './store'

/**
 * Kernel tool descriptors over the RoadmapStore. The store is injected
 * (tests pass an InMemoryRoadmapStore; production resolves the DB lazily per
 * operation via defaultRoadmapStore). Handlers stay thin — the registry
 * pipeline covers permissions, audit, and vcs commits, and schemas are parsed
 * here for typed inputs (same idiom as the website module).
 */

export type RoadmapToolDeps = {
  store?: RoadmapStore
}

const roadmapStatus = z.enum(['shipped', 'in_progress', 'planned'])
const roadmapKind = z.enum(['feature', 'fix', 'chore'])

const listItemsInput = z.object({}).strict()

const addItemInput = z.object({
  title: z.string().min(1),
  detail: z.string().default(''),
  status: roadmapStatus.default('planned'),
  kind: roadmapKind.default('feature'),
  position: z.number().int().nonnegative().optional(),
})

const updateItemInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  detail: z.string().optional(),
  status: roadmapStatus.optional(),
  kind: roadmapKind.optional(),
  position: z.number().int().nonnegative().optional(),
})

/** Kernel descriptors for the roadmap surface. */
export function createRoadmapTools(deps: RoadmapToolDeps = {}): ToolDescriptor[] {
  const store = deps.store ?? defaultRoadmapStore()

  return [
    {
      name: 'roadmap.list_items',
      module: 'roadmap',
      summary:
        "List the company's roadmap items — the shipped build log first, then work in progress, then the planned queue (ordered by status, then position).",
      auditClass: 'read',
      inputSchema: listItemsInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async () => store.list(),
    },
    {
      name: 'roadmap.add_item',
      module: 'roadmap',
      summary:
        'Add one roadmap item (title required; detail defaults to empty, status to planned, kind to feature). Born-shipped items get shipped_at stamped.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof addItemInput>) => `Added “${input.title}” to the roadmap`,
      inputSchema: addItemInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const parsed = addItemInput.parse(input)
        return store.create({
          title: parsed.title,
          detail: parsed.detail,
          status: parsed.status,
          kind: parsed.kind,
          ...(parsed.position === undefined ? {} : { position: parsed.position }),
        })
      },
    },
    {
      name: 'roadmap.update_item',
      module: 'roadmap',
      summary:
        "Patch one roadmap item by id (title, detail, status, kind, position). Moving status to 'shipped' stamps shipped_at; moving away clears it. Fails loud on an unknown id.",
      auditClass: 'mutate',
      activity: (input: z.infer<typeof updateItemInput>, output?: RoadmapItem) => {
        const title = output?.title ?? input.title
        return title === undefined ? 'Updated a roadmap item' : `Updated the roadmap item “${title}”`
      },
      inputSchema: updateItemInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const parsed = updateItemInput.parse(input)
        return store.update(parsed.id, {
          ...(parsed.title === undefined ? {} : { title: parsed.title }),
          ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
          ...(parsed.status === undefined ? {} : { status: parsed.status }),
          ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
          ...(parsed.position === undefined ? {} : { position: parsed.position }),
        })
      },
    },
  ]
}
