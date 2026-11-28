import { describe, expect, it } from 'vitest'
import { OneDoor } from './one-door.svelte'

type Call = { body: Record<string, unknown> }

function door(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = []
  const asked: string[] = []
  const fetch = (async (_url: string, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) })
    const r = responses.shift()!
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  const d = new OneDoor({ fetch, ask: (text) => asked.push(text) })
  return { d, calls, asked }
}

describe('the one door (Ask bar → memory.route_input)', () => {
  it('a question goes on to the chat; nothing is shown as filed', async () => {
    const { d, asked } = door([{ status: 200, body: { outcome: 'chat', route: 'question', decisionId: 'd', confidence: 0.9, source: 'jev' } }])
    await d.submit('What did Acme say?')
    expect(asked).toEqual(['What did Acme say?'])
    expect(d.state).toEqual({ kind: 'idle' })
  })

  it('a filed input shows the chip; change refiles it with the person’s choice and removes the first', async () => {
    const { d, calls, asked } = door([
      { status: 200, body: { outcome: 'filed', route: 'task', id: 't1', url: '/m/memory/tasks', decisionId: 'd1', confidence: 0.9, source: 'jev' } },
      { status: 200, body: { outcome: 'filed', route: 'remember', id: 'th1', url: '/m/memory/capture?thought=th1', decisionId: 'd1', confidence: null, source: 'person' } },
    ])
    await d.submit('Acme pays net 30')
    expect(d.state).toMatchObject({ kind: 'filed', route: 'task', url: '/m/memory/tasks', text: 'Acme pays net 30' })
    await d.choose('remember')
    expect(calls[1]!.body).toEqual({ text: 'Acme pays net 30', as: 'remember', decision_id: 'd1', replaces: { route: 'task', id: 't1' } })
    expect(d.state).toMatchObject({ kind: 'filed', route: 'remember' })
    expect(asked).toEqual([])
  })

  it('unsure: nothing filed, the person picks; picking question opens the chat', async () => {
    const { d, calls, asked } = door([
      { status: 200, body: { outcome: 'unsure', decisionId: 'd2', choices: ['task', 'question', 'remember', 'document', 'reminder'] } },
      { status: 200, body: { outcome: 'chat', route: 'question', decisionId: 'd2', confidence: null, source: 'person' } },
    ])
    await d.submit('Acme renewal')
    expect(d.state).toMatchObject({ kind: 'unsure', choices: ['task', 'question', 'remember', 'document', 'reminder'] })
    await d.choose('question')
    expect(calls[1]!.body).toEqual({ text: 'Acme renewal', as: 'question', decision_id: 'd2' })
    expect(asked).toEqual(['Acme renewal'])
  })

  it('a failure is shown with the words kept, never dropped', async () => {
    const { d, asked } = door([{ status: 502, body: { error: 'The brain could not take this in: jev down' } }])
    await d.submit('Acme pays net 30')
    expect(d.state).toEqual({ kind: 'failed', text: 'Acme pays net 30', error: 'The brain could not take this in: jev down' })
    expect(asked).toEqual([])
  })
})
