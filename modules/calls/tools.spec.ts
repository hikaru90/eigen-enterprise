import { describe, expect, it } from 'vitest'
import { CALLS_TOOL_NAMES, CALLS_WRITE_TOOLS } from './manifest'
import { fixture } from './test-fixtures'
import { createCallsTools } from './tools'

function setup() {
  const f = fixture()
  const tools = createCallsTools({ service: async () => f.service })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const human = (id: string) => ({
    principal: { id, kind: 'human' as const, roles: ['admin'] },
    requestId: 'r',
  })
  const agent = {
    principal: { id: 'agent:1', kind: 'agent' as const, roles: ['agent'] },
    requestId: 'r',
  }
  return { ...f, tools, tool, human, agent }
}

describe('calls.* tools', () => {
  it('declares the manifest’s tools with their audit classes; start is approval-risk internal', () => {
    const { tools, tool } = setup()
    expect(tools.map((t) => t.name)).toEqual([...CALLS_TOOL_NAMES])
    for (const name of CALLS_WRITE_TOOLS) expect(tool(name).approvalRisk).toBeDefined()
    expect(tool('calls.schedule')).toMatchObject({
      auditClass: 'external',
      approvalRisk: 'external',
    })
    expect(tool('calls.invite_guests')).toMatchObject({
      auditClass: 'external',
      approvalRisk: 'external',
    })
    expect(tool('calls.brain_recap').auditClass).toBe('read')
    expect(tool('calls.list').auditClass).toBe('read')
    expect(tool('calls.start')).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    expect(tool('calls.end').auditClass).toBe('mutate')
    expect(tool('calls.start').activity!({ context_kind: 'meeting' }, undefined)).toBe(
      'Tried to start a meeting',
    )
  })

  it('no tool hands out a media token', async () => {
    const { tools, agent, tool } = setup()
    const { call } = (await tool('calls.start').handler(agent, {
      context_kind: 'meeting',
      user_ids: ['ann'],
    })) as { call: { id: string } }
    for (const t of tools) expect(t.name).not.toMatch(/token|join/)
    const listed = JSON.stringify(await tool('calls.list').handler(agent, {}))
    expect(listed).toContain(call.id)
    expect(listed).not.toMatch(/eyJ/) // no JWT anywhere in what the agent sees
  })

  it('the agent starts and ends a meeting; it cannot ring a DM', async () => {
    const { tool, agent } = setup()
    await expect(
      tool('calls.start').handler(agent, { context_kind: 'dm', context_id: 'dm-ann-ben' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    const out = (await tool('calls.start').handler(agent, {
      context_kind: 'meeting',
      user_ids: ['ann', 'ben'],
      title: 'Weekly',
    })) as {
      call: { id: string; title: string }
    }
    expect(out.call.title).toBe('Weekly')
    expect(tool('calls.start').activity!({ context_kind: 'meeting' }, out)).toBe(
      'Started a call: Weekly (2 people)',
    )
    expect(await tool('calls.end').handler(agent, { call_id: out.call.id })).toMatchObject({
      call: { state: 'missed' },
    })
  })

  it('a person acts as themselves (membership checked)', async () => {
    const { tool, human } = setup()
    const out = (await tool('calls.start').handler(human('ann'), {
      context_kind: 'dm',
      context_id: 'dm-ann-ben',
    })) as { call: { id: string } }
    expect(await tool('calls.list').handler(human('ben'), {})).toMatchObject({
      calls: [{ id: out.call.id }],
    })
    expect(await tool('calls.list').handler(human('cat'), {})).toEqual({ calls: [], summaries: {} })
    await expect(
      tool('calls.end').handler(human('cat'), { call_id: out.call.id }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects unknown input keys', async () => {
    const { tool, agent } = setup()
    await expect(tool('calls.end').handler(agent, { call_id: 'x', force: true })).rejects.toThrow()
  })

  it('books a meeting now or later with guests and a duration; invites more guests; removes one — as the host', async () => {
    const { tool, human, mail, clock } = setup()
    const later = new Date(clock.now().getTime() + 2 * 3_600_000).toISOString()
    const out = (await tool('calls.schedule').handler(human('ann'), {
      guests: ['kunde@example.org'],
      user_ids: ['ben'],
      starts_at: later,
      duration_minutes: 30,
      title: 'Kick-off',
      time_zone: 'Europe/Berlin',
    })) as {
      call: { id: string; title: string; scheduledStart: string; scheduledEnd: string }
      invitations: Array<{ guestId: string; emailed: boolean }>
    }
    expect(out.call).toMatchObject({ title: 'Kick-off', scheduledStart: later })
    expect(Date.parse(out.call.scheduledEnd) - Date.parse(later)).toBe(30 * 60_000)
    expect(out.invitations).toMatchObject([{ emailed: true }])

    const more = (await tool('calls.invite_guests').handler(human('ann'), {
      call_id: out.call.id,
      guests: ['amt@behoerde.de'],
      time_zone: 'UTC',
    })) as {
      invitations: Array<{ guestId: string }>
    }
    expect(mail.sent.map((m) => m.to)).toEqual(['kunde@example.org', 'amt@behoerde.de'])
    await expect(
      tool('calls.invite_guests').handler(human('ben'), {
        call_id: out.call.id,
        guests: ['x@y.de'],
        time_zone: 'UTC',
      }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    })
    const removed = (await tool('calls.remove_guest').handler(human('ann'), {
      call_id: out.call.id,
      guest_id: more.invitations[0]!.guestId,
    })) as {
      call: { guests: Array<{ email: string; revoked: boolean }> }
    }
    expect(removed.call.guests.map((g) => [g.email, g.revoked])).toEqual([
      ['kunde@example.org', false],
      ['amt@behoerde.de', true],
    ])
  })

  it('the agent on its own books no meetings and has no Brain switch (a person’s act)', async () => {
    const { tool, agent } = setup()
    await expect(
      tool('calls.schedule').handler(agent, { guests: ['a@b.de'], time_zone: 'UTC' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      tool('calls.brain_set').handler(agent, { call_id: 'x', on: true }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      tool('calls.remove_guest').handler(agent, { call_id: 'x', guest_id: 'g' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('the Brain in a call: on, an answer shared, off; the recap after the call for whoever switched it on', async () => {
    const f = setup()
    const call = await f.service.start(f.user('ann'), {
      contextKind: 'dm',
      contextId: 'dm-ann-ben',
    })
    await f.service.accept('ben', call.id)
    for (const identity of ['ann', 'ben'])
      await f.service.applyWebhook({
        kind: 'participant_joined',
        room: `ee-call-${call.id}`,
        identity,
      })
    const on = (await f
      .tool('calls.brain_set')
      .handler(f.human('ann'), { call_id: call.id, on: true })) as {
      call: { brain: { listening: boolean } }
    }
    expect(on.call.brain.listening).toBe(true)
    f.clock.tick(30_000)
    f.speech.next('Wir machen das Angebot fertig.')
    await f.service.transcribeChunk('ben', call.id, {
      bytes: new Uint8Array(3).fill(7),
      format: 'webm',
      durationMs: 30_000,
    })
    f.brain.next('The offer.')
    const answer = await f.service.askBrain('ann', call.id, 'What did we agree?')
    const shared = (await f
      .tool('calls.brain_share_answer')
      .handler(f.human('ann'), { call_id: call.id, answer_id: answer.id })) as {
      call: { brain: { shared: Array<{ id: string }> } }
    }
    expect(shared.call.brain.shared.map((a) => a.id)).toEqual([answer.id])
    await expect(
      f
        .tool('calls.brain_share_answer')
        .handler(f.human('ben'), { call_id: call.id, answer_id: answer.id }),
    ).rejects.toMatchObject({ code: 'not_found' })
    const off = (await f
      .tool('calls.brain_set')
      .handler(f.human('ben'), { call_id: call.id, on: false })) as {
      call: { brain: { listening: boolean } }
    }
    expect(off.call.brain.listening).toBe(false)
    await f.service.end(f.user('ann'), call.id)
    f.brain.next('Decided: finish the offer.')
    expect(await f.tool('calls.brain_recap').handler(f.human('ann'), { call_id: call.id })).toEqual(
      { recap: 'Decided: finish the offer.' },
    )
    await expect(
      f.tool('calls.brain_recap').handler(f.human('ben'), { call_id: call.id }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('the chat in a call: a person writes and reads it (from a cursor); the agent on its own does neither', async () => {
    const { tool, human, agent, service, user } = setup()
    expect(tool('calls.chat_post')).toMatchObject({ auditClass: 'mutate' })
    expect(tool('calls.chat_post').approvalRisk).toBeUndefined() // like messages.post: a person's own line
    expect(tool('calls.chat_read').auditClass).toBe('read')
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await service.accept('ben', call.id)
    const { message } = (await tool('calls.chat_post').handler(human('ben'), {
      call_id: call.id,
      body: 'Agenda kommt',
    })) as {
      message: { seq: number; body: string; authorName: string }
    }
    expect(message).toMatchObject({ body: 'Agenda kommt', authorName: 'Ben Example' })
    expect(tool('calls.chat_post').activity!({ call_id: call.id, body: 'x' }, { message })).toBe(
      `Wrote in the chat of call ${call.id}`,
    )
    await tool('calls.chat_post').handler(human('ann'), { call_id: call.id, body: 'Danke' })
    const all = (await tool('calls.chat_read').handler(human('ann'), { call_id: call.id })) as {
      messages: { body: string }[]
      hasMore: boolean
    }
    expect(all).toMatchObject({
      messages: [{ body: 'Agenda kommt' }, { body: 'Danke' }],
      hasMore: false,
    })
    const after = (await tool('calls.chat_read').handler(human('ann'), {
      call_id: call.id,
      since: message.seq,
    })) as { messages: { body: string }[] }
    expect(after.messages.map((m) => m.body)).toEqual(['Danke'])
    await expect(
      tool('calls.chat_post').handler(agent, { call_id: call.id, body: 'hi' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      tool('calls.chat_read').handler(agent, { call_id: call.id }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      tool('calls.chat_read').handler(human('cat'), { call_id: call.id }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      tool('calls.chat_post').handler(human('ann'), { call_id: call.id, body: 'x', extra: 1 }),
    ).rejects.toThrow()
  })
})
