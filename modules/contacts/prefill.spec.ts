import { describe, expect, it } from 'vitest'
import { CONTACT_FIELDS, LOG_FIELDS, newChannels, newTags, planFields } from './prefill'

const blank = { name: '', organisation: '', title: '', metHow: '', whyRelevant: '', lastContactedOn: '', nextFollowUpOn: '', nextStep: '' }

describe('planFields', () => {
  it('fills empty fields, leaves what was not said alone, and lists a different existing value as a change', () => {
    const plan = planFields(
      CONTACT_FIELDS,
      { ...blank, name: 'Mara Voss', organisation: 'Northwind' },
      { name: 'Mara Voss', organisation: 'Acme', title: 'Partner', metHow: null, nextStep: '  ' },
    )
    expect(plan.filled).toEqual([{ key: 'title', label: 'Role or title', value: 'Partner' }])
    expect(plan.changes).toEqual([{ key: 'organisation', label: 'Organisation', from: 'Northwind', to: 'Acme' }])
  })

  it('a field still at its default counts as empty (the log form’s today)', () => {
    const plan = planFields(LOG_FIELDS, { on: '2026-11-12', nextFollowUpOn: '', nextStep: '' }, { on: '2026-11-11' }, { on: '2026-11-12' })
    expect(plan.filled).toEqual([{ key: 'on', label: 'In touch on', value: '2026-11-11' }])
    expect(plan.changes).toEqual([])
  })

  it('a field the person changed from its default is a change', () => {
    const plan = planFields(LOG_FIELDS, { on: '2026-11-05', nextFollowUpOn: '', nextStep: '' }, { on: '2026-11-11' }, { on: '2026-11-12' })
    expect(plan.changes).toEqual([{ key: 'on', label: 'In touch on', from: '2026-11-05', to: '2026-11-11' }])
  })
})

describe('channels and tags are added, never replaced', () => {
  it('only channels the form does not have yet', () => {
    expect(
      newChannels(
        [{ type: 'email', value: 'mara@northwind.example' }, { type: 'phone', value: '' }],
        [
          { type: 'email', value: 'mara@northwind.example' },
          { type: 'phone', value: '+49 30 1234567' },
        ],
      ),
    ).toEqual([{ type: 'phone', value: '+49 30 1234567' }])
  })

  it('only tags not checked yet', () => {
    expect(newTags(['investor'], ['investor', 'partner'])).toEqual(['partner'])
  })
})
