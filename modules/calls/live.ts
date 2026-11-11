import type { CallContextPort } from './context-port'
import type { CallsDirectory } from './store'
import { CALLS_NOTIFY_CHANNEL, dbCallsStore } from './db-store'
import { CallsHub } from './hub'
import { liveRoomControl, livekitConfig } from './livekit'
import { createCallsService, type CallsService } from './service'
import { RING_TIMEOUT_MS } from './state'

/**
 * Live wiring: the Postgres store over the app pool (company-level tables, no
 * RLS), the members table as directory, LiveKit from the env (read at use
 * time), the conversation port handed in by the composition root, one hub per
 * process fed by LISTEN ee_calls, and a sweep that stores elapsed ring windows
 * (every read also derives them, so a slow sweep is never visible).
 */

const SWEEP_MS = Math.min(5_000, RING_TIMEOUT_MS)

let servicePromise: Promise<CallsService> | null = null
let hubPromise: Promise<CallsHub> | null = null

async function liveDirectory(): Promise<CallsDirectory> {
  const { dbMemberStore } = await import('$lib/server/members/db-store')
  const { getUserRole } = await import('$lib/server/auth/user-role')
  return {
    async listPeople() {
      return (await dbMemberStore.listMembers()).map((m) => ({ id: m.id, name: m.name, email: m.email }))
    },
    role: (userId) => getUserRole(userId),
  }
}

/** This process's Calls service (first call wins; `contexts` is the composition root's Messages adapter). */
export function callsService(contexts: CallContextPort): Promise<CallsService> {
  servicePromise ??= (async () => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const service = createCallsService({
      store: dbCallsStore(createScopedDrizzle(appSql)),
      contexts,
      directory: await liveDirectory(),
      livekit: () => livekitConfig(process.env),
      rooms: liveRoomControl(() => livekitConfig(process.env)),
    })
    const sweep = setInterval(() => {
      service.expireRinging().catch((err) => console.error('[calls] ring-timeout sweep failed', err))
    }, SWEEP_MS)
    sweep.unref()
    return service
  })().catch((err) => {
    servicePromise = null
    throw err
  })
  return servicePromise
}

/** This process's hub; the first call starts LISTEN ee_calls. */
export function callsHub(contexts: CallContextPort): Promise<CallsHub> {
  hubPromise ??= (async () => {
    const hub = new CallsHub(await callsService(contexts))
    const { appSql } = await import('$lib/server/db')
    await appSql.listen(
      CALLS_NOTIFY_CHANNEL,
      (callId) => {
        hub.dispatch(callId).catch((err) => console.error('[calls] dispatch failed', { callId, err }))
      },
      () => {
        // Also runs on the first LISTEN (no subscribers yet: a no-op).
        hub.resync().catch((err) => console.error('[calls] resync after LISTEN reconnect failed', err))
      },
    )
    return hub
  })().catch((err) => {
    hubPromise = null
    throw err
  })
  return hubPromise
}
