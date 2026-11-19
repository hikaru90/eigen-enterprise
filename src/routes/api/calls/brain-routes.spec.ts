import { describe, expect, it } from 'vitest'
import { fixture } from '../../../../modules/calls/test-fixtures'
import * as brainRoute from './[id]/brain/+server'
import * as shareRoute from './[id]/brain/answers/[answerId]/share/+server'
import * as askRoute from './[id]/brain/ask/+server'
import * as recapRoute from './[id]/brain/recap/+server'

/** The Company Brain over HTTP (members only — there are no guest routes). One in-memory service. */
function wire() {
  const f = fixture()
  const service = async () => f.service
  for (const r of [brainRoute, askRoute, shareRoute, recapRoute]) r._deps.service = service
  return f
}

const ev = (over: Record<string, unknown>) => over as never
const as = (id: string | null, extra: Record<string, unknown> = {}) => ({ locals: { user: id ? { id } : null }, ...extra })
const json = (b: unknown) => new Request('http://os.test/api/calls/x/brain', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })

async function liveDm(f: ReturnType<typeof wire>) {
  const call = await f.service.start(f.user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
  await f.service.accept('ben', call.id)
  for (const identity of ['ann', 'ben']) await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity })
  return call.id
}

describe('/api/calls/[id]/brain*', () => {
  it('signed in only', async () => {
    wire()
    const p = { params: { id: 'x', answerId: 'a' } }
    expect((await brainRoute.POST(ev(as(null, { ...p, request: json({ on: true }) })))).status).toBe(401)
    expect((await brainRoute.GET(ev(as(null, p)))).status).toBe(401)
    expect((await askRoute.POST(ev(as(null, { ...p, request: json({ question: 'Q?' }) })))).status).toBe(401)
    expect((await shareRoute.POST(ev(as(null, p)))).status).toBe(401)
    expect((await recapRoute.POST(ev(as(null, p)))).status).toBe(401)
  })

  it('switch on → ask → my answers → share → off; the recap after the call', async () => {
    const f = wire()
    const id = await liveDm(f)
    const on = await brainRoute.POST(ev(as('ann', { params: { id }, request: json({ on: true }) })))
    expect(on.status).toBe(200)
    expect(((await on.json()) as { call: { brain: { listening: boolean } } }).call.brain.listening).toBe(true)

    f.brain.next('Weiß ich nicht.')
    const asked = await askRoute.POST(ev(as('ben', { params: { id }, request: json({ question: 'Wer hat das entschieden?' }) })))
    expect(asked.status).toBe(200)
    const { answer } = (await asked.json()) as { answer: { id: string; answer: string } }
    expect(answer.answer).toBe('Weiß ich nicht.')

    const mine = await brainRoute.GET(ev(as('ben', { params: { id } })))
    expect(((await mine.json()) as { answers: unknown[] }).answers).toHaveLength(1)
    expect(((await (await brainRoute.GET(ev(as('ann', { params: { id } })))).json()) as { answers: unknown[] }).answers).toEqual([])

    const shared = await shareRoute.POST(ev(as('ben', { params: { id, answerId: answer.id } })))
    expect(((await shared.json()) as { call: { brain: { shared: unknown[] } } }).call.brain.shared).toHaveLength(1)
    expect((await shareRoute.POST(ev(as('ann', { params: { id, answerId: answer.id } })))).status).toBe(404)

    expect((await brainRoute.POST(ev(as('ben', { params: { id }, request: json({ on: false }) })))).status).toBe(200)
    expect((await askRoute.POST(ev(as('ben', { params: { id }, request: json({ question: 'Noch da?' }) })))).status).toBe(409)
    expect((await recapRoute.POST(ev(as('ann', { params: { id } })))).status).toBe(409) // still going
    await f.service.end(f.user('ann'), id)
    expect((await recapRoute.POST(ev(as('ben', { params: { id } })))).status).toBe(403)
  })

  it('a bad body is a 400', async () => {
    const f = wire()
    const id = await liveDm(f)
    expect((await brainRoute.POST(ev(as('ann', { params: { id }, request: json({ on: 'yes' }) })))).status).toBe(400)
    await f.service.setBrain('ann', id, true)
    expect((await askRoute.POST(ev(as('ann', { params: { id }, request: json({}) })))).status).toBe(400)
    expect(f.brain.asks).toEqual([])
  })
})
