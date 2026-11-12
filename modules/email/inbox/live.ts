import type { InboxAudit, InboxDeps, InboxMember } from './service'
import { dbInboxStore } from './db-store'

/**
 * Live wiring: the DB store over the app pool (company-level tables, no RLS),
 * roles and names from the members tables, groups from the company data repo,
 * verified domains from the email platform, kernel events for the audit trail.
 */

let depsPromise: Promise<InboxDeps> | null = null

async function members(): Promise<InboxMember[]> {
  const { asc, eq } = await import('drizzle-orm')
  const { authDb } = await import('$lib/server/db/auth-db')
  const { user } = await import('$lib/server/db/auth.schema')
  // Harness accounts exist for automated verification only (as in the members store).
  return authDb
    .select({ id: user.id, name: user.name, email: user.email, firstName: user.firstName, lastName: user.lastName })
    .from(user)
    .where(eq(user.accountKind, 'production'))
    .orderBy(asc(user.createdAt))
}

const kernelAudit: InboxAudit = async ({ type, principalId, payload }) => {
  const { appKernel } = await import('$lib/server/boot')
  const { emitKernelEvent } = await import('$lib/kernel/events')
  const { moduleSource } = await import('$lib/kernel/cloudevents')
  const kernel = await appKernel()
  await emitKernelEvent(kernel.eventSink, { type, principalId, source: moduleSource('email'), payload })
}

export function inboxDeps(): Promise<InboxDeps> {
  depsPromise ??= (async (): Promise<InboxDeps> => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const { getUserRole } = await import('$lib/server/auth/user-role')
    const { groupDeps } = await import('$lib/server/members')
    const { emailPlatform } = await import('../platform/service')
    return {
      store: dbInboxStore(createScopedDrizzle(appSql)),
      roleOf: getUserRole,
      members,
      groups: async () => (await (await groupDeps()).groups.listGroups()).map((g) => ({ id: g.id, name: g.name, memberIds: g.memberIds })),
      domains: async () =>
        (await emailPlatform().listDomains()).filter((d) => d.sendable).map((d) => ({ id: d.id, name: d.name })),
      audit: kernelAudit,
    }
  })().catch((err) => {
    depsPromise = null
    throw err
  })
  return depsPromise
}

let inboundPromise: Promise<import('./inbound').InboundDeps> | null = null

/**
 * Live wiring for /api/mail/ses-inbound: the receiving settings S2 stores
 * (topic, bucket), the raw mail from S3 with the company's SES keys, the DB store.
 */
export function inboundDeps(): Promise<import('./inbound').InboundDeps> {
  inboundPromise ??= (async () => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const { defaultOwleryStore } = await import('../owlery/store')
    const { owleryService } = await import('../owlery/service')
    const { s3RawMailSource } = await import('./raw-source')
    const { MAX_RAW_BYTES } = await import('./ingest')
    const credentials = async () => {
      const s = await owleryService().settings()
      if (!s) throw new Error('Amazon SES is not set up, so received mail cannot be read from S3.')
      return { region: s.region, accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey }
    }
    return {
      owlery: defaultOwleryStore(),
      fetch,
      ingest: { store: dbInboxStore(createScopedDrizzle(appSql)), raw: s3RawMailSource(credentials, MAX_RAW_BYTES) },
    }
  })().catch((err) => {
    inboundPromise = null
    throw err
  })
  return inboundPromise
}
