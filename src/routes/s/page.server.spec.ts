import { describe, expect, it, vi } from 'vitest'

const { listPagesMock, isAdminMock } = vi.hoisted(() => ({
  listPagesMock: vi.fn(),
  isAdminMock: vi.fn(),
}))
vi.mock('../../../modules/website/store', () => ({
  defaultWebsiteStore: () => ({ listPages: listPagesMock }),
}))
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: isAdminMock }))

import { load } from './+page.server'

const pages = [
  { slug: 'home', title: 'Home', kind: 'page', visibility: 'public' },
  { slug: 'draft', title: 'Draft', kind: 'page', visibility: 'private' },
]
const event = (user: { id: string } | null) => ({ locals: user ? { user } : {} }) as never

describe('/s site home', () => {
  it('lists only published pages for anonymous visitors', async () => {
    listPagesMock.mockResolvedValue(pages)
    const result = (await load(event(null))) as { pages: unknown[] }
    expect(result.pages).toEqual([{ slug: 'home', title: 'Home', draft: false }])
  })

  it('lists drafts flagged for the admin owner', async () => {
    listPagesMock.mockResolvedValue(pages)
    isAdminMock.mockResolvedValue(true)
    const result = (await load(event({ id: 'owner' }))) as { pages: unknown[] }
    expect(result.pages).toEqual([
      { slug: 'home', title: 'Home', draft: false },
      { slug: 'draft', title: 'Draft', draft: true },
    ])
  })
})
