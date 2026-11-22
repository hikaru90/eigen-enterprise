import { describe, expect, it } from 'vitest'
import { EeClient, PREVIEW_BUSY, PreviewBusyError, SubstrateError, type EeStatus, type EeTransport, type PreviewView } from './client'

const view = (over: Partial<PreviewView> = {}): PreviewView => ({
  id: 'pv3f9a0c12be47',
  folderName: 'shop',
  state: 'installing',
  host: 'pv3f9a0c12be47.preview.os.example.com',
  url: 'https://pv3f9a0c12be47.preview.os.example.com/',
  script: null,
  startedAt: '2026-11-20T10:00:00.000Z',
  lastSeenAt: '2026-11-20T10:00:00.000Z',
  error: null,
  log: [],
  ...over,
})

function recording(answer: (method: string, path: string, body: unknown) => { status: number; data: unknown }) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const transport: EeTransport = async (method, path, body) => {
    calls.push({ method, path, body })
    return answer(method, path, body)
  }
  return { client: new EeClient(transport), calls }
}

describe('ee client: /v1/previews (the Drive app preview contract)', () => {
  it('speaks the five verbs with the contract bodies', async () => {
    const { client, calls } = recording((method) => ({
      status: method === 'POST' && calls.length === 1 ? 202 : 200,
      data: method === 'GET' && calls.at(-1)!.path === '/v1/previews' ? { previews: [view()] } : { preview: view() },
    }))
    const start = { id: 'pv3f9a0c12be47', tarball: '/s/previews/pv3f9a0c12be47-1.tar.gz', sha256: 'a'.repeat(64), folderName: 'shop', author: 'human:u1' }
    expect(await client.startPreview(start)).toEqual({ preview: view() })
    expect(await client.previews()).toEqual({ previews: [view()] })
    await client.preview('pv3f9a0c12be47')
    await client.previewSeen('pv3f9a0c12be47')
    await client.stopPreview('pv3f9a0c12be47', { author: 'human:u1' })
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/previews', body: start },
      { method: 'GET', path: '/v1/previews', body: undefined },
      { method: 'GET', path: '/v1/previews/pv3f9a0c12be47', body: undefined },
      { method: 'POST', path: '/v1/previews/pv3f9a0c12be47/seen', body: {} },
      { method: 'DELETE', path: '/v1/previews/pv3f9a0c12be47', body: { author: 'human:u1' } },
    ])
  })

  it('409 urn:ee:preview_busy becomes a PreviewBusyError carrying the running preview', async () => {
    const running = view({ id: 'pv000000000001', folderName: 'blog', state: 'running' })
    const { client } = recording(() => ({ status: 409, data: { type: PREVIEW_BUSY, detail: 'another preview is running', running } }))
    const err = await client.startPreview({ id: 'pv3f9a0c12be47', tarball: '/t', sha256: 'a'.repeat(64), folderName: 'shop', author: 'human:u1' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PreviewBusyError)
    expect(err).toBeInstanceOf(SubstrateError)
    expect(err).toMatchObject({ status: 409, type: PREVIEW_BUSY, running })
  })

  it('a busy answer without the running preview is a contract breach, not a busy error', async () => {
    const { client } = recording(() => ({ status: 409, data: { type: PREVIEW_BUSY, detail: 'busy' } }))
    const err = await client.previews().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SubstrateError)
    expect(err).not.toBeInstanceOf(PreviewBusyError)
    expect((err as Error).message).toMatch(/without the running preview/)
  })

  it('an unknown id is a plain SubstrateError 404', async () => {
    const { client } = recording(() => ({ status: 404, data: { type: 'urn:ee:not_found', detail: 'no such preview' } }))
    await expect(client.preview('pv3f9a0c12be47')).rejects.toMatchObject({ status: 404, message: 'no such preview' })
  })
})

describe('ee client: domains and certificates (plan/domains-one-claim.md D1)', () => {
  it('addDomain returns the workload the host showed before', async () => {
    const { client, calls } = recording(() => ({ status: 200, data: { rev: 'r', reconcileError: null, replaced: 'site' } }))
    const out = await client.addDomain({ host: 'www.example.com', workload: 'shop', role: 'app', author: 'human:u1' })
    expect(out).toEqual({ rev: 'r', reconcileError: null, replaced: 'site' })
    expect(calls).toEqual([{ method: 'POST', path: '/v1/domains', body: { host: 'www.example.com', workload: 'shop', role: 'app', author: 'human:u1' } }])
  })

  it('retryCertificate posts the host (and who asked)', async () => {
    const { client, calls } = recording(() => ({ status: 200, data: { host: 'www.example.com', reloaded: true } }))
    expect(await client.retryCertificate('www.example.com', 'human:u1')).toEqual({ host: 'www.example.com', reloaded: true })
    expect(calls).toEqual([{ method: 'POST', path: '/v1/certificates/retry', body: { host: 'www.example.com', author: 'human:u1' } }])
  })

  it('a host ee does not serve is a 404 with ee’s plain sentence', async () => {
    const detail = 'this server does not serve x.example.com, so it has no certificate to retry; set the domain first'
    const { client } = recording(() => ({ status: 404, data: { type: 'urn:ee:error', detail } }))
    await expect(client.retryCertificate('x.example.com', 'human:u1')).rejects.toMatchObject({ status: 404, message: detail })
  })

  it('status carries callsHost and certificates as ee sends them', async () => {
    const certificates: EeStatus['certificates'] = [
      { host: 'eigenenterprise.app', state: 'failing', lastError: 'timeout', nextRetryAt: '2026-11-22T10:10:01.000Z', notAfter: null },
    ]
    const { client } = recording(() => ({
      status: 200,
      data: { settings: { consoleHost: 'os.example.com', publicHost: null, acmeEmail: null, callsHost: 'rtc.os.example.com' }, certificates },
    }))
    const s = await client.status()
    expect(s.settings.callsHost).toBe('rtc.os.example.com')
    expect(s.certificates).toEqual(certificates)
  })
})
