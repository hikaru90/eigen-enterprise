import type { BackgroundScrubDeps } from './background-scrub'
import { describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { appDbAsyncLocal, getDb } from '$lib/server/db/context'
import { judged } from '../test-fixtures'
import { backgroundScrub } from './background-scrub'

const OWNER = 'owner-1'
const FAKE_DB = {} as AppDatabase

/**
 * The scrub runs on the job-queue tick, outside any request: there is no app DB
 * context unless the scrub opens one. The gateway reads provider config and
 * records cost through getDb(), so a chat that calls getDb() stands in for it.
 */
function deps(over: Partial<BackgroundScrubDeps> = {}): BackgroundScrubDeps {
  return {
    ownerId: async () => OWNER,
    onCompanyProvider: (fn) => fn(),
    withDbUser: (_userId, fn) => appDbAsyncLocal.run(FAKE_DB, fn),
    chat: async () => {
      getDb()
      return judged({ summary: 'Drive upload fails for large files.', language: 'de', removed: ['person'] })
    },
    ...over,
  }
}

describe('contribute background scrub', () => {
  it('runs the gateway call inside a DB context for the owner (the tick has none)', async () => {
    const withDbUser = vi.fn<BackgroundScrubDeps['withDbUser']>((_userId, fn) => appDbAsyncLocal.run(FAKE_DB, fn))
    expect(appDbAsyncLocal.getStore()).toBeUndefined()
    const out = await backgroundScrub('Ana sagt: Upload bricht ab', deps({ withDbUser }))
    expect(out.summary).toBe('Drive upload fails for large files.')
    expect(withDbUser).toHaveBeenCalledWith(OWNER, expect.any(Function))
  })

  it('attributes the scrub to the owner', async () => {
    const chat = vi.fn<BackgroundScrubDeps['chat']>(async () =>
      judged({ summary: 'ok', language: 'en', removed: [] }),
    )
    await backgroundScrub('x', deps({ chat }))
    expect(chat.mock.calls[0][0].userId).toBe(OWNER)
  })

  it('fails loud without an owner and never calls the gateway', async () => {
    const chat = vi.fn<BackgroundScrubDeps['chat']>()
    await expect(backgroundScrub('x', deps({ ownerId: async () => null, chat }))).rejects.toThrow(/no owner/)
    expect(chat).not.toHaveBeenCalled()
  })
})
