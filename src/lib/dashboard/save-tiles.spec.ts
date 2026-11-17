import { describe, expect, it, vi } from 'vitest'
import { saveHiddenTiles } from './save-tiles'

describe('saveHiddenTiles', () => {
  it('puts the whole list', async () => {
    const fetcher = vi.fn(async () => new Response('{"hidden":["apps"]}', { status: 200 }))
    await saveHiddenTiles(fetcher as unknown as typeof fetch, ['apps'])
    expect(fetcher).toHaveBeenCalledWith('/api/settings/dashboard-tiles', expect.objectContaining({ method: 'PUT', body: '{"hidden":["apps"]}' }))
  })

  it('fails with the server’s reason, or its status', async () => {
    const refused = vi.fn(async () => new Response('{"error":"You must be signed in."}', { status: 401 }))
    await expect(saveHiddenTiles(refused as unknown as typeof fetch, [])).rejects.toThrow('You must be signed in.')
    const broken = vi.fn(async () => new Response('oops', { status: 502 }))
    await expect(saveHiddenTiles(broken as unknown as typeof fetch, [])).rejects.toThrow('the server answered 502')
  })
})
