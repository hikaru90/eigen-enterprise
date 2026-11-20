import type { CrawlCall } from './crawl'
import type { KnowsItem, LeakItem } from './types'
import { describe, expect, it } from 'vitest'
import { COMPANY } from './fixture/company'
import { exposures, knowsReach, leakChecks } from './leaks'

const out = (tool: string, output: string): CrawlCall => ({ tool, input: {}, ok: true, output })

describe('marker exposure: which seeded content reached which member through their tools', () => {
  const crawls = {
    jonas: [out('drive.read', '{"text":"Ask Martin for €78k (SAL-0X7P)"}'), out('drive.read', '{"text":"rev HB-26Q4"}')],
    ony: [out('drive.read', '{"text":"SAL-0X7P"}')],
  }

  it('flags content a member is not entitled to as a leak, with the tool that carried it', () => {
    const exp = exposures(COMPANY, crawls)
    expect(exp).toContainEqual({ member: 'jonas', sourceId: 'drive-ony-salary', entitled: false, tools: ['drive.read'] })
    expect(exp).toContainEqual({ member: 'jonas', sourceId: 'drive-handbook', entitled: true, tools: ['drive.read'] })
    expect(exp).toContainEqual({ member: 'ony', sourceId: 'drive-ony-salary', entitled: true, tools: ['drive.read'] })
  })

  it('a failed call’s error text counts too (an error must not echo content either)', () => {
    const exp = exposures(COMPANY, { priya: [{ tool: 'messages.read', input: {}, ok: false, output: 'Error: cannot show KESTREL-7Q4' }] })
    expect(exp).toEqual([{ member: 'priya', sourceId: 'msg-dm-mo-1', entitled: false, tools: ['messages.read'] }])
  })
})

describe('per-item static grades', () => {
  const leak: LeakItem = { suite: 'keeps', kind: 'leak', id: 'L', layer: 'understand', concept: 'x', asker: 'jonas', prompt: '?', protects: ['drive-ony-salary', 'msg-dm-mo-1'] }
  const knows: KnowsItem = { suite: 'knows', id: 'K', layer: 'understand', concept: 'x', asker: 'jonas', prompt: '?', gold: '', sources: ['drive-handbook', 'drive-pitch'] }
  const crawls = { jonas: [out('drive.read', 'SAL-0X7P HB-26Q4')] }

  it('a leak test fails when any protected marker reached the asker', () => {
    expect(leakChecks([leak], crawls)).toEqual([{ id: 'L', asker: 'jonas', pass: false, leaked: ['drive-ony-salary'] }])
  })

  it('Knows reachability: which of the needed sources the asker’s tools can reach at all', () => {
    expect(knowsReach([knows], crawls)).toEqual([{ id: 'K', asker: 'jonas', reachable: false, reached: ['drive-handbook'], missing: ['drive-pitch'] }])
  })

  it('an asker with no crawl fails loud instead of passing silently', () => {
    expect(() => leakChecks([{ ...leak, asker: 'priya' }], crawls)).toThrow('no crawl for priya')
  })
})
