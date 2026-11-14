import { describe, expect, it } from 'vitest'
import { currentAreaTab } from '$lib/shell/area-nav'
import { EMAIL_SETUP_TABS, EMAIL_TABS, emailTabs } from './tabs'

describe('Email area tabs (your inbox first, setup behind one tab)', () => {
  it('shows mail first and puts the setup sections behind Setup', () => {
    expect(EMAIL_TABS.map((t) => t.label)).toEqual(['Inbox', 'Company mail', 'Contacts', 'Lists', 'Setup'])
    expect(EMAIL_SETUP_TABS.map((t) => t.label)).toEqual([
      'Account',
      'Senders',
      'Mailboxes',
      'Templates',
      'Layouts',
      'Flows',
      'Logs',
      'Suppression',
      'API',
    ])
  })
  it('domains live under Account (no Domains tab since 2026-11-14)', () => {
    expect(EMAIL_SETUP_TABS[0]).toEqual({ id: 'account', label: 'Account', href: '/m/email/setup', match: ['/m/email/domains'] })
  })
  it('the Inbox is where /m/email lands; Company mail (the company-wide pending + sent log) is for the owner and admins only', () => {
    expect(EMAIL_TABS[0]).toEqual({ id: 'inbox', label: 'Inbox', href: '/m/email/inbox', match: ['/m/email/inbox'] })
    expect(EMAIL_TABS[1]).toEqual({ id: 'company', label: 'Company mail', href: '/m/email/company' })
    expect(emailTabs({ isAdmin: true }).map((t) => t.id)).toEqual(['inbox', 'company', 'people', 'contacts', 'setup'])
    expect(emailTabs({ isAdmin: false }).map((t) => t.id)).toEqual(['inbox', 'people', 'contacts', 'setup'])
  })
  it('calls the audience lists "Lists" (people you know live in Contacts); the route stays', () => {
    expect(EMAIL_TABS.find((t) => t.id === 'contacts')).toEqual({ id: 'contacts', label: 'Lists', href: '/m/email/contacts' })
  })
  it('has a Contacts tab (the people you know) after Inbox, before Lists — Contacts lives inside Email', () => {
    expect(EMAIL_TABS.find((t) => t.id === 'people')).toEqual({ id: 'people', label: 'Contacts', href: '/m/email/people' })
  })
  it.each([
    ['/m/email/company', 'company'],
    ['/m/email/inbox', 'inbox'],
    ['/m/email/inbox/attachments/1', 'inbox'],
    ['/m/email/contacts/abc', 'contacts'],
    ['/m/email/people', 'people'],
    ['/m/email/people/new', 'people'],
    ['/m/email/people/abc', 'people'],
    ['/m/email/setup', 'setup'],
    ['/m/email/domains/1', 'setup'],
    ['/m/email/senders', 'setup'],
    ['/m/email/mailboxes', 'setup'],
    ['/m/email/templates/1', 'setup'],
    ['/m/email/layouts', 'setup'],
    ['/m/email/flows/1', 'setup'],
    ['/m/email/logs/1', 'setup'],
    ['/m/email/suppression', 'setup'],
    ['/m/email/api', 'setup'],
  ] as const)('%s → %s', (path, id) => {
    expect(currentAreaTab(EMAIL_TABS, path)).toBe(id)
  })
  it.each([
    ['/m/email/setup', 'account'],
    ['/m/email/domains/1', 'account'],
    ['/m/email/domains', 'account'],
    ['/m/email/logs/1', 'logs'],
    ['/m/email/mailboxes', 'mailboxes'],
    ['/m/email/api', 'api'],
  ] as const)('setup section %s → %s', (path, id) => {
    expect(currentAreaTab(EMAIL_SETUP_TABS, path)).toBe(id)
  })
})
