import { describe, expect, it } from 'vitest'
import { dueLabel, metaLine, updateLine } from './assigned-task-format'

const base = {
  title: 'Send the Q4 deck',
  assigner: { id: 'alex', name: 'Alex' },
  assignee: { id: 'ony', name: 'Ony' },
  dueOn: '2026-11-21',
  status: 'open' as const,
  createdVia: 'assistant' as const,
}

describe('assigned task lines', () => {
  it('shows the due day as stored, without a time zone shift', () => {
    expect(dueLabel('2026-11-21')).toBe('due 21 Nov 2026')
    expect(dueLabel(null)).toBeNull()
  })

  it('says who assigned it to whom, and how', () => {
    expect(metaLine({ ...base, role: 'assignee' })).toBe('From Alex · via the assistant · due 21 Nov 2026')
    expect(metaLine({ ...base, role: 'assigner', status: 'done', createdVia: 'person', dueOn: null })).toBe('To Ony · done')
  })

  it('names what is new for the viewer', () => {
    expect(updateLine({ ...base, role: 'assignee', update: { kind: 'assigned', at: 't' } })).toBe("Alex assigned you 'Send the Q4 deck'")
    expect(updateLine({ ...base, role: 'assigner', update: { kind: 'completed', at: 't' } })).toBe("Ony completed 'Send the Q4 deck'")
    expect(updateLine({ ...base, role: 'assigner', update: { kind: 'commented', at: 't' } })).toBe("Ony commented on 'Send the Q4 deck'")
    expect(updateLine({ ...base, role: 'assignee', update: { kind: 'commented', at: 't' } })).toBe("Alex commented on 'Send the Q4 deck'")
    expect(updateLine({ ...base, role: 'assignee', update: null })).toBeNull()
  })
})
