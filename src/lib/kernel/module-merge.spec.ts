import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MODULE_MERGES,
  MODULE_MERGE_MIGRATION,
  mergeActivations,
  moduleMergeSql,
  RETIRED_MODULE_IDS,
} from './module-merge'

describe('MODULE_MERGES (plan/phase-platform.md step 1)', () => {
  it('maps every old module id onto exactly one merged module', () => {
    expect(MODULE_MERGES).toEqual({
      website: ['website', 'substrate', 'github'],
      email: ['email', 'owlery'],
      orchestrator: ['repo', 'dev-agent', 'roadmap'],
    })
    expect(RETIRED_MODULE_IDS).toEqual(['substrate', 'github', 'owlery', 'repo', 'dev-agent', 'roadmap'])
  })
})

describe('mergeActivations', () => {
  it('a merged module is active if any of its parts was active', () => {
    const out = mergeActivations([
      { moduleId: 'website', active: false },
      { moduleId: 'substrate', active: true },
      { moduleId: 'github', active: false },
      { moduleId: 'owlery', active: true },
      { moduleId: 'roadmap', active: true },
      { moduleId: 'memory', active: true },
    ])
    expect(out).toEqual([
      { moduleId: 'email', active: true },
      { moduleId: 'memory', active: true },
      { moduleId: 'orchestrator', active: true },
      { moduleId: 'website', active: true },
    ])
  })

  it('stays inactive when every present part was inactive', () => {
    expect(
      mergeActivations([
        { moduleId: 'email', active: false },
        { moduleId: 'owlery', active: false },
        { moduleId: 'repo', active: false },
      ]),
    ).toEqual([
      { moduleId: 'email', active: false },
      { moduleId: 'orchestrator', active: false },
    ])
  })

  it('writes no row for a merged module none of whose parts had a row (activation stays unknown = off)', () => {
    expect(mergeActivations([{ moduleId: 'brand', active: true }])).toEqual([
      { moduleId: 'brand', active: true },
    ])
  })

  it('removes every retired id and leaves unrelated modules untouched', () => {
    const out = mergeActivations([
      { moduleId: 'dev-agent', active: true },
      { moduleId: 'chat-gateway', active: false },
      { moduleId: 'kernel', active: true },
    ])
    expect(out.map((r) => r.moduleId)).toEqual(['chat-gateway', 'kernel', 'orchestrator'])
    for (const id of RETIRED_MODULE_IDS) expect(out.some((r) => r.moduleId === id)).toBe(false)
  })

  it('is idempotent (re-running over its own output changes nothing)', () => {
    const once = mergeActivations([
      { moduleId: 'github', active: true },
      { moduleId: 'email', active: false },
    ])
    expect(mergeActivations(once)).toEqual(once)
  })
})

describe('migration SQL', () => {
  it('the checked-in migration is exactly the SQL generated from MODULE_MERGES', () => {
    const sql = readFileSync(`drizzle/${MODULE_MERGE_MIGRATION}.sql`, 'utf8')
    expect(sql).toBe(moduleMergeSql())
  })

  it('has a matching journal entry', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    const entry = journal.entries.find((e) => e.tag === MODULE_MERGE_MIGRATION)
    expect(entry?.idx).toBe(92)
  })
})
