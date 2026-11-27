import { describe, expect, it } from 'vitest'
import { readBundle } from '../../contracts/module-bundle'
import { publishModule } from './service'
import { buildSummaryMessages, summarizeVersion, summarySource, SummaryFailedError, type SummaryChat } from './summarize'
import { bundleOf, helloFiles, moduleHubFixture, publishBody, withFile } from './test-fixtures'

const answer = (content: string) => ({ choices: [{ message: { content } }] })
const GOOD = JSON.stringify({ does: 'Greets a person by name.', touches: 'Reads the member list.', sends_out: 'Nothing leaves the company.' })

async function published(files = helloFiles()) {
  const f = moduleHubFixture()
  const i = await f.registered()
  const b = bundleOf(files)
  await publishModule(f.deps, f.publishReq(i, publishBody(b)))
  return { f, b }
}

describe('module summary (plan/phase-upgrades-u2.md §7)', () => {
  it('reads the entry file first, then the rest by size, within the budget; never LICENSE or module.yaml', () => {
    const b = bundleOf(withFile(withFile(helloFiles(), 'big.mjs', 'x'.repeat(5000)), 'tiny.mjs', 'y'))
    const entries = readBundle(b.bytes).entries
    const src = summarySource({ manifest: b.manifest as never }, entries)
    expect(src.map((s) => s.path)).toEqual(['index.mjs', 'tiny.mjs', 'package.json', 'test.mjs', 'big.mjs'])
    const cut = summarySource({ manifest: b.manifest as never }, entries, 100)
    expect(cut).toEqual([expect.objectContaining({ path: 'index.mjs', cut: true })])
    expect(Buffer.byteLength(cut[0]!.text)).toBeLessThanOrEqual(100 + 2) // a cut inside a character becomes one U+FFFD
  })

  it('one gateway call as the owner writes and stores the summary', async () => {
    const { f, b } = await published()
    const calls: Parameters<SummaryChat>[0][] = []
    const summary = await summarizeVersion(
      {
        store: f.moduleStore,
        bundles: f.bundles,
        chat: async (input) => {
          calls.push(input)
          return answer(GOOD)
        },
        runAsOwner: (fn) => fn('owner-1'),
        now: () => new Date('2026-11-24T12:00:00Z'),
      },
      b.sha256,
    )
    expect(summary).toEqual({ does: 'Greets a person by name.', touches: 'Reads the member list.', sendsOut: 'Nothing leaves the company.' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userId: 'owner-1', task: 'contribute.module_summary', responseFormat: 'json_object' })
    expect(calls[0]!.messages[1]!.content).toContain('--- index.mjs')
    const stored = await f.moduleStore.getVersion(b.sha256)
    expect(stored?.summary).toEqual(summary)
    expect(stored?.summaryAt?.toISOString()).toBe('2026-11-24T12:00:00.000Z')
  })

  it('three answers off the schema store nothing', async () => {
    const { f, b } = await published()
    let n = 0
    const deps = {
      store: f.moduleStore,
      bundles: f.bundles,
      chat: async () => {
        n++
        return answer('{"does": "only this"}')
      },
      runAsOwner: <T>(fn: (u: string) => Promise<T>) => fn('owner-1'),
      now: () => new Date(),
    }
    await expect(summarizeVersion(deps, b.sha256)).rejects.toBeInstanceOf(SummaryFailedError)
    expect(n).toBe(3)
    expect((await f.moduleStore.getVersion(b.sha256))?.summary).toBeNull()
  })

  it('the prompt carries the manifest', () => {
    const b = bundleOf()
    const messages = buildSummaryMessages({ manifest: b.manifest as never }, readBundle(b.bytes).entries)
    expect(messages[1]!.content).toContain('"members.list"')
  })
})
