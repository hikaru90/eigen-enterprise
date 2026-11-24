import type { PersonPrincipal } from './runner'
import type { DemoPorts } from './tools'
import type { Teammate } from './types'
import { emitKernelEvent, type EventSink } from '$lib/kernel/events'
import { auth } from '$lib/server/auth'
import { getUserRole, personFor } from '$lib/server/auth/user-role'
import { withDbUser } from '$lib/server/db'
import {
  dbDemoGuestStore,
  findDemoGuestUserByEmail,
  findDemoGuestUserById,
  isDemoModuleActiveInDb,
} from '$lib/server/demo/guest-access-db'
import { humanActor, inviteMember, memberDeps } from '$lib/server/members'
import { createInvitedAccount } from '$lib/server/members/accept'
import { dbMemberStore } from '$lib/server/members/db-store'

/** The signed-out DB session a request without a person runs in (hooks.server.ts). */
const SIGNED_OUT = ''

async function personOf(userId: string): Promise<PersonPrincipal> {
  const person = await personFor(userId)
  if (!person) throw new Error(`user ${userId} is not a member`)
  return { id: person.id, roles: person.roles }
}

/**
 * A teammate joins the way a person does: the owner invites (inviteMember,
 * the service behind members.invite), the invite is accepted and creates the
 * account with the invited role through Better Auth's user-create hook (which
 * consumes the invite). The teammates' addresses are fictitious (.example):
 * no invite is mailed (the service's own "mail is not set up" branch), and
 * nobody is signed in — see createInvitedAccount.
 */
async function addTeammate(owner: PersonPrincipal, t: Teammate): Promise<PersonPrincipal> {
  const noMail = {
    isConfigured: async () => false,
    send: async () => {
      throw new Error('the demo seed never mails an invite')
    },
  }
  // Inviting runs in the owner's own DB session (Settings → Members as the owner) …
  const invite = await withDbUser(owner.id, async () =>
    inviteMember(
      await humanActor(owner.id),
      { email: t.email, role: t.role },
      { ...(await memberDeps()), mail: noMail },
    ),
  )
  const token = new URL(invite.url).searchParams.get('token')
  if (!token) throw new Error(`invite for ${t.email} carries no token`)
  // … accepting in a signed-out one (the /invite page before the person exists).
  const ctx = await auth.$context
  await withDbUser(SIGNED_OUT, () =>
    createInvitedAccount(
      token,
      { name: `${t.firstName} ${t.lastName}` },
      {
        store: dbMemberStore,
        // What the email-code sign-in does for a new address, minus the session: the
        // account (emailVerified, as the code would prove), through the same hooks.
        createAccount: (email, name) =>
          ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: 'email-otp' }),
      },
    ),
  )
  const member = await dbMemberStore.findMemberByEmail(t.email)
  if (!member) throw new Error(`${t.email} accepted the invite but is no member`)
  return personOf(member.id)
}

export function demoPorts(eventSink?: EventSink): DemoPorts {
  return {
    roleOf: getUserRole,
    personOf,
    addTeammate,
    guestAccess: {
      store: dbDemoGuestStore,
      demoModuleActive: isDemoModuleActiveInDb,
      findUserById: findDemoGuestUserById,
      findUserByEmail: findDemoGuestUserByEmail,
      audit: async (event) => {
        if (!eventSink) return
        await emitKernelEvent(eventSink, { ...event, source: 'demo' })
      },
    },
  }
}
