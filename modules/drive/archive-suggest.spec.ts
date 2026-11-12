import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmHttpError, LlmNotConfiguredError } from '$lib/server/llm/errors'
import {
  buildSuggestMessages,
  parseSuggestOutput,
  SUGGEST_LOG_CONTEXT,
  SUGGEST_MAX_ATTEMPTS,
  suggestArchive,
  type SuggestChat,
} from './archive-suggest'
import { memoryEditLockStore } from './locks'
import { memoryDriveAccess } from './memory-access'
import { createDriveService, type Actor } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'

/**
 * "Suggest what to archive": plain facts pick the candidates (files you can
 * edit, unchanged for N days — a bounded prompt), the model judges which look
 * done with and says why in one line (gateway, JSON validated against the
 * schema and the candidate ids). Nothing is archived here: the person reviews.
 */

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const alice: Actor = { kind: 'user', userId: 'alice' }
const text = (s: string) => new TextEncoder().encode(s)
const DAY = 86_400_000
const answer = (json: unknown) => ({ choices: [{ message: { content: typeof json === 'string' ? json : JSON.stringify(json) } }] })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-suggest-'))
  dirs.push(dir)
  const clock = { t: Date.parse('2025-01-10T10:00:00Z') }
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir),
    access: memoryDriveAccess({ users: { alice: { role: 'member', name: 'Alice' } } }),
    maxUploadBytes: 1 << 20,
    locks: memoryEditLockStore(),
    now: () => new Date((clock.t += 1000)),
  })
  const old = await drive.createFolder(alice, null, 'Old projects')
  const draft = await drive.upload(alice, old.id, { name: 'pitch-draft-v1.md', bytes: text('v1'), mime: null })
  const keep = await drive.upload(alice, null, { name: 'company-handbook.md', bytes: text('h'), mime: null })
  clock.t = Date.parse('2026-11-12T10:00:00Z')
  const today = new Date(clock.t)
  return { drive, draft, keep, today }
}

describe('buildSuggestMessages', () => {
  it('states the schema, the rules (archive is reversible; when unsure leave it out) and every candidate as data', async () => {
    const { drive, today } = await setup()
    const { candidates } = await drive.archiveCandidates(alice, { changedBefore: new Date(today.getTime() - 180 * DAY), limit: 10 })
    const [system, user] = buildSuggestMessages(candidates, today)
    expect(system!.role).toBe('system')
    expect(system!.content).toContain('"suggestions"')
    expect(system!.content).toContain('"file_id"')
    expect(system!.content).toContain('"reason"')
    expect(system!.content).toMatch(/not deleted/i)
    expect(user!.content).toContain('2026-11-12')
    expect(user!.content).toContain('pitch-draft-v1.md')
    expect(user!.content).toContain('My drive / Old projects')
    expect(user!.content).toContain('company-handbook.md')
  })
})

describe('parseSuggestOutput', () => {
  const ids = new Set(['f1', 'f2'])
  it('keeps suggestions for candidate ids, one line each', () => {
    expect(
      parseSuggestOutput(answer({ suggestions: [{ file_id: 'f1', reason: 'An early draft,\n superseded  by later versions.' }] }), ids),
    ).toEqual([{ fileId: 'f1', reason: 'An early draft, superseded by later versions.' }])
    expect(parseSuggestOutput(answer('```json\n{"suggestions":[]}\n```'), ids)).toEqual([])
  })
  it('refuses ids that were not candidates, the same file twice, empty reasons and other shapes', () => {
    expect(() => parseSuggestOutput(answer({ suggestions: [{ file_id: 'nope', reason: 'x' }] }), ids)).toThrow(/not one of the candidates/)
    expect(() =>
      parseSuggestOutput(answer({ suggestions: [{ file_id: 'f1', reason: 'a' }, { file_id: 'f1', reason: 'b' }] }), ids),
    ).toThrow(/twice/)
    expect(() => parseSuggestOutput(answer({ suggestions: [{ file_id: 'f1', reason: ' ' }] }), ids)).toThrow()
    expect(() => parseSuggestOutput(answer({ files: [] }), ids)).toThrow()
    expect(() => parseSuggestOutput(answer('not json'), ids)).toThrow()
  })
})

describe('suggestArchive', () => {
  it('asks the gateway once (JSON mode, temperature 0, its own log context) and returns the suggestions with where each file is', async () => {
    const { drive, draft, today } = await setup()
    const chat = vi.fn<SuggestChat>(async () => answer({ suggestions: [{ file_id: draft.id, reason: 'A first draft of a pitch that later versions replaced.' }] }))
    const out = await suggestArchive({ drive, chat, now: () => today }, { actor: alice, olderThanDays: 180 })
    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat.mock.calls[0]![0]).toMatchObject({ userId: 'alice', temperature: 0, responseFormat: 'json_object', logContext: SUGGEST_LOG_CONTEXT })
    expect(out).toMatchObject({ olderThanDays: 180, considered: 2, more: false })
    expect(out.suggestions).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ id: draft.id, name: 'pitch-draft-v1.md' }),
        root: expect.objectContaining({ label: 'My drive' }),
        path: [expect.objectContaining({ name: 'Old projects' })],
        reason: 'A first draft of a pitch that later versions replaced.',
      }),
    ])
    // Nothing was archived: the person decides.
    expect((await drive.archived(alice)).length).toBe(0)
  })

  it('with no file unchanged that long, it does not ask the model at all', async () => {
    const { drive, today } = await setup()
    const chat = vi.fn<SuggestChat>()
    const out = await suggestArchive({ drive, chat, now: () => today }, { actor: alice, olderThanDays: 3000 })
    expect(chat).not.toHaveBeenCalled()
    expect(out).toMatchObject({ considered: 0, suggestions: [] })
  })

  it(`retries an unreadable answer, then fails plainly after ${SUGGEST_MAX_ATTEMPTS} tries (no guessed suggestions)`, async () => {
    const { drive, today } = await setup()
    const chat = vi.fn<SuggestChat>(async () => answer({ suggestions: [{ file_id: 'invented', reason: 'x' }] }))
    await expect(suggestArchive({ drive, chat, now: () => today }, { actor: alice, olderThanDays: 180 })).rejects.toMatchObject({
      code: 'upstream',
    })
    expect(chat).toHaveBeenCalledTimes(SUGGEST_MAX_ATTEMPTS)
  })

  it('no AI provider: says so plainly and does not retry', async () => {
    const { drive, today } = await setup()
    const chat = vi.fn<SuggestChat>(async () => {
      throw new LlmNotConfiguredError('LLM base URL missing (Settings → AI provider)')
    })
    await expect(suggestArchive({ drive, chat, now: () => today }, { actor: alice, olderThanDays: 180 })).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/no AI provider/i),
    })
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('the provider refusing (e.g. no credits) is a plain upstream error with its status', async () => {
    const { drive, today } = await setup()
    const chat = vi.fn<SuggestChat>(async () => {
      throw new LlmHttpError(402, 'insufficient credits')
    })
    await expect(suggestArchive({ drive, chat, now: () => today }, { actor: alice, olderThanDays: 180 })).rejects.toMatchObject({
      code: 'upstream',
      message: expect.stringContaining('402'),
    })
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('refuses a cut-off outside 30 days to 10 years', async () => {
    const { drive, today } = await setup()
    const chat = vi.fn<SuggestChat>()
    await expect(suggestArchive({ drive, chat, now: () => today }, { actor: alice, olderThanDays: 3 })).rejects.toMatchObject({ code: 'invalid' })
  })
})
