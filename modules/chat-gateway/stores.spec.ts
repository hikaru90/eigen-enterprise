import { describe, expect, it } from 'vitest'
import { InMemoryAllowlistStore, InMemorySessionStore } from './stores'

describe('InMemoryAllowlistStore', () => {
  it('added entries are allowed and resolve to their principal', async () => {
    const store = new InMemoryAllowlistStore()
    await store.add('telegram', '42', 'principal-a')

    expect(await store.isAllowed('telegram', '42')).toBe(true)
    expect(await store.principalFor('telegram', '42')).toBe('principal-a')
  })

  it('unknown users are not allowed and resolve to null', async () => {
    const store = new InMemoryAllowlistStore()

    expect(await store.isAllowed('telegram', '999')).toBe(false)
    expect(await store.principalFor('telegram', '999')).toBeNull()
  })

  it('platforms are isolated', async () => {
    const store = new InMemoryAllowlistStore()
    await store.add('telegram', '42', 'principal-a')

    expect(await store.isAllowed('slack', '42')).toBe(false)
  })

  it('re-adding the same key replaces the principal without duplicating', async () => {
    const store = new InMemoryAllowlistStore()
    await store.add('telegram', '42', 'principal-a')
    await store.add('telegram', '42', 'principal-b')

    expect(await store.principalFor('telegram', '42')).toBe('principal-b')
    expect(await store.list()).toEqual([
      { platform: 'telegram', externalUserId: '42', principalId: 'principal-b' },
    ])
  })

  it('remove revokes access', async () => {
    const store = new InMemoryAllowlistStore()
    await store.add('telegram', '42', 'principal-a')
    await store.remove('telegram', '42')

    expect(await store.isAllowed('telegram', '42')).toBe(false)
    expect(await store.list()).toEqual([])
  })
})

describe('InMemorySessionStore', () => {
  it('touch creates a session and get returns it', async () => {
    const store = new InMemorySessionStore()

    const touched = await store.touch('telegram', '100', 'principal-a')

    expect(touched.id).toBeTruthy()
    expect(await store.get('telegram', '100')).toEqual({
      id: touched.id,
      principalId: 'principal-a',
    })
  })

  it('touch is an upsert: same key keeps the session id and updates principal', async () => {
    const store = new InMemorySessionStore()
    const first = await store.touch('telegram', '100', 'principal-a')
    const second = await store.touch('telegram', '100', 'principal-b')

    expect(second.id).toBe(first.id)
    expect(await store.get('telegram', '100')).toEqual({
      id: first.id,
      principalId: 'principal-b',
    })
  })

  it('get returns null for unknown chats', async () => {
    const store = new InMemorySessionStore()
    expect(await store.get('telegram', 'nope')).toBeNull()
  })

  it('chats are isolated per platform', async () => {
    const store = new InMemorySessionStore()
    await store.touch('telegram', '100', 'principal-a')

    expect(await store.get('slack', '100')).toBeNull()
  })
})
