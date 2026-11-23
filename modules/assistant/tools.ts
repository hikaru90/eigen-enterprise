import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { renameRunBody } from '$lib/agent-runs/rename'
import { KernelError } from '$lib/kernel/errors'
import { ASSISTANT_MODULE_ID } from './manifest'

/**
 * assistant.* tools: renaming one of your own conversations — the same
 * effect as PATCH /api/agent/runs/[id] (runViewAccess + the runs source's
 * rename, which lets only the run's owner name it).
 */

export type ConversationsPort = {
  /** The route's access check: a company member (or why not). */
  access(userId: string): Promise<{ ok: true } | { ok: false; error: string }>
  rename(userId: string, runId: number, title: string): Promise<{ ok: true; run: unknown } | { ok: false; status: number; error: string }>
}

const renameInput = renameRunBody.extend({ run_id: z.number().int().positive() }).strict()

async function livePort(): Promise<ConversationsPort> {
  const [{ runViewAccess }, { agentRunsSource }] = await Promise.all([
    import('$lib/server/agent-runs/access'),
    import('$lib/server/agent-runs/source'),
  ])
  return {
    access: async (userId) => {
      const a = await runViewAccess({ id: userId })
      return a.ok ? { ok: true } : { ok: false, error: a.error }
    },
    rename: (userId, runId, title) => agentRunsSource().rename(userId, runId, title),
  }
}

function personOf(ctx: ToolContext): string {
  if (ctx.principal.kind !== 'human') {
    throw new KernelError('no_person', 'A conversation belongs to a person; this call runs as no person.')
  }
  return ctx.principal.id
}

export function createAssistantTools(opts: { port?: () => Promise<ConversationsPort> } = {}): ToolDescriptor[] {
  const port = opts.port ?? livePort
  return [
    {
      name: 'assistant.conversation_rename',
      module: ASSISTANT_MODULE_ID,
      summary:
        'Give one of your own conversations with the company agent a name (run_id: the agent run’s id; title: at most 120 characters). Only the person the conversation ran for may name it.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof renameInput>) => `Renamed a conversation to “${input.title.trim()}”`,
      inputSchema: renameInput,
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx, input) => {
        const i = renameInput.parse(input)
        const userId = personOf(ctx)
        const p = await port()
        const access = await p.access(userId)
        if (!access.ok) throw new KernelError('permission_denied', access.error)
        const out = await p.rename(userId, i.run_id, i.title)
        if (!out.ok) throw new KernelError(out.status === 404 ? 'invalid_input' : 'permission_denied', out.error)
        return { run: out.run }
      },
    },
  ]
}
