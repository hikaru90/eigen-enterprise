import { describe, expect, it, vi } from 'vitest'
import { memoryStore } from './memory-store'
import {
  hashInviteToken,
  inviteMember,
  inviteStatus,
  listMembers,
  removeMember,
  setMemberRole,
  type Member,
} from './service'

const at = new Date('2026-10-21T10:00:00Z')
const owner: Member = { id: 'o', email: 'owner@k.co', name: 'Owner', role: 'owner', createdAt: at }
const admin: Member = { id: 'a', email: 'admin@k.co', name: 'Admin', role: 'admin', createdAt: at }
const member: Member = { id: 'm', email: 'm@k.co', name: 'M', role: 'member', createdAt: at }

function setup() {
  const store = memoryStore([owner, admin, member])
  const mail = { send: vi.fn(async () => ({ messageId: 'x' })) }
  const deps = { store, mail, origin: 'https://os.kindred.co/', companyName: 'Kindred', now: () => at }
  return { store, mail, deps }
}

function tokenFrom(mail: { send: ReturnType<typeof vi.fn> }): string {
  const text = (mail.send.mock.calls[0]![0] as { text: string }).text
  return new URL(/https:\S+/.exec(text)![0]).searchParams.get('token')!
}

describe('members: invites', () => {
  it('sends a one-time link by company mail and stores only its hash', async () => {
    const { store, mail, deps } = setup()
    const out = await inviteMember({ id: 'o', role: 'owner' }, { email: ' New@K.co ', role: 'admin' }, deps)
    expect(out).toMatchObject({ email: 'new@k.co', role: 'admin', expiresAt: '2026-10-28T10:00:00.000Z' })
    expect(mail.send).toHaveBeenCalledOnce()
    const sent = mail.send.mock.calls[0]![0] as { to: string; subject: string; text: string }
    expect(sent.to).toBe('new@k.co')
    expect(sent.subject).toBe("You're invited to join Kindred")
    const token = tokenFrom(mail)
    expect(sent.text).toContain(`https://os.kindred.co/invite?token=`)
    expect(store.invites[0]!.tokenHash).toBe(hashInviteToken(token))
    expect(JSON.stringify(store.invites)).not.toContain(token)
    expect(JSON.stringify(out)).not.toContain(token)
  })

  it('accept path: valid → consumed once → reuse refused', async () => {
    const { store, mail, deps } = setup()
    await inviteMember({ id: 'o', role: 'owner' }, { email: 'n@k.co', role: 'member' }, deps)
    const token = tokenFrom(mail)
    const st = await inviteStatus(token, deps)
    expect(st).toMatchObject({ ok: true, invite: { email: 'n@k.co', role: 'member' } })
    if (!st.ok) throw new Error('unreachable')
    expect(await store.consumeInvite(st.invite.id, at)).toBe(true)
    expect(await store.consumeInvite(st.invite.id, at)).toBe(false)
    expect(await inviteStatus(token, deps)).toEqual({ ok: false, reason: 'used' })
  })

  it('expired and unknown tokens are refused', async () => {
    const { mail, deps } = setup()
    await inviteMember({ id: 'o', role: 'owner' }, { email: 'n@k.co', role: 'member' }, deps)
    const token = tokenFrom(mail)
    expect(await inviteStatus(token, { ...deps, now: () => new Date('2026-10-29T00:00:00Z') })).toEqual({ ok: false, reason: 'expired' })
    expect(await inviteStatus('nope', deps)).toEqual({ ok: false, reason: 'invalid' })
    expect(await inviteStatus('', deps)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('a new invite to the same address replaces the old link', async () => {
    const { mail, deps } = setup()
    await inviteMember({ id: 'o', role: 'owner' }, { email: 'n@k.co', role: 'member' }, deps)
    const first = tokenFrom(mail)
    mail.send.mockClear()
    await inviteMember({ id: 'o', role: 'owner' }, { email: 'n@k.co', role: 'admin' }, deps)
    expect(await inviteStatus(first, deps)).toEqual({ ok: false, reason: 'invalid' })
    expect(await inviteStatus(tokenFrom(mail), deps)).toMatchObject({ ok: true, invite: { role: 'admin' } })
  })

  it('refuses existing members, bad emails, the owner role, and members inviting', async () => {
    const { deps } = setup()
    await expect(inviteMember({ id: 'o', role: 'owner' }, { email: 'm@k.co', role: 'member' }, deps)).rejects.toThrow(/already a member/)
    await expect(inviteMember({ id: 'o', role: 'owner' }, { email: 'nope', role: 'member' }, deps)).rejects.toThrow(/valid email/)
    await expect(inviteMember({ id: 'o', role: 'owner' }, { email: 'x@k.co', role: 'owner' as never }, deps)).rejects.toThrow()
    await expect(inviteMember({ id: 'm', role: 'member' }, { email: 'x@k.co', role: 'member' }, deps)).rejects.toThrow(/owner or an admin/)
  })
})

describe('members: role rules', () => {
  it('owner and admins change roles of admins and members', async () => {
    const { store, deps } = setup()
    await setMemberRole({ id: 'a', role: 'admin' }, { userId: 'm', role: 'admin' }, deps)
    expect((await store.getMember('m'))!.role).toBe('admin')
    await setMemberRole({ id: 'o', role: 'owner' }, { userId: 'a', role: 'member' }, deps)
    expect((await store.getMember('a'))!.role).toBe('member')
  })

  it('the owner cannot be demoted or removed, and nobody can be made a second owner', async () => {
    const { deps } = setup()
    await expect(setMemberRole({ id: 'a', role: 'admin' }, { userId: 'o', role: 'member' }, deps)).rejects.toThrow(/owner's role/)
    await expect(removeMember({ id: 'a', role: 'admin' }, { userId: 'o' }, deps)).rejects.toThrow(/owner can't be removed/)
    await expect(removeMember({ id: 'o', role: 'owner' }, { userId: 'o' }, deps)).rejects.toThrow(/owner can't be removed/)
    await expect(setMemberRole({ id: 'o', role: 'owner' }, { userId: 'a', role: 'owner' as never }, deps)).rejects.toThrow()
  })

  it('members cannot list, change or remove', async () => {
    const { deps } = setup()
    const m = { id: 'm', role: 'member' as const }
    await expect(listMembers(m, deps)).rejects.toThrow(/owner or an admin/)
    await expect(setMemberRole(m, { userId: 'a', role: 'member' }, deps)).rejects.toThrow(/owner or an admin/)
    await expect(removeMember(m, { userId: 'a' }, deps)).rejects.toThrow(/owner or an admin/)
  })

  it('removes a member; lists members and open invites', async () => {
    const { deps } = setup()
    await removeMember({ id: 'o', role: 'owner' }, { userId: 'm' }, deps)
    await inviteMember({ id: 'o', role: 'owner' }, { email: 'n@k.co', role: 'member' }, { ...deps, mail: { send: async () => ({}) } })
    const list = await listMembers({ id: 'o', role: 'owner' }, deps)
    expect(list.members.map((x) => x.role)).toEqual(['owner', 'admin'])
    expect(list.invites).toEqual([{ id: expect.any(String), email: 'n@k.co', role: 'member', expiresAt: '2026-10-28T10:00:00.000Z' }])
  })
})
