import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_UNAVAILABLE_MESSAGE, BrowserUnavailableError } from '../../../../../modules/brand/extract/capture-errors'

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }))

vi.mock('$lib/server/boot', () => ({
  appKernel: async () => ({ registry: { execute: executeMock } }),
}))

const { executeBrandExtractTool } = await import('./handler')

describe('executeBrandExtractTool', () => {
  beforeEach(() => executeMock.mockReset())

  it('runs the tool as a human admin principal and answers its result', async () => {
    executeMock.mockResolvedValueOnce({ sessionId: 's-1' })
    const response = await executeBrandExtractTool('brand.extract_start', { url: 'https://example.com' }, { id: 'owner-1' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ sessionId: 's-1' })
    expect(executeMock).toHaveBeenCalledWith(
      'brand.extract_start',
      { url: 'https://example.com' },
      expect.objectContaining({ principal: { id: 'owner-1', kind: 'human', roles: ['admin'] } }),
    )
  })

  it('answers 503 with the plain message when the server has no browser to capture with', async () => {
    executeMock.mockRejectedValueOnce(new BrowserUnavailableError('/opt/pw/chrome-headless-shell'))
    const response = await executeBrandExtractTool('brand.extract_start', { url: 'https://example.com' }, { id: 'owner-1' })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      message: BROWSER_UNAVAILABLE_MESSAGE,
      code: 'browser_unavailable',
    })
  })

  it('rethrows any other failure unchanged (no catch-all)', async () => {
    const boom = new Error('gateway down')
    executeMock.mockRejectedValueOnce(boom)
    await expect(
      executeBrandExtractTool('brand.extract_propose', { sessionId: 'x' }, { id: 'owner-1' }),
    ).rejects.toBe(boom)
  })
})
