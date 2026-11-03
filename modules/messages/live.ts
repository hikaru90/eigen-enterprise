import type { AttachmentPort, DriveFileInfo, MessageDto, MessagesAudit, MessagesDeps } from './service'
import type { Conversation, Directory } from './store'
import { liveAccessPort } from './access-port'
import { dbMessagesStore, MESSAGES_NOTIFY_CHANNEL } from './db-store'
import { MessagesHub } from './hub'
import { notifyNewMessage, type PushPort } from './notify'

/**
 * Live wiring: the DB store over the app pool (company-level tables, no RLS),
 * the members table as directory, the access port, web push, and one hub per
 * process fed by Postgres LISTEN.
 */

let depsPromise: Promise<MessagesDeps> | null = null
let hubPromise: Promise<MessagesHub> | null = null

async function liveDirectory(): Promise<Directory> {
  const { dbMemberStore } = await import('$lib/server/members/db-store')
  const { getUserRole } = await import('$lib/server/auth/user-role')
  return {
    async listPeople() {
      return (await dbMemberStore.listMembers()).map((m) => ({ id: m.id, name: m.name, email: m.email }))
    },
    role: (userId) => getUserRole(userId),
  }
}

/** Moderation lands in kernel_events (Overview activity, audit), like access changes. */
const kernelAudit: MessagesAudit = async ({ type, principalId, payload }) => {
  const { appKernel } = await import('$lib/server/boot')
  const { emitKernelEvent } = await import('$lib/kernel/events')
  const { moduleSource } = await import('$lib/kernel/cloudevents')
  const kernel = await appKernel()
  await emitKernelEvent(kernel.eventSink, { type, principalId, source: moduleSource('messages'), payload })
}

/**
 * Attachments through the live Drive's public seam ($lib/server/drive, as the
 * routes use it — never the drive module's internals): system-made folders,
 * uploads as the person (Drive access + size limit). The folder's first
 * grants go through the access contract ($lib/server/access); the Drive
 * service registered the folder resolver when it started.
 */
async function liveAttachmentPort(): Promise<AttachmentPort> {
  const { driveService, DriveError } = await import('$lib/server/drive')
  const { access } = await import('$lib/server/access')
  const drive = await driveService()
  const system = { kind: 'agent', id: 'messages' } as const
  const info = (v: { id: string; name: string; mime?: string; size?: number; parentId: string | null; ownerId: string }): DriveFileInfo => {
    if (v.mime === undefined || v.size === undefined) throw new Error(`drive file ${v.id} has no mime/size`)
    return { id: v.id, name: v.name, mime: v.mime, size: v.size, folderId: v.parentId, ownerId: v.ownerId }
  }
  return {
    createSystemFolder: async (parentId, name) => (await drive.createFolder(system, parentId, name)).id,
    async initFolderGrants(creatorId, folderId, grants) {
      await access.initializeGrants(creatorId, 'folder', folderId, grants)
    },
    async upload(actorId, folderId, file) {
      try {
        return { ok: true, file: info(await drive.upload({ kind: 'user', userId: actorId }, folderId, file)) }
      } catch (err) {
        // Size/name problems are per file, in the Drive's own words; access refusals stay failures.
        if (err instanceof DriveError && (err.code === 'too_large' || err.code === 'invalid')) return { ok: false, error: err.message }
        throw err
      }
    },
    async fileInfo(actorId, fileId) {
      try {
        return info((await drive.fileInfo({ kind: 'user', userId: actorId }, fileId)).file)
      } catch (err) {
        if (err instanceof DriveError && (err.code === 'not_found' || err.code === 'forbidden')) return null
        throw err
      }
    },
  }
}

export function messagesDeps(): Promise<MessagesDeps> {
  depsPromise ??= (async () => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const db = createScopedDrizzle(appSql)
    const store = dbMessagesStore(db)
    return {
      store,
      access: await liveAccessPort(async (id) => {
        const { isId } = await import('./service')
        if (!isId(id)) return false
        const c = await store.getConversation(id)
        return c?.kind === 'channel'
      }),
      directory: await liveDirectory(),
      audit: kernelAudit,
      drive: await liveAttachmentPort(),
    }
  })().catch((err) => {
    depsPromise = null
    throw err
  })
  return depsPromise
}

/** This process's hub; the first call starts LISTEN ee_messages (re-dispatching after reconnects). */
export function messagesHub(): Promise<MessagesHub> {
  hubPromise ??= (async () => {
    const hub = new MessagesHub(await messagesDeps())
    const { appSql } = await import('$lib/server/db')
    await appSql.listen(
      MESSAGES_NOTIFY_CHANNEL,
      (payload) => {
        const id = Number(payload)
        if (!Number.isSafeInteger(id)) {
          console.error('[messages] ignoring malformed notify payload', payload)
          return
        }
        hub.dispatch(id).catch((err) => console.error('[messages] dispatch failed', { id, err }))
      },
      () => {
        hub.resync().catch((err) => console.error('[messages] resync after LISTEN reconnect failed', err))
      },
    )
    return hub
  })().catch((err) => {
    hubPromise = null
    throw err
  })
  return hubPromise
}

const livePush: PushPort = {
  async hasSubscription(userId) {
    const { listPushSubscriptionsForUser } = await import('$lib/server/push/subscription')
    return (await listPushSubscriptionsForUser(userId)).length > 0
  },
  async send(userId, payload) {
    const { sendPushToUser } = await import('$lib/server/push/send')
    await sendPushToUser(userId, payload)
  },
}

/** Fire-and-log: a failed push never fails the post. */
export function pushNewMessage(deps: MessagesDeps, c: Conversation, m: MessageDto): void {
  notifyNewMessage(deps, livePush, c, m).catch((err) =>
    console.error('[messages] push dispatch failed', { conversationId: c.id, err }),
  )
}
