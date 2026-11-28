import { beforeEach, describe, expect, it, vi } from 'vitest'

const completeMock = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/agent/db-scoped-complete', () => ({ dbScopedGatewayComplete: completeMock }))
const visionMock = vi.hoisted(() => vi.fn(async () => 'google/gemini-3.8-flash'))
vi.mock('$lib/server/llm/vision', () => ({ resolveVisionModel: visionMock }))

function upload(files: File[]) {
  const form = new FormData()
  for (const file of files) form.append('file', file)
  return new Request('http://localhost/api/assistant/attachments', { method: 'POST', body: form })
}

/** POST /api/assistant/attachments: one file in, its readable text (or a plain refusal) out. */
describe('POST /api/assistant/attachments', () => {
  beforeEach(() => {
    completeMock.mockReset()
  })

  it('requires a signed-in member', async () => {
    const { POST } = await import('./+server')
    const res = await POST({
      locals: { user: null },
      request: upload([new File(['x'], 'a.txt')]),
    } as never)
    expect(res.status).toBe(401)
  })

  it('returns the attachment the composer sends with the message', async () => {
    const { POST } = await import('./+server')
    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: upload([new File(['Ship the bakery site.'], 'notes.md', { type: 'text/markdown' })]),
    } as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      attachment: { name: 'notes.md', kind: 'text', sizeBytes: 21, text: 'Ship the bakery site.' },
    })
  })

  it('reads a PDF through the company model, as the member', async () => {
    const { POST } = await import('./+server')
    completeMock.mockResolvedValue({
      choices: [{ message: { content: 'Revenue grew 12%.' }, finish_reason: 'stop' }],
    })
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], 'q3.pdf', {
      type: 'application/pdf',
    })
    const res = await POST({ locals: { user: { id: 'u1' } }, request: upload([pdf]) } as never)
    expect(res.status).toBe(200)
    expect((await res.json()).attachment).toMatchObject({ kind: 'pdf', text: 'Revenue grew 12%.' })
    expect(completeMock.mock.calls[0]![0]).toMatchObject({ userId: 'u1', modelOverride: 'google/gemini-3.8-flash' })
    expect(visionMock).toHaveBeenCalledWith('u1')
  })

  it('a refusal is a plain sentence with its status', async () => {
    const { POST } = await import('./+server')
    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: upload([new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00])], 'a.docx')]),
    } as never)
    expect(res.status).toBe(415)
    expect((await res.json()).error).toContain('“a.docx”')
  })

  it('takes exactly one file per request', async () => {
    const { POST } = await import('./+server')
    const none = await POST({ locals: { user: { id: 'u1' } }, request: upload([]) } as never)
    expect(none.status).toBe(400)
    const two = await POST({
      locals: { user: { id: 'u1' } },
      request: upload([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]),
    } as never)
    expect(two.status).toBe(400)
  })
})
