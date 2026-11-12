import type { DownloadDeps } from '../../../../../../../../modules/email/inbox/attachments'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestReceived, parseReceipt } from '../../../../../../../../modules/email/inbox/ingest'
import { PDF_BYTES, WITH_ATTACHMENT } from '../../../../../../../../modules/email/inbox/mime-fixtures'
import { fakeRawMailSource } from '../../../../../../../../modules/email/inbox/raw-source'
import { BUCKET, received } from '../../../../../../../../modules/email/inbox/receipt-fixtures'
import { assignPersonalMailbox } from '../../../../../../../../modules/email/inbox/service'
import { fixture } from '../../../../../../../../modules/email/inbox/test-fixtures'

let deps: DownloadDeps
vi.mock('../../../../../../../../modules/email/inbox/live', () => ({ downloadDeps: async () => deps }))

const { GET } = await import('./+server')

let f: ReturnType<typeof fixture>

async function ingest(virus = 'PASS') {
  f = fixture()
  await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' })
  const raw = fakeRawMailSource()
  raw.objects.set(`${BUCKET}/ses-msg-1`, Buffer.from(WITH_ATTACHMENT))
  const parsed = parseReceipt(received({ verdicts: { virus } }))
  if (parsed.kind !== 'received') throw new Error('fixture')
  await ingestReceived({ store: f.store, raw, log: () => {} }, parsed.notification, BUCKET)
  deps = { inbox: f.deps, raw, bucket: async () => BUCKET }
  return [...f.store.attachments.values()].find((a) => a.contentType === 'application/pdf')!
}

const get = (user: string | null, id: string, query = '') =>
  GET({ locals: { user: user ? { id: user } : null }, params: { id }, url: new URL(`http://x/m/email/inbox/attachments/${id}${query}`) } as never) as Promise<Response>

describe('GET /m/email/inbox/attachments/[id]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('downloads the bytes for the reader, never sniffed', async () => {
    const pdf = await ingest()
    const res = await get('ana', pdf.id)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF_BYTES)).toBe(true)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="contract.pdf"/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('is not found for anyone else, the owner included, and for a malformed id', async () => {
    const pdf = await ingest()
    expect((await get('olga', pdf.id)).status).toBe(404)
    expect(await (await get('ben', pdf.id)).text()).toBe('No such attachment.')
    expect((await get('ana', 'x')).status).toBe(404)
    expect((await get(null, pdf.id)).status).toBe(401)
  })

  it('refuses a blocked attachment with a plain message', async () => {
    const pdf = await ingest('FAIL')
    const res = await get('ana', pdf.id)
    expect(res.status).toBe(403)
    expect(await res.text()).toMatch(/^Blocked: Amazon found a virus/)
  })
})
