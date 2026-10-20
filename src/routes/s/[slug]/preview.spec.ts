import { describe, expect, it, vi } from 'vitest'

const { getPageMock, isAdminMock } = vi.hoisted(() => ({
  getPageMock: vi.fn(),
  isAdminMock: vi.fn(),
}))

vi.mock('../../../../modules/website/store', () => ({
  defaultWebsiteStore: () => ({ getPage: getPageMock }),
}))
vi.mock('../../../../modules/brand/store', () => ({
  defaultBrandStore: () => ({ findActiveVisualSet: async () => null }),
}))
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: isAdminMock }))

import { load } from './+page.server'

const page = (visibility: string) => ({
  title: 'About',
  body: '# Hi',
  updatedAt: '2026-10-01T00:00:00.000Z',
  visibility,
})
const event = (user: { id: string } | null) =>
  ({ params: { slug: 'about' }, locals: user ? { user } : {} }) as never

describe('/s/[slug] published + owner preview', () => {
  it('serves a published page to anonymous visitors without a draft flag', async () => {
    getPageMock.mockResolvedValue(page('public'))
    const result = (await load(event(null))) as { title: string; draft: boolean }
    expect(result.title).toBe('About')
    expect(result.draft).toBe(false)
  })

  it('404s a draft for anonymous visitors', async () => {
    getPageMock.mockResolvedValue(page('private'))
    await expect(load(event(null))).rejects.toMatchObject({ status: 404 })
  })

  it('404s a draft for signed-in non-admins', async () => {
    getPageMock.mockResolvedValue(page('private'))
    isAdminMock.mockResolvedValue(false)
    await expect(load(event({ id: 'u2' }))).rejects.toMatchObject({ status: 404 })
  })

  it('serves a draft to the signed-in admin owner with the draft banner flag', async () => {
    getPageMock.mockResolvedValue(page('private'))
    isAdminMock.mockResolvedValue(true)
    const result = (await load(event({ id: 'owner' }))) as { title: string; draft: boolean }
    expect(result.title).toBe('About')
    expect(result.draft).toBe(true)
    expect(isAdminMock).toHaveBeenCalledWith('owner')
  })
})
