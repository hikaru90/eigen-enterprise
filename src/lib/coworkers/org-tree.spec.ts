import { describe, expect, it } from 'vitest'
import { chatModelOption, modelFamily, modelName } from './model-family'
import { accountabilityLines, buildOrgTree, managerName, managerOptions, type OrgNode, type OrgPerson } from './org-tree'

const seat = (id: string, over: Partial<OrgPerson> = {}): OrgPerson => ({
  id,
  name: id,
  kind: 'human',
  role: 'member',
  title: null,
  accountabilities: [],
  reportsToUserId: null,
  accountableHuman: null,
  enabled: null,
  modelId: null,
  ...over,
})

const shape = (nodes: OrgNode[]): unknown => nodes.map((n) => (n.reports.length ? [n.person.id, shape(n.reports)] : n.person.id))

describe('buildOrgTree', () => {
  it('puts each seat under the person it reports to: owner first, people before co-workers, by name', () => {
    const people = [
      seat('Zed', { reportsToUserId: 'Olga' }),
      seat('Marketing', { kind: 'coworker', reportsToUserId: 'Olga' }),
      seat('Designer', { kind: 'coworker', reportsToUserId: 'Marketing' }),
      seat('Ada', { reportsToUserId: 'Olga' }),
      seat('Olga', { role: 'owner' }),
      seat('Loner'),
    ]
    expect(shape(buildOrgTree(people))).toEqual([['Olga', ['Ada', 'Zed', ['Marketing', ['Designer']]]], 'Loner'])
  })

  it('shows a seat whose manager left the chart as a root, and every seat exactly once even in a cycle', () => {
    const tree = buildOrgTree([seat('a', { reportsToUserId: 'gone' }), seat('b', { reportsToUserId: 'c' }), seat('c', { reportsToUserId: 'b' })])
    expect(shape(tree)).toEqual(['a', ['b', ['c']]])
  })
})

describe('managerOptions / managerName', () => {
  const people = [seat('o', { role: 'owner' }), seat('m', { reportsToUserId: 'o' }), seat('d', { reportsToUserId: 'm' }), seat('x')]
  it('offers everyone but the seat itself and the people below it (no cycles)', () => {
    expect(managerOptions(people, 'm').map((p) => p.id)).toEqual(['o', 'x'])
    expect(managerOptions(people, 'd').map((p) => p.id)).toEqual(['o', 'm', 'x'])
  })
  it('names the manager, null at the top', () => {
    expect(managerName(people, people[2]!)).toBe('m')
    expect(managerName(people, people[0]!)).toBeNull()
  })
})

describe('accountabilityLines', () => {
  it('one accountability per line, trimmed, blank lines dropped', () => {
    expect(accountabilityLines(' Pipeline \n\n  Launches\n')).toEqual(['Pipeline', 'Launches'])
  })
})

describe('modelFamily', () => {
  it('reads the family from the pool id namespace', () => {
    expect(modelFamily('anthropic/claude-sonnet-5.5')).toBe('Anthropic')
    expect(modelFamily('~deepseek/deepseek-flash-latest')).toBe('DeepSeek')
    expect(modelFamily('mistralai/mistral-large-4-0')).toBe('Mistral')
    expect(modelFamily('newmaker/model-1')).toBe('newmaker')
    expect(modelName('google/gemini-3.8-flash')).toBe('gemini-3.8-flash')
  })
  it('fails loud on an id without a namespace', () => {
    expect(() => modelFamily('gpt')).toThrow(/no provider namespace/)
  })
  it('builds a picker option', () => {
    expect(chatModelOption({ id: 'qwen/qwen3.8-flash', note: 'cheap' })).toEqual({
      id: 'qwen/qwen3.8-flash',
      family: 'Qwen',
      name: 'qwen3.8-flash',
      note: 'cheap',
      recommended: false,
    })
  })
})
