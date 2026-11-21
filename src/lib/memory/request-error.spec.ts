import { describe, expect, it } from 'vitest'
import { agentIn, RequestError, requestErrorOf, shownOf } from './request-error'

const agent = { attempted: 'Creating a project', nextSteps: ['Read the journal.'] }

describe('requestErrorOf: a refused memory/timeline request as the page shows it', () => {
  it('reads the one error shape ({ error, agent })', async () => {
    const res = new Response(JSON.stringify({ error: 'label is required', agent }), { status: 400 })
    expect((await requestErrorOf(res)).shown).toEqual({ error: 'label is required', agent })
  })

  it('reads a SvelteKit error body ({ message, agent }) from handleError', async () => {
    const res = new Response(JSON.stringify({ message: 'Internal Error', agent }), { status: 500 })
    expect((await requestErrorOf(res)).shown).toEqual({ error: 'Internal Error', agent })
  })

  it('keeps a plain-text body as the sentence, and says the status when there is none', async () => {
    expect((await requestErrorOf(new Response('Gateway down', { status: 502 }))).shown).toEqual({
      error: 'Gateway down',
      agent: null,
    })
    expect((await requestErrorOf(new Response('', { status: 503 }))).shown).toEqual({
      error: 'Request failed (503)',
      agent: null,
    })
  })
})

describe('shownOf', () => {
  it('carries a RequestError as it is and any other error as its message', () => {
    expect(shownOf(new RequestError({ error: 'x', agent }))).toEqual({ error: 'x', agent })
    expect(shownOf(new Error('network down'))).toEqual({ error: 'network down', agent: null })
    expect(shownOf('boom')).toEqual({ error: 'boom', agent: null })
  })
})

describe('agentIn', () => {
  it('finds the agent report in a body text, and none in plain text', () => {
    expect(agentIn(JSON.stringify({ error: 'x', agent }))).toEqual(agent)
    expect(agentIn('Bad Gateway')).toBeNull()
  })
})
