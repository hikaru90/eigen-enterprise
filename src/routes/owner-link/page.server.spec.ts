import { describe, expect, it, vi } from 'vitest'

const { signInWithOwnerLink, ownerLinkStatus } = vi.hoisted(() => ({
  signInWithOwnerLink: vi.fn(async () => 'o@k.co'),
  ownerLinkStatus: vi.fn(async (): Promise<string> => 'ok'),
}))

vi.mock('$lib/server/auth', () => ({ auth: { api: {} } }))
vi.mock('$lib/server/db/auth-db', () => ({
  authDb: {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => [{ email: 'o@k.co' }] }) }),
      }),
    }),
  },
}))
vi.mock('$lib/server/env/private-env', () => ({ env: {} }))
vi.mock('$lib/server/overview/sources', () => ({ foundingCompanyName: async () => 'Kindred' }))
vi.mock('$lib/server/auth/owner-link', () => ({
  signInWithOwnerLink,
  ownerLinkStatus,
  ownerLinkConfigFromEnv: () => ({}),
  ownerLinkMessage: (s: string) => `message for ${s}`,
  OwnerLinkError: class OwnerLinkError extends Error {},
}))

const { actions, load } = await import('./+page.server')

const ev = (url: string, fields?: Record<string, string>, user: unknown = null) =>
  ({
    locals: { user },
    url: new URL(url),
    getClientAddress: () => '127.0.0.1',
    request: new Request(url, { method: 'POST', body: new URLSearchParams(fields ?? {}) }),
  }) as never

describe('/owner-link page', () => {
  it('a valid link shows whom it signs in', async () => {
    expect(await load(ev('http://x/owner-link?token=t'))).toMatchObject({
      step: 'link',
      ok: true,
      email: 'o@k.co',
      token: 't',
    })
  })

  it('a used or expired link says so in plain words', async () => {
    ownerLinkStatus.mockResolvedValueOnce('used')
    expect(await load(ev('http://x/owner-link?token=t'))).toMatchObject({
      ok: false,
      message: 'message for used',
      email: null,
    })
  })

  it('signing in goes on to the passkey step', async () => {
    await expect(actions.default(ev('http://x/owner-link', { token: 't' }))).rejects.toMatchObject({
      status: 303,
      location: '/owner-link?step=passkey',
    })
    expect(signInWithOwnerLink).toHaveBeenCalledWith('t', expect.anything())
  })

  it('a refused link keeps the sentence and gives the agent no token', async () => {
    signInWithOwnerLink.mockRejectedValueOnce(new Error('This link was already used.'))
    const out = (await actions.default(ev('http://x/owner-link', { token: 'secret-t' }))) as {
      status: number
      data: { message: string; agent: Record<string, unknown> }
    }
    expect(out.status).toBe(400)
    expect(out.data.message).toBe('This link was already used.')
    expect(out.data.agent).toMatchObject({
      attempted: expect.stringContaining('Signing in as the owner'),
    })
    expect(out.data.agent).not.toHaveProperty('cause')
    expect(JSON.stringify(out.data.agent)).not.toContain('secret-t')
  })

  it('signed in: ?step=passkey shows the passkey step', async () => {
    expect(
      await load(ev('http://x/owner-link?step=passkey', undefined, { id: 'u', email: 'o@k.co' })),
    ).toMatchObject({ step: 'passkey', email: 'o@k.co', companyName: 'Kindred' })
  })
})
