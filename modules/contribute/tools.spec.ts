import type { ContributionDto } from './types'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { CONTRIBUTE_TOOL_NAMES } from './manifest'
import { shareProposal } from './service'
import { fixture } from './test-fixtures'
import { createContributeTools } from './tools'

const agentCtx: ToolContext = { principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] }, requestId: 'r1' }
const humanCtx = (id: string): ToolContext => ({ principal: { id, kind: 'human', roles: ['admin'] }, requestId: 'r2' })

async function seeded() {
  const f = fixture()
  const a = await shareProposal(f.deps, 'ana', { title: 'Dark mode', kind: 'idea', area: 'everywhere' })
  const b = await shareProposal(f.deps, 'ben', { title: 'Typo on login', kind: 'polish', area: 'settings' })
  const tools = Object.fromEntries(
    createContributeTools({
      deps: async () => f.deps,
      actor: async (ctx) => ({ id: ctx.principal.id, kind: ctx.principal.kind === 'human' ? 'human' : 'agent', canManage: ctx.principal.id !== 'ben' }),
    }).map((t) => [t.name, t]),
  )
  return { f, a, b, tools }
}

describe('contribute.* tools', () => {
  it('match the manifest', () => {
    expect(createContributeTools().map((t) => t.name)).toEqual([...CONTRIBUTE_TOOL_NAMES])
  })

  it('the agent lists open proposals, picks one up and ships it', async () => {
    const { a, b, tools } = await seeded()
    const listed = (await tools['contribute.list'].handler(agentCtx, {})) as { proposals: ContributionDto[] }
    expect(listed.proposals.map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
    expect(listed.proposals.every((p) => p.myVote === 0)).toBe(true)

    const picked = (await tools['contribute.update'].handler(agentCtx, { id: a.id, status: 'in_progress', note: 'On it' })) as ContributionDto
    expect(picked).toMatchObject({ status: 'in_progress', note: 'On it' })
    await tools['contribute.update'].handler(agentCtx, { id: a.id, status: 'shipped' })

    const open = (await tools['contribute.list'].handler(agentCtx, {})) as { proposals: ContributionDto[] }
    expect(open.proposals.map((p) => p.id)).toEqual([b.id])
    const shipped = (await tools['contribute.list'].handler(agentCtx, { status: 'shipped' })) as { proposals: ContributionDto[] }
    expect(shipped.proposals.map((p) => p.id)).toEqual([a.id])
    expect(((await tools['contribute.get'].handler(agentCtx, { id: a.id })) as ContributionDto).status).toBe('shipped')
  })

  it('a person sees their own votes; a non-admin person cannot update', async () => {
    const { a, tools } = await seeded()
    const listed = (await tools['contribute.list'].handler(humanCtx('ana'), { status: 'all' })) as { proposals: ContributionDto[] }
    expect(listed.proposals.find((p) => p.id === a.id)).toMatchObject({ myVote: 1, own: true })
    await expect(tools['contribute.update'].handler(humanCtx('ben'), { id: a.id, status: 'shipped' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('says what it did in plain words', () => {
    const update = createContributeTools().find((t) => t.name === 'contribute.update')!
    const out = { title: 'Dark mode' } as ContributionDto
    expect(update.activity!({ id: 'x', status: 'in_progress' }, out)).toBe('Marked “Dark mode” in progress')
    expect(update.activity!({ id: 'x', note: 'hi' }, undefined)).toBe('Updated the note on a proposal')
  })
})
