import type { DownloadDeps } from './attachments'
import type { InboxHub } from './hub'
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
    const { s3RawMailSource } = await import('./raw-source')
    const { MAX_RAW_BYTES } = await import('./ingest')
    const credentials = sesCredentials
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

/** The company's SES keys for reading raw mail from the inbound bucket (resolved per call). */
async function sesCredentials() {
  const { owleryService } = await import('../owlery/service')
  const s = await owleryService().settings()
  if (!s) throw new Error('Amazon SES is not set up, so received mail cannot be read from S3.')
  return { region: s.region, accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey }
}

let downloadPromise: Promise<DownloadDeps> | null = null

/** Live wiring for attachment downloads: the inbox deps, S3 with the company's keys, the stored inbound bucket. */
export function downloadDeps(): Promise<DownloadDeps> {
  downloadPromise ??= (async (): Promise<DownloadDeps> => {
    const { defaultOwleryStore } = await import('../owlery/store')
    const { s3RawMailSource } = await import('./raw-source')
    const { MAX_RAW_BYTES } = await import('./ingest')
    const owlery = defaultOwleryStore()
    return {
      inbox: await inboxDeps(),
      raw: s3RawMailSource(sesCredentials, MAX_RAW_BYTES),
      bucket: async () => {
        const bucket = (await owlery.read())?.receivingBucket
        if (!bucket) throw new Error('Receiving has no inbound bucket stored, so attachments cannot be read.')
        return bucket
      },
    }
  })().catch((err) => {
    downloadPromise = null
    throw err
  })
  return downloadPromise
}

let hubPromise: Promise<InboxHub> | null = null

/** This process's live-mail hub; the first call starts LISTEN inbox_messages. */
export function inboxHub(): Promise<InboxHub> {
  hubPromise ??= (async () => {
    const { InboxHub, parseNotifyPayload } = await import('./hub')
    const { INBOX_NOTIFY_CHANNEL } = await import('./store')
    const hub = new InboxHub(await inboxDeps())
    const { appSql } = await import('$lib/server/db')
    await appSql.listen(INBOX_NOTIFY_CHANNEL, (payload) => {
      const mailboxId = parseNotifyPayload(payload)
      if (!mailboxId) {
        console.error('[inbox] ignoring a malformed notify payload')
        return
      }
      hub.dispatch(mailboxId).catch((err) => console.error('[inbox] dispatch failed', { mailboxId, err }))
    })
    return hub
  })().catch((err) => {
    hubPromise = null
    throw err
  })
  return hubPromise
}
