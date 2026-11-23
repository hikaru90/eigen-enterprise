import { describe, expect, it, vi } from 'vitest'
import {
  APP_UPDATED_SENTENCE,
  AppUpdatedError,
  explainLoadFailure,
  fullReloadHref,
  loadChunk,
  watchStaleChunks,
} from './detect'

/** A version check the way SvelteKit's `updated.check()` answers it: the server's version vs this tab's. */
const versionCheck = (tab: string, server: string) => vi.fn(async () => server !== tab)

describe('explainLoadFailure', () => {
  const chunkGone = new TypeError('Failed to fetch dynamically imported module: https://x/_app/immutable/chunks/BXNSwe4O.js')

  it('a failed load after a new release (server version differs from the tab) is an app update', async () => {
    const shown = await explainLoadFailure(chunkGone, versionCheck('1763900000000', '1763990000000'))
    expect(shown).toBeInstanceOf(AppUpdatedError)
    expect((shown as AppUpdatedError).message).toBe(APP_UPDATED_SENTENCE)
    expect((shown as AppUpdatedError).cause).toBe(chunkGone)
  })

  it('a failed load on the current version keeps its real error', async () => {
    const shown = await explainLoadFailure(chunkGone, versionCheck('1763900000000', '1763900000000'))
    expect(shown).toBe(chunkGone)
  })

  it('when the version check itself fails, the real load error is shown, not an update guess', async () => {
    const shown = await explainLoadFailure(chunkGone, async () => {
      throw new Error('offline')
    })
    expect(shown).toBe(chunkGone)
  })
})

describe('loadChunk', () => {
  it('passes a loaded module through without checking the version', async () => {
    const check = vi.fn(async () => true)
    await expect(loadChunk(async () => ({ default: 1 }), check)).resolves.toEqual({ default: 1 })
    expect(check).not.toHaveBeenCalled()
  })

  it('rejects with AppUpdatedError when the deployed version changed', async () => {
    const err = new TypeError('Failed to fetch dynamically imported module')
    await expect(loadChunk(() => Promise.reject(err), versionCheck('a', 'b'))).rejects.toBeInstanceOf(AppUpdatedError)
  })

  it('rejects with the original error, once, on the current version (no retry)', async () => {
    const err = new Error('SyntaxError in chunk')
    const load = vi.fn(() => Promise.reject(err))
    await expect(loadChunk(load, versionCheck('a', 'a'))).rejects.toBe(err)
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('fullReloadHref', () => {
  const to = { url: new URL('https://one.example/drive/file/1') }

  it('after an update, an in-app navigation becomes a full page load of its target', () => {
    expect(fullReloadHref({ willUnload: false, to }, true)).toBe('https://one.example/drive/file/1')
  })

  it('without an update, client navigation stays client-side', () => {
    expect(fullReloadHref({ willUnload: false, to }, false)).toBeNull()
  })

  it('a navigation that already unloads the page (external link, reload) is left alone', () => {
    expect(fullReloadHref({ willUnload: true, to }, true)).toBeNull()
    expect(fullReloadHref({ willUnload: false, to: null }, true)).toBeNull()
  })
})

describe('watchStaleChunks', () => {
  const preloadError = () => Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: new Error('gone') })

  it('reports an update when a chunk fails and the deployed version changed, without swallowing the error', async () => {
    const target = new EventTarget()
    const onUpdated = vi.fn()
    const stop = watchStaleChunks(target, versionCheck('a', 'b'), onUpdated)
    const event = preloadError()
    target.dispatchEvent(event)
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
    expect(event.defaultPrevented).toBe(false)
    stop()
  })

  it('stays quiet when the version is unchanged, and after stop', async () => {
    const target = new EventTarget()
    const onUpdated = vi.fn()
    const check = versionCheck('a', 'a')
    const stop = watchStaleChunks(target, check, onUpdated)
    target.dispatchEvent(preloadError())
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1))
    stop()
    target.dispatchEvent(preloadError())
    expect(check).toHaveBeenCalledTimes(1)
    expect(onUpdated).not.toHaveBeenCalled()
  })
})
