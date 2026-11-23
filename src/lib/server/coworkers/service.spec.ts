import { describe, expect, it } from 'vitest'
import { isPoolModel } from '$lib/server/llm/model-pool'
import { memoryCoworkerStore } from './memory-store'
import {
  accountableHumanFor,
  coworkerEmail,
  createCoworker,
  getCoworker,
  listCoworkers,
  listEnabledCoworkers,
  orgChart,
  removeCoworker,
  setCoworkerEnabled,
  setOrgPosition,
  slugify,
  updateCoworker,
  type CoworkerActor,
  type OrgMember,
} from './service'
import { COWORKER_TEMPLATE_IDS, COWORKER_TEMPLATES } from './templates'

const at = new Date('2026-11-23T09:00:00Z')
const person = (id: string, role: OrgMember['role'], minute: number): OrgMember => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  email: `${id}@k.co`,
  role,
  kind: 'human',
  createdAt: new Date(at.getTime() - (10 - minute) * 60_000),
})

const owner: CoworkerActor = { id: 'olga', role: 'owner', kind: 'person' }
const admin: CoworkerActor = { id: 'ari', role: 'admin', kind: 'person' }
const member: CoworkerActor = { id: 'mo', role: 'member', kind: 'person' }
const agent: CoworkerActor = { id: 'orchestrator', role: 'admin', kind: 'agent' }

function setup() {
  const store = memoryCoworkerStore([person('olga', 'owner', 0), person('ari', 'admin', 1), person('mo', 'member', 2)])
  let n = 0
  const deps = { store, now: () => at, newId: () => `cw${String(++n).padStart(6, '0')}abcdef` }
  return { store, deps }
}

describe('co-worker templates', () => {
  it('the catalog has the six seats, each with 3–5 accountabilities, a lens and a pool chat model', () => {
    expect(COWORKER_TEMPLATES.map((t) => t.title)).toEqual([
      'Marketing Manager',
      'Go-to-Market Manager',
      'Designer',
      'Ops Analyst',
      'Finance Analyst',
      'Customer Success Lead',
    ])
    expect(COWORKER_TEMPLATES.map((t) => t.id)).toEqual([...COWORKER_TEMPLATE_IDS])
    for (const t of COWORKER_TEMPLATES) {
      expect(t.accountabilities.length).toBeGreaterThanOrEqual(3)
      expect(t.accountabilities.length).toBeLessThanOrEqual(5)
      expect(t.lens.length).toBeGreaterThan(200)
      expect(isPoolModel('chat', t.suggestedModelId), `${t.id}: ${t.suggestedModelId}`).toBe(true)
      expect(t.suggestedDailyCapUsd).toBeGreaterThan(0)
    }
  })

  it('templates spread over more than one model family', () => {
    expect(new Set(COWORKER_TEMPLATES.map((t) => t.suggestedModelId)).size).toBeGreaterThan(1)
  })
})

describe('createCoworker', () => {
  it('from a template: a member-role co-worker user with its role card and seat, answering to the owner', async () => {
    const { store, deps } = setup()
    const cw = await createCoworker(owner, { templateId: 'marketing-manager' }, deps)
    expect(cw).toMatchObject({
      name: 'Marketing Manager',
      slug: 'marketing-manager',
      title: 'Marketing Manager',
      modelId: 'openai/gpt-5-mini',
      enabled: true,
      dailyCapUsd: 2,
      templateId: 'marketing-manager',
      reportsToUserId: null,
      accountableHuman: { id: 'olga', name: 'Olga', reason: 'owner' },
      agentId: `coworker-${cw.id}`,
      createdBy: 'olga',
      removedAt: null,
    })
    expect(cw.email).toBe(`marketing-manager.${cw.id.slice(0, 8)}@coworker.invalid`)
    expect(store.users.get(cw.id)).toMatchObject({ role: 'member', kind: 'coworker' })
  })

  it('explicit fields override the template; a named co-worker reports to a person', async () => {
    const { deps } = setup()
    const cw = await createCoworker(
      admin,
      {
        templateId: 'designer',
        name: 'Dana',
        modelId: '~deepseek/deepseek-flash-latest',
        reportsToUserId: 'mo',
        dailyCapUsd: 0.5,
        accountabilities: ['Own the look'],
      },
      deps,
    )
    expect(cw).toMatchObject({
      name: 'Dana',
      slug: 'dana',
      title: 'Designer',
      modelId: '~deepseek/deepseek-flash-latest',
      dailyCapUsd: 0.5,
      accountabilities: ['Own the look'],
      reportsToUserId: 'mo',
      accountableHuman: { id: 'mo', reason: 'chain' },
    })
  })

  it('without a template every field is asked for', async () => {
    const { deps } = setup()
    await expect(createCoworker(owner, { name: 'X', title: 'Analyst', lens: 'L' }, deps)).rejects.toMatchObject({ code: 'invalid_input' })
    const cw = await createCoworker(
      owner,
      { title: 'Analyst', lens: 'Care about numbers.', accountabilities: ['Numbers'], modelId: 'openai/gpt-5-mini', dailyCapUsd: 1 },
      deps,
    )
    expect(cw).toMatchObject({ name: 'Analyst', templateId: null })
  })

  it('refuses a model outside the chat pool (fail loud)', async () => {
    const { deps } = setup()
    await expect(createCoworker(owner, { templateId: 'ops-analyst', modelId: 'anthropic/claude-made-up' }, deps)).rejects.toMatchObject({
      code: 'invalid_model',
    })
    // A pool model of another slot is no chat model either.
    await expect(createCoworker(owner, { templateId: 'ops-analyst', modelId: 'typesafe/jev-1.13' }, deps)).rejects.toMatchObject({
      code: 'invalid_model',
    })
  })

  it('refuses an unknown template, an unknown manager and a bad cap', async () => {
    const { deps } = setup()
    await expect(createCoworker(owner, { templateId: 'cfo' }, deps)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createCoworker(owner, { templateId: 'designer', reportsToUserId: 'ghost' }, deps)).rejects.toMatchObject({ code: 'not_found' })
    await expect(createCoworker(owner, { templateId: 'designer', dailyCapUsd: 0 }, deps)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('only the owner, an admin or the agent creates one; never a member or a co-worker', async () => {
    const { deps } = setup()
    await expect(createCoworker(member, { templateId: 'designer' }, deps)).rejects.toMatchObject({ code: 'forbidden' })
    const cw = await createCoworker(agent, { templateId: 'designer' }, deps)
    await expect(createCoworker({ id: cw.id, role: 'member', kind: 'coworker' }, { templateId: 'designer' }, deps)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('slugs stay unique', async () => {
    const { deps } = setup()
    const a = await createCoworker(owner, { templateId: 'designer' }, deps)
    const b = await createCoworker(owner, { templateId: 'designer' }, deps)
    expect([a.slug, b.slug]).toEqual(['designer', 'designer-2'])
    expect(slugify('Zoë  Müller!')).toBe('zoe-muller')
    expect(slugify('???')).toBe('coworker')
    expect(coworkerEmail('zoe', 'abcdef1234')).toBe('zoe.abcdef12@coworker.invalid')
  })
})

describe('the org chart', () => {
  it('lists every member and co-worker with kind, title, accountabilities, reports-to and the accountable human', async () => {
    const { deps } = setup()
    const mm = await createCoworker(owner, { templateId: 'marketing-manager', reportsToUserId: 'ari' }, deps)
    const gtm = await createCoworker(owner, { templateId: 'go-to-market-manager', reportsToUserId: mm.id }, deps)
    await setOrgPosition(owner, { userId: 'ari', title: 'Head of Growth', accountabilities: ['Growth'], reportsToUserId: 'olga' }, deps)
    const { people } = await orgChart(deps.store)
    expect(people.map((p) => [p.id, p.kind, p.title, p.reportsToUserId, p.accountableHuman?.id ?? null, p.enabled])).toEqual([
      ['olga', 'human', null, null, null, null],
      ['ari', 'human', 'Head of Growth', 'olga', null, null],
      ['mo', 'human', null, null, null, null],
      [mm.id, 'coworker', 'Marketing Manager', 'ari', 'ari', true],
      [gtm.id, 'coworker', 'Go-to-Market Manager', mm.id, 'ari', true],
    ])
    expect(await accountableHumanFor(deps.store, gtm.id)).toEqual({ id: 'ari', name: 'Ari', reason: 'chain' })
  })

  it('refuses self-reporting and cycles, through people and co-workers alike', async () => {
    const { deps } = setup()
    const mm = await createCoworker(owner, { templateId: 'marketing-manager', reportsToUserId: 'ari' }, deps)
    const gtm = await createCoworker(owner, { templateId: 'go-to-market-manager', reportsToUserId: mm.id }, deps)
    await expect(setOrgPosition(owner, { userId: 'ari', reportsToUserId: 'ari' }, deps)).rejects.toMatchObject({ code: 'org_cycle' })
    await expect(setOrgPosition(owner, { userId: 'ari', reportsToUserId: gtm.id }, deps)).rejects.toMatchObject({ code: 'org_cycle' })
    await expect(updateCoworker(owner, { userId: mm.id, reportsToUserId: gtm.id }, deps)).rejects.toMatchObject({ code: 'org_cycle' })
    await expect(setOrgPosition(owner, { userId: 'ari', reportsToUserId: 'ghost' }, deps)).rejects.toMatchObject({ code: 'not_found' })
    // Nothing changed.
    expect((await orgChart(deps.store)).people.find((p) => p.id === 'ari')!.reportsToUserId).toBeNull()
  })

  it('a member edits their own title and accountabilities, never someone else’s, never reports-to', async () => {
    const { deps } = setup()
    const mine = await setOrgPosition(member, { userId: 'mo', title: 'Engineer', accountabilities: ['Ship'] }, deps)
    expect(mine).toMatchObject({ title: 'Engineer', accountabilities: ['Ship'], reportsToUserId: null })
    await expect(setOrgPosition(member, { userId: 'ari', title: 'Intern' }, deps)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(setOrgPosition(member, { userId: 'mo', reportsToUserId: 'olga' }, deps)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a co-worker sets no seat, not even its own', async () => {
    const { deps } = setup()
    const cw = await createCoworker(owner, { templateId: 'designer' }, deps)
    await expect(setOrgPosition({ id: cw.id, role: 'member', kind: 'coworker' }, { userId: cw.id, title: 'CEO' }, deps)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('accountable human: the nearest person up the chain, past co-workers; the owner when none', async () => {
    const { deps } = setup()
    const a = await createCoworker(owner, { templateId: 'ops-analyst' }, deps)
    const b = await createCoworker(owner, { templateId: 'finance-analyst', reportsToUserId: a.id }, deps)
    expect(await accountableHumanFor(deps.store, b.id)).toEqual({ id: 'olga', name: 'Olga', reason: 'owner' })
    await setOrgPosition(owner, { userId: a.id, reportsToUserId: 'mo' }, deps)
    expect(await accountableHumanFor(deps.store, b.id)).toEqual({ id: 'mo', name: 'Mo', reason: 'chain' })
    await expect(accountableHumanFor(deps.store, 'mo')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('update, enable, disable, remove', () => {
  it('updates name, lens, model, cap and seat; refuses a non-pool model', async () => {
    const { store, deps } = setup()
    const cw = await createCoworker(owner, { templateId: 'designer' }, deps)
    const out = await updateCoworker(
      admin,
      { userId: cw.id, name: 'Dee', lens: 'New lens.', modelId: '~deepseek/deepseek-flash-latest', dailyCapUsd: 3, title: 'Lead Designer' },
      deps,
    )
    expect(out).toMatchObject({ name: 'Dee', lens: 'New lens.', modelId: '~deepseek/deepseek-flash-latest', dailyCapUsd: 3, title: 'Lead Designer', slug: 'designer' })
    expect(out.accountabilities).toEqual(COWORKER_TEMPLATES.find((t) => t.id === 'designer')!.accountabilities)
    await expect(updateCoworker(admin, { userId: cw.id, modelId: 'x/y' }, deps)).rejects.toMatchObject({ code: 'invalid_model' })
    await expect(updateCoworker(member, { userId: cw.id, name: 'Z' }, deps)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(updateCoworker(admin, { userId: 'mo', name: 'Z' }, deps)).rejects.toMatchObject({ code: 'not_found' })
    expect(store.users.get(cw.id)!.name).toBe('Dee')
  })

  it('disable and enable: listEnabledCoworkers follows', async () => {
    const { deps } = setup()
    const a = await createCoworker(owner, { templateId: 'designer' }, deps)
    const b = await createCoworker(owner, { templateId: 'ops-analyst' }, deps)
    expect((await setCoworkerEnabled(owner, { userId: a.id, enabled: false }, deps)).enabled).toBe(false)
    expect((await listEnabledCoworkers(deps.store)).map((c) => c.id)).toEqual([b.id])
    expect((await listCoworkers(deps.store)).map((c) => c.id)).toEqual([a.id, b.id])
    await setCoworkerEnabled(owner, { userId: a.id, enabled: true }, deps)
    expect((await listEnabledCoworkers(deps.store)).map((c) => c.id)).toEqual([a.id, b.id])
  })

  it('remove keeps the user row, switches it off for good, takes it out of the chart and moves its reports up', async () => {
    const { store, deps } = setup()
    const mm = await createCoworker(owner, { templateId: 'marketing-manager', reportsToUserId: 'ari' }, deps)
    const gtm = await createCoworker(owner, { templateId: 'go-to-market-manager', reportsToUserId: mm.id }, deps)
    const removed = await removeCoworker(owner, { userId: mm.id }, deps)
    expect(removed).toMatchObject({ enabled: false, removedAt: at.toISOString(), accountableHuman: null, name: 'Marketing Manager' })
    expect(store.users.has(mm.id)).toBe(true)
    expect(await getCoworker(deps.store, mm.id)).toMatchObject({ removedAt: at.toISOString() })
    expect((await listCoworkers(deps.store)).map((c) => c.id)).toEqual([gtm.id])
    const chart = (await orgChart(deps.store)).people
    expect(chart.map((p) => p.id)).not.toContain(mm.id)
    expect(chart.find((p) => p.id === gtm.id)).toMatchObject({ reportsToUserId: 'ari', accountableHuman: { id: 'ari' } })
    await expect(setCoworkerEnabled(owner, { userId: mm.id, enabled: true }, deps)).rejects.toMatchObject({ code: 'removed' })
    await expect(removeCoworker(owner, { userId: mm.id }, deps)).rejects.toMatchObject({ code: 'removed' })
    await expect(accountableHumanFor(deps.store, mm.id)).rejects.toMatchObject({ code: 'removed' })
    await expect(removeCoworker(member, { userId: gtm.id }, deps)).rejects.toMatchObject({ code: 'forbidden' })
  })
})
