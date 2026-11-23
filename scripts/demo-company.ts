import type { Teammate } from './demo-company/types'
/**
 * The demo company (plan/phase-demo-company.md DC1):
 *
 *   npm run demo-company -- seed     fill an empty, claimed company with Northwind Studio
 *
 * Runs as the os workload (same env as the app: DATABASE_URL, auth secrets).
 * Every write is a kernel registry tool executed in-process as the person it
 * belongs to (the owner, or the teammate who wrote the message / holds the
 * contact), the same path the ee CLI takes. Teammates become real members
 * through the members invite + accept code path. Seeding twice fails loud.
 */
import { registerAdminTools } from '$lib/kernel/admin-bootstrap'
import { auth } from '$lib/server/auth'
import { personFor } from '$lib/server/auth/user-role'
import { withDbUser } from '$lib/server/db'
import { humanActor, inviteMember, memberDeps } from '$lib/server/members'
import { joinWithInvite } from '$lib/server/members/accept'
import { dbMemberStore } from '$lib/server/members/db-store'
import { bootstrapKernel } from '../modules/index'
import { northwind } from './demo-company/dataset'
import { seedDemoCompany, type PersonPrincipal } from './demo-company/runner'
import { withoutBrowser } from './demo-company/server-request'

/** The signed-out DB session a request without a person runs in (hooks.server.ts). */
const SIGNED_OUT = ''

async function principalOf(userId: string): Promise<PersonPrincipal> {
  const person = await personFor(userId)
  if (!person) throw new Error(`user ${userId} is not a member`)
  return { id: person.id, roles: person.roles }
}

/** The person who claimed this company; none = unclaimed, which the seed refuses. */
async function claimedOwner(): Promise<PersonPrincipal> {
  const owners = (await dbMemberStore.listMembers()).filter((m) => m.role === 'owner')
  if (owners.length !== 1)
    throw new Error(
      `the company is not claimed (found ${owners.length} owners): claim it first, then seed`,
    )
  return principalOf(owners[0]!.id)
}

/**
 * A teammate joins the way a person does: the owner invites (inviteMember,
 * the service behind members.invite), the invite is accepted (joinWithInvite,
 * the /invite path) and creates the account with the invited role. The
 * teammates' addresses are fictitious (.example), so no invite is mailed: the
 * service's own "mail is not set up" branch, where the owner copies the link.
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
  await withDbUser(SIGNED_OUT, () =>
    withoutBrowser(() =>
      joinWithInvite(
        token,
        { name: `${t.firstName} ${t.lastName}` },
        {
          store: dbMemberStore,
          createCode: (email) =>
            auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } }),
          signIn: (email, code, name) =>
            auth.api.signInEmailOTP({ body: { email, otp: code, name }, headers: new Headers() }),
        },
      ),
    ),
  )
  const member = await dbMemberStore.findMemberByEmail(t.email)
  if (!member) throw new Error(`${t.email} accepted the invite but is no member`)
  return principalOf(member.id)
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] !== 'seed' || argv.length !== 1) {
    console.error('usage: demo-company seed')
    return 1
  }
  const kernel = bootstrapKernel()
  await registerAdminTools(kernel)
  const owner = await claimedOwner()
  const counts = await seedDemoCompany(northwind, {
    registry: kernel.registry,
    owner,
    addTeammate: (t) => addTeammate(owner, t),
    now: new Date(),
    log: (line) => console.info(`[demo-company] ${line}`),
  })
  console.info(JSON.stringify({ seeded: northwind.companyName, ...counts }, null, 2))
  return 0
}

try {
  process.exit(await main(process.argv.slice(2).filter((a) => a !== '--')))
} catch (err) {
  console.error(`[demo-company] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
}
