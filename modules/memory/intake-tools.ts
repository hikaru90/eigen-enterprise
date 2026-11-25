import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import {
  BRAIN_INTAKE_LIMIT,
  BRAIN_INTAKE_MAX_LIMIT,
  type BrainIntake,
} from '$lib/memory/brain-intake'
import { liveMemoryWriterOf, requireWriter, type MemoryWriter } from './assistant-writes'
import { INTAKE_TOOL_NAMES } from './manifest'

/**
 * Memory › What the brain took in (Contribute 30a8d920 part 2) as a registry read:
 * the page runs this same tool as the signed-in person, so the CLI, MCP and the
 * agent see exactly what the person sees (ui-parity: reads need a tool too).
 * It reads as the person (assistant-writes.ts: the brain reads for the person it
 * answers, a co-worker its own Memory); there is no user id to pass, so nobody
 * reads someone else's intake. Who sees which items: src/lib/server/memory/brain-intake.ts.
 */

export { INTAKE_TOOL_NAMES }

export type IntakeToolDeps = {
  /** The intake as one reader sees it (live: loadBrainIntake over the database). */
  load?: (readerId: string, limit: number) => Promise<BrainIntake>
  writerOf?: (ctx: ToolContext) => Promise<MemoryWriter | null>
}

async function liveLoad(readerId: string, limit: number): Promise<BrainIntake> {
  const [{ loadBrainIntake }, { liveBrainIntakeStore }] = await Promise.all([
    import('$lib/server/memory/brain-intake'),
    import('$lib/server/memory/brain-intake-store'),
  ])
  return loadBrainIntake(readerId, { limit }, liveBrainIntakeStore)
}

const intakeInput = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(BRAIN_INTAKE_MAX_LIMIT)
      .optional()
      .describe(
        `How many of the newest items to list (default ${BRAIN_INTAKE_LIMIT}, at most ${BRAIN_INTAKE_MAX_LIMIT}).`,
      ),
  })
  .strict()

export function createIntakeTools(opts: IntakeToolDeps = {}): ToolDescriptor[] {
  const load = opts.load ?? liveLoad
  const writerOf = opts.writerOf ?? liveMemoryWriterOf
  return [
    {
      name: 'memory.intake',
      module: 'memory',
      summary:
        'What the company brain has taken in, as far as the person may see it (Memory › What the brain took in): totals and counts per source (source.kind: app_input | assistant | connected_agent | cli_or_mcp | app | evaluation | unrecorded for thoughts; own_document | shared_document for documents) for the last 24 hours, 7 days, 30 days and all time, and the newest items (when, source, title, link). Covers the person’s own thoughts, their documents and the documents colleagues share — never a colleague’s thoughts or private documents.',
      permission: { roles: ['admin', 'member', 'agent'] },
      auditClass: 'read',
      inputSchema: intakeInput,
      handler: async (ctx, input) => {
        const parsed = intakeInput.parse(input ?? {})
        const w = requireWriter(await writerOf(ctx))
        return load(w.userId, parsed.limit ?? BRAIN_INTAKE_LIMIT)
      },
    },
  ]
}
