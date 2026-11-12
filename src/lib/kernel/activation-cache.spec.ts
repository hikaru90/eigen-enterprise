import { describe, expect, it } from 'vitest'
import { CachedActivationStore } from './activation-cache'
import { InMemoryActivationStore, type ActivationStore } from './modules'

/** An in-memory store that counts how often the cache asks it. */
function countingStore() {
  const inner = new InMemoryActivationStore()
  const reads = { list: 0, get: 0 }
  const store: ActivationStore = {
    set: (id, active) => inner.set(id, active),
    get: async (id) => {
      reads.get += 1
      return inner.get(id)
    },
    list: async () => {
      reads.list += 1
      return inner.list()
    },
  }
  return { inner, store, reads }
}

describe('CachedActivationStore', () => {
  it('reads the activation set once for many lookups (no store read per request)', async () => {
    const { inner, store, reads } = countingStore()
    await inner.set('drive', true)
    const cache = new CachedActivationStore(store)
    for (let i = 0; i < 50; i++) expect(await cache.get('drive')).toBe(true)
    expect(await cache.list()).toEqual(new Map([['drive', true]]))
    expect(reads).toEqual({ list: 1, get: 0 })
  })

  it('answers false for a module it has no record of (fail closed, like the store)', async () => {
    const cache = new CachedActivationStore(countingStore().store)
    expect(await cache.get('ghost')).toBe(false)
  })

  it('a switch through the cache is seen at once (write-through, then re-read)', async () => {
    const { store, reads } = countingStore()
    const cache = new CachedActivationStore(store)
    await cache.set('drive', true)
    expect(await cache.get('drive')).toBe(true)
    await cache.set('drive', false)
    expect(await cache.get('drive')).toBe(false)
    expect(await cache.list()).toEqual(new Map([['drive', false]]))
    expect(reads.list).toBe(2)
  })

  it('invalidate() drops the set: a switch made elsewhere (the CLI) is read on the next lookup', async () => {
    const { inner, store } = countingStore()
    await inner.set('calls', true)
    const cache = new CachedActivationStore(store)
    expect(await cache.get('calls')).toBe(true)
    await inner.set('calls', false) // another process
    expect(await cache.get('calls')).toBe(true) // still cached
    cache.invalidate()
    expect(await cache.get('calls')).toBe(false)
  })

  it('never keeps a read that was in flight when the cache was dropped', async () => {
    const { inner, store } = countingStore()
    await inner.set('calls', true)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow: ActivationStore = {
      ...store,
      list: async () => {
        const snapshot = await store.list()
        await gate
        return snapshot
      },
    }
    const cache = new CachedActivationStore(slow)
    const inFlight = cache.get('calls')
    await inner.set('calls', false)
    cache.invalidate()
    release()
    expect(await inFlight).toBe(true) // the read that started before the switch
    expect(await cache.get('calls')).toBe(false) // the next read asks again
  })

  it('announces every switch to the other processes (after the write), and still drops its own cache', async () => {
    const { inner, store } = countingStore()
    const announced: Array<[string, boolean | undefined]> = []
    const cache = new CachedActivationStore(store, {
      announce: async (id) => {
        announced.push([id, (await inner.list()).get(id)])
      },
    })
    expect(await cache.get('drive')).toBe(false)
    await cache.set('drive', true)
    expect(announced).toEqual([['drive', true]])
    expect(await cache.get('drive')).toBe(true)
  })

  it('fails loud when the announcement fails (other processes would not know), and re-reads', async () => {
    const { store } = countingStore()
    const cache = new CachedActivationStore(store, {
      announce: async () => {
        throw new Error('notify failed')
      },
    })
    expect(await cache.get('drive')).toBe(false)
    await expect(cache.set('drive', true)).rejects.toThrow('notify failed')
    expect(await cache.get('drive')).toBe(true)
  })

  it('never caches a failed read', async () => {
    const { inner, store } = countingStore()
    await inner.set('drive', true)
    let fail = true
    const flaky: ActivationStore = {
      ...store,
      list: async () => {
        if (fail) throw new Error('connection reset')
        return store.list()
      },
    }
    const cache = new CachedActivationStore(flaky)
    await expect(cache.get('drive')).rejects.toThrow('connection reset')
    fail = false
    expect(await cache.get('drive')).toBe(true)
  })

  it('hands out copies: a caller changing its map does not change the cache', async () => {
    const { inner, store } = countingStore()
    await inner.set('drive', true)
    const cache = new CachedActivationStore(store)
    ;(await cache.list()).set('drive', false)
    expect(await cache.get('drive')).toBe(true)
  })
})
