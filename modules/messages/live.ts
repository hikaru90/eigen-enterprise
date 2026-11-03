import type { MessageDto, MessagesDeps } from './service'
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

export function messagesDeps(): Promise<MessagesDeps> {
  depsPromise ??= (async () => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const db = createScopedDrizzle(appSql)
    const store = dbMessagesStore(db)
    return { store, access: await liveAccessPort(async (id) => {
        const { isId } = await import('./service')
        if (!isId(id)) return false
        const c = await store.getConversation(id)
        return c?.kind === 'channel'
      }), directory: await liveDirectory() }
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
