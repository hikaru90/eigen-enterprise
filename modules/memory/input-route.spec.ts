import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import { INPUT_ROUTES, memoryInputRoute, ROUTE_ASK_BELOW, routeInput, type RouteDeps, type RouteJev } from './input-route'

function setup(jev: RouteJev | Error) {
  const filed: Array<{ route: string; userId: string; text: string; via: string }> = []
  const unfiled: Array<{ route: string; id: string }> = []
  const labels: Array<{ decisionId: string; choice: string; userId: string }> = []
  const decided: string[] = []
  const deps: RouteDeps = {
    async decide(input) {
      decided.push(input.text)
      if (jev instanceof Error) throw jev
      return jev
    },
    async label(decisionId, choice, userId) {
      labels.push({ decisionId, choice, userId })
    },
    async file(route, userId, text, via) {
      filed.push({ route, userId, text, via })
      return { id: `${route}-1`, url: `/m/memory/${route}` }
    },
    async unfile(route, _userId, id) {
      unfiled.push({ route, id })
    },
  }
  return { deps, filed, unfiled, labels, decided }
}

const sure = (choice: (typeof INPUT_ROUTES)[number], confidence = 0.9): RouteJev => ({
  decisionId: 'd-1',
  choice,
  confidence,
  distribution: { [choice]: confidence, question: 1 - confidence },
})
const me = { kind: 'self' as const, userId: 'ony' }

describe('memory.input_route (the one door, M1)', () => {
  it('is a closed set Jev decides, enforced, logging only the length of the private text', () => {
    expect(memoryInputRoute.choices).toEqual(['question', 'remember', 'task', 'document', 'reminder'])
    expect(memoryInputRoute.status).toBe('enforced')
    expect(memoryInputRoute.logInput({ userId: 'ony', text: 'Call Acme on Friday' })).toEqual({ textChars: 19 })
    expect(memoryInputRoute.state({ userId: 'ony', text: 'Call Acme on Friday' })).toContain('Call Acme on Friday')
  })

  it('files a thing to remember, a task and a document with no chat turn', async () => {
    for (const route of ['remember', 'task', 'document'] as const) {
      const { deps, filed } = setup(sure(route))
      const r = await routeInput(deps, me, { text: '  Acme pays net 30.  ' })
      expect(r).toEqual({ outcome: 'filed', route, id: `${route}-1`, url: `/m/memory/${route}`, decisionId: 'd-1', confidence: 0.9, source: 'jev' })
      expect(filed).toEqual([{ route, userId: 'ony', text: 'Acme pays net 30.', via: 'self' }])
    }
  })

  it('a question opens the chat; a reminder goes to the chat too (the assistant writes its time), nothing is filed', async () => {
    for (const route of ['question', 'reminder'] as const) {
      const { deps, filed } = setup(sure(route))
      expect(await routeInput(deps, me, { text: 'What did Acme say?' })).toEqual({ outcome: 'chat', route, decisionId: 'd-1', confidence: 0.9, source: 'jev' })
      expect(filed).toEqual([])
    }
  })

  it('below the threshold it asks the person instead of guessing: nothing filed, the choices most likely first', async () => {
    const { deps, filed } = setup({ decisionId: 'd-2', choice: 'task', confidence: ROUTE_ASK_BELOW - 0.01, distribution: { task: 0.59, remember: 0.3, question: 0.11 } })
    const r = await routeInput(deps, me, { text: 'Acme renewal' })
    expect(r).toEqual({ outcome: 'unsure', decisionId: 'd-2', choices: ['task', 'remember', 'question', 'document', 'reminder'] })
    expect(filed).toEqual([])
  })

  it('the person’s choice skips Jev and is logged as the label of the decision it corrects', async () => {
    const { deps, filed, labels, decided } = setup(sure('task'))
    const r = await routeInput(deps, me, { text: 'Acme renewal', as: 'remember', decision_id: 'd-2' })
    expect(decided).toEqual([])
    expect(r).toMatchObject({ outcome: 'filed', route: 'remember', decisionId: 'd-2', confidence: null, source: 'person' })
    expect(labels).toEqual([{ decisionId: 'd-2', choice: 'remember', userId: 'ony' }])
    expect(filed).toHaveLength(1)
  })

  it('change: files it anew first, then removes what it filed before', async () => {
    const { deps, filed, unfiled } = setup(sure('task'))
    const r = await routeInput(deps, me, { text: 'Acme renewal', as: 'document', decision_id: 'd-1', replaces: { route: 'task', id: 'task-9' } })
    expect(r).toMatchObject({ outcome: 'filed', route: 'document' })
    expect(filed.map((f) => f.route)).toEqual(['document'])
    expect(unfiled).toEqual([{ route: 'task', id: 'task-9' }])
  })

  it('a Jev failure fails loud — nothing is filed, no fallback to the chat model', async () => {
    const { deps, filed } = setup(new Error('jev down'))
    await expect(routeInput(deps, me, { text: 'x' })).rejects.toThrow('jev down')
    expect(filed).toEqual([])
  })

  it('refuses an empty input and a replace without the person’s choice', async () => {
    const { deps } = setup(sure('task'))
    await expect(routeInput(deps, me, { text: '   ' })).rejects.toBeInstanceOf(KernelError)
    await expect(routeInput(deps, me, { text: 'x', replaces: { route: 'task', id: 't' } })).rejects.toBeInstanceOf(KernelError)
  })
})
