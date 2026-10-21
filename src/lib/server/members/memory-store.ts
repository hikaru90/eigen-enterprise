import type { Invite, Member, MemberStore } from './service'

/** In-memory MemberStore (tests). */
export function memoryStore(members: Member[] = []): MemberStore & { members: Member[]; invites: Invite[] } {
  const s = {
    members: [...members],
    invites: [] as Invite[],
    async listMembers() {
      return s.members
    },
    async getMember(id: string) {
      return s.members.find((m) => m.id === id) ?? null
    },
    async findMemberByEmail(email: string) {
      return s.members.find((m) => m.email === email) ?? null
    },
    async setRole(id: string, role: 'admin' | 'member') {
      s.members = s.members.map((m) => (m.id === id ? { ...m, role } : m))
    },
    async removeMember(id: string) {
      s.members = s.members.filter((m) => m.id !== id)
    },
    async listOpenInvites(now: Date) {
      return s.invites.filter((i) => !i.acceptedAt && i.expiresAt > now)
    },
    async insertInvite(invite: Invite) {
      s.invites = [...s.invites.filter((i) => i.acceptedAt || i.email !== invite.email), invite]
    },
    async findInviteByHash(h: string) {
      return s.invites.find((i) => i.tokenHash === h) ?? null
    },
    async getInvite(id: string) {
      return s.invites.find((i) => i.id === id) ?? null
    },
    async consumeInvite(id: string, now: Date) {
      const i = s.invites.find((x) => x.id === id)
      if (!i || i.acceptedAt || i.expiresAt < now) return false
      i.acceptedAt = now
      return true
    },
  }
  return s
}
