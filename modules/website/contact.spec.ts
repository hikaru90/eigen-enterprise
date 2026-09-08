import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { InMemoryEventSink, type EventSink } from '$lib/kernel/events'
import { handleContactSubmit } from './contact'
import { InMemoryWebsiteStore, type CreateContactInput, type WebsiteStore } from './store'

type Deps = {
  store: WebsiteStore
  eventSink: EventSink
  principalId?: string
}

function makeDeps(
  overrides: Partial<Deps> = {},
): { deps: Deps; store: InMemoryWebsiteStore; sink: InMemoryEventSink } {
  const store = new InMemoryWebsiteStore()
  const sink = new InMemoryEventSink()
  const deps: Deps = { store, eventSink: sink, ...overrides }
  return { deps, store, sink }
}

/** Wrap the store to observe exactly what handleContactSubmit persists. */
function spyCreateContact(store: InMemoryWebsiteStore): {
  store: WebsiteStore
  captured: CreateContactInput[]
} {
  const captured: CreateContactInput[] = []
  const wrapped: WebsiteStore = {
    ...store,
    createContact: async (input) => {
      captured.push(input)
      return store.createContact(input)
    },
  }
  return { store: wrapped, captured }
}

describe('handleContactSubmit', () => {
  it('validates, stores, and returns the contact id', async () => {
    const { deps, store } = makeDeps()
    const { store: spied, captured } = spyCreateContact(store)

    const result = await handleContactSubmit(
      { name: '  Jane  ', email: 'jane@example.com', message: '  Hello  ' },
      { ...deps, store: spied },
    )

    expect(result.id).toBeTruthy()
    expect(captured[0]).toEqual({
      name: 'Jane',
      email: 'jane@example.com',
      message: 'Hello',
    })
    const stored = await store.createContact({ email: 'probe@example.com' })
    expect(stored.source).toBe('website')
    expect(stored.principalId).toBeNull()
  })

  it('emits exactly one website.contact.captured event whose payload carries the contact id only (no content)', async () => {
    const { deps, sink } = makeDeps()

    const result = await handleContactSubmit(
      { name: 'Jane', email: 'jane@example.com', message: 'secret message content' },
      deps,
    )

    expect(sink.events).toHaveLength(1)
    const event = sink.events[0]
    expect(event.type).toBe('website.contact.captured')
    expect(event.payload).toEqual({ contactId: result.id })
    expect(JSON.stringify(event.payload)).not.toContain('secret message content')
    expect(JSON.stringify(event.payload)).not.toContain('jane@example.com')
  })

  it('carries the principal id on the event only when one is provided', async () => {
    const anonymous = makeDeps()
    await handleContactSubmit({ email: 'a@example.com' }, anonymous.deps)
    expect(anonymous.sink.events[0].principalId).toBeUndefined()

    const attributed = makeDeps({ principalId: 'principal-9' })
    await handleContactSubmit({ email: 'b@example.com' }, attributed.deps)
    expect(attributed.sink.events[0].principalId).toBe('principal-9')
  })

  it('rejects an invalid email loud (zod) and stores nothing, emits nothing', async () => {
    const { deps, sink } = makeDeps()

    await expect(handleContactSubmit({ email: 'not-an-email' }, deps)).rejects.toBeInstanceOf(
      ZodError,
    )
    expect(sink.events).toHaveLength(0)
  })

  it('rejects a missing email and non-string name loud', async () => {
    const { deps } = makeDeps()

    await expect(handleContactSubmit({ name: 'Jane' }, deps)).rejects.toBeInstanceOf(ZodError)
    await expect(
      handleContactSubmit({ email: 'a@example.com', name: 42 }, deps),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('accepts email-only submissions (name and message optional)', async () => {
    const { deps, sink } = makeDeps()

    const result = await handleContactSubmit({ email: 'a@example.com' }, deps)

    expect(result.id).toBeTruthy()
    expect(sink.events).toHaveLength(1)
  })

  it('rejects oversized name/message loud', async () => {
    const { deps } = makeDeps()

    await expect(
      handleContactSubmit({ email: 'a@example.com', message: 'x'.repeat(5001) }, deps),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      handleContactSubmit({ email: 'a@example.com', name: 'x'.repeat(201) }, deps),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('normalizes whitespace-only name/message to absent (stored as null by the store)', async () => {
    const { deps } = makeDeps()
    const { store: spied, captured } = spyCreateContact(new InMemoryWebsiteStore())

    await handleContactSubmit(
      { email: 'a@example.com', name: '   ', message: '' },
      { ...deps, store: spied },
    )

    expect(captured[0]).toMatchObject({ email: 'a@example.com' })
    expect(captured[0].name).toBeUndefined()
    expect(captured[0].message).toBeUndefined()
  })
})
