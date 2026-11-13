import { describe, expect, it } from 'vitest'
import { checkProposal, JUDGE_CANDIDATES, listProposals, shareProposal, updateProposal, voteProposal } from './service'
import { fixture, judged } from './test-fixtures'
import { CONTRIBUTION_MAX_LENGTH } from './types'

const owner = { id: 'owner', kind: 'human' as const, canManage: true }
const agent = { id: 'agent-1', kind: 'agent' as const, canManage: true }
const member = { id: 'ben', kind: 'human' as const, canManage: false }

async function shared(f = fixture(), title = 'Dark mode please') {
  const p = await shareProposal(f.deps, 'ana', { title, kind: 'idea', area: 'everywhere' })
  return { f, p }
}

describe('contribute: propose', () => {
  it('a share lands as Requested with the author’s +1, a kernel event and the author’s name', async () => {
    const { f, p } = await shared()
    expect(p).toMatchObject({ title: 'Dark mode please', kind: 'idea', area: 'everywhere', status: 'requested', score: 1, myVote: 1, own: true, authorName: 'Ana Lind', note: null, shippedAt: null })
    expect(f.events).toEqual([{ type: 'contribute.proposed', principalId: 'ana', payload: { id: p.id, title: 'Dark mode please', kind: 'idea', area: 'everywhere' } }])
  })

  it('refuses an empty, too long, or unclassified proposal', async () => {
    const f = fixture()
    await expect(shareProposal(f.deps, 'ana', { title: '   ', kind: 'idea', area: 'drive' })).rejects.toThrow(/must not be empty/)
    await expect(shareProposal(f.deps, 'ana', { title: 'x'.repeat(CONTRIBUTION_MAX_LENGTH + 1), kind: 'idea', area: 'drive' })).rejects.toThrow(/at most/)
    await expect(shareProposal(f.deps, 'ana', { title: 'x', kind: 'feature', area: 'drive' })).rejects.toThrow(/kind must be one of/)
    await expect(shareProposal(f.deps, 'ana', { title: 'x', kind: 'idea', area: 'kitchen' })).rejects.toThrow(/area must be one of/)
    expect(f.store.rows.size).toBe(0)
  })

  it('check: the judge reads kind and area; nothing is created', async () => {
    const f = fixture([judged({ kind: 'bug', area: 'messages', duplicate_of: null })])
    expect(await checkProposal(f.deps, 'ana', '  Threads lose replies  ')).toEqual({ kind: 'bug', area: 'messages', duplicateOf: null })
    expect(f.store.rows.size).toBe(0)
    expect(f.calls[0].messages[1].content).toContain('"Threads lose replies"')
  })

  it('check: the same request already open comes back as the duplicate, seen by the drafter', async () => {
    const { f, p } = await shared(fixture())
    f.queue.push(judged({ kind: 'idea', area: 'everywhere', duplicate_of: p.id }))
    const r = await checkProposal(f.deps, 'ben', 'A dark theme')
    expect(r.duplicateOf).toMatchObject({ id: p.id, title: 'Dark mode please', score: 1, myVote: 0, own: false })
  })

  it('check: only open proposals are candidates, newest first, capped', async () => {
    const f = fixture()
    const done = await shareProposal(f.deps, 'ana', { title: 'shipped one', kind: 'idea', area: 'drive' })
    await updateProposal(f.deps, owner, done.id, { status: 'shipped' })
    for (let i = 0; i < JUDGE_CANDIDATES + 2; i++) await shareProposal(f.deps, 'ana', { title: `open ${i}`, kind: 'idea', area: 'drive' })
    f.queue.push(judged({ kind: 'idea', area: 'drive', duplicate_of: null }))
    await checkProposal(f.deps, 'ana', 'new')
    const prompt = String(f.calls[0].messages[1].content)
    expect(prompt).not.toContain('shipped one')
    expect(prompt).toContain(`"open ${JUDGE_CANDIDATES + 1}"`)
    expect(prompt).not.toContain('"open 0"')
    expect(prompt.match(/- id: /g)).toHaveLength(JUDGE_CANDIDATES)
  })
})

describe('contribute: votes and the board', () => {
  it('votes add up, change and come back; the board orders by score', async () => {
    const f = fixture()
    const a = await shareProposal(f.deps, 'ana', { title: 'A', kind: 'idea', area: 'drive' })
    const b = await shareProposal(f.deps, 'ana', { title: 'B', kind: 'idea', area: 'drive' })
    expect((await voteProposal(f.deps, 'ben', a.id, 1)).score).toBe(2)
    expect((await voteProposal(f.deps, 'owner', b.id, -1)).score).toBe(0)
    expect((await voteProposal(f.deps, 'ben', a.id, -1)).score).toBe(0)
    expect((await voteProposal(f.deps, 'ben', a.id, 0)).myVote).toBe(0)
    await voteProposal(f.deps, 'owner', a.id, 1)
    const board = await listProposals(f.deps, 'ben')
    expect(board.map((p) => [p.title, p.score])).toEqual([['A', 2], ['B', 0]])
  })

  it('refuses a bad direction and closes voting once shipped; declined is gone', async () => {
    const { f, p } = await shared()
    await expect(voteProposal(f.deps, 'ben', p.id, 2)).rejects.toThrow(/direction must be/)
    await updateProposal(f.deps, owner, p.id, { status: 'shipped' })
    await expect(voteProposal(f.deps, 'ben', p.id, 1)).rejects.toMatchObject({ code: 'conflict' })
    await updateProposal(f.deps, owner, p.id, { status: 'declined' })
    await expect(voteProposal(f.deps, 'ben', p.id, 1)).rejects.toMatchObject({ code: 'not_found' })
    expect(await listProposals(f.deps, 'ben')).toEqual([])
  })
})

describe('contribute: the makers and the agent move proposals along', () => {
  it('the agent picks one up with a note, then ships it (shipped_at stamped, event logged)', async () => {
    const { f, p } = await shared()
    const picked = await updateProposal(f.deps, agent, p.id, { status: 'in_progress', note: 'Picked up — building it now.' })
    expect(picked).toMatchObject({ status: 'in_progress', note: 'Picked up — building it now.', myVote: 0, own: false })
    const shipped = await updateProposal(f.deps, agent, p.id, { status: 'shipped' })
    expect(shipped.shippedAt).not.toBeNull()
    expect(shipped.note).toBe('Picked up — building it now.')
    expect(f.events.slice(1).map((e) => [e.type, e.principalId, e.payload.from, e.payload.to])).toEqual([
      ['contribute.status_changed', 'agent-1', 'requested', 'in_progress'],
      ['contribute.status_changed', 'agent-1', 'in_progress', 'shipped'],
    ])
    const reopened = await updateProposal(f.deps, owner, p.id, { status: 'requested', note: null })
    expect(reopened).toMatchObject({ status: 'requested', shippedAt: null, note: null })
  })

  it('a member cannot manage; nothing to change, a bad status and an unknown id fail loud', async () => {
    const { f, p } = await shared()
    await expect(updateProposal(f.deps, member, p.id, { status: 'shipped' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(updateProposal(f.deps, owner, p.id, {})).rejects.toThrow(/nothing to change/)
    await expect(updateProposal(f.deps, owner, p.id, { status: 'done' })).rejects.toThrow(/status must be one of/)
    await expect(updateProposal(f.deps, owner, p.id, { note: '  ' })).rejects.toThrow(/send null to clear/)
    await expect(updateProposal(f.deps, owner, '00000000-0000-4000-8000-999999999999', { status: 'shipped' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(updateProposal(f.deps, owner, 'nope', { status: 'shipped' })).rejects.toThrow(/UUID/)
  })

  it('the shipped tab lists newest shipped first', async () => {
    const f = fixture()
    const a = await shareProposal(f.deps, 'ana', { title: 'A', kind: 'idea', area: 'drive' })
    const b = await shareProposal(f.deps, 'ana', { title: 'B', kind: 'idea', area: 'drive' })
    await updateProposal(f.deps, owner, b.id, { status: 'shipped' })
    await updateProposal(f.deps, owner, a.id, { status: 'shipped' })
    expect((await listProposals(f.deps, null, ['shipped'])).map((p) => p.title)).toEqual(['A', 'B'])
  })
})

describe('contribute: sharing outbox hooks', () => {
  it('sharing on: a new proposal gets a pending outbox row', async () => {
    const { f, p } = await shared()
    expect(f.shareState.outbox.get(p.id)).toMatchObject({ state: 'pending', summary: null, lastSentHash: null })
  })

  it('sharing off: a new proposal gets no row (and is never backfilled)', async () => {
    const { f, p } = await shared(fixture([], { sharing: false }))
    expect(f.shareState.outbox.has(p.id)).toBe(false)
  })

  it('a vote or a status change on a sent proposal makes it due again', async () => {
    const { f, p } = await shared()
    const sentAt = f.now()
    f.shareState.outbox.set(p.id, { ...f.shareState.outbox.get(p.id)!, state: 'sent', lastSentHash: 'h', nextAttemptAt: new Date('2027-01-01'), updatedAt: sentAt })
    const later = f.tick(60_000)
    await voteProposal(f.deps, 'ben', p.id, 1)
    expect(f.shareState.outbox.get(p.id)).toMatchObject({ state: 'scrubbed', nextAttemptAt: later })

    f.shareState.outbox.set(p.id, { ...f.shareState.outbox.get(p.id)!, state: 'sent', nextAttemptAt: new Date('2027-01-01') })
    await updateProposal(f.deps, owner, p.id, { status: 'in_progress' })
    expect(f.shareState.outbox.get(p.id)?.state).toBe('scrubbed')
  })

  it('an excluded row stays excluded on a change', async () => {
    const { f, p } = await shared()
    f.shareState.outbox.set(p.id, { ...f.shareState.outbox.get(p.id)!, state: 'excluded' })
    await voteProposal(f.deps, 'ben', p.id, 1)
    expect(f.shareState.outbox.get(p.id)?.state).toBe('excluded')
  })
})
