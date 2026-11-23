import type { CallBrain } from './brain'
import type { CallContextPort, CallLogPort } from './context-port'
import type { CallsDirectory } from './store'
import { dbBrainAnswerStore } from './brain-db-store'
import { liveBrain } from './brain-live'
import { CALLS_CHAT_NOTIFY_CHANNEL, chatSeqOf, dbChatStore } from './chat-db-store'
import { CALLS_NOTIFY_CHANNEL, dbCallsStore } from './db-store'
import { CallsError } from './errors'
import { CallsHub } from './hub'
import { liveRoomControl, livekitConfig } from './livekit'
import { createCallsService, type CallSpeech, type CallsService } from './service'
import { RING_TIMEOUT_MS } from './state'
import { dbTranscriptStore } from './transcript-db-store'

/**
 * Live wiring: the Postgres store over the app pool (company-level tables, no
 * RLS), the members table as directory, LiveKit from the env (read at use
 * time), the conversation port handed in by the composition root, one hub per
 * process fed by LISTEN ee_calls (call changes) and LISTEN ee_calls_chat (chat
 * lines), and a sweep that stores elapsed ring windows
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

/**
 * Call transcripts' speech to text: the app's one transcription path
 * (`transcribeAudio`, STT_MODEL qwen/qwen3-asr-1.7b, through the gateway) on
 * the company's AI provider — like dictation, so every member (and a guest,
 * billed to the host) is transcribed without a provider of their own.
 *
 * Declared as private content (`contentOrigin: 'memory'`, the gateway's only
 * "never keep the text" origin): what people say in a call is not written to
 * the server log or the AI usage log; cost, model and timing are kept.
 *
 * No vocabulary prompt (it has no effect on this model, plan/progress.md
 * 2026-11-19) and no LLM judge per chunk: the browser drops silent chunks
 * before upload ($lib/voice/clip-speech.ts).
 */
const liveSpeech: CallSpeech = async ({ userId, audio }) => {
  const { onCompanyProvider } = await import('$lib/server/llm/company-provider')
  const { isLlmNotConfiguredError } = await import('$lib/server/llm/errors')
  const { transcribeAudio } = await import('$lib/server/llm/stt-client')
  try {
    return await onCompanyProvider(() => transcribeAudio({ userId, audio, contentOrigin: 'memory' }))
  } catch (err) {
    if (isLlmNotConfiguredError(err)) throw new CallsError('unavailable', err instanceof Error ? err.message : String(err))
    throw new Error(`speech to text failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

/**
 * The Company Brain in a call (./brain-live.ts: the assistant's answer path,
 * as the asker). No AI provider on this server → 'unavailable' (the call goes
 * on; the panel says so), any other failure stays a failure.
 */
async function brainCall<T>(fn: () => Promise<T>): Promise<T> {
  const { isLlmNotConfiguredError } = await import('$lib/server/llm/errors')
  try {
    return await fn()
  } catch (err) {
    if (isLlmNotConfiguredError(err)) throw new CallsError('unavailable', err instanceof Error ? err.message : String(err))
    throw err
  }
}
const liveCallBrain: CallBrain = {
  answer: (input) => brainCall(() => liveBrain.answer(input)),
  recap: (input) => brainCall(() => liveBrain.recap(input)),
}

/** What the composition root hands Calls: its conversation ports, both answered by Messages. */
export type CallsPorts = { contexts: CallContextPort; log: CallLogPort }

/** This process's Calls service (first call wins; the ports are the composition root's Messages adapters). */
export function callsService(ports: CallsPorts): Promise<CallsService> {
  servicePromise ??= (async () => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const { companyMail } = await import('$lib/server/mail')
    const { normalizeAuthOrigin } = await import('$lib/server/auth')
    const { env } = await import('$lib/server/env/private-env')
    const { foundingCompanyName } = await import('$lib/server/overview/sources')
    const mail = companyMail()
    const db = createScopedDrizzle(appSql)
    const service = createCallsService({
      store: dbCallsStore(db),
      transcripts: dbTranscriptStore(db),
      speech: liveSpeech,
      brain: liveCallBrain,
      brainAnswers: dbBrainAnswerStore(db),
      chat: dbChatStore(db),
      contexts: ports.contexts,
      log: ports.log,
      directory: await liveDirectory(),
      livekit: () => livekitConfig(process.env),
      rooms: liveRoomControl(() => livekitConfig(process.env)),
      // Guest invitations: company mail like every transactional send (system source: no body in the log).
      mail: {
        isConfigured: () => mail.isConfigured(),
        send: (input) => mail.send({ ...input, source: 'system' }),
      },
      origin: () => normalizeAuthOrigin(env.ORIGIN),
      companyName: () => foundingCompanyName(),
    })
    const sweep = setInterval(() => {
      service.expireRinging().catch((err) => console.error('[calls] ring-timeout sweep failed', err))
      service.expireWindows().catch((err) => console.error('[calls] meeting-window sweep failed', err))
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
export function callsHub(ports: CallsPorts): Promise<CallsHub> {
  hubPromise ??= (async () => {
    const hub = new CallsHub(await callsService(ports))
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
    // Chat lines missed while LISTEN was down are not replayed here: the resync's call frames
    // make every open call view read its chat on from its own cursor.
    await appSql.listen(CALLS_CHAT_NOTIFY_CHANNEL, (payload) => {
      Promise.resolve()
        .then(() => hub.dispatchChat(chatSeqOf(payload)))
        .catch((err) => console.error('[calls] chat dispatch failed', { payload, err }))
    })
    return hub
  })().catch((err) => {
    hubPromise = null
    throw err
  })
  return hubPromise
}
