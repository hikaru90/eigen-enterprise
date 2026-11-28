import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { intakeItemHref } from '$lib/memory/brain-intake'
import { liveMemoryWriterOf, requireWriter, type MemoryWriter } from './assistant-writes'
import {
  FILED_ROUTES,
  INPUT_ROUTE_TEXT_MAX,
  INPUT_ROUTES,
  memoryInputRoute,
  routeInput,
  type RouteDeps,
  type RouteResult,
} from './input-route'
import { ROUTE_TOOL_NAMES } from './manifest'

/**
 * memory.route_input — the one door (plan/concept-memory-one-door.md M1) as a registry action:
 * the Ask bar runs it as the signed-in person, and the CLI, MCP and the agent reach the same
 * door. Jev routes (input-route.ts); the person's choice skips Jev and labels the decision.
 */

export { ROUTE_TOOL_NAMES }

export type RouteToolDeps = {
  deps?: () => Promise<RouteDeps>
  writerOf?: (ctx: ToolContext) => Promise<MemoryWriter | null>
}

const sourceOf = (via: MemoryWriter['kind']) => (via === 'self' ? ('ui' as const) : ('agent' as const))

async function liveRouteDeps(): Promise<RouteDeps> {
  return {
    async decide(input) {
      const { decide } = await import('$lib/server/decisions/decide')
      const r = await decide(memoryInputRoute, input, { requestedBy: input.userId, subjectUserId: input.userId, judge: { none: true } })
      if (r.outcome !== 'decided' || !r.jev) throw new Error(`memory.input_route: Jev gave no answer (${r.outcome}).`)
      return { decisionId: r.decisionId, choice: r.choice, confidence: r.jev.confidence, distribution: r.jev.distribution }
    },
    async label(decisionId, choice, userId) {
      const { liveDecisionsPort } = await import('$lib/server/decisions/live')
      await liveDecisionsPort.label(userId, decisionId, choice)
    },
    async file(route, userId, text, via) {
      if (route === 'remember') {
        const { captureThought } = await import('$lib/server/capture/service')
        const stored = await captureThought(userId, text, { source: sourceOf(via) })
        return { id: stored.id, url: intakeItemHref('thought', stored.id) }
      }
      if (route === 'task') {
        const { liveOwnTaskService } = await import('$lib/server/memory/own-tasks')
        const { taskId } = await (await liveOwnTaskService()).create(userId, { text, source: via === 'self' ? 'api' : 'agent' })
        return { id: taskId, url: '/m/memory/tasks' }
      }
      // A document is kept as written and private to its writer until they share it.
      const { createTextFile } = await import('$lib/server/text-files/service')
      const file = await createTextFile(userId, { body: text, visibility: 'private' })
      return { id: file.id, url: intakeItemHref('document', file.id) }
    },
    async unfile(route, userId, id) {
      if (route === 'document') {
        const { deleteTextFile } = await import('$lib/server/text-files/service')
        if (!(await deleteTextFile(userId, id))) throw new Error('The document filed before is gone already.')
        return
      }
      const { deleteThoughtForUser } = await import('$lib/server/memory/delete-thought')
      const r = await deleteThoughtForUser(userId, id)
      if (!r.ok) throw new Error('What was filed before could not be removed.')
    },
  }
}

const routeEnum = z.enum(INPUT_ROUTES)
const routeInputSchema = z
  .object({
    text: z.string().min(1).max(INPUT_ROUTE_TEXT_MAX).describe('What the person typed or said, as they said it.'),
    as: routeEnum.optional().describe('The person’s own choice of what it is: Jev is not asked.'),
    decision_id: z.string().min(1).optional().describe('The routing decision this choice corrects (from an earlier result).'),
    replaces: z
      .object({ route: z.enum(FILED_ROUTES), id: z.string().min(1) })
      .strict()
      .optional()
      .describe('What this door filed before for the same input: removed after filing it anew (change).'),
  })
  .strict()

export function createRouteTools(opts: RouteToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveRouteDeps
  const writerOf = opts.writerOf ?? liveMemoryWriterOf
  return [
    {
      name: 'memory.route_input',
      module: 'memory',
      summary:
        'The company brain’s one door: give it what the person said and it decides (Jev, a cheap closed-set model) whether it is a question (answer it in the chat), something to remember, a task, a document (filed in Memory straight away) or a reminder (set it with reminders.create). When unsure it files nothing and returns the choices to ask the person; with `as` the person’s choice is used and logged as the correction of `decision_id`; `replaces` removes what was filed before.',
      permission: { roles: ['admin', 'member', 'agent'] },
      auditClass: 'mutate',
      activity: (_input: unknown, output: unknown) => {
        const r = output as RouteResult | undefined
        if (r?.outcome === 'filed') return `Filed an input in Memory as ${r.route}`
        if (r?.outcome === 'chat') return `Routed an input to the chat (${r.route})`
        return 'Routed an input to the company brain'
      },
      inputSchema: routeInputSchema,
      handler: async (ctx, input) => {
        const i = routeInputSchema.parse(input)
        const w = requireWriter(await writerOf(ctx))
        return routeInput(await deps(), w, i)
      },
    },
  ]
}
