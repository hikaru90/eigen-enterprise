import type { SummaryInput, SummaryResult } from './summary'
import type { ReposSyncedPayload, SyncDeps } from './sync'
import { tokenSealKey } from './seal'
import { createReposService } from './service'
import { InMemoryReposStore } from './store'
import { FakeDrivePort, FakeGitHub, sampleRepo } from './testing'

/** A wired plugin over the fakes: one fine-grained token that sees kindred/shop. */
export const TOKEN = 'github_pat_11AAAAAAA0secretSECRETsecret9z9z'
export const MASTER = 'test-master-key'

export function setup(start = '2026-11-12T14:00:00Z') {
  const gh = new FakeGitHub()
  gh.identities.set(TOKEN, { login: 'ada', expiresAt: new Date('2027-01-31T00:00:00Z'), classic: false })
  const data = sampleRepo()
  gh.addRepo(data, [TOKEN])
  const store = new InMemoryReposStore()
  const drive = new FakeDrivePort()
  const logs: Array<[string, Record<string, unknown>]> = []
  const clock = { now: new Date(start) }
  /** The fake summarizer: answers `next` (a result, or an Error to throw) and records every call. */
  const summaries = {
    calls: [] as SummaryInput[],
    next: { status: 'written', summary: 'Cart work is nearly done. Checkout shipped.', highlights: [{ kind: 'pr', text: 'Cart totals is a draft', ref: '#7' }] } as SummaryResult | Error,
  }
  const events: ReposSyncedPayload[] = []
  const deps: SyncDeps = {
    store,
    drive,
    client: (t) => gh.client(t),
    key: () => tokenSealKey(MASTER),
    now: () => clock.now,
    owner: 'test-slot',
    log: (m, f) => logs.push([m, f]),
    summarizer: async (input) => {
      summaries.calls.push(input)
      if (summaries.next instanceof Error) throw summaries.next
      return summaries.next
    },
    emitSynced: async (payload) => {
      events.push(payload)
    },
  }
  const service = createReposService(deps)
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms)
  }
  /** Adds the token and ticks kindred/shop; returns the token id. */
  const connect = async () => {
    const { id } = await service.addToken('user-1', TOKEN)
    await service.setRepo(id, data.repo.id, true)
    return id
  }
  return { gh, data, store, drive, logs, clock, deps, service, advance, connect, summaries, events }
}
