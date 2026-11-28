import { describe, expect, it } from 'vitest'
import {
  buildPatternFacts,
  MAX_FACTS,
  parsePatternSentences,
  patternSentenceMessages,
  visibleItems,
  type ActivityEvent,
  type ToolCatalog,
} from './digest'

const catalog: ToolCatalog = (tool) =>
  ({
    'drive.write_text': { module: 'drive', roles: ['admin', 'member'] },
    'drive.rename': { module: 'drive', roles: ['admin', 'member'] },
    'members.set_role': { module: 'members', roles: ['admin'] },
    'messages.post': { module: 'messages', roles: ['admin', 'member'] },
  })[tool] ?? null

const names: Record<string, string> = { anna: 'Anna', ben: 'Ben' }
const at = (day: number) => new Date(Date.UTC(2026, 10, 20 + day, 10))
const ev = (principalId: string, tool: string, day: number): ActivityEvent => ({ principalId, tool, at: at(day) })

const build = (events: ActivityEvent[]) =>
  buildPatternFacts({ events, catalog, personName: (id) => names[id] ?? null, moduleLabel: (m) => m.toUpperCase() })

describe('buildPatternFacts', () => {
  it('counts changes per person and module, with distinct days, busiest first', () => {
    const facts = build([
      ev('anna', 'drive.write_text', 0),
      ev('anna', 'drive.rename', 0),
      ev('anna', 'drive.write_text', 1),
      ev('ben', 'messages.post', 2),
    ])
    expect(facts.map((f) => [f.id, f.count, f.days, f.kind])).toEqual([
      ['anna:drive', 3, 2, 'activity'],
      ['ben:messages', 1, 1, 'activity'],
    ])
    expect(facts[0]).toMatchObject({ personName: 'Anna', moduleLabel: 'DRIVE', tools: ['drive.rename', 'drive.write_text'] })
  })

  it('calls activity on at least three distinct days recurring', () => {
    const [fact] = build([ev('anna', 'messages.post', 0), ev('anna', 'messages.post', 2), ev('anna', 'messages.post', 4)])
    expect(fact).toMatchObject({ kind: 'recurring', days: 3 })
  })

  it('leaves out unknown tools and principals without a name', () => {
    expect(build([ev('anna', 'gone.tool', 0), ev('ghost', 'drive.rename', 0)])).toEqual([])
  })

  it('keeps the roles every counted tool admits', () => {
    const [fact] = build([ev('anna', 'members.set_role', 0)])
    expect(fact.roles).toEqual(['admin'])
  })

  it('keeps at most MAX_FACTS facts', () => {
    const events = Array.from({ length: MAX_FACTS + 3 }, () => ev('anna', 'drive.rename', 0)).map((e, i) => ({
      ...e,
      principalId: `p${i}`,
    }))
    const facts = buildPatternFacts({ events, catalog, personName: (id) => id, moduleLabel: (m) => m })
    expect(facts).toHaveLength(MAX_FACTS)
  })
})

describe('visibleItems', () => {
  const items = parsePatternSentences(
    JSON.stringify({ sentences: { 'anna:drive': 'Anna changed Drive once.', 'anna:members': 'Anna changed a role.' } }),
    build([ev('anna', 'drive.rename', 0), ev('anna', 'members.set_role', 0)]),
  )

  it('a member sees only facts whose tools a member may run', () => {
    expect(visibleItems(items, { roles: ['member'], moduleActive: () => true }).map((i) => i.id)).toEqual(['anna:drive'])
  })

  it('an admin sees both', () => {
    expect(visibleItems(items, { roles: ['admin', 'member'], moduleActive: () => true })).toHaveLength(2)
  })

  it('nobody sees facts of an inactive module', () => {
    expect(
      visibleItems(items, { roles: ['admin', 'member'], moduleActive: (m) => m !== 'drive' }).map((i) => i.id),
    ).toEqual(['anna:members'])
  })
})

describe('the one writing call', () => {
  const facts = build([ev('anna', 'drive.rename', 0)])

  it('sends only the structural facts', () => {
    const [, user] = patternSentenceMessages(facts)
    expect(JSON.parse(user.content)).toEqual({
      window_days: 7,
      facts: [{ id: 'anna:drive', kind: 'activity', person: 'Anna', module: 'DRIVE', changes: 1, days_active: 1 }],
    })
  })

  it('fails loud when a fact has no sentence', () => {
    expect(() => parsePatternSentences(JSON.stringify({ sentences: {} }), facts)).toThrow(/no sentence for fact anna:drive/)
  })

  it('fails loud on a non-JSON answer', () => {
    expect(() => parsePatternSentences('nope', facts)).toThrow(/not JSON/)
  })
})
