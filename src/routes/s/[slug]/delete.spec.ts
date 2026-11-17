import { describe, expect, it, vi, beforeEach } from 'vitest'
import { KernelError } from '$lib/kernel/errors'

const { getPageMock, isUserAdminMock, ownerRunMock } = vi.hoisted(() => ({
  getPageMock: vi.fn(),
  isUserAdminMock: vi.fn(),
  ownerRunMock: vi.fn(),
}))

vi.mock('../../../../modules/website/store', () => ({
  defaultWebsiteStore: () => ({ getPage: getPageMock }),
}))
vi.mock('../../../../modules/brand/store', () => ({
  defaultBrandStore: () => ({ findActiveVisualSet: async () => null }),
}))
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: isUserAdminMock }))
vi.mock('$lib/server/auth/require-admin', () => ({
  requireAdmin: async (u: unknown) => {
    if (!u) throw new Error('not signed in')
    return u
  },
}))
vi.mock('$lib/server/website/owner-run', () => ({ ownerRun: ownerRunMock }))

import { actions, load } from './+page.server'

const page = {
  title: 'Old offer',
  body: 'x',
  updatedAt: '2026-09-10T00:00:00.000Z',
  visibility: 'public',
}

function postEvent(slug: string, user: { id: string } | null) {
  return {
    params: { slug },
    locals: { user },
    request: new Request('http://x', { method: 'POST', body: new FormData() }),
  } as never
}

beforeEach(() => {
  getPageMock.mockReset()
  isUserAdminMock.mockReset()
  ownerRunMock.mockReset()
})

describe('/s/[slug]: deleting a page (the owner’s click)', () => {
  it('load offers delete to a signed-in admin only', async () => {
    getPageMock.mockResolvedValue(page)
    const anonymous = (await load({ params: { slug: 'old' }, locals: {} } as never)) as {
      canDelete: boolean
    }
    expect(anonymous.canDelete).toBe(false)

    isUserAdminMock.mockResolvedValue(true)
    const admin = (await load({ params: { slug: 'old' }, locals: { user: { id: 'u1' } } } as never)) as {
      canDelete: boolean
    }
    expect(admin.canDelete).toBe(true)

    isUserAdminMock.mockResolvedValue(false)
    const member = (await load({ params: { slug: 'old' }, locals: { user: { id: 'u2' } } } as never)) as {
      canDelete: boolean
    }
    expect(member.canDelete).toBe(false)
  })

  it('runs website.delete_page as the signed-in owner for exactly this slug, then goes to the site home', async () => {
    ownerRunMock.mockResolvedValue({ slug: 'old' })
    await expect(actions.deletePage(postEvent('old', { id: 'u1' }))).rejects.toMatchObject({
      status: 303,
      location: '/s',
    })
    expect(ownerRunMock).toHaveBeenCalledWith({ id: 'u1' }, 'website.delete_page', { slug: 'old' })
  })

  it('a refusal is a plain sentence on the page, never a raw error', async () => {
    ownerRunMock.mockRejectedValue(new KernelError('permission_denied', 'principal x is not permitted'))
    const out = (await actions.deletePage(postEvent('old', { id: 'u1' }))) as {
      status: number
      data: { error: string }
    }
    expect(out.status).toBe(403)
    expect(out.data.error).toBe('Only an admin can delete a page.')

    ownerRunMock.mockRejectedValue(new Error('unknown website page: old'))
    const gone = (await actions.deletePage(postEvent('old', { id: 'u1' }))) as {
      status: number
      data: { error: string }
    }
    expect(gone.status).toBe(400)
    expect(gone.data.error).toMatch(/could not be deleted/)
  })

  it('signed out: refused before anything runs', async () => {
    await expect(actions.deletePage(postEvent('old', null))).rejects.toThrow()
    expect(ownerRunMock).not.toHaveBeenCalled()
  })
})
