import { describe, expect, it, vi } from 'vitest'
import { memoryHandoverStore } from './memory-store'
import {
  addEntry,
  assignEntry,
  createHandover,
  getHandover,
  HandoverError,
  handoverBoard,
  listHandovers,
  removeEntry,
  removeHandover,
  updateEntry,
  type HandoverDeps,
} from './service'

const people = [
  { id: 'ony', name: 'Ony', email: 'ony@k.co' },
  { id: 'alex', name: 'Alex', email: 'alex@k.co' },
  { id: 'kim', name: 'Kim', email: 'kim@k.co' },
]

function setup() {
  let clock = new Date('2026-11-25T09:00:00Z')
  let n = 0
  const tasks = new Map<string, { status: 'open' | 'done'; assigneeId: string; title: string; context: string }>()
  const assign = vi.fn(async (actor: { userId: string; via: string }, input: { assigneeId: string; title: string; context: string }) => {
    const id = `task-${tasks.size + 1}`
    tasks.set(id, { status: 'open', assigneeId: input.assigneeId, title: input.title, context: input.context })
    return { id }
  })
  const deps: HandoverDeps = {
    store: memoryHandoverStore(),
    directory: { get: async (id) => people.find((p) => p.id === id) ?? null, list: async () => people },
    tasks: { assign, status: async (id) => tasks.get(id)?.status ?? null },
    now: () => clock,
    newId: () => `id-${++n}`,
  }
  const tick = (ms = 60_000) => (clock = new Date(clock.getTime() + ms))
  return { deps, assign, tasks, tick }
}

const ony = { userId: 'ony', via: 'person' as const }

describe('handovers', () => {
  it('a member creates a handover for a person; every member reads it, only the owner may edit', async () => {
    const { deps } = setup()
    const h = await createHandover(deps, ony, { title: 'Handover to Alex', subjectId: 'alex' })
    expect(h).toMatchObject({ title: 'Handover to Alex', owner: { id: 'ony', name: 'Ony' }, subject: { id: 'alex', name: 'Alex' }, canEdit: true, entries: [] })
    expect(await getHandover(deps, 'kim', h.id)).toMatchObject({ id: h.id, canEdit: false })
    expect((await listHandovers(deps, 'alex')).map((x) => [x.title, x.canEdit])).toEqual([['Handover to Alex', false]])
  })

  it('a topic handover has no subject; the subject must be a member', async () => {
    const { deps } = setup()
    expect((await createHandover(deps, ony, { title: 'Grants' })).subject).toBeNull()
    await expect(createHandover(deps, ony, { title: 'X', subjectId: 'acme-contact' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(createHandover(deps, ony, { title: '  ' })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('someone who is no member reads nothing', async () => {
    const { deps } = setup()
    const h = await createHandover(deps, ony, { title: 'Handover to Alex', subjectId: 'alex' })
    await expect(getHandover(deps, 'stranger', h.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(listHandovers(deps, 'stranger')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(createHandover(deps, { userId: 'stranger', via: 'person' }, { title: 'X' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('handover entries', () => {
  it('lists entries newest first: date, topic, one sentence, status, link', async () => {
    const { deps, tick } = setup()
    const h = await createHandover(deps, ony, { title: 'Handover to Alex', subjectId: 'alex' })
    await addEntry(deps, ony, { handoverId: h.id, topic: 'EXIST grant', sentence: 'The application went out on Monday.', status: 'for_info', entryOn: '2026-11-20' })
    tick()
    await addEntry(deps, ony, {
      handoverId: h.id,
      topic: 'Office lease',
      sentence: 'The landlord offers two options for the renewal.',
      status: 'decision_needed',
      link: '/m/drive/file/abc',
    })
    const got = await getHandover(deps, 'alex', h.id)
    expect(got.entries.map((e) => [e.date, e.topic, e.status, e.link])).toEqual([
      ['2026-11-25', 'Office lease', 'decision_needed', '/m/drive/file/abc'],
      ['2026-11-20', 'EXIST grant', 'for_info', null],
    ])
    expect(got.entries[0]).toMatchObject({ sentence: 'The landlord offers two options for the renewal.', assignee: null, assignedTask: null, writtenVia: 'person' })
  })

  it('one entry per topic: a second entry on the same topic is refused (update it instead)', async () => {
    const { deps } = setup()
    const h = await createHandover(deps, ony, { title: 'Handover to Alex' })
    await addEntry(deps, ony, { handoverId: h.id, topic: 'Office lease', sentence: 'A.', status: 'for_info' })
    await expect(addEntry(deps, ony, { handoverId: h.id, topic: ' office LEASE ', sentence: 'B.', status: 'for_info' })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/handover\.update_entry/),
    })
  })

  it('only the owner adds, changes or removes entries', async () => {
    const { deps } = setup()
    const h = await createHandover(deps, ony, { title: 'Handover to Alex' })
    const kim = { userId: 'kim', via: 'person' as const }
    await expect(addEntry(deps, kim, { handoverId: h.id, topic: 'T', sentence: 'S.', status: 'for_info' })).rejects.toMatchObject({ code: 'forbidden' })
    const e = await addEntry(deps, ony, { handoverId: h.id, topic: 'T', sentence: 'S.', status: 'for_info' })
    await expect(updateEntry(deps, kim, { entryId: e.id, status: 'in_progress' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(removeEntry(deps, kim, e.id)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('the owner changes an entry (status, sentence, topic, link) and removes it', async () => {
    const { deps, tick } = setup()
    const h = await createHandover(deps, ony, { title: 'Handover to Alex' })
    const e = await addEntry(deps, ony, { handoverId: h.id, topic: 'Lease', sentence: 'Two options.', status: 'decision_needed', link: 'https://example.com/lease' })
    tick()
    const changed = await updateEntry(deps, { userId: 'ony', via: 'assistant' }, { entryId: e.id, status: 'in_progress', sentence: 'Option B is being negotiated.', link: null })
    expect(changed).toMatchObject({ status: 'in_progress', sentence: 'Option B is being negotiated.', link: null, writtenVia: 'assistant' })
    expect(await removeEntry(deps, ony, e.id)).toEqual({ id: e.id, removed: true })
    expect((await getHandover(deps, 'ony', h.id)).entries).toEqual([])
  })

  it('validates the parts: sentence length, status, link shape, day', async () => {
    const { deps } = setup()
    const h = await createHandover(deps, ony, { title: 'H' })
    const base = { handoverId: h.id, topic: 'T', sentence: 'S.', status: 'for_info' as const }
    await expect(addEntry(deps, ony, { ...base, sentence: '' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(addEntry(deps, ony, { ...base, sentence: 'x'.repeat(401) })).rejects.toMatchObject({ code: 'invalid' })
    await expect(addEntry(deps, ony, { ...base, status: 'urgent' as never })).rejects.toMatchObject({ code: 'invalid' })
    await expect(addEntry(deps, ony, { ...base, link: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(addEntry(deps, ony, { ...base, link: '//evil.example' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(addEntry(deps, ony, { ...base, entryOn: '2026-02-30' })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('an unknown handover or entry is not found', async () => {
    const { deps } = setup()
    await expect(getHandover(deps, 'ony', 'nope')).rejects.toBeInstanceOf(HandoverError)
    await expect(addEntry(deps, ony, { handoverId: 'nope', topic: 'T', sentence: 'S.', status: 'for_info' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(updateEntry(deps, ony, { entryId: 'nope', status: 'for_info' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('assigning an entry', () => {
  it('lands in the assignee’s Needs you as an assigned task from the owner, linking back to the entry', async () => {
    const { deps, assign } = setup()
    const h = await createHandover(deps, ony, { title: 'Handover to Alex', subjectId: 'alex' })
    const e = await addEntry(deps, ony, { handoverId: h.id, topic: 'Office lease', sentence: 'Two options for the renewal.', status: 'decision_needed', link: '/m/drive/file/abc' })
    const assigned = await assignEntry(deps, ony, { entryId: e.id, assigneeId: 'alex' })
    expect(assign).toHaveBeenCalledWith(
      { userId: 'ony', via: 'person' },
      expect.objectContaining({ assigneeId: 'alex', title: 'Handover: Office lease', context: expect.stringContaining('Two options for the renewal.') }),
    )
    const context = (assign.mock.calls[0]![1] as { context: string }).context
    expect(context).toContain(`/m/memory/handover#entry-${e.id}`)
    expect(context).toContain('/m/drive/file/abc')
    expect(assigned).toMatchObject({ assignee: { id: 'alex', name: 'Alex' }, assignedTask: { id: 'task-1', status: 'open' } })
  })

  it('refuses while the earlier assignment is open, and the owner themself; allows a new one once it is done', async () => {
    const { deps, tasks } = setup()
    const h = await createHandover(deps, ony, { title: 'H' })
    const e = await addEntry(deps, ony, { handoverId: h.id, topic: 'T', sentence: 'S.', status: 'in_progress' })
    await expect(assignEntry(deps, ony, { entryId: e.id, assigneeId: 'ony' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(assignEntry(deps, ony, { entryId: e.id, assigneeId: 'nobody' })).rejects.toMatchObject({ code: 'invalid' })
    await assignEntry(deps, ony, { entryId: e.id, assigneeId: 'alex' })
    await expect(assignEntry(deps, ony, { entryId: e.id, assigneeId: 'kim' })).rejects.toMatchObject({ code: 'conflict' })
    tasks.get('task-1')!.status = 'done'
    expect(await assignEntry(deps, ony, { entryId: e.id, assigneeId: 'kim' })).toMatchObject({ assignee: { id: 'kim' }, assignedTask: { id: 'task-2', status: 'open' } })
  })

  it('only the owner assigns', async () => {
    const { deps } = setup()
    const h = await createHandover(deps, ony, { title: 'H' })
    const e = await addEntry(deps, ony, { handoverId: h.id, topic: 'T', sentence: 'S.', status: 'for_info' })
    await expect(assignEntry(deps, { userId: 'kim', via: 'person' }, { entryId: e.id, assigneeId: 'alex' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('deleting a whole handover (Contribute 8587d182)', () => {
  it('the owner deletes a handover and its entries are gone from the board', async () => {
    const { deps } = setup()
    const h = await createHandover(deps, ony, { title: 'Mistaken handover' })
    await addEntry(deps, ony, { handoverId: h.id, topic: 'T', sentence: 'S.', status: 'for_info' })
    expect(await removeHandover(deps, ony, h.id)).toEqual({ id: h.id, removed: true })
    expect((await listHandovers(deps, 'alex')).map((x) => x.id)).not.toContain(h.id)
    await expect(getHandover(deps, 'ony', h.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('only the owner deletes; a non-member deletes nothing; unknown ids are not found', async () => {
    const { deps } = setup()
    const h = await createHandover(deps, ony, { title: 'Handover to Alex' })
    await expect(removeHandover(deps, { userId: 'kim', via: 'person' }, h.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(removeHandover(deps, { userId: 'stranger', via: 'person' }, h.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(removeHandover(deps, ony, 'missing')).rejects.toMatchObject({ code: 'not_found' })
    expect((await listHandovers(deps, 'alex')).map((x) => x.id)).toContain(h.id)
  })
})

describe('the board', () => {
  it('shows every handover with its entries, the latest changed first', async () => {
    const { deps, tick } = setup()
    const a = await createHandover(deps, ony, { title: 'Handover to Alex' })
    tick()
    await createHandover(deps, { userId: 'kim', via: 'person' }, { title: 'Grants' })
    tick()
    await addEntry(deps, ony, { handoverId: a.id, topic: 'T', sentence: 'S.', status: 'for_info' })
    const board = await handoverBoard(deps, 'alex')
    expect(board.map((h) => [h.title, h.entries.length])).toEqual([
      ['Handover to Alex', 1],
      ['Grants', 0],
    ])
  })
})
