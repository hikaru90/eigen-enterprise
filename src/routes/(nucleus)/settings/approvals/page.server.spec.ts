import { describe, expect, it, vi } from 'vitest'
import { load } from './+page.server'

const { roleMock } = vi.hoisted(() => ({ roleMock: vi.fn(async (): Promise<string | null> => 'owner') }))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

const event = (user: { id: string } | null, response?: Response) =>
  ({
    locals: { user },
    fetch: vi.fn(async () => response ?? new Response(JSON.stringify({ mode: 'ask' }))),
  }) as unknown as Parameters<typeof load>[0]

describe('/settings/approvals — Approval mode (company-wide, admin only)', () => {
  it('redirects signed-out visitors to login', async () => {
    await expect(load(event(null))).rejects.toMatchObject({ status: 302, location: '/login' })
  })

  it('sends members back to the Account section: the approval mode is the owner/admin choice', async () => {
    roleMock.mockResolvedValueOnce('member')
    await expect(load(event({ id: 'm' }))).rejects.toMatchObject({
      status: 303,
      location: '/settings',
    })
  })

  it('loads the stored mode through /api/approvals/mode', async () => {
    const e = event({ id: 'owner' }, new Response(JSON.stringify({ mode: 'reasonable' })))
    expect(await load(e)).toEqual({ approvalMode: { status: 'ok', mode: 'reasonable' } })
  })

  it('shows a failed load as unavailable — never a default mode', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = event({ id: 'owner' }, new Response('nope', { status: 500 }))
    expect(await load(e)).toEqual({ approvalMode: { status: 'unavailable' } })
    spy.mockRestore()
  })
})
