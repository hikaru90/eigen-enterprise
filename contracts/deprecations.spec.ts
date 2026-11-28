import { describe, expect, it } from 'vitest'
import { compareSemver, DEPRECATIONS, isIsoDate, removeAfter, windowEnded } from './deprecations'

describe('deprecation window (R4: 2 minor releases and 30 days, whichever is later)', () => {
  it('removeAfter is two minors on and thirty days on', () => {
    expect(removeAfter({ since: '0.5.40', sinceDate: '2026-11-01' })).toEqual({
      release: '0.7.0',
      date: '2026-12-01',
    })
    expect(removeAfter({ since: '1.9.3', sinceDate: '2026-12-15' })).toEqual({
      release: '1.11.0',
      date: '2027-01-14',
    })
  })

  it('the window ends only when both the release and the date have passed', () => {
    const d = { since: '0.5.40', sinceDate: '2026-11-01' }
    expect(windowEnded(d, '0.7.0', '2026-12-01')).toBe(true)
    expect(windowEnded(d, '0.6.12', '2027-12-01')).toBe(false)
    expect(windowEnded(d, '0.9.0', '2026-11-30')).toBe(false)
  })

  it('fails loud on a malformed release or date', () => {
    expect(() => removeAfter({ since: 'v0.5', sinceDate: '2026-11-01' })).toThrow(
      /MAJOR\.MINOR\.PATCH/,
    )
    expect(() => removeAfter({ since: '0.5.40', sinceDate: '2026-02-30' })).toThrow(/YYYY-MM-DD/)
    expect(isIsoDate('2026-02-28')).toBe(true)
  })

  it('compares versions numerically, not as text', () => {
    expect(compareSemver('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
  })

  it('deprecates the named model/provider outputs for their label (wish 60bd7be2), and nothing else besides handover', () => {
    const rest = DEPRECATIONS.filter((d) => !d.item.startsWith('tool:handover.'))
    expect(rest.map((d) => [d.item, d.replacement])).toEqual([
      ...['create', 'get', 'update', 'enable', 'disable', 'remove'].map((v) => [`tool:coworkers.${v}.output.modelId`, `tool:coworkers.${v}.output.modelLabel`]),
      ['tool:coworkers.list.output.coworkers.[].modelId', 'tool:coworkers.list.output.coworkers.[].modelLabel'],
      ['tool:settings.get.output.ai.modelProvider', 'tool:settings.get.output.ai.providerLabel'],
      ['tool:settings.update.output.ai.modelProvider', 'tool:settings.update.output.ai.providerLabel'],
    ])
    for (const d of rest) {
      expect(d).toMatchObject({ since: '0.5.48', sinceDate: '2026-11-28' })
      expect(d.howToMigrate).toContain('eigenInference')
    }
  })

  it('deprecates exactly the handover.* tools (wish f3fc516e: Handover goes), with nothing replacing them', () => {
    const handover = DEPRECATIONS.filter((d) => d.item.startsWith('tool:handover.'))
    expect(handover.map((d) => d.item)).toEqual([
      'tool:handover.create',
      'tool:handover.list',
      'tool:handover.get',
      'tool:handover.add_entry',
      'tool:handover.update_entry',
      'tool:handover.remove_entry',
      'tool:handover.delete',
      'tool:handover.assign_entry',
      'tool:handover.draft_entry',
    ])
    for (const d of handover) {
      expect(d).toMatchObject({ since: '0.5.48', sinceDate: '2026-11-28', replacement: null })
      expect(d.howToMigrate.trim()).not.toBe('')
      expect(removeAfter(d)).toEqual({ release: '0.7.0', date: '2026-12-28' })
    }
  })
})
