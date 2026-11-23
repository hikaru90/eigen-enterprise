import type { DemoDataset } from './types'
import { describe, expect, it } from 'vitest'
import { northwind } from './data/dataset'
import { validateDataset } from './validate'

const clone = (): DemoDataset => structuredClone(northwind)

describe('the Northwind dataset', () => {
  it('validates: every reference points at a teammate, company, channel or project that exists', () => {
    expect(validateDataset(northwind)).toEqual([])
  })

  it('has the size the plan asks for', () => {
    const d = northwind
    expect(d.teammates).toHaveLength(5)
    expect(d.companies).toHaveLength(8)
    expect(d.contacts.length).toBeGreaterThanOrEqual(25)
    expect(d.projects).toHaveLength(4)
    expect(d.projects.flatMap((p) => p.tasks).length).toBeGreaterThanOrEqual(30)
    expect(d.projects.flatMap((p) => p.tasks).some((t) => t.done)).toBe(true)
    expect(d.channels.length).toBeGreaterThanOrEqual(3)
    expect(d.channels.length).toBeLessThanOrEqual(4)
    expect(d.messages.length).toBeGreaterThanOrEqual(40)
    expect(new Set(d.messages.map((m) => m.author)).size).toBe(6)
    expect(d.events.length).toBeGreaterThanOrEqual(12)
    expect(d.events.some((e) => e.week === 0) && d.events.some((e) => e.week === 1)).toBe(true)
    expect(d.docs.length).toBeGreaterThanOrEqual(6)
    expect(d.pages.length).toBeGreaterThanOrEqual(2)
    expect(d.memories.length).toBeGreaterThanOrEqual(30)
    // Every client company has people in the pipeline.
    for (const c of d.companies) expect(d.contacts.some((p) => p.company === c.id)).toBe(true)
  })
})

describe('validateDataset', () => {
  it('refuses an assignee who is not a teammate', () => {
    const d = clone()
    d.projects[0]!.tasks[0]!.assignee = 'nobody'
    expect(validateDataset(d)).toContain(
      'project acme-relaunch: task "Sitemap and content inventory" is assigned to unknown person "nobody"',
    )
  })

  it("refuses a contact whose company doesn't exist", () => {
    const d = clone()
    d.contacts[0]!.company = 'globex'
    expect(validateDataset(d)).toContain('contact acme-kraus: unknown company "globex"')
  })

  it('refuses a message author who is not a teammate', () => {
    const d = clone()
    d.messages.push({ channel: 'general', author: 'ghost', body: 'hi' })
    expect(validateDataset(d)).toContain(
      `message ${d.messages.length - 1} in general: unknown author "ghost"`,
    )
  })

  it('refuses a message in a channel that does not exist', () => {
    const d = clone()
    d.messages[0]!.channel = 'nowhere'
    expect(validateDataset(d)).toContain('message 0: unknown channel "nowhere"')
  })

  it('refuses unknown event people, an end before the start, and the organizer as their own guest', () => {
    const d = clone()
    d.events[0]!.attendees = ['mira', 'zed']
    d.events[1]!.end = '14:00'
    const errors = validateDataset(d)
    expect(errors).toContain('event 0 "Studio meeting": unknown attendee "zed"')
    expect(errors).toContain('event 0 "Studio meeting": the organizer "mira" is also a guest')
    expect(errors).toContain('event 1 "Elbtal Coffee: logo presentation": ends before it starts')
  })

  it('refuses teammates off the demo domain and duplicate handles or emails', () => {
    const d = clone()
    d.teammates[1]!.email = 'jonas@gmail.com'
    d.teammates[2]!.handle = 'lena'
    const errors = validateDataset(d)
    expect(errors).toContain(
      'teammate jonas: email jonas@gmail.com is not on northwind-studio.example',
    )
    expect(errors).toContain('duplicate person handle "lena"')
  })

  it('refuses unknown authors of docs and memories, unknown memory companies, and duplicate page slugs', () => {
    const d = clone()
    d.docs[0]!.author = 'x'
    d.memories[0]!.author = 'y'
    d.memories[1]!.company = 'globex'
    d.pages[1]!.slug = d.pages[0]!.slug
    const errors = validateDataset(d)
    expect(errors).toContain(`doc "${d.docs[0]!.name}": unknown author "x"`)
    expect(errors).toContain(`memory "${d.memories[0]!.title}": unknown author "y"`)
    expect(errors).toContain(`memory "${d.memories[1]!.title}": unknown company "globex"`)
    expect(errors).toContain(`duplicate page slug "${d.pages[0]!.slug}"`)
  })

  it('refuses a contact owner, group member or project lead who is not a teammate', () => {
    const d = clone()
    d.contacts[0]!.owner = 'q'
    d.groups[0]!.members.push('r')
    d.projects[1]!.lead = 's'
    d.projects[1]!.client = 'globex'
    const errors = validateDataset(d)
    expect(errors).toContain('contact acme-kraus: unknown owner "q"')
    expect(errors).toContain('group Design: unknown member "r"')
    expect(errors).toContain('project elbtal-refresh: unknown lead "s"')
    expect(errors).toContain('project elbtal-refresh: unknown client "globex"')
  })
})
