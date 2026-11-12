import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getGuideMock, requireAdminMock } = vi.hoisted(() => ({
  getGuideMock: vi.fn(),
  requireAdminMock: vi.fn(),
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: requireAdminMock }))
vi.mock('../../../../../../../../modules/brand/extract/store', () => ({
  defaultBrandExtractionStore: () => ({ getGuide: getGuideMock }),
}))

const { GET } = await import('./+server')

const SESSION = '0b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f'
const PDF = new TextEncoder().encode('%PDF-1.7\n')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function call(id: string) {
  return GET({ locals: { user: { id: 'owner-1' } }, params: { id } } as never)
}

describe('GET /api/brand/extract/session/[id]/guide', () => {
  beforeEach(() => {
    getGuideMock.mockReset()
    requireAdminMock.mockReset()
    requireAdminMock.mockResolvedValue({ id: 'owner-1' })
  })

  it('requires an owner/admin session', async () => {
    requireAdminMock.mockRejectedValueOnce(Object.assign(new Error('login'), { status: 302 }))
    await expect(call(SESSION)).rejects.toMatchObject({ status: 302 })
    expect(getGuideMock).not.toHaveBeenCalled()
  })

  it('serves a PDF guide inline for the browser viewer, not cached', async () => {
    getGuideMock.mockResolvedValueOnce({
      filename: 'Kindred CI.pdf',
      mime: 'application/pdf',
      sizeBytes: PDF.length,
      base64: Buffer.from(PDF).toString('base64'),
    })
    const response = await call(SESSION)
    expect(getGuideMock).toHaveBeenCalledWith(SESSION)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toBe(
      "inline; filename*=UTF-8''Kindred%20CI.pdf",
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF)
  })

  it('serves an image guide sandboxed', async () => {
    getGuideMock.mockResolvedValueOnce({
      filename: 'board.png',
      mime: 'image/png',
      sizeBytes: PNG.length,
      base64: Buffer.from(PNG).toString('base64'),
    })
    const response = await call(SESSION)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
  })

  it('404 for a session without a guide, 400 for a malformed id', async () => {
    getGuideMock.mockResolvedValueOnce(null)
    await expect(call(SESSION)).rejects.toMatchObject({ status: 404 })
    await expect(call('nope')).rejects.toMatchObject({ status: 400 })
  })
})
