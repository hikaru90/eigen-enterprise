import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MemberRole } from '$lib/server/auth/user-role'

/**
 * Company members (Settings → Members and the members.* kernel tools).
 *
 * Roles live on user.role: exactly one owner, admins who manage members like
 * the owner does, and members. People join only by invite: a one-time link
 * (random token; only its SHA-256 is stored), expiring after INVITE_TTL_DAYS.
 * The inviter gets the link to copy (owner decision W-4) and, when company
 * mail is set up, it is emailed too. Opening it creates the account with the
 * invited role and asks for a passkey (see ./accept.ts).
 */

export const INVITE_TTL_DAYS = 7
export type InvitableRole = Exclude<MemberRole, 'owner'>
export const invitableRole = z.enum(['admin', 'member'])

export type Member = {
  id: string
  email: string
  name: string
  role: MemberRole
  createdAt: Date
  /** Profile picture bytes (P-5); null until the person adds one. */
  avatarSha256?: string | null
}
export type Invite = {
  id: string
  email: string
  role: InvitableRole
  tokenHash: string
  invitedBy: string
  expiresAt: Date
  acceptedAt: Date | null
  createdAt: Date
}

export type MemberStore = {
  listMembers(): Promise<Member[]>
  getMember(id: string): Promise<Member | null>
  findMemberByEmail(email: string): Promise<Member | null>
  setRole(id: string, role: InvitableRole): Promise<void>
  removeMember(id: string): Promise<void>
  listOpenInvites(now: Date): Promise<Invite[]>
  /** Replaces any open invite for the same address: only the newest link works. */
  insertInvite(invite: Invite): Promise<void>
  findInviteByHash(tokenHash: string): Promise<Invite | null>
  getInvite(id: string): Promise<Invite | null>
  /** Atomically marks an open, unexpired invite accepted; false when it was already used or expired. */
  consumeInvite(id: string, now: Date): Promise<boolean>
}

export type InviteMail = {
  send(input: { to: string; subject: string; html: string; text: string }): Promise<unknown>
  /** Whether company mail is set up; without it the link is only shown to the inviter to copy. */
  isConfigured(): Promise<boolean>
}

export class MemberError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'owner_protected' | 'already_member' | 'invalid_email' | 'invalid_role' | 'invalid_group',
    message: string,
  ) {
    super(message)
  }
}

/** Who is acting: a person (their stored role) or the agent (admin rights, behind the approval gate). */
export type Actor = { id: string; role: MemberRole | null }

function assertCanManage(actor: Actor): void {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    throw new MemberError('forbidden', 'Only the owner or an admin can manage members.')
  }
}

export const hashInviteToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/invite?token=${encodeURIComponent(token)}`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export type MemberDeps = {
  store: MemberStore
  mail: InviteMail
  origin: string
  companyName: string | null
  now?: () => Date
}

export async function listMembers(actor: Actor, deps: Pick<MemberDeps, 'store' | 'now'>) {
  assertCanManage(actor)
  const now = deps.now?.() ?? new Date()
  const [members, invites] = await Promise.all([deps.store.listMembers(), deps.store.listOpenInvites(now)])
  return {
    members: members.map((m) => ({ id: m.id, email: m.email, name: m.name, role: m.role })),
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() })),
  }
}

export async function inviteMember(
  actor: Actor,
  input: { email: string; role: InvitableRole },
  deps: MemberDeps,
): Promise<{ inviteId: string; email: string; role: InvitableRole; expiresAt: string; url: string; emailed: boolean }> {
  assertCanManage(actor)
  const email = z.string().trim().toLowerCase().email().safeParse(input.email)
  if (!email.success) throw new MemberError('invalid_email', 'Enter a valid email address.')
  const role = invitableRole.parse(input.role)
  if (await deps.store.findMemberByEmail(email.data)) {
    throw new MemberError('already_member', `${email.data} is already a member.`)
  }
  const now = deps.now?.() ?? new Date()
  const token = randomBytes(32).toString('base64url')
  const invite: Invite = {
    id: randomUUID(),
    email: email.data,
    role,
    tokenHash: hashInviteToken(token),
    invitedBy: actor.id,
    expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000),
    acceptedAt: null,
    createdAt: now,
  }
  await deps.store.insertInvite(invite)
  const company = deps.companyName ?? 'the company'
  const url = inviteUrl(deps.origin, token)
  const roleWord = role === 'admin' ? 'an admin' : 'a member'
  const emailed = await deps.mail.isConfigured()
  if (emailed) await deps.mail.send({
    to: email.data,
    subject: `You're invited to join ${company}`,
    text: `You're invited to join ${company} as ${roleWord}.\n\nAccept the invite (works once, for ${INVITE_TTL_DAYS} days):\n${url}\n`,
    html: `<p>You're invited to join <strong>${escapeHtml(company)}</strong> as ${roleWord}.</p><p><a href="${escapeHtml(url)}">Accept the invite</a> (works once, for ${INVITE_TTL_DAYS} days).</p>`,
  })
  return { inviteId: invite.id, email: invite.email, role, expiresAt: invite.expiresAt.toISOString(), url, emailed }
}

export async function setMemberRole(
  actor: Actor,
  input: { userId: string; role: InvitableRole },
  deps: Pick<MemberDeps, 'store'>,
): Promise<{ userId: string; email: string; role: InvitableRole }> {
  assertCanManage(actor)
  const role = invitableRole.parse(input.role)
  const target = await deps.store.getMember(input.userId)
  if (!target) throw new MemberError('not_found', 'No such member.')
  if (target.role === 'owner') throw new MemberError('owner_protected', "The owner's role can't be changed.")
  await deps.store.setRole(target.id, role)
  return { userId: target.id, email: target.email, role }
}

export async function removeMember(
  actor: Actor,
  input: { userId: string },
  deps: Pick<MemberDeps, 'store'>,
): Promise<{ userId: string; email: string }> {
  assertCanManage(actor)
  const target = await deps.store.getMember(input.userId)
  if (!target) throw new MemberError('not_found', 'No such member.')
  if (target.role === 'owner') throw new MemberError('owner_protected', "The owner can't be removed.")
  await deps.store.removeMember(target.id)
  return { userId: target.id, email: target.email }
}

export type InviteStatus = { ok: true; invite: Invite } | { ok: false; reason: 'invalid' | 'expired' | 'used' }

export async function inviteStatus(token: string, deps: Pick<MemberDeps, 'store' | 'now'>): Promise<InviteStatus> {
  if (!token) return { ok: false, reason: 'invalid' }
  const invite = await deps.store.findInviteByHash(hashInviteToken(token))
  if (!invite) return { ok: false, reason: 'invalid' }
  if (invite.acceptedAt) return { ok: false, reason: 'used' }
  if ((deps.now?.() ?? new Date()).getTime() > invite.expiresAt.getTime()) return { ok: false, reason: 'expired' }
  return { ok: true, invite }
}

const INVITE_MESSAGES = {
  invalid: 'This invite link is not valid. Use the exact link you were sent.',
  expired: 'This invite has expired. Ask the owner for a new one.',
  used: 'This invite was already used. Sign in instead.',
} as const

export function inviteMessage(reason: keyof typeof INVITE_MESSAGES): string {
  return INVITE_MESSAGES[reason]
}
