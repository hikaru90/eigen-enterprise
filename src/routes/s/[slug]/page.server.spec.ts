import { describe, expect, it, vi } from 'vitest'
import { grayscaleTint } from '../../../../modules/brand/style-format/tint'

const { getPageMock, findActiveVisualSetMock } = vi.hoisted(() => ({
  getPageMock: vi.fn(),
  findActiveVisualSetMock: vi.fn(),
}))

vi.mock('../../../../modules/website/store', () => ({
  defaultWebsiteStore: () => ({ getPage: getPageMock }),
}))
vi.mock('../../../../modules/brand/store', () => ({
  defaultBrandStore: () => ({ findActiveVisualSet: findActiveVisualSetMock }),
}))

import { load } from './+page.server'

const event = (slug: string) =>
  ({ params: { slug }, locals: {}, cookies: { get: vi.fn(), set: vi.fn() } }) as never

const publicPage = {
  title: 'Kindred Digital Labs',
  body: '# Hello',
  updatedAt: '2026-09-10T00:00:00.000Z',
  visibility: 'public',
}

/** Every activation-required role, so the fixture can actually activate in real flows. */
const activeSet = {
  id: '7a000000-0000-4000-8000-00000000000a',
  status: 'active',
  cssVars: {
    '--background': 'oklch(0.247 0.05 260)',
    '--foreground': 'oklch(0.962 0.02 260)',
  },
  darkCssVars: null,
}

describe('/s/[slug] page server load (phase-2d M5 hero consumption)', () => {
  it('derives hero + water-flow props from the active visual set (shader tints are brand grays)', async () => {
    getPageMock.mockResolvedValue(publicPage)
    findActiveVisualSetMock.mockResolvedValue(activeSet)

    const result = (await load(event('kindred'))) as {
      title: string
      brand: {
        heroBg: string
        heroFg: string
        h1Color: string
        waterFlowFrom: string
        waterFlowTo: string
      }
    }
    expect(result.title).toBe('Kindred Digital Labs')
    expect(result.brand.heroBg).toBe('oklch(0.247 0.05 260)')
    expect(result.brand.heroFg).toBe('oklch(0.962 0.02 260)')
    expect(result.brand.h1Color).toBe('oklch(0.962 0.02 260)')
    // Chromatic brand colors project onto the L axis: gray hex the shader accepts.
    expect(result.brand.waterFlowFrom).toBe(grayscaleTint('oklch(0.247 0.05 260)'))
    expect(result.brand.waterFlowTo).toBe(grayscaleTint('oklch(0.962 0.02 260)'))
    expect(result.brand.waterFlowFrom).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('keeps the exact current hero defaults when no visual set is active (legit state, no fallback machinery)', async () => {
    getPageMock.mockResolvedValue(publicPage)
    findActiveVisualSetMock.mockResolvedValue(null)

    const result = (await load(event('kindred'))) as { brand: Record<string, string> }
    expect(result.brand).toEqual({
      heroBg: '#060606',
      heroFg: '#b9b9b9',
      h1Color: '#ffffff',
      waterFlowFrom: '#060606',
      waterFlowTo: '#b9b9b9',
    })
  })

  it('propagates brand store failures loud — only "none active" resolves null', async () => {
    getPageMock.mockResolvedValue(publicPage)
    findActiveVisualSetMock.mockRejectedValue(new Error('db connection failed'))

    await expect(load(event('kindred'))).rejects.toThrow(/db connection failed/)
  })

  it('still 404s unknown or non-public pages before reading the brand store', async () => {
    findActiveVisualSetMock.mockClear()
    getPageMock.mockResolvedValue(null)
    await expect(load(event('nope'))).rejects.toMatchObject({ status: 404 })
    expect(findActiveVisualSetMock).not.toHaveBeenCalled()

    getPageMock.mockResolvedValue({ ...publicPage, visibility: 'unlisted' })
    await expect(load(event('kindred'))).rejects.toMatchObject({ status: 404 })
  })
})
