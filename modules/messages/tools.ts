import type { Conversation } from './store'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { MESSAGES_MODULE_ID } from './manifest'
import { listConversations, listMessages, messagePage, type MessagesDeps } from './service'

/**
 * messages.* kernel tools — read only. A person reads what they may see (their
 * channels and their DMs). Any other principal (the agent) reads only what the
 * whole company may see: channels with a company grant; never private channels
 * or DMs.
 */

const listInput = z.object({}).strict()
const readInput = z
  .object({
    conversation_id: z.string().uuid().optional(),
    channel: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    before_id: z.string().uuid().optional(),
  })
  .strict()
  .refine((i) => (i.conversation_id ? 1 : 0) + (i.channel ? 1 : 0) === 1, {
    message: 'pass exactly one of conversation_id or channel',
  })

async function liveDeps(): Promise<MessagesDeps> {
  const { messagesDeps } = await import('./live')
  return messagesDeps()
}

/** Public channels carry the company grant (set at creation, never changed in C1). */
async function companyChannel(_d: MessagesDeps, c: Conversation): Promise<boolean> {
  return c.kind === 'channel' && !c.archived && !c.private
}

async function companyChannels(d: MessagesDeps): Promise<Conversation[]> {
  const out: Conversation[] = []
  for (const c of await d.store.listChannels()) if (await companyChannel(d, c)) out.push(c)
  return out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}

const isPerson = (ctx: ToolContext) => ctx.principal.kind === 'human'

export function createMessagesTools(opts: { deps?: () => Promise<MessagesDeps> } = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  return [
    {
      name: 'messages.list_channels',
      module: MESSAGES_MODULE_ID,
      summary:
        'List the team chat conversations you may read: channels (and, for a person, their direct messages) with unread counts.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx) => {
        const d = await deps()
        if (isPerson(ctx)) return { conversations: await listConversations(d, ctx.principal.id) }
        return {
          conversations: (await companyChannels(d)).map((c) => ({ id: c.id, kind: c.kind, title: c.name, topic: c.topic })),
        }
      },
    },
    {
      name: 'messages.read',
      module: MESSAGES_MODULE_ID,
      summary:
        'Read recent messages (Markdown) of one conversation you may see, by conversation_id or channel name; page back with before_id.',
      auditClass: 'read',
      inputSchema: readInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = readInput.parse(input)
        const d = await deps()
        let id = i.conversation_id ?? null
        if (i.channel) {
          const c = await d.store.findChannelByName(i.channel.replace(/^#/, ''))
          if (!c) throw new Error('conversation not found')
          id = c.id
        }
        if (isPerson(ctx)) return listMessages(d, ctx.principal.id, id!, { limit: i.limit, beforeId: i.before_id })
        const c = await d.store.getConversation(id!)
        if (!c || !(await companyChannel(d, c))) throw new Error('conversation not found')
        return messagePage(d, c, { limit: i.limit, beforeId: i.before_id })
      },
    },
  ]
}
