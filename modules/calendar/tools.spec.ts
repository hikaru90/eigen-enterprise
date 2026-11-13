import type { FreeBusyDto, OccurrenceDto } from './types'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { CALENDAR_TOOL_NAMES } from './manifest'
import { createEvent } from './service'
import { fixture, timed, user } from './test-fixtures'
import { createCalendarTools } from './tools'

const agentCtx: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }, requestId: 'r1' }
const humanCtx = (id: string): ToolContext => ({ principal: { id, kind: 'human', roles: ['admin'] }, requestId: 'r2' })

async function setup(opts: { onBehalfOf?: string | null } = {}) {
  const f = fixture()
  await createEvent(f.deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { title: 'Doctor', visibility: 'private' }))
  await createEvent(f.deps, user('ben'), timed('2026-11-16', '12:00', '13:00', { title: 'Lunch with Mara' }))
  const list = createCalendarTools({
    deps: async () => f.deps,
    onBehalfOf: async () => opts.onBehalfOf ?? null,
    now: () => new Date('2026-11-15T08:00:00Z'),
  })
  return { f, tools: Object.fromEntries(list.map((t) => [t.name, t])) }
}

type ListOut = { from: string; to: string; occurrences: OccurrenceDto[] }

describe('calendar.* tools', () => {
  it('match the manifest and are reads', async () => {
    expect(createCalendarTools().map((t) => t.name)).toEqual([...CALENDAR_TOOL_NAMES])
    const { tools } = await setup()
    for (const name of CALENDAR_TOOL_NAMES) expect(tools[name].auditClass).toBe('read')
  })

  it('calendar.list is the person’s own calendar — the agent working for Ben sees Ben’s, not Ana’s', async () => {
    const { tools } = await setup({ onBehalfOf: 'ben' })
    const out = (await tools['calendar.list'].handler(agentCtx, {})) as ListOut
    // Defaults: from the start of today (UTC) for 7 days.
    expect([out.from, out.to]).toEqual(['2026-11-15T00:00:00.000Z', '2026-11-22T00:00:00.000Z'])
    expect(out.occurrences.map((o) => o.title)).toEqual(['Lunch with Mara'])
    const ana = (await tools['calendar.list'].handler(humanCtx('ana'), { from: '2026-11-16T00:00:00Z', to: '2026-11-17T00:00:00Z' })) as ListOut
    expect(ana.occurrences.map((o) => o.title)).toEqual(['Doctor'])
  })

  it('the agent on its own has no calendar to list', async () => {
    const { tools } = await setup()
    await expect(tools['calendar.list'].handler(agentCtx, {})).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('calendar.free_busy shows colleagues’ time with the visibility labels, never private titles', async () => {
    const { tools } = await setup({ onBehalfOf: 'ben' })
    const out = (await tools['calendar.free_busy'].handler(agentCtx, {
      member_ids: ['ana', 'ben'],
      from: '2026-11-16T00:00:00Z',
      to: '2026-11-17T00:00:00Z',
    })) as { people: FreeBusyDto[] }
    expect(out.people.map((p) => [p.name, p.blocks.map((b) => [b.kind, b.title])])).toEqual([
      ['Ana Lind', [['out_of_office', null]]],
      ['Ben Ode', [['busy', null]]],
    ])
    expect(JSON.stringify(out)).not.toContain('Doctor')
  })

  it('rejects unknown keys and bad ranges', async () => {
    const { tools } = await setup()
    await expect(tools['calendar.list'].handler(humanCtx('ana'), { owner: 'ben' })).rejects.toThrow()
    await expect(tools['calendar.free_busy'].handler(humanCtx('ana'), { member_ids: ['ben'], from: '2026-11-16T00:00:00Z' })).rejects.toThrow()
  })
})
