import { describe, expect, it } from 'vitest'
import { DECISION_STATUSES } from '$lib/server/db/decisions.schema'
import { coworkerEventMine } from './coworkers/decision-kinds'
import { DECISION_KINDS } from './decision-kinds'
import { moduleManifests } from './index'
import { websitePageAudience } from './website/decision-kinds'

describe('the decision kinds catalog', () => {
  it('declares the website’s page-audience kind, in shadow', () => {
    expect(DECISION_KINDS.get('website.page_audience')).toBe(websitePageAudience)
    expect(websitePageAudience.status).toBe('shadow')
  })

  it('declares the co-workers’ event_mine kind (C7): yes/no, in shadow with no current judge — log, don’t act', () => {
    expect(DECISION_KINDS.get('coworkers.event_mine')).toBe(coworkerEventMine)
    expect(coworkerEventMine.status).toBe('shadow')
    expect(coworkerEventMine.choices).toEqual(['yes', 'no'])
    expect(coworkerEventMine.lowConfidence).toBe(0)
  })

  it('every kind has a unique id, a status of shadow or enforced, and belongs to a registered module', () => {
    const kinds = DECISION_KINDS.list()
    expect(new Set(kinds.map((k) => k.id)).size).toBe(kinds.length)
    const moduleIds = new Set(moduleManifests.map((m) => m.id))
    for (const kind of kinds) {
      expect(DECISION_STATUSES).toContain(kind.status)
      expect(moduleIds.has(kind.module), `${kind.id}: module ${kind.module}`).toBe(true)
    }
  })
})
