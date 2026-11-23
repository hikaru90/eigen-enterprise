import type { CompanyFixture } from '../types'
import { describe, expect, it } from 'vitest'
import { listSources } from './audience'
import { COMPANY } from './company'
import { validateFixture } from './validate'

const clone = (): CompanyFixture => structuredClone(COMPANY)
const audienceOf = (f: CompanyFixture, id: string) => [...(listSources(f).find((s) => s.id === id)?.audience ?? [])].sort()
/** Every seat: the four people and the three AI co-workers (a co-worker sits like a new member). */
const EVERYONE = ['designer', 'gtm', 'jonas', 'marketing', 'martin', 'ony', 'priya']

describe('north-star fixture: who may read what (axis A, no admin override)', () => {
  it('a public channel message is everyone’s (co-workers included); a private channel’s only its members’', () => {
    expect(audienceOf(COMPANY, 'msg-general-deck')).toEqual(EVERYONE)
    expect(audienceOf(COMPANY, 'msg-sales-acme')).toEqual(['martin', 'ony'])
    expect(audienceOf(COMPANY, 'msg-launch-brief')).toEqual(['designer', 'gtm', 'marketing', 'martin', 'priya'])
  })

  it('a DM is its two people’s — the owner of the company is not among them', () => {
    expect(audienceOf(COMPANY, 'msg-dm-pj-1')).toEqual(['jonas', 'priya'])
  })

  it('mail belongs to whoever can read the mailbox: the members of its group, or the person whose mailbox it is', () => {
    expect(audienceOf(COMPANY, 'mail-acme-1')).toEqual(['martin', 'ony'])
    expect(audienceOf(COMPANY, 'mail-ony-recruiter')).toEqual(['ony'])
  })

  it('a call transcript is its participants’', () => {
    expect(audienceOf(COMPANY, 'call-acme')).toEqual(['martin', 'ony'])
  })

  it('Drive: everyone / some / private (owner only, admins and owner included in no override)', () => {
    expect(audienceOf(COMPANY, 'drive-handbook')).toEqual(EVERYONE)
    expect(audienceOf(COMPANY, 'drive-acme-proposal')).toEqual(['martin', 'ony'])
    expect(audienceOf(COMPANY, 'drive-ony-salary')).toEqual(['ony'])
  })

  it('a private calendar event is its owner’s and attendees’; a company event everyone’s', () => {
    expect(audienceOf(COMPANY, 'ev-jonas-dentist')).toEqual(['jonas'])
    expect(audienceOf(COMPANY, 'ev-investor')).toEqual(EVERYONE)
  })

  it('a person’s thought is their own alone; an unshared contact its owner’s', () => {
    expect(audienceOf(COMPANY, 'th-priya-brightwave')).toEqual(['priya'])
    expect(audienceOf(COMPANY, 'ct-elin')).toEqual(['martin'])
    expect(audienceOf(COMPANY, 'ct-dana')).toEqual(EVERYONE)
  })

  it('a co-worker’s thought is company-visible: every person and every co-worker', () => {
    expect(audienceOf(COMPANY, 'th-mkt-story')).toEqual(EVERYONE)
    expect(audienceOf(COMPANY, 'th-dsg-a11y')).toEqual(EVERYONE)
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
    // thoughts of two people and of every co-worker
    expect(new Set(COMPANY.thoughts.map((t) => t.owner))).toEqual(new Set(['martin', 'priya', 'marketing', 'gtm', 'designer']))
    expect(COMPANY.thoughts.some((t) => t.sensitive)).toBe(true)
    // the mailbox is readable by some members only
    expect(audienceOf(COMPANY, 'mail-acme-1').length).toBeLessThan(COMPANY.members.length)
    // C8: three co-workers from three templates on three different pool models, under a person
    expect(COMPANY.coworkers.map((c) => c.templateId).sort()).toEqual(['designer', 'go-to-market-manager', 'marketing-manager'])
    expect(new Set(COMPANY.coworkers.map((c) => c.modelId)).size).toBe(3)
    expect(COMPANY.coworkers.find((c) => c.key === 'marketing')!.reportsTo).toBe('martin')
  })

  it('the co-workers’ models are chat models of the curated pool', async () => {
    const { poolFor } = await import('$lib/server/llm/model-pool')
    const chat = new Set(poolFor('chat').map((m) => m.id))
    for (const c of COMPANY.coworkers) expect(chat.has(c.modelId), c.modelId).toBe(true)
  })

  it('refuses two co-workers on one model, an unknown manager and a reports-to loop', () => {
    const f = clone()
    f.coworkers[2]!.modelId = f.coworkers[1]!.modelId
    f.coworkers[1]!.reportsTo = 'nobody' as never
    f.coworkers[0]!.reportsTo = 'designer'
    const errors = validateFixture(f)
    expect(errors).toContain(`duplicate co-worker modelId ${f.coworkers[1]!.modelId}`)
    expect(errors).toContain('co-worker gtm: unknown member or co-worker nobody')
    expect(errors).toContain('co-worker marketing: the reports-to chain loops')
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
    f.mailboxes[0] = { ...f.mailboxes[0]!, groupId: 'nope' }
    f.calls[0]!.participants = ['priya']
    const errors = validateFixture(f)
    expect(errors).toContain('exactly one owner is required, found 2')
    expect(errors).toContain('dm-priya-jonas: author martin is not in the DM')
    expect(errors).toContain('mbx-sales: unknown group nope')
    expect(errors).toContain('call-acme: startedBy ony is not a participant')
  })
})
