import { describe, expect, it, vi } from 'vitest'
import { ShellFeeds } from './shell-feeds'

const feed = () => ({ connect: vi.fn(), close: vi.fn() })

describe('ShellFeeds', () => {
  it('opens nothing while the shell is hidden (a call tab keeps its connections for the call)', () => {
    const a = feed()
    const feeds = new ShellFeeds([a])
    feeds.sync(false)
    expect(a.connect).not.toHaveBeenCalled()
  })

  it('opens each feed once, the first time the shell shows, and keeps it open across pages', () => {
    const a = feed()
    const b = feed()
    const feeds = new ShellFeeds([a, null, b])
    feeds.sync(false)
    feeds.sync(true)
    feeds.sync(false)
    feeds.sync(true)
    expect(a.connect).toHaveBeenCalledOnce()
    expect(b.connect).toHaveBeenCalledOnce()
    expect(a.close).not.toHaveBeenCalled()
  })

  it('closes on close() only what it opened, and opens nothing after', () => {
    const never = feed()
    const unopened = new ShellFeeds([never])
    unopened.close()
    unopened.sync(true)
    expect(never.close).not.toHaveBeenCalled()
    expect(never.connect).not.toHaveBeenCalled()

    const a = feed()
    const feeds = new ShellFeeds([a])
    feeds.sync(true)
    feeds.close()
    expect(a.close).toHaveBeenCalledOnce()
  })
})
