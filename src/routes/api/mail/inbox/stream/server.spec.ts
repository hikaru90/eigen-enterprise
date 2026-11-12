import { describe, expect, it, vi } from 'vitest'
import { InboxHub } from '../../../../../../modules/email/inbox/hub'
import { assignPersonalMailbox } from '../../../../../../modules/email/inbox/service'
import { fixture } from '../../../../../../modules/email/inbox/test-fixtures'

const f = fixture()
const hub = new InboxHub(f.deps)
vi.mock('../../../../../../modules/email/inbox/live', () => ({ inboxHub: async () => hub }))

const { GET } = await import('./+server')

const call = (user: { id: string } | null, signal = new AbortController().signal) =>
  GET({ locals: { user }, request: new Request('http://x/api/mail/inbox/stream', { signal }) } as never) as Promise<Response>

describe('GET /api/mail/inbox/stream', () => {
  it('needs a signed-in person', async () => {
    expect((await call(null)).status).toBe(401)
  })

  it('streams the signed-in person’s own mailboxes only', async () => {
    const box = await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana', domainId: 'd-1' })
    const abort = new AbortController()
    const [ana, olga] = [await call({ id: 'ana' }, abort.signal), await call({ id: 'olga' }, abort.signal)]
    expect(ana.headers.get('content-type')).toBe('text/event-stream')
    const anaReader = ana.body!.getReader()
    const olgaReader = olga.body!.getReader()
    const text = async (r: ReadableStreamDefaultReader<Uint8Array>) => new TextDecoder().decode((await r.read()).value)
    await text(anaReader)
    await text(olgaReader)
    await hub.dispatch(box.id)
    expect(await text(anaReader)).toContain(`"mailboxId":"${box.id}"`)
    abort.abort()
    expect((await olgaReader.read()).done).toBe(true)
  })
})
