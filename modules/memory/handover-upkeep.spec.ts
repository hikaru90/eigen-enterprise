import { describe, expect, it, vi } from 'vitest'
import type { DecisionResult } from '$lib/server/decisions/decide'
import { memoryHandoverStore } from '$lib/server/memory/handover/memory-store'
import { addEntry, createHandover, getHandover, type HandoverDeps } from '$lib/server/memory/handover/service'
import type { HandoverStatus } from '$lib/server/memory/handover/store'
import { memoryHandoverStatus } from './decision-kinds'
import { draftEntry, handoverSentenceMessages, parseHandoverSentence, type DraftDeps } from './handover-upkeep'

const people = [
  { id: 'ony', name: 'Ony', email: 'ony@k.co' },
  { id: 'alex', name: 'Alex', email: 'alex@k.co' },
]

const decided = (choice: HandoverStatus): DecisionResult<HandoverStatus> => ({
  kind: 'memory.handover_status',
  status: 'enforced',
  decisionId: 'd1',
  outcome: 'decided',
  choice,
  confidence: 0.9,
  distribution: null,
  source: 'jev',
  jev: null,
})

function setup(status: DecisionResult<HandoverStatus> = decided('decision_needed')) {
  let n = 0
  const handover: HandoverDeps = {
    store: memoryHandoverStore(),
    directory: { get: async (id) => people.find((p) => p.id === id) ?? null, list: async () => people },
    tasks: { assign: async () => ({ id: 't' }), status: async () => null },
    now: () => new Date('2026-11-25T09:00:00Z'),
    newId: () => `id-${++n}`,
  }
  const decideStatus = vi.fn(async () => status)
  const writeSentence = vi.fn(async () => 'The landlord offers two renewal options; one must be chosen by Friday.')
  const deps: DraftDeps = { handover, decideStatus, writeSentence }
  return { deps, handover, decideStatus, writeSentence }
}

const ony = { userId: 'ony', via: 'brain' as const }

describe('the brain’s handover upkeep (handover.draft_entry)', () => {
  it('drafts a new entry: Jev decides the status, the LLM only writes the sentence', async () => {
    const { deps, handover, decideStatus, writeSentence } = setup()
    const h = await createHandover(handover, { userId: 'ony', via: 'person' }, { title: 'Handover to Alex', subjectId: 'alex' })
    const out = await draftEntry(deps, ony, { handoverId: h.id, topic: 'Office lease', source: 'Mail from the landlord: option A or B, decide by Friday.', link: '/m/mail/1' })
    expect(decideStatus).toHaveBeenCalledWith({ handoverId: h.id, handoverTitle: 'Handover to Alex', ownerId: 'ony', topic: 'Office lease', source: 'Mail from the landlord: option A or B, decide by Friday.' })
    expect(writeSentence).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'ony', topic: 'Office lease', previous: null }))
    expect(out).toMatchObject({ outcome: 'added', entry: { topic: 'Office lease', status: 'decision_needed', link: '/m/mail/1', writtenVia: 'brain' } })
  })

  it('keeps one entry per topic: a draft on an existing topic updates it and hands the LLM the previous sentence', async () => {
    const { deps, handover, writeSentence } = setup(decided('in_progress'))
    const h = await createHandover(handover, { userId: 'ony', via: 'person' }, { title: 'H' })
    const e = await addEntry(handover, { userId: 'ony', via: 'person' }, { handoverId: h.id, topic: 'Office lease', sentence: 'Two options.', status: 'decision_needed', link: '/m/a' })
    const out = await draftEntry(deps, ony, { handoverId: h.id, topic: 'office lease', source: 'We chose B; the lawyer reviews the contract.' })
    expect(writeSentence).toHaveBeenCalledWith(expect.objectContaining({ previous: 'Two options.' }))
    expect(out).toMatchObject({ outcome: 'updated', entry: { id: e.id, status: 'in_progress', link: '/m/a' } })
    expect((await getHandover(handover, 'alex', h.id)).entries).toHaveLength(1)
  })

  it('a status the owner gives is used as is: Jev is not asked', async () => {
    const { deps, handover, decideStatus } = setup()
    const h = await createHandover(handover, { userId: 'ony', via: 'person' }, { title: 'H' })
    const out = await draftEntry(deps, { userId: 'ony', via: 'assistant' }, { handoverId: h.id, topic: 'T', source: 'S', status: 'for_info' })
    expect(decideStatus).not.toHaveBeenCalled()
    expect(out).toMatchObject({ outcome: 'added', entry: { status: 'for_info', writtenVia: 'assistant' } })
  })

  it('when Jev is unsure the owner is asked in Needs you: nothing is written and no sentence is paid for', async () => {
    const pending: DecisionResult<HandoverStatus> = { kind: 'memory.handover_status', status: 'enforced', decisionId: 'q1', outcome: 'pending', pending: true, questionId: 'q1' }
    const { deps, handover, writeSentence } = setup(pending)
    const h = await createHandover(handover, { userId: 'ony', via: 'person' }, { title: 'H' })
    const out = await draftEntry(deps, ony, { handoverId: h.id, topic: 'T', source: 'S' })
    expect(out).toMatchObject({ outcome: 'pending', questionId: 'q1' })
    expect(writeSentence).not.toHaveBeenCalled()
    expect((await getHandover(handover, 'ony', h.id)).entries).toEqual([])
  })

  it('only the owner’s side drafts; nothing is decided or written for anyone else', async () => {
    const { deps, handover, decideStatus, writeSentence } = setup()
    const h = await createHandover(handover, { userId: 'ony', via: 'person' }, { title: 'H' })
    await expect(draftEntry(deps, { userId: 'alex', via: 'brain' }, { handoverId: h.id, topic: 'T', source: 'S' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(decideStatus).not.toHaveBeenCalled()
    expect(writeSentence).not.toHaveBeenCalled()
  })
})

describe('the sentence call', () => {
  it('asks for one observed sentence as JSON, in the source’s language', () => {
    const [system, user] = handoverSentenceMessages({ handoverTitle: 'Übergabe an Alex', topic: 'Mietvertrag', source: 'Vermieter bietet A oder B.', previous: null })
    expect(system!.content).toMatch(/one sentence/i)
    expect(system!.content).toMatch(/JSON/)
    expect(String(user!.content)).toContain('Vermieter bietet A oder B.')
  })

  it('validates the model’s JSON and fails loud on anything else', () => {
    const ok = { choices: [{ message: { content: '{"sentence":"Option B is chosen."}' } }] }
    expect(parseHandoverSentence(ok)).toBe('Option B is chosen.')
    expect(() => parseHandoverSentence({ choices: [{ message: { content: '{"text":"x"}' } }] })).toThrow(/schema/)
    expect(() => parseHandoverSentence({ choices: [{ message: { content: `{"sentence":"${'x'.repeat(401)}"}` } }] })).toThrow(/schema/)
  })
})

describe('memory.handover_status', () => {
  it('is a closed set of the three statuses, enforced, asking the owner when unsure; the log never keeps the source', () => {
    expect(memoryHandoverStatus.choices).toEqual(['decision_needed', 'in_progress', 'for_info'])
    expect(memoryHandoverStatus.status).toBe('enforced')
    expect(memoryHandoverStatus.lowConfidence).toBeGreaterThan(0)
    const input = { handoverId: 'h', handoverTitle: 'H', ownerId: 'ony', topic: 'T', source: 'private memory text' }
    expect(memoryHandoverStatus.ask!.who(input)).toBe('ony')
    expect(JSON.stringify(memoryHandoverStatus.logInput(input))).not.toContain('private memory text')
  })
})
