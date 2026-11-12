import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture } from '../../../../../../modules/email/inbox/test-fixtures'

/** Setup › Mailboxes over the real inbox service on the in-memory store. */

let f = fixture()
let me = { userId: 'olga', email: 'olga@home.example', isAdmin: true }
/** What the receipt-rule sync answers: null when the rules match, else Amazon's reason. */
let syncAnswer: string | null = null
const syncs = vi.fn(async () => syncAnswer)

vi.mock('../../../../../../modules/email/inbox/live', () => ({ inboxDeps: async () => f.deps }))
vi.mock('../../../../../../modules/email/platform/receiving-sync', () => ({ syncMailReceiving: () => syncs() }))
vi.mock('../access.server', async (orig) => {
  const real = await orig<typeof import('../access.server')>()
  return {
    ...real,
    requireMember: vi.fn(async () => me),
    requireAdmin: vi.fn(async () => {
      if (!me.isAdmin) throw Object.assign(new Error('Only the owner or an admin can change email settings.'), { status: 403 })
      return me
    }),
  }
})

const { load, actions } = await import('./+page.server')

const form = (fields: Record<string, string>) => {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  return { locals: {}, request: new Request('http://x/', { method: 'POST', body }) } as never
}
const run = () => load({ locals: {} } as never) as Promise<Record<string, unknown>>

describe('Email › Setup › Mailboxes', () => {
  beforeEach(() => {
    f = fixture()
    me = { userId: 'olga', email: 'olga@home.example', isAdmin: true }
    syncAnswer = null
    syncs.mockClear()
  })

  it('every successful mailbox change re-syncs the receipt rules; a failed change does not', async () => {
    await actions.shared(form({ groupId: 'g-sales', localPart: 'sales', domainId: 'd-1' }))
    await actions.assign(form({ memberId: 'ana', localPart: 'ana', domainId: 'd-1' }))
    const id = ((await run()).admin as { mailboxes: Array<{ id: string; address: string }> }).mailboxes.find((m) => m.address === 'sales@example.com')!.id
    await actions.alias(form({ mailboxId: id, localPart: 'vertrieb', domainId: 'd-1' }))
    await actions.removeAlias(form({ address: 'vertrieb@example.com' }))
    await actions.disable(form({ mailboxId: id }))
    await actions.enable(form({ mailboxId: id }))
    expect(syncs).toHaveBeenCalledTimes(6)
    await actions.assign(form({ memberId: 'ben', localPart: 'ana', domainId: 'd-1' }))
    expect(syncs).toHaveBeenCalledTimes(6)
  })

  it('a failed sync keeps the mailbox change and shows the admin why', async () => {
    syncAnswer = 'These AWS keys may not manage Amazon SES receipt rules.'
    expect(await actions.assign(form({ memberId: 'ana', localPart: 'ana', domainId: 'd-1' }))).toEqual({
      action: 'assign',
      ok: true,
      address: 'ana@example.com',
      receivingError: 'These AWS keys may not manage Amazon SES receipt rules.',
    })
    expect(((await run()).admin as { mailboxes: unknown[] }).mailboxes).toHaveLength(1)
  })

  it('the owner assigns a member their address and sees it listed with counts', async () => {
    expect(await actions.assign(form({ memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' }))).toEqual({
      action: 'assign',
      ok: true,
      address: 'ana.lind@example.com',
    })
    const out = await run()
    expect(out.admin).toMatchObject({ mailboxes: [{ address: 'ana.lind@example.com', holder: 'Ana Lind', messages: 0 }] })
  })

  it('a taken address comes back as a form error the owner can fix', async () => {
    await actions.assign(form({ memberId: 'ana', localPart: 'ana', domainId: 'd-1' }))
    const out = (await actions.assign(form({ memberId: 'ben', localPart: 'ana', domainId: 'd-1' }))) as { status: number; data: unknown }
    expect(out.status).toBe(400)
    expect(out.data).toEqual({ action: 'assign', error: 'ana@example.com is already in use. Pick another address.' })
  })

  it('creates a shared mailbox, adds and removes an alias, disables and enables', async () => {
    await actions.shared(form({ groupId: 'g-sales', localPart: 'sales', domainId: 'd-1', displayName: 'Sales' }))
    const id = ((await run()).admin as { mailboxes: Array<{ id: string }> }).mailboxes[0]!.id
    await actions.alias(form({ mailboxId: id, localPart: 'vertrieb', domainId: 'd-1' }))
    await actions.disable(form({ mailboxId: id }))
    let box = ((await run()).admin as { mailboxes: Array<Record<string, unknown>> }).mailboxes[0]
    expect(box).toMatchObject({ address: 'sales@example.com', aliases: ['vertrieb@example.com'], disabled: true })
    await actions.removeAlias(form({ address: 'vertrieb@example.com' }))
    await actions.enable(form({ mailboxId: id }))
    box = ((await run()).admin as { mailboxes: Array<Record<string, unknown>> }).mailboxes[0]
    expect(box).toMatchObject({ aliases: [], disabled: false })
  })

  it('a member sees only the addresses they read, no admin view', async () => {
    await actions.assign(form({ memberId: 'ana', localPart: 'ana', domainId: 'd-1' }))
    await actions.assign(form({ memberId: 'ben', localPart: 'ben', domainId: 'd-1' }))
    me = { userId: 'ana', email: 'ana@home.example', isAdmin: false }
    expect(await run()).toEqual({
      admin: null,
      mine: [{ address: 'ana@example.com', aliases: [], kind: 'personal', displayName: null, disabled: false }],
    })
    await expect(actions.assign(form({ memberId: 'ana', localPart: 'x', domainId: 'd-1' }))).rejects.toMatchObject({ status: 403 })
  })
})
