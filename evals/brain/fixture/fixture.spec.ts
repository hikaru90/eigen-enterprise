import type { CompanyFixture } from '../types'
import { describe, expect, it } from 'vitest'
import { listSources } from './audience'
import { COMPANY } from './company'
import { validateFixture } from './validate'

const clone = (): CompanyFixture => structuredClone(COMPANY)
const audienceOf = (f: CompanyFixture, id: string) => [...(listSources(f).find((s) => s.id === id)?.audience ?? [])].sort()

describe('north-star fixture: who may read what (axis A, no admin override)', () => {
  it('a public channel message is everyone’s; a private channel’s only its members’', () => {
    expect(audienceOf(COMPANY, 'msg-general-deck')).toEqual(['jonas', 'martin', 'ony', 'priya'])
    expect(audienceOf(COMPANY, 'msg-sales-acme')).toEqual(['martin', 'ony'])
  })

  it('a DM is its two people’s — the owner of the company is not among them', () => {
    expect(audienceOf(COMPANY, 'msg-dm-pj-1')).toEqual(['jonas', 'priya'])
  })

  it('mail belongs to whoever can read the mailbox: the members of its group', () => {
    expect(audienceOf(COMPANY, 'mail-acme-1')).toEqual(['martin', 'ony'])
  })

  it('a call transcript is its participants’', () => {
    expect(audienceOf(COMPANY, 'call-acme')).toEqual(['martin', 'ony'])
  })

  it('Drive: everyone / some / private (owner only, admins and owner included in no override)', () => {
    expect(audienceOf(COMPANY, 'drive-handbook')).toEqual(['jonas', 'martin', 'ony', 'priya'])
    expect(audienceOf(COMPANY, 'drive-acme-proposal')).toEqual(['martin', 'ony'])
    expect(audienceOf(COMPANY, 'drive-ony-salary')).toEqual(['ony'])
  })

  it('a private calendar event is its owner’s and attendees’; a company event everyone’s', () => {
    expect(audienceOf(COMPANY, 'ev-jonas-dentist')).toEqual(['jonas'])
    expect(audienceOf(COMPANY, 'ev-investor')).toEqual(['jonas', 'martin', 'ony', 'priya'])
  })

  it('a thought is its owner’s alone; an unshared contact its owner’s', () => {
    expect(audienceOf(COMPANY, 'th-priya-brightwave')).toEqual(['priya'])
    expect(audienceOf(COMPANY, 'ct-elin')).toEqual(['martin'])
    expect(audienceOf(COMPANY, 'ct-dana')).toEqual(['jonas', 'martin', 'ony', 'priya'])
  })
})

describe('north-star fixture validity', () => {
  it('the shipped fixture is valid and has what CB0 asks for', () => {
    expect(validateFixture(COMPANY)).toEqual([])
    const s = listSources(COMPANY)
    expect(COMPANY.members.length).toBeGreaterThanOrEqual(3)
    expect(new Set(COMPANY.members.map((m) => m.role)).size).toBe(3)
    expect(s.some((x) => x.kind === 'dm_message')).toBe(true)
    expect(COMPANY.drive.some((f) => f.kind === 'pptx')).toBe(true)
    expect(COMPANY.drive.some((f) => f.grant === 'private')).toBe(true)
    expect(COMPANY.drive.some((f) => f.grant === 'everyone')).toBe(true)
    expect(new Set(COMPANY.thoughts.map((t) => t.owner)).size).toBe(2)
    expect(COMPANY.thoughts.some((t) => t.sensitive)).toBe(true)
    // the mailbox is readable by some members only
    expect(audienceOf(COMPANY, 'mail-acme-1').length).toBeLessThan(COMPANY.members.length)
  })

  it('refuses a marker that is not written into its own text', () => {
    const f = clone()
    f.thoughts[0]!.marker = 'NOT-IN-TEXT'
    expect(validateFixture(f)).toContain('th-martin-lease: marker NOT-IN-TEXT is not in its own text')
  })

  it('refuses a marker that also appears in another source (it would not identify its source)', () => {
    const f = clone()
    f.thoughts[0]!.text += ' see FJ-2207'
    expect(validateFixture(f)).toContain('marker FJ-2207 (msg-general-deck) also appears in th-martin-lease')
  })

  it('refuses duplicate ids and markers', () => {
    const f = clone()
    f.thoughts[1]!.id = 'th-martin-lease'
    expect(validateFixture(f)).toContain('duplicate id th-martin-lease')
  })

  it('refuses a second owner, an unknown member, a DM author outside the DM, a mailbox without its group', () => {
    const f = clone()
    f.members[1]!.role = 'owner'
    f.dms[1]!.messages[0]!.author = 'martin'
    f.mailboxes[0]!.groupId = 'nope'
    f.calls[0]!.participants = ['priya']
    const errors = validateFixture(f)
    expect(errors).toContain('exactly one owner is required, found 2')
    expect(errors).toContain('dm-priya-jonas: author martin is not in the DM')
    expect(errors).toContain('mbx-sales: unknown group nope')
    expect(errors).toContain('call-acme: startedBy ony is not a participant')
  })
})
