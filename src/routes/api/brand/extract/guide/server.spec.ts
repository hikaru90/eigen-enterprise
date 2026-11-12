import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock, requireAdminMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  requireAdminMock: vi.fn(),
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: requireAdminMock }))
vi.mock('../handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../handler')>()),
  executeBrandExtractTool: executeMock,
}))

const { POST } = await import('./+server')

const PDF = new TextEncoder().encode('%PDF-1.7\n')

function upload(form: FormData) {
  return new Request('http://localhost/api/brand/extract/guide', { method: 'POST', body: form })
}

function formWith(file: File): FormData {
  const form = new FormData()
  form.append('file', file)
  return form
}

describe('POST /api/brand/extract/guide', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('requires an owner/admin session before reading the upload', async () => {
    requireAdminMock.mockRejectedValueOnce(Object.assign(new Error('login'), { status: 302 }))
    await expect(
      POST({
        locals: { user: null },
        request: upload(formWith(new File([PDF], 'g.pdf'))),
      } as never),
    ).rejects.toMatchObject({ status: 302 })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('hands the file to brand.extract_guide_start as base64 with its name', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    await POST({
      locals: { user },
      request: upload(formWith(new File([PDF], 'Kindred CI.pdf', { type: 'application/pdf' }))),
    } as never)
    expect(executeMock).toHaveBeenCalledWith(
      'brand.extract_guide_start',
      { filename: 'Kindred CI.pdf', dataB64: Buffer.from(PDF).toString('base64') },
      user,
    )
  })

  it('refuses an unsupported file before the tool, with the plain sentence (415)', async () => {
    requireAdminMock.mockResolvedValueOnce({ id: 'owner-1' })
    const response = await POST({
      locals: { user: { id: 'owner-1' } },
      request: upload(formWith(new File(['GIF89a......'], 'anim.gif', { type: 'image/gif' }))),
    } as never)
    expect(response.status).toBe(415)
    await expect(response.json()).resolves.toEqual({
      message:
        "“anim.gif” isn't a PDF, PNG, JPEG or WebP file. Upload your brand guide in one of those formats.",
      code: 'unsupported_type',
    })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('answers 400 without a file field', async () => {
    requireAdminMock.mockResolvedValueOnce({ id: 'owner-1' })
    const form = new FormData()
    form.append('file', 'just text')
    await expect(
      POST({ locals: { user: { id: 'owner-1' } }, request: upload(form) } as never),
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Choose a brand guide file: a PDF, PNG, JPEG or WebP.' },
    })
  })

  it('answers 400 when the body is not a multipart form', async () => {
    requireAdminMock.mockResolvedValueOnce({ id: 'owner-1' })
    const request = new Request('http://localhost/api/brand/extract/guide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    await expect(
      POST({ locals: { user: { id: 'owner-1' } }, request } as never),
    ).rejects.toMatchObject({
      status: 400,
    })
  })
})
