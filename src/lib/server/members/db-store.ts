import { and, asc, eq, gt, isNull, ne } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { memberInvite, user } from '$lib/server/db/auth.schema'
import { coworkerProfile } from '$lib/server/db/coworkers.schema'
import type { Invite, Member, MemberStore } from './service'

/** Members live in the Better Auth user table (role column); invites in member_invite. */

const memberColumns = {
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  kind: user.kind,
  createdAt: user.createdAt,
  avatarSha256: user.avatarSha256,
}
// Harness accounts exist for automated verification only: never listed as company members.
// A removed AI co-worker keeps its user row (what it wrote stays attributed) but is no member.
const production = and(eq(user.accountKind, 'production'), isNull(coworkerProfile.removedAt))

const members = () => authDb.select(memberColumns).from(user).leftJoin(coworkerProfile, eq(coworkerProfile.userId, user.id))

export const dbMemberStore: MemberStore = {
  async listMembers(): Promise<Member[]> {
    return members().where(production).orderBy(asc(user.createdAt))
  },
  async getMember(id) {
    const [row] = await members().where(and(eq(user.id, id), production)).limit(1)
    return row ?? null
  },
  async findMemberByEmail(email) {
    const [row] = await authDb.select(memberColumns).from(user).where(eq(user.email, email)).limit(1)
    return row ?? null
  },
  async setRole(id, role) {
    // ne(owner) and kind human again at write time: neither the owner row nor a co-worker is rewritten by this path.
    const rows = await authDb
      .update(user)
      .set({ role })
      .where(and(eq(user.id, id), ne(user.role, 'owner'), eq(user.kind, 'human')))
      .returning({ id: user.id })
    if (rows.length !== 1) throw new Error(`role change for ${id} matched ${rows.length} rows`)
  },
  async removeMember(id) {
    const rows = await authDb
      .delete(user)
      .where(and(eq(user.id, id), ne(user.role, 'owner'), eq(user.kind, 'human')))
      .returning({ id: user.id })
    if (rows.length !== 1) throw new Error(`removing ${id} matched ${rows.length} rows`)
  },
  async listOpenInvites(now) {
    return authDb
      .select()
      .from(memberInvite)
      .where(and(isNull(memberInvite.acceptedAt), gt(memberInvite.expiresAt, now)))
      .orderBy(asc(memberInvite.createdAt)) as Promise<Invite[]>
  },
  async insertInvite(invite) {
    await authDb.transaction(async (tx) => {
      await tx.delete(memberInvite).where(and(eq(memberInvite.email, invite.email), isNull(memberInvite.acceptedAt)))
      await tx.insert(memberInvite).values(invite)
    })
  },
  async findInviteByHash(tokenHash) {
    const [row] = await authDb.select().from(memberInvite).where(eq(memberInvite.tokenHash, tokenHash)).limit(1)
    return (row as Invite | undefined) ?? null
  },
  async getInvite(id) {
    const [row] = await authDb.select().from(memberInvite).where(eq(memberInvite.id, id)).limit(1)
    return (row as Invite | undefined) ?? null
  },
  async consumeInvite(id, now) {
    const rows = await authDb
      .update(memberInvite)
      .set({ acceptedAt: now })
      .where(and(eq(memberInvite.id, id), isNull(memberInvite.acceptedAt), gt(memberInvite.expiresAt, now)))
      .returning({ id: memberInvite.id })
    return rows.length === 1
  },
}
