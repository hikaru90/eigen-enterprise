import type { AllowlistStore, SessionStore } from './stores'
import { emitKernelEvent, type EventSink } from '$lib/kernel/events'
import { chatGatewayEnv } from './env'

export const TELEGRAM_PLATFORM = 'telegram'

const DEFAULT_POLL_TIMEOUT_SEC = 25
const DEFAULT_CHUNK_MAX_LEN = 4000
const TELEGRAM_API_BASE = 'https://api.telegram.org'

export type TelegramUpdate = {
  update_id: number
  message?: {
    chat: { id: number | string }
    from?: { id: number | string; username?: string }
    text?: string
  }
}

export type TelegramClient = {
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>
  sendMessage(chatId: string, text: string): Promise<void>
}

type TelegramApiResponse = {
  ok?: unknown
  result?: unknown
  description?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Structural validation only — malformed entries are dropped at the transport edge. */
function parseTelegramUpdate(raw: unknown): TelegramUpdate | null {
  if (!isRecord(raw)) return null
  const updateId = raw.update_id
  if (typeof updateId !== 'number' || !Number.isFinite(updateId)) return null
  if (raw.message !== undefined && !isRecord(raw.message)) return null
  return raw as TelegramUpdate
}

export class HttpTelegramClient implements TelegramClient {
  private readonly botToken: string
  private readonly apiBase: string
  private readonly fetchImpl: typeof fetch

  constructor(options: { botToken: string; apiBase?: string; fetchImpl?: typeof fetch }) {
    if (!options.botToken) {
      throw new TypeError('HttpTelegramClient requires a botToken (no fallback)')
    }
    this.botToken = options.botToken
    this.apiBase = options.apiBase ?? TELEGRAM_API_BASE
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    const response = await this.request('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message'],
    })
    const result = response.result
    if (!Array.isArray(result)) return []
    const updates: TelegramUpdate[] = []
    for (const raw of result) {
      const update = parseTelegramUpdate(raw)
      if (update) updates.push(update)
    }
    return updates
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.request('sendMessage', { chat_id: chatId, text })
  }

  /** Errors never include the bot token — only method, status, and API description. */
  private async request(
    method: string,
    body: Record<string, unknown>,
  ): Promise<TelegramApiResponse> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiBase}/bot${this.botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      throw new Error(
        `telegram ${method} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
    const payload = (await response.json().catch(() => null)) as TelegramApiResponse | null
    if (!response.ok || !payload || payload.ok !== true) {
      const description =
        typeof payload?.description === 'string' ? payload.description : 'unknown telegram error'
      throw new Error(`telegram ${method} failed (${response.status}): ${description}`)
    }
    return payload
  }
}

export function telegramClientFromEnv(env: Record<string, string | undefined>): TelegramClient {
  const { botToken } = chatGatewayEnv(env)
  return new HttpTelegramClient({ botToken })
}

/**
 * Long-polling cursor: max update_id + 1 over all received updates (skipped
 * ones included, or Telegram would redeliver them forever). Null when empty.
 */
export function nextOffset(updates: readonly TelegramUpdate[]): number | null {
  let max: number | null = null
  for (const update of updates) {
    if (typeof update.update_id === 'number' && Number.isFinite(update.update_id)) {
      max = max === null ? update.update_id : Math.max(max, update.update_id)
    }
  }
  return max === null ? null : max + 1
}

/** Split on UTF-16 code points so surrogate pairs never break mid-character. */
function hardWrap(text: string, maxLen: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const char of text) {
    if (current !== '' && current.length + char.length > maxLen) {
      chunks.push(current)
      current = char
    } else {
      current += char
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/**
 * Split a reply into sendable chunks: paragraph boundaries (\n\n) first, then
 * hard-wrap. Every chunk is non-empty and at most `maxLen` UTF-16 units.
 */
export function chunkMessage(text: string, maxLen = DEFAULT_CHUNK_MAX_LEN): string[] {
  if (maxLen < 1) throw new RangeError(`chunkMessage maxLen must be >= 1, got ${maxLen}`)
  if (text.trim().length === 0) return []
  const chunks: string[] = []
  let current = ''
  for (const paragraph of text.split(/\n{2,}/)) {
    const pieces = paragraph.length > maxLen ? hardWrap(paragraph, maxLen) : [paragraph]
    for (const piece of pieces) {
      if (current === '') {
        current = piece
      } else if (current.length + 2 + piece.length <= maxLen) {
        current += `\n\n${piece}`
      } else {
        chunks.push(current)
        current = piece
      }
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

export type TelegramSessionRef = {
  sessionId: string
  platform: string
  externalChatId: string
  principalId: string
}

export type Brain = {
  respond(session: TelegramSessionRef, text: string): Promise<string>
}

export type TelegramGatewayDeps = {
  allowlist: AllowlistStore
  sessions: SessionStore
  events: EventSink
  brain: Brain
  client: TelegramClient
}

/**
 * One poll cycle: allowlist gate → session touch → kernel events → orchestrator
 * → chunked reply. Denied users get a `gateway.telegram.denied` event and are
 * skipped silently (no reply). Message content never enters events.
 */
export class TelegramGateway {
  constructor(private readonly deps: TelegramGatewayDeps) {}

  async runCycle(offset: number, timeoutSec = DEFAULT_POLL_TIMEOUT_SEC): Promise<number> {
    const updates = await this.deps.client.getUpdates(offset, timeoutSec)
    return (await this.processUpdates(updates)) ?? offset
  }

  async processUpdates(updates: readonly TelegramUpdate[]): Promise<number | null> {
    for (const update of updates) {
      await this.processUpdate(update)
    }
    return nextOffset(updates)
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message
    if (!message) return
    const text = message.text
    if (typeof text !== 'string' || text.trim().length === 0) return
    const chatId = message.chat?.id
    if (chatId === undefined || chatId === null || chatId === '') return
    const fromId = message.from?.id
    if (fromId === undefined || fromId === null || fromId === '') return

    const externalUserId = String(fromId)
    const allowed = await this.deps.allowlist.isAllowed(TELEGRAM_PLATFORM, externalUserId)
    if (!allowed) {
      await this.deny(externalUserId, String(chatId))
      return
    }
    const principalId = await this.deps.allowlist.principalFor(TELEGRAM_PLATFORM, externalUserId)
    if (principalId === null) {
      await this.deny(externalUserId, String(chatId))
      return
    }

    const externalChatId = String(chatId)
    const session = await this.deps.sessions.touch(TELEGRAM_PLATFORM, externalChatId, principalId)

    await emitKernelEvent(this.deps.events, {
      type: 'gateway.telegram.message',
      principalId,
      // Metadata only — never message content.
      payload: { chatId: externalChatId, principalId, textLength: text.length },
    })

    const reply = await this.deps.brain.respond(
      { sessionId: session.id, platform: TELEGRAM_PLATFORM, externalChatId, principalId },
      text,
    )

    for (const chunk of chunkMessage(reply)) {
      await this.deps.client.sendMessage(externalChatId, chunk)
    }
  }

  private async deny(externalUserId: string, externalChatId: string): Promise<void> {
    await emitKernelEvent(this.deps.events, {
      type: 'gateway.telegram.denied',
      payload: { platform: TELEGRAM_PLATFORM, externalUserId, externalChatId },
    })
  }
}
