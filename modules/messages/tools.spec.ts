import { describe, expect, it } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { PresenceTracker } from '$lib/server/presence/tracker'
import { MESSAGES_TOOL_NAMES, MESSAGES_WRITE_TOOLS } from './manifest'
import { createChannel, openDm, postMessage } from './service'
import { depthFixture, fixture } from './test-fixtures'
import { createMessagesTools } from './tools'

const ctx = (id: string, kind: 'human' | 'agent'): ToolContext => ({
  principal: { id, kind, roles: [kind === 'human' ? 'admin' : 'agent'] },
  requestId: 'r1',
})

async function seeded() {
  const f = fixture()
  const general = await createChannel(f.deps, 'owner', { name: 'general', private: false })
  const lead = await createChannel(f.deps, 'owner', { name: 'leadership', private: true, userIds: ['carl'] })
  const dm = await openDm(f.deps, 'bea', ['carl'])
  await postMessage(f.deps, 'bea', general.id, 'hello **team**')
  await postMessage(f.deps, 'owner', lead.id, 'secret')
  await postMessage(f.deps, 'carl', dm.id, 'private dm')
  const tools = Object.fromEntries(createMessagesTools({ deps: async () => f.deps }).map((t) => [t.name, t]))
  return { ...f, general, lead, dm, tools }
}

describe('messages.* tools (read only)', () => {
  it('every tool is in the manifest', () => {
    expect(createMessagesTools().map((t) => t.name).sort()).toEqual([...MESSAGES_TOOL_NAMES].sort())
  })

  it('the agent sees company-visible channels only — never private channels or DMs', async () => {
    const { tools, general, lead, dm } = await seeded()
    const listed = (await tools['messages.list_channels'].handler(ctx('agent-1', 'agent'), {})) as {
      conversations: Array<{ id: string }>
    }
    expect(listed.conversations.map((c) => c.id)).toEqual([general.id])
    const read = (await tools['messages.read'].handler(ctx('agent-1', 'agent'), { channel: '#general' })) as {
      messages: Array<{ body: string }>
    }
    expect(read.messages.map((m) => m.body)).toEqual(['hello **team**'])
    await expect(tools['messages.read'].handler(ctx('agent-1', 'agent'), { conversation_id: lead.id })).rejects.toThrow(/not found/)
    await expect(tools['messages.read'].handler(ctx('agent-1', 'agent'), { conversation_id: dm.id })).rejects.toThrow(/not found/)
  })

  it('messages.read shows which message a reply quotes (replyTo), so the agent follows the conversation', async () => {
    const { tools, deps, general } = await seeded()
    const [original] = (await tools['messages.read'].handler(ctx('agent-1', 'agent'), { channel: 'general' }) as { messages: Array<{ id: string }> }).messages
    await postMessage(deps, 'carl', general.id, 'agreed', { replyToId: original.id })
    const read = (await tools['messages.read'].handler(ctx('agent-1', 'agent'), { channel: 'general' })) as {
      messages: Array<{ body: string; replyTo: { id: string; snippet: string } | null }>
    }
    expect(read.messages.at(-1)).toMatchObject({ body: 'agreed', replyTo: { id: original.id, snippet: 'hello **team**' } })
  })

  it('a person reads with their own access', async () => {
    const { tools, dm, lead } = await seeded()
    const read = (await tools['messages.read'].handler(ctx('bea', 'human'), { conversation_id: dm.id })) as {
      messages: Array<{ body: string }>
    }
    expect(read.messages.map((m) => m.body)).toEqual(['private dm'])
    await expect(tools['messages.read'].handler(ctx('bea', 'human'), { conversation_id: lead.id })).rejects.toMatchObject({ code: 'not_found' })
  })
})

type Msg = { id: string; body: string; authorId: string; reactions: Array<{ emoji: string }> }

async function writeSetup() {
  const f = depthFixture()
  const tracker = new PresenceTracker(() => new Date(Date.UTC(2026, 10, 12, 9, 0, 0)))
  const pushed: string[] = []
  const tools = Object.fromEntries(
    createMessagesTools({
      deps: async () => f.deps,
      presence: async () => tracker,
      push: (_d, _c, m) => pushed.push(m.id),
    }).map((t) => [t.name, t]),
  )
  const run = (name: string, who: string, input: unknown) => tools[name].handler(ctx(who, 'human'), input)
  return { ...f, tools, tracker, pushed, run }
}

describe('messages.* write tools (the person acts with their own access)', () => {
  it('write tools are persons only (owner decision W-2: the agent principal does not post)', () => {
    for (const t of createMessagesTools().filter((t) => (MESSAGES_WRITE_TOOLS as readonly string[]).includes(t.name))) {
      expect(t.permission.roles).not.toContain('agent')
      expect(t.auditClass).toBe('mutate')
    }
  })

  it('create a channel, post, reply in a thread, read the thread, push fan-out', async () => {
    const { run, pushed } = await writeSetup()
    const { conversation } = (await run('messages.create_channel', 'owner', { name: 'ops', private: true, user_ids: ['bea'] })) as { conversation: { id: string } }
    const { message } = (await run('messages.post', 'bea', { conversation_id: conversation.id, body: 'hi' })) as { message: Msg }
    const reply = (await run('messages.post', 'owner', { conversation_id: conversation.id, body: 'yo', parent_id: message.id })) as { message: Msg; parent: Msg }
    expect(reply.parent.id).toBe(message.id)
    expect(pushed).toEqual([message.id, reply.message.id])
    const thread = (await run('messages.thread', 'bea', { message_id: message.id })) as { parent: Msg; replies: Msg[] }
    expect(thread.replies.map((r) => r.body)).toEqual(['yo'])
    await expect(run('messages.post', 'carl', { conversation_id: conversation.id, body: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    const members = (await run('messages.members', 'bea', { conversation_id: conversation.id })) as { members: Array<{ id: string }> }
    expect(members.members.map((p) => p.id).sort()).toEqual(['bea', 'owner'])
  })

  it('open a DM, edit, react, mark read, delete own; others cannot edit', async () => {
    const { run } = await writeSetup()
    const { conversation } = (await run('messages.open_dm', 'bea', { user_ids: ['carl'] })) as { conversation: { id: string } }
    const { message } = (await run('messages.post', 'bea', { conversation_id: conversation.id, body: 'draft' })) as { message: Msg }
    await run('messages.edit', 'bea', { message_id: message.id, body: 'final' })
    await expect(run('messages.edit', 'carl', { message_id: message.id, body: 'hijack' })).rejects.toMatchObject({ code: 'forbidden' })
    const reacted = (await run('messages.react', 'carl', { message_id: message.id, emoji: '👍' })) as { message: Msg }
    expect(reacted.message.reactions.map((r) => r.emoji)).toEqual(['👍'])
    const before = (await run('messages.list_channels', 'carl', {})) as { conversations: Array<{ id: string; unread: number }> }
    expect(before.conversations.find((c) => c.id === conversation.id)?.unread).toBe(1)
    await run('messages.mark_read', 'carl', { conversation_id: conversation.id })
    const after = (await run('messages.list_channels', 'carl', {})) as { conversations: Array<{ id: string; unread: number }> }
    expect(after.conversations.find((c) => c.id === conversation.id)?.unread).toBe(0)
    await expect(run('messages.delete', 'carl', { message_id: message.id })).rejects.toMatchObject({ code: 'forbidden' })
    await run('messages.delete', 'bea', { message_id: message.id })
    const read = (await run('messages.read', 'carl', { conversation_id: conversation.id })) as { messages: Msg[] }
    expect(read.messages.find((m) => m.id === message.id)?.body ?? '').not.toBe('final')
  })

  it('an owner moderates a channel message (audited)', async () => {
    const { run, audits } = await writeSetup()
    const { conversation } = (await run('messages.create_channel', 'bea', { name: 'random', private: false })) as { conversation: { id: string } }
    const { message } = (await run('messages.post', 'bea', { conversation_id: conversation.id, body: 'oops' })) as { message: Msg }
    await run('messages.delete', 'owner', { message_id: message.id })
    expect(audits.map((a) => a.type)).toEqual(['messages.message_moderated'])
  })

  it('uploads base64 files then attaches them to a post; the Drive limit applies per file', async () => {
    const { run } = await writeSetup()
    const { conversation } = (await run('messages.create_channel', 'bea', { name: 'files', private: false })) as { conversation: { id: string } }
    const up = (await run('messages.upload_attachments', 'bea', {
      conversation_id: conversation.id,
      files: [
        { filename: 'a.txt', mime: 'text/plain', content_base64: Buffer.from('hello').toString('base64') },
        { filename: 'big.bin', mime: 'application/octet-stream', content_base64: Buffer.alloc(2000).toString('base64') },
      ],
    })) as { uploaded: Array<{ fileId: string; name: string }>; errors: string[] }
    expect(up.uploaded.map((u) => u.name)).toEqual(['a.txt'])
    expect(up.errors).toHaveLength(1)
    const { message } = (await run('messages.post', 'bea', { conversation_id: conversation.id, body: 'see file', attachment_ids: [up.uploaded[0].fileId] })) as { message: Msg & { attachments: unknown[] } }
    expect(message.attachments).toHaveLength(1)
  })

  it('do not disturb on and off', async () => {
    const { run } = await writeSetup()
    expect(await run('messages.set_do_not_disturb', 'bea', { do_not_disturb: true })).toMatchObject({ presence: { doNotDisturb: true } })
    expect(await run('messages.set_do_not_disturb', 'bea', { do_not_disturb: false })).toMatchObject({ presence: { doNotDisturb: false } })
  })
})
