import { describe, expect, it } from 'vitest'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryAllowlistStore, InMemorySessionStore } from './stores'
import {
  HttpTelegramClient,
  TELEGRAM_PLATFORM,
  TelegramGateway,
  nextOffset,
  telegramClientFromEnv,
  type Brain,
  type TelegramClient,
  type TelegramSessionRef,
  type TelegramUpdate,
} from './telegram'

function textUpdate(
  updateId: number,
  text: string,
  fromId: number | string = 1,
  chatId: number | string = 100,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      chat: { id: chatId },
      from: { id: fromId, username: 'tester' },
      text,
    },
  }
}

class FakeTelegramClient implements TelegramClient {
  readonly sent: Array<{ chatId: string; text: string }> = []
  readonly getUpdatesCalls: Array<{ offset: number; timeoutSec: number }> = []

  constructor(private readonly updates: TelegramUpdate[] = []) {}

  async getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    this.getUpdatesCalls.push({ offset, timeoutSec })
    return this.updates
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text })
  }
}

class FakeBrain implements Brain {
  readonly calls: Array<{ session: TelegramSessionRef; text: string }> = []

  constructor(private readonly reply: string = 'done') {}

  async respond(session: TelegramSessionRef, text: string): Promise<string> {
    this.calls.push({ session, text })
    return this.reply
  }
}

type Fixture = {
  sink: InMemoryEventSink
  client: FakeTelegramClient
  brain: FakeBrain
  allowlist: InMemoryAllowlistStore
  sessions: InMemorySessionStore
  gateway: TelegramGateway
}

function makeFixture(updates: TelegramUpdate[] = []): Fixture {
  const sink = new InMemoryEventSink()
  const client = new FakeTelegramClient(updates)
  const brain = new FakeBrain()
  const allowlist = new InMemoryAllowlistStore()
  const sessions = new InMemorySessionStore()
  const gateway = new TelegramGateway({ allowlist, sessions, events: sink, brain, client })
  return { sink, client, brain, allowlist, sessions, gateway }
}

describe('nextOffset', () => {
  it('returns null for no updates', () => {
    expect(nextOffset([])).toBeNull()
  })

  it('returns max update_id + 1', () => {
    expect(nextOffset([{ update_id: 41 }])).toBe(42)
  })

  it('is robust to unsorted update ids', () => {
    expect(nextOffset([{ update_id: 9 }, { update_id: 5 }, { update_id: 7 }])).toBe(10)
  })

  it('ignores entries without a numeric update_id', () => {
    const broken = { update_id: 'x' } as unknown as TelegramUpdate
    expect(nextOffset([broken, { update_id: 3 }])).toBe(4)
  })
})

describe('TelegramGateway.processUpdates — allowed path', () => {
  it('flows allowlisted messages to brain and sendMessage', async () => {
    const fx = makeFixture([textUpdate(5, 'hello')])
    await fx.allowlist.add(TELEGRAM_PLATFORM, '1', 'principal-1')

    const offset = await fx.gateway.processUpdates([textUpdate(5, 'hello')])

    expect(offset).toBe(6)
    expect(fx.brain.calls).toHaveLength(1)
    expect(fx.brain.calls[0].text).toBe('hello')
    expect(fx.client.sent).toEqual([{ chatId: '100', text: 'done' }])
  })

  it('passes a session ref built from the touched session', async () => {
    const fx = makeFixture([textUpdate(1, 'hi', 7, 42)])
    await fx.allowlist.add(TELEGRAM_PLATFORM, '7', 'principal-7')

    await fx.gateway.processUpdates([textUpdate(1, 'hi', 7, 42)])

    const stored = await fx.sessions.get(TELEGRAM_PLATFORM, '42')
    expect(stored).not.toBeNull()
    expect(stored?.principalId).toBe('principal-7')
    expect(fx.brain.calls[0].session).toEqual({
      sessionId: stored?.id,
      platform: TELEGRAM_PLATFORM,
      externalChatId: '42',
      principalId: 'principal-7',
    })
  })

  it('emits gateway.telegram.message with metadata only, never content', async () => {
    const fx = makeFixture([textUpdate(2, 'super-secret-words')])
    await fx.allowlist.add(TELEGRAM_PLATFORM, '1', 'principal-1')

    await fx.gateway.processUpdates([textUpdate(2, 'super-secret-words')])

    const events = fx.sink.events.filter((e) => e.type === 'gateway.telegram.message')
    expect(events).toHaveLength(1)
    expect(events[0].principalId).toBe('principal-1')
    expect(events[0].payload).toEqual({
      chatId: '100',
      principalId: 'principal-1',
      textLength: 'super-secret-words'.length,
    })
    expect(JSON.stringify(fx.sink.events)).not.toContain('super-secret-words')
  })

  it('splits long replies into chunks', async () => {
    const fx = makeFixture([textUpdate(3, 'hi')])
    fx.brain = new FakeBrain('a'.repeat(9000))
    const gateway = new TelegramGateway({
      allowlist: fx.allowlist,
      sessions: fx.sessions,
      events: fx.sink,
      brain: fx.brain,
      client: fx.client,
    })
    await fx.allowlist.add(TELEGRAM_PLATFORM, '1', 'principal-1')

    await gateway.processUpdates([textUpdate(3, 'hi')])

    expect(fx.client.sent).toHaveLength(3)
    for (const { text } of fx.client.sent) expect(text.length).toBeLessThanOrEqual(4000)
  })
})

describe('TelegramGateway.processUpdates — denied path', () => {
  it('emits gateway.telegram.denied and silently skips', async () => {
    const fx = makeFixture([textUpdate(9, 'knock knock', 999)])

    const offset = await fx.gateway.processUpdates([textUpdate(9, 'knock knock', 999)])

    expect(offset).toBe(10)
    const denied = fx.sink.events.filter((e) => e.type === 'gateway.telegram.denied')
    expect(denied).toHaveLength(1)
    expect(denied[0].payload).toEqual({
      platform: TELEGRAM_PLATFORM,
      externalUserId: '999',
      externalChatId: '100',
    })
    expect(fx.brain.calls).toHaveLength(0)
    expect(fx.client.sent).toHaveLength(0)
    expect(await fx.sessions.get(TELEGRAM_PLATFORM, '100')).toBeNull()
    expect(JSON.stringify(fx.sink.events)).not.toContain('knock knock')
  })
})

describe('TelegramGateway.processUpdates — structural filtering', () => {
  it('skips non-message, empty-text, and identity-less updates', async () => {
    const malformed = [
      { update_id: 1 },
      { update_id: 2, message: { chat: { id: 100 } } },
      { update_id: 3, message: { chat: { id: 100 }, from: { id: 1 }, text: '' } },
      { update_id: 4, message: { chat: { id: 100 }, from: { id: 1 }, text: '   ' } },
      { update_id: 5, message: { chat: {}, from: { id: 1 }, text: 'hi' } },
    ] as unknown as TelegramUpdate[]
    const fx = makeFixture(malformed)
    await fx.allowlist.add(TELEGRAM_PLATFORM, '1', 'principal-1')

    const offset = await fx.gateway.processUpdates(malformed)

    expect(offset).toBe(6)
    expect(fx.brain.calls).toHaveLength(0)
    expect(fx.client.sent).toHaveLength(0)
    expect(fx.sink.events).toHaveLength(0)
  })
})

describe('TelegramGateway.runCycle', () => {
  it('polls with the given offset and advances it', async () => {
    const fx = makeFixture([textUpdate(7, 'hi')])
    await fx.allowlist.add(TELEGRAM_PLATFORM, '1', 'principal-1')

    const offset = await fx.gateway.runCycle(3)

    expect(fx.client.getUpdatesCalls).toEqual([{ offset: 3, timeoutSec: 25 }])
    expect(offset).toBe(8)
    expect(fx.brain.calls).toHaveLength(1)
  })

  it('keeps the current offset when the poll returns nothing', async () => {
    const fx = makeFixture([])

    const offset = await fx.gateway.runCycle(11)

    expect(offset).toBe(11)
    expect(fx.brain.calls).toHaveLength(0)
  })
})

describe('HttpTelegramClient', () => {
  it('requires a bot token', () => {
    expect(() => new HttpTelegramClient({ botToken: '' })).toThrow(/botToken/)
  })

  it('posts getUpdates and structurally skips malformed result entries', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            { update_id: 1, message: { chat: { id: 10 }, text: 'x' } },
            { update_id: 'broken' },
            'garbage',
            null,
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch
    const client = new HttpTelegramClient({ botToken: 'tok', apiBase: 'https://example.test', fetchImpl })

    const updates = await client.getUpdates(5, 20)

    expect(calls[0].url).toBe('https://example.test/bottok/getUpdates')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      offset: 5,
      timeout: 20,
      allowed_updates: ['message'],
    })
    expect(updates).toEqual([{ update_id: 1, message: { chat: { id: 10 }, text: 'x' } }])
  })

  it('posts sendMessage payloads', async () => {
    const bodies: unknown[] = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
    }) as typeof fetch
    const client = new HttpTelegramClient({ botToken: 'tok', apiBase: 'https://example.test', fetchImpl })

    await client.sendMessage('55', 'hello')

    expect(bodies).toEqual([{ chat_id: '55', text: 'hello' }])
  })

  it('throws on API errors without leaking the token', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), {
        status: 400,
      })) as typeof fetch
    const client = new HttpTelegramClient({ botToken: 'sekrit', apiBase: 'https://example.test', fetchImpl })

    await expect(client.sendMessage('55', 'hi')).rejects.toThrow(/chat not found/)

    try {
      await client.sendMessage('55', 'hi')
    } catch (err) {
      expect(err instanceof Error && err.message.includes('sekrit')).toBe(false)
    }
  })
})

describe('telegramClientFromEnv', () => {
  it('throws when TELEGRAM_BOT_TOKEN is missing', () => {
    expect(() => telegramClientFromEnv({})).toThrow(/TELEGRAM_BOT_TOKEN/)
  })

  it('returns an HttpTelegramClient when present', () => {
    const client = telegramClientFromEnv({ TELEGRAM_BOT_TOKEN: 'tok' })
    expect(client).toBeInstanceOf(HttpTelegramClient)
  })
})
