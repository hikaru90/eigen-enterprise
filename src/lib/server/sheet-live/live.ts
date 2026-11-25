import type { Actor } from '$lib/server/drive'
import { dbSheetLiveStore, SHEET_LIVE_NOTIFY_CHANNEL } from './db-store'
import { createSheetLive, type LiveMessage, type SheetLive } from './service'

/**
 * Live wiring for .xlsx co-editing: Postgres-backed session/log/presence store
 * + NOTIFY/LISTEN fan-out across app processes (web server and `ee` CLI).
 *
 * `sheetLive()` builds the service without opening a persistent LISTEN
 * connection (for short-lived CLI processes that submit tool writes and exit);
 * `sheetLiveListening()` ensures `LISTEN ee_sheet_live` is active for the
 * web server's open SSE streams and presence/save sweep timers.
 */

let livePromise: Promise<SheetLive> | null = null
let listenPromise: Promise<SheetLive> | null = null

async function nameOf(actor: Actor): Promise<string> {
  const { accountOf } = await import('$lib/server/members/account-of')
  const id = actor.kind === 'user' ? actor.userId : actor.id
  const acc = await accountOf(id)
  if (acc?.name) return acc.name
  if (actor.kind === 'agent') return actor.id === 'orchestrator' ? 'Assistant' : actor.id
  return 'Someone'
}

async function publish(message: LiveMessage): Promise<void> {
  const { appSql } = await import('$lib/server/db')
  const compact: LiveMessage =
    message.k === 'save_failed' && message.error.length > 500
      ? { ...message, error: `${message.error.slice(0, 497)}...` }
      : message
  await appSql`SELECT pg_notify(${SHEET_LIVE_NOTIFY_CHANNEL}, ${JSON.stringify(compact)})`
}

export function sheetLive(): Promise<SheetLive> {
  livePromise ??= (async () => {
    const { driveService } = await import('$lib/server/drive')
    const { onShutdownSignal } = await import('$lib/server/shutdown')
    const live = createSheetLive({
      drive: await driveService(),
      store: dbSheetLiveStore,
      publish,
      nameOf,
    })
    onShutdownSignal('sheet-live', () => live.stop())
    return live
  })().catch((err) => {
    livePromise = null
    throw err
  })
  return livePromise
}

export function sheetLiveListening(): Promise<SheetLive> {
  listenPromise ??= (async () => {
    const live = await sheetLive()
    const { appSql } = await import('$lib/server/db')
    await appSql.listen(
      SHEET_LIVE_NOTIFY_CHANNEL,
      (payload) => {
        try {
          live.receive(JSON.parse(payload) as LiveMessage)
        } catch (err) {
          console.error('[sheet-live] failed to handle notification', { err })
        }
      },
      () => {
        live.resync().catch((err) => console.error('[sheet-live] resync after LISTEN reconnect failed', { err }))
      },
    )
    return live
  })().catch((err) => {
    listenPromise = null
    throw err
  })
  return listenPromise
}
