import { normalizeAuthOrigin } from '$lib/server/auth'
import { getUserRole } from '$lib/server/auth/user-role'
import { env } from '$lib/server/env/private-env'
import { companyMail } from '$lib/server/mail'
import { foundingCompanyName } from '$lib/server/overview/sources'
import { dbMemberStore } from './db-store'
import type { GroupDeps } from './groups'
import type { Actor, MemberDeps } from './service'

export * from './service'

/** The live members wiring: the auth DB, the company mail, this server's origin and company name. */
export async function memberDeps(): Promise<MemberDeps> {
  return {
    store: dbMemberStore,
    mail: companyMail(),
    origin: normalizeAuthOrigin(env.ORIGIN),
    companyName: await foundingCompanyName(),
  }
}

export async function humanActor(userId: string): Promise<Actor> {
  return { id: userId, role: await getUserRole(userId) }
}

export * from './groups'

/**
 * The live groups wiring: the company data repo (groups/<slug>.yaml, files
 * first — plan/phase-git-native.md G0) with Postgres as the rebuildable
 * index, plus kernel audit events.
 */
export async function groupDeps(): Promise<GroupDeps> {
  const { kernelAudit } = await import('$lib/server/access')
  const { companyData } = await import('$lib/server/gitstore/live')
  return { groups: (await companyData()).groups, audit: kernelAudit }
}
