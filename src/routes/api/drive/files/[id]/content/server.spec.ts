import { describe, expect, it, vi } from 'vitest'

const { holder } = vi.hoisted(() => ({ holder: { drive: null as unknown } }))
vi.mock('$lib/server/drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/drive')>()
  return { ...actual, driveService: async () => holder.drive }
})

const { GET } = await import('./+server')

describe('GET /api/drive/files/[id]/content', () => {
  it('downloads source bytes with their explicit binary MIME type', async () => {
    const bytes = Uint8Array.of(0, 255, 1, 2, 3)
    holder.drive = {
      readFile: vi.fn(async () => ({
        file: { id: 'png-1', name: 'pixel.png', mime: 'image/png' },
        bytes,
      })),
    }
    const response = await GET({
      locals: { user: { id: 'alice' } },
      params: { id: 'png-1' },
      url: new URL('http://localhost/api/drive/files/png-1/content?download=1'),
    } as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''pixel.png")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })
})
